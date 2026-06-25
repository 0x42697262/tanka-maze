import "./style.css";
import {
  DEFAULT_GAME_CONFIG,
  WALL_STYLES,
  type AdvancedConfig,
  type GameConfig,
  type GameMode,
  type LobbyDTO,
  type LobbySummaryDTO,
  type MapSize,
  type MazeDTO,
  type RosterEntry,
  type RoundStanding,
  type ScoreDTO,
  type ServerMessage,
  type WallStyle,
} from "../shared/protocol.js";
import { bytesEqual, decodeSnapshot, encodeInput } from "../shared/wire.js";
import { Input } from "./input.js";
import { Net } from "./net.js";
import { Renderer } from "./render.js";

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const screens = {
  menu: $("menu"),
  lobby: $("lobby"),
  game: $("game"),
};
function show(name: keyof typeof screens): void {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle("hidden", key !== name);
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(message: string): void {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const net = new Net();
const canvas = $<HTMLCanvasElement>("canvas");
const renderer = new Renderer(canvas);
let input: Input | null = null;

let playerId = "";
let currentLobby: LobbyDTO | null = null;
let inGame = false;
let paused = false;
let lastInputSent = 0;
let lastInputBytes: Uint8Array | null = null;
let roster = new Map<number, RosterEntry>();
let arena: { w: number; h: number } | null = null;
let moveMode: "relative" | "eight" = "relative";
let roundInfo: { round: number; total: number } = { round: 1, total: 1 };
let roundStanding: RoundStanding[] = [];
let roundCountdown: ReturnType<typeof setInterval> | null = null;
const latencies = new Map<string, number>(); // player id -> round-trip ms
let scoreboardOpen = false;
let scoreboardTimer: ReturnType<typeof setInterval> | null = null;
const IS_TOUCH =
  typeof window !== "undefined" &&
  (window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window);

const IDLE_INPUT = {
  forward: false,
  backward: false,
  turnLeft: false,
  turnRight: false,
  fire: false,
  aim: 0,
  eightDir: false,
};

const STORAGE_KEY = "tanka-maze-name";
const MOVE_KEY = "tanka-maze-move"; // "relative" | "eight"
const COLOR_KEY = "tanka-maze-color";
const SESSION_KEY = "tanka-maze-session";
const colorInput = $<HTMLInputElement>("color");
const PRESET_COLORS = [
  "#e6453f",
  "#3f8ce6",
  "#46c24f",
  "#e6c23f",
  "#b04fe6",
  "#e6863f",
  "#3fd9e6",
  "#e63f9e",
];

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
net.onStatus((status) => {
  const el = $("conn-status");
  if (status === "open") {
    el.textContent = "Connected";
    // Handshake first: resume our session if we have a token. The token lives
    // in sessionStorage (per-tab) so two tabs in the same browser are distinct
    // players and never steal each other's session.
    net.send({ type: "identify", sessionId: sessionStorage.getItem(SESSION_KEY) ?? undefined });
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      ($("name") as HTMLInputElement).value = saved;
      net.send({ type: "setName", name: saved });
    }
    // Tank color is auto-assigned by the server on join and tweakable in the
    // lobby — no color is chosen here on the connect screen.
    net.send({ type: "listLobbies" });
  } else if (status === "connecting") {
    el.textContent = "Connecting…";
  } else {
    el.textContent = "Disconnected — reconnecting…";
    if (inGame) toast("Connection lost — reconnecting…");
  }
});

net.onMessage((msg: ServerMessage) => {
  switch (msg.type) {
    case "welcome":
      playerId = msg.playerId;
      sessionStorage.setItem(SESSION_KEY, msg.sessionId);
      if (msg.resumed && inGame) {
        toast("Reconnected");
      } else if (!msg.resumed && inGame) {
        // Session couldn't be restored (e.g., server restarted) — back to menu.
        inGame = false;
        input?.dispose();
        input = null;
        currentLobby = null;
        leaveToMenu();
      }
      break;
    case "lobbyList":
      renderLobbyList(msg.lobbies);
      break;
    case "lobbyJoined":
      currentLobby = msg.lobby;
      if (!inGame) {
        renderLobby(msg.lobby, true);
        show("lobby");
      }
      break;
    case "lobbyUpdate":
      currentLobby = msg.lobby;
      if (!inGame) {
        renderLobby(msg.lobby, false);
        show("lobby");
      }
      break;
    case "lobbyClosed":
      toast(msg.reason);
      currentLobby = null;
      leaveToMenu();
      break;
    case "gameStart":
      roster = new Map(msg.roster.map((r) => [r.index, r]));
      startGame(msg.maze, msg.round, msg.totalRounds, msg.standing);
      // The first snapshot arrives next as a binary frame.
      break;
    case "roster":
      roster = new Map(msg.roster.map((r) => [r.index, r]));
      break;
    case "roundOver":
      showRoundOver(msg.round, msg.totalRounds, msg.winnerName, msg.standing, msg.nextInSeconds);
      break;
    case "gameOver":
      endGame(msg.scores, msg.winnerName, msg.standing, msg.totalRounds);
      break;
    case "latencies":
      for (const p of msg.pings) latencies.set(p.id, p.ms);
      if (scoreboardOpen) renderScoreboard();
      if (!inGame && currentLobby) renderLobby(currentLobby, false);
      break;
    case "kicked":
      closeScoreboard();
      closePause();
      input?.dispose();
      input = null;
      currentLobby = null;
      toast(msg.reason);
      leaveToMenu();
      break;
    case "error":
      toast(msg.message);
      break;
  }
});

// Snapshots arrive as binary frames; decode against the current roster.
net.onBinary((buf) => {
  if (!inGame) return;
  const snap = decodeSnapshot(buf, roster);
  for (const e of snap.events) logKillEvent(e);
  renderer.push(snap, performance.now());
});

// ---- In-game kill/suicide log (icons + colored names + points) ----
const killLog: string[] = [];
function nameSpan(index: number): string {
  const r = roster.get(index);
  return `<span class="lg-name" style="color:${r?.color ?? "#888"}">${escapeHtml(r?.name ?? "?")}</span>`;
}
function logKillEvent(e: { type: number; killer: number; victim: number; points: number }): void {
  const pts = `<span class="lg-pts ${e.points >= 0 ? "pos" : "neg"}">${e.points >= 0 ? "+" : ""}${e.points}</span>`;
  let html: string;
  if (e.type === 0) html = `${nameSpan(e.killer)} 🎯 ${nameSpan(e.victim)} ${pts}`; // kill
  else if (e.type === 2) html = `${nameSpan(e.killer)} 💀 ${nameSpan(e.victim)} ${pts}`; // team-kill
  else html = `💀 ${nameSpan(e.victim)} ${pts}`; // suicide / self-destruct
  killLog.push(`<li>${html}</li>`);
  if (killLog.length > 6) killLog.shift();
  $("killlog").innerHTML = killLog.join("");
}

// ---------------------------------------------------------------------------
// Menu / lobby UI
// ---------------------------------------------------------------------------
function renderLobbyList(lobbies: LobbySummaryDTO[]): void {
  const ul = $("lobby-list");
  ul.innerHTML = "";
  if (lobbies.length === 0) {
    ul.innerHTML = `<li class="empty">No lobbies yet — create one!</li>`;
    return;
  }
  for (const l of lobbies) {
    const li = document.createElement("li");
    const full = l.playerCount >= l.maxPlayers;
    const closed = l.inGame && !l.allowLateJoin; // started + late join disabled
    const joinable = !full && !closed;
    const status = l.inGame ? (closed ? "● in progress" : "● live") : "";
    li.innerHTML = `
      <div class="lobby-info">
        <span class="name">${escapeHtml(l.name)}</span>
        <span class="sub">host ${escapeHtml(l.hostName)} · ${modeLabel(l.mode)}</span>
      </div>
      <span class="badge ${l.inGame ? "live" : ""}">
        ${status} ${l.playerCount}/${l.maxPlayers}
      </span>`;
    const btn = document.createElement("button");
    btn.className = "ghost small";
    btn.textContent = full ? "Full" : closed ? "Closed" : l.inGame ? "Join live" : "Join";
    btn.disabled = !joinable;
    btn.onclick = () => net.send({ type: "joinLobby", lobbyId: l.id });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function renderLobby(lobby: LobbyDTO, firstRender: boolean): void {
  $("lobby-title").textContent = lobby.name;
  $("lobby-meta").textContent = `${lobby.players.length}/${lobby.maxPlayers} players · ${configSummary(lobby.config)}`;

  const teams = lobby.config.mode === "teams";
  const isHost = lobby.hostId === playerId;
  const ul = $("lobby-players");
  ul.innerHTML = "";

  if (teams) {
    // A boxed roster per team; clicking a box joins that team.
    ul.classList.add("teams");
    for (let team = 0; team < lobby.config.teamCount; team++) {
      const members = lobby.players.filter((p) => p.team === team);
      const mine = lobby.players.find((p) => p.id === playerId)?.team === team;
      const captain = members[0]?.id === playerId; // first player of this team
      const tint = lobby.teamColors[team] ?? TEAM_TINT[team % TEAM_TINT.length];
      const tname = lobby.teamNames[team] ?? `Team ${team + 1}`;

      const box = document.createElement("li");
      box.className = `team-box${mine ? " mine" : ""}`;
      box.style.borderColor = tint;

      const head = document.createElement("div");
      head.className = "team-head";
      head.style.color = tint;
      if (captain) {
        // Captain (first player) may edit the team's color + name.
        head.appendChild(teamColorInput(team, tint));
        head.appendChild(teamNameInput(team, tname));
      } else {
        head.innerHTML = `<span class="swatch" style="background:${tint}"></span>${escapeHtml(tname)}`;
      }
      const count = document.createElement("span");
      count.className = "team-n";
      count.textContent = `(${members.length})`;
      head.appendChild(count);
      box.appendChild(head);

      const sub = document.createElement("ul");
      members.forEach((p) => sub.appendChild(playerRow(p, lobby.hostId)));
      box.appendChild(sub);
      box.onclick = () => {
        if (!mine) net.send({ type: "setTeam", team });
      };
      ul.appendChild(box);
    }
  } else {
    ul.classList.remove("teams");
    lobby.players.forEach((p) => ul.appendChild(playerRow(p, lobby.hostId)));
  }

  $("team-hint").classList.toggle("hidden", !teams);
  $("start").classList.toggle("hidden", !isHost);
  $("waiting-host").classList.toggle("hidden", isHost);

  // Per-player tank color: reflect the server-assigned color; hide in Team VS
  // (there the team color governs the tank's in-game appearance).
  const me = lobby.players.find((p) => p.id === playerId);
  if (me) {
    colorInput.value = me.color;
    updateSwatchSelection();
  }
  $("lobby-customize").classList.toggle("hidden", teams);

  // Host configures the game here; populate the controls once on entry.
  $("lobby-config").classList.toggle("hidden", !isHost);
  if (isHost && firstRender) applyConfigToControls(lobby.config, lobby.maxPlayers);

  // Everyone sees the full, read-only configuration on the right.
  renderConfigDetails(lobby);
}

/** Render the complete (read-only) lobby configuration into the lobby sidebar. */
function renderConfigDetails(lobby: LobbyDTO): void {
  $("details-body").innerHTML = buildConfigDetailsHtml(lobby);
}

/** Build the complete (read-only) config as organized HTML groups. */
function buildConfigDetailsHtml(lobby: LobbyDTO): string {
  const c = lobby.config;
  const a = c.adv;
  const teams = c.mode === "teams";
  const hasWin = c.mode !== "lms";
  const onOff = (b: boolean) => (b ? "On" : "Off");
  type Row = [string, string | number];
  const groups: Array<{ title: string; rows: Row[] }> = [];

  const mode: Row[] = [["Mode", modeLabel(c.mode)]];
  if (teams) {
    mode.push(["Teams", c.teamCount]);
    mode.push(["Friendly fire", onOff(c.friendlyFire)]);
    mode.push(["Team-kill penalty", `${c.teamKillPenalty} pts`]);
  }
  groups.push({ title: "Mode", rows: mode });

  groups.push({
    title: "Map",
    rows: [
      ["Walls", WALL_LABEL[c.wallStyle]],
      ["Size", SIZE_LABEL[c.mapSize]],
    ],
  });

  groups.push({
    title: "Match",
    rows: [
      ["Rounds", c.rounds > 1 ? `best of ${c.rounds}` : "single round"],
      ["Max players", lobby.maxPlayers],
      ["Join after start", c.allowLateJoin ? "Allowed" : "Closed"],
      ["Tank speed", `${c.tankSpeedPct}%`],
      ["HP", c.hp],
      ["Lives", c.lives > 0 ? c.lives : "∞"],
      ["Respawn", `${c.respawnSeconds}s`],
    ],
  });

  const scoring: Row[] = [
    ["Kill", `${c.killPoints} pts`],
    ["Death penalty", `${c.deathPenaltyPct}%`],
  ];
  if (hasWin) scoring.push(["Points to win", `${c.winScore}`]);
  groups.push({ title: "Scoring", rows: scoring });

  const pwr: Row[] = [["Power-ups", onOff(c.powerups)]];
  if (c.powerups) {
    pwr.push(["Spawn every", `${c.powerupEverySeconds}s`]);
    pwr.push(["Despawn after", `${c.powerupDespawnSeconds}s`]);
    pwr.push(["Charges / pickup", c.powerupCharges]);
  }
  groups.push({ title: "Power-ups", rows: pwr });

  // Advanced engine tuning, grouped the same way as the host's editor.
  groups.push({
    title: "Adv · Tank",
    rows: [
      ["Size", a.tankRadius],
      ["Turn rate", a.tankTurnSpeed],
      ["Fire cooldown", `${a.fireCooldown}s`],
      ["Magazine", a.maxAmmo],
      ["Reload", `${a.reloadSeconds}s`],
    ],
  });
  groups.push({
    title: "Adv · Bullet",
    rows: [
      ["Speed", a.bulletSpeed],
      ["Size", a.bulletRadius],
      ["Bounces", a.bulletBounces],
      ["Lifetime", `${a.bulletLifetime}s`],
    ],
  });
  groups.push({
    title: "Adv · Map",
    rows: [
      ["Cell size", a.cellSize],
      ["Wall thickness", a.wallThickness],
    ],
  });
  groups.push({
    title: "Adv · Power-ups",
    rows: [
      ["Boost ×", a.speedBoostMult],
      ["Boost duration", `${a.speedBoostSeconds}s`],
      ["Shield duration", `${a.shieldSeconds}s`],
      ["Laser windup", `${a.laserDelay}s`],
      ["Laser range", a.laserRange],
      ["Sniper ×", a.sniperSpeedMult],
      ["Sniper wall pierce", a.sniperWallPierce],
      ["Explosion radius", a.explosionRadius],
      ["Scope duration", `${a.scopeSeconds}s`],
      ["Scope range", a.scopeRange],
      ["Tracking turn", a.trackingTurnRate],
      ["Tracking life", `${a.trackingLifetime}s`],
      ["Tracking bounces", a.trackingBounces],
      ["Multishot pellets", a.multishotCount],
      ["Multishot spread", `${a.multishotSpread}°`],
      ["Multishot shots", a.multishotMaxShots],
    ],
  });

  return groups
    .map(
      (g) =>
        `<div class="det-group"><h4>${g.title}</h4><dl>` +
        g.rows
          .map(
            ([k, v]) =>
              `<div class="det-row"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`
          )
          .join("") +
        `</dl></div>`
    )
    .join("");
}

function teamColorInput(team: number, color: string): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "color";
  el.className = "team-color-input";
  el.value = color;
  el.title = "Team color";
  el.onclick = (e) => e.stopPropagation();
  el.onchange = () => net.send({ type: "setTeamColor", team, color: el.value });
  return el;
}

function teamNameInput(team: number, name: string): HTMLInputElement {
  const el = document.createElement("input");
  el.className = "team-name-input";
  el.maxLength = 16;
  el.value = name;
  el.title = "Team name";
  el.onclick = (e) => e.stopPropagation();
  el.onchange = () => {
    const v = el.value.trim();
    if (v) net.send({ type: "setTeamName", team, name: v });
  };
  return el;
}

function playerRow(p: LobbyDTO["players"][number], hostId: string): HTMLLIElement {
  const li = document.createElement("li");
  if (!p.connected) li.className = "offline";
  const you = p.id === playerId ? " (you)" : "";
  const tag = p.connected ? you : " (reconnecting…)";
  li.innerHTML = `<span><span class="swatch" style="background:${p.color}"></span>${escapeHtml(p.name)}${tag}</span>${pingBadge(p.id)}`;
  if (p.id === hostId) {
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = "HOST";
    li.appendChild(host);
  }
  return li;
}

/** Colored latency badge (— when unknown) for a player id. */
function pingBadge(id: string): string {
  const ms = latencies.get(id);
  if (ms == null) return `<span class="ping">—</span>`;
  const cls = ms < 80 ? "good" : ms < 160 ? "ok" : "bad";
  return `<span class="ping ${cls}">${ms} ms</span>`;
}

// ---------------------------------------------------------------------------
// In-game scoreboard (Tab): connected players, latency, full config, host kick
// ---------------------------------------------------------------------------
function renderScoreboard(): void {
  if (!currentLobby) return;
  const lobby = currentLobby;
  const teams = lobby.config.mode === "teams";
  const isHost = lobby.hostId === playerId;
  const snap = renderer.latest();
  const scoreById = new Map<string, number>();
  if (snap) for (const t of snap.tanks) scoreById.set(t.id, t.score);

  const rows = [...lobby.players].sort(
    (a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0)
  );
  const teamHead = teams ? "<th>Team</th>" : "";
  const body = rows
    .map((p) => {
      const teamCell = teams
        ? `<td>${escapeHtml(lobby.teamNames[p.team] ?? `Team ${p.team + 1}`)}</td>`
        : "";
      const kick =
        isHost && p.id !== playerId
          ? `<button class="sb-kick ghost small" data-id="${p.id}">Kick</button>`
          : "";
      const tag = p.id === playerId ? ' <span class="sb-you">you</span>' : "";
      const host = p.id === lobby.hostId ? ' <span class="sb-host">host</span>' : "";
      return (
        `<tr class="${p.connected ? "" : "sb-off"}">` +
        `<td><span class="swatch" style="background:${p.color}"></span>${escapeHtml(p.name)}${tag}${host}</td>` +
        teamCell +
        `<td class="sb-score">${scoreById.get(p.id) ?? 0}</td>` +
        `<td>${pingBadge(p.id)}</td>` +
        `<td class="sb-act">${kick}</td>` +
        `</tr>`
      );
    })
    .join("");

  $("sb-table-wrap").innerHTML =
    `<table class="sb-table"><thead><tr>` +
    `<th>Player</th>${teamHead}<th>Score</th><th>Ping</th><th></th>` +
    `</tr></thead><tbody>${body}</tbody></table>`;

  $("sb-table-wrap")
    .querySelectorAll<HTMLButtonElement>(".sb-kick")
    .forEach((b) => {
      b.onclick = () => net.send({ type: "kickPlayer", targetId: b.dataset.id ?? "" });
    });

  $("sb-details").innerHTML = buildConfigDetailsHtml(lobby);
}

function openScoreboard(): void {
  if (!inGame) return;
  scoreboardOpen = true;
  renderScoreboard();
  $("scoreboard").classList.remove("hidden");
  if (scoreboardTimer) clearInterval(scoreboardTimer);
  scoreboardTimer = setInterval(renderScoreboard, 500); // live scores + latency
}
function closeScoreboard(): void {
  scoreboardOpen = false;
  $("scoreboard").classList.add("hidden");
  if (scoreboardTimer) {
    clearInterval(scoreboardTimer);
    scoreboardTimer = null;
  }
}

function leaveToMenu(): void {
  inGame = false;
  closeScoreboard();
  $("touch-controls").classList.add("hidden");
  if (roundCountdown) {
    clearInterval(roundCountdown);
    roundCountdown = null;
  }
  $("roundover").classList.add("hidden");
  $("gameover").classList.add("hidden");
  show("menu");
  net.send({ type: "listLobbies" });
}

// ---------------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------------
function startGame(maze: MazeDTO, round = 1, totalRounds = 1, standing: RoundStanding[] = []): void {
  renderer.setMaze(maze);
  const adv = currentLobby?.config.adv ?? DEFAULT_GAME_CONFIG.adv;
  renderer.setParams(adv.tankRadius, adv.bulletRadius);
  renderer.setScope({
    range: adv.scopeRange,
    laserRange: adv.laserRange,
    bulletSpeed: adv.bulletSpeed,
    bounces: adv.bulletBounces,
    multiCount: adv.multishotCount,
    multiSpread: adv.multishotSpread,
  });
  arena = { w: maze.width, h: maze.height };
  inGame = true;
  if (roundCountdown) {
    clearInterval(roundCountdown);
    roundCountdown = null;
  }
  roundInfo = { round, total: totalRounds };
  roundStanding = standing;
  lastInputBytes = null; // force the first input of the new game to send
  // Full config + players live in the Tab scoreboard now; the header just names
  // the lobby and hints at Tab.
  $("gh-lobby").textContent = currentLobby ? currentLobby.name : "";
  renderRoundBadge();
  renderSeriesBoard();
  closePause();
  $("gameover").classList.add("hidden");
  $("roundover").classList.add("hidden");
  $("respawn").classList.add("hidden");
  input?.dispose();
  input = new Input(canvas);
  input.eightDir = moveMode === "eight";
  if (IS_TOUCH) {
    input.enableTouch($("stick-move"), $("stick-aim"));
    $("touch-controls").classList.remove("hidden");
  }
  killLog.length = 0;
  $("killlog").innerHTML = "";
  show("game");
  fitCanvas();
}

/** "Round 2 / 3" pill in the game header (hidden for single-round matches). */
function renderRoundBadge(): void {
  const el = $("gh-round");
  if (roundInfo.total > 1) {
    el.textContent = `Round ${roundInfo.round} / ${roundInfo.total}`;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

/** In-game round scoreboard in the leaderboard sidebar (multi-round matches). */
function renderSeriesBoard(): void {
  const board = $("series-board");
  if (roundInfo.total <= 1 || roundStanding.length === 0) {
    board.classList.add("hidden");
    return;
  }
  $("series-board-rows").innerHTML = standingHtml(roundStanding);
  board.classList.remove("hidden");
}

/** Markup for a series tally (round wins per player/team), best first. */
function standingHtml(standing: RoundStanding[]): string {
  return standing
    .map(
      (s) =>
        `<li><span class="swatch" style="background:${s.color}"></span>` +
        `<span class="lg-name">${escapeHtml(s.name)}</span>` +
        `<span class="pts">${"●".repeat(s.wins) || "—"} ${s.wins}</span></li>`
    )
    .join("");
}

/** Between-rounds intermission overlay with the series tally + countdown. */
/**
 * Between-rounds indication. The game is NOT paused — the arena keeps animating
 * with players locked — so this is a slim, non-blocking banner, not a modal. The
 * full tally lives in the persistent series scoreboard in the sidebar.
 */
function showRoundOver(
  round: number,
  total: number,
  winnerName: string,
  standing: RoundStanding[],
  nextInSeconds: number
): void {
  roundInfo = { round, total };
  roundStanding = standing;
  renderRoundBadge();
  renderSeriesBoard();
  $("respawn").classList.add("hidden");
  $("ro-title").textContent = winnerName
    ? `🏆 ${winnerName} takes round ${round}`
    : `Round ${round} drawn`;
  const countEl = $("ro-count");
  let secs = Math.max(1, Math.round(nextInSeconds));
  countEl.textContent = String(secs);
  $("ro-sub").textContent = `Round ${round + 1} of ${total} in `;
  $("roundover").classList.remove("hidden");
  if (roundCountdown) clearInterval(roundCountdown);
  roundCountdown = setInterval(() => {
    secs -= 1;
    countEl.textContent = String(Math.max(0, secs));
    if (secs <= 0 && roundCountdown) {
      clearInterval(roundCountdown);
      roundCountdown = null;
    }
  }, 1000);
}

/**
 * Scale the canvas's *display* size to fill the browser window while preserving
 * the arena's aspect ratio. The drawing buffer stays at native resolution, so
 * the game world is unchanged — only the on-screen size grows/shrinks. Input
 * mapping divides by the element's rendered size, so aiming stays accurate.
 */
function fitCanvas(): void {
  if (!arena) return;
  // On compact/touch screens the leaderboard sidebar and hint line are hidden,
  // so the arena gets the full viewport (minus a small margin + header).
  const compact = window.innerWidth <= 760;
  const hintEl = document.querySelector("#game .hint") as HTMLElement;
  const hint = compact ? 0 : hintEl?.offsetHeight ?? 24;
  const header = (document.querySelector("#game .game-header") as HTMLElement)?.offsetHeight ?? 0;
  const reservedV = header + hint + (compact ? 20 : 72);
  const sidebar = compact ? 0 : 214; // leaderboard column (200 + gap)
  const pad = compact ? 16 : 48;
  const availW = window.innerWidth - pad - sidebar;
  const availH = window.innerHeight - reservedV;
  const scale = Math.max(0.1, Math.min(availW / arena.w, availH / arena.h));
  canvas.style.width = `${Math.floor(arena.w * scale)}px`;
  canvas.style.height = `${Math.floor(arena.h * scale)}px`;
}

function endGame(
  scores: ScoreDTO[],
  winnerName: string,
  standing: RoundStanding[] = [],
  totalRounds = 1
): void {
  inGame = false;
  closePause();
  closeScoreboard();
  $("touch-controls").classList.add("hidden");
  if (roundCountdown) {
    clearInterval(roundCountdown);
    roundCountdown = null;
  }
  $("respawn").classList.add("hidden");
  $("roundover").classList.add("hidden");
  input?.dispose();
  input = null;

  $("winner").textContent = winnerName ? `🏆 ${winnerName} wins!` : "Game Over";

  // Series tally (round wins) — only meaningful for multi-round matches.
  const series = $("series");
  if (totalRounds > 1 && standing.length) {
    series.innerHTML = `<h4>Rounds won</h4><ul class="series-rows">${standingHtml(standing)}</ul>`;
    series.classList.remove("hidden");
  } else {
    series.classList.add("hidden");
  }

  const ul = $("final-scores");
  ul.innerHTML = "";
  scores.forEach((s, i) => {
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="rank">${i + 1}</span>` +
      `<span class="swatch" style="background:${s.color}"></span>` +
      `<span>${escapeHtml(s.name)}</span>` +
      `<span class="pts">${s.score}</span>`;
    ul.appendChild(li);
  });
  $("gameover").classList.remove("hidden");
}

/** In-arena leaderboard. Team VS ranks by combined team points; else per-player. */
function renderLeaderboard(): void {
  const snap = renderer.latest();
  if (!snap) return;
  const ol = $("leaderboard-rows");
  ol.innerHTML = "";

  if (currentLobby?.config.mode === "teams") {
    const totals = new Map<number, { score: number; n: number }>();
    for (const t of snap.tanks) {
      const cur = totals.get(t.team) ?? { score: 0, n: 0 };
      cur.score += t.score;
      cur.n += 1;
      totals.set(t.team, cur);
    }
    const myTeam = snap.tanks.find((t) => t.id === playerId)?.team;
    const names = currentLobby?.teamNames ?? [];
    const colors = currentLobby?.teamColors ?? [];
    [...totals.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[0] - b[0])
      .forEach(([team, d], i) => {
        const li = document.createElement("li");
        if (team === myTeam) li.className = "me";
        const tint = colors[team] ?? TEAM_TINT[team % TEAM_TINT.length];
        const tname = names[team] ?? `Team ${team + 1}`;
        li.innerHTML =
          `<span class="rank">${i + 1}</span>` +
          `<span class="swatch" style="background:${tint}"></span>` +
          `<span class="nm">${escapeHtml(tname)} (${d.n})</span>` +
          `<span class="pts">${d.score}</span>`;
        ol.appendChild(li);
      });
    return;
  }

  [...snap.tanks]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .forEach((t, i) => {
      const li = document.createElement("li");
      li.className = `${t.id === playerId ? "me " : ""}${t.alive ? "" : "dead"}`.trim();
      li.innerHTML =
        `<span class="rank">${i + 1}</span>` +
        `<span class="swatch" style="background:${t.color}"></span>` +
        `<span class="nm">${escapeHtml(t.name)}</span>` +
        `<span class="pts">${t.score}</span>`;
      ol.appendChild(li);
    });
}

function updateRespawnOverlay(me: { alive: boolean; respawnIn: number } | undefined): void {
  const el = $("respawn");
  if (me && !me.alive) {
    el.classList.remove("hidden");
    $("respawn-count").textContent = String(Math.max(0, Math.ceil(me.respawnIn)));
  } else {
    el.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
function frame(): void {
  const now = performance.now();
  if (inGame) {
    const snap = renderer.latest();
    const me = snap?.tanks.find((t) => t.id === playerId);
    if (input && me && !paused) {
      const bytes = encodeInput(input.getState(me.x, me.y));
      // Send only when the input actually changed (capped at ~30 Hz). The server
      // keeps applying the last input, so idle players send nothing.
      if (now - lastInputSent > 1000 / 30 && !bytesEqual(lastInputBytes, bytes)) {
        net.sendBinary(bytes);
        lastInputBytes = bytes;
        lastInputSent = now;
      }
    }
    renderer.render(playerId, now);
    renderLeaderboard();
    updateRespawnOverlay(me);
    renderAmmo(me);
    if (snap) {
      const alive = snap.tanks.filter((t) => t.alive).length;
      $("gh-count").textContent = `${snap.tanks.length} players · ${alive} alive`;
    }
  }
  requestAnimationFrame(frame);
}

const WEAPON_LABEL: Record<string, string> = {
  sniper: "Sniper",
  explosive: "Explosive",
  laser: "Laser",
  tracking: "Tracking",
  multishot: "Multishot",
};

function renderAmmo(
  me:
    | {
      ammo: number;
      maxAmmo: number;
      reloadIn: number;
      weapon: string | null;
      weaponCharges: number;
      boosted: boolean;
      shielded: boolean;
      charging: boolean;
      scoped: boolean;
    }
    | undefined
): void {
  const el = $("ammo");
  if (!me) {
    el.innerHTML = "";
    return;
  }
  let html = "";
  for (let i = 0; i < me.maxAmmo; i++) {
    html += `<span class="pip ${i < me.ammo ? "" : "spent"}"></span>`;
  }
  if (me.reloadIn > 0) html += `<span class="reload">reloading ${Math.ceil(me.reloadIn)}s</span>`;
  if (me.charging) html += `<span class="weapon laser">charging…</span>`;
  else if (me.weapon && WEAPON_LABEL[me.weapon]) {
    html += `<span class="weapon">${WEAPON_LABEL[me.weapon]} ×${me.weaponCharges}</span>`;
  }
  if (me.boosted) html += `<span class="weapon boost">» boost</span>`;
  if (me.shielded) html += `<span class="weapon shield">◈ shield</span>`;
  if (me.scoped) html += `<span class="weapon scope">ⓘ scope</span>`;
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Wire up controls
// ---------------------------------------------------------------------------
function commitName(): void {
  const value = ($("name") as HTMLInputElement).value.trim();
  if (value) {
    localStorage.setItem(STORAGE_KEY, value);
    net.send({ type: "setName", name: value });
  }
}
$("name").addEventListener("change", commitName);

function commitColor(): void {
  const value = colorInput.value;
  localStorage.setItem(COLOR_KEY, value);
  net.send({ type: "setColor", color: value });
  updateSwatchSelection();
}

function updateSwatchSelection(): void {
  const current = colorInput.value.toLowerCase();
  $("swatches")
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((b) => b.classList.toggle("selected", (b.dataset.color ?? "") === current));
}

function buildSwatches(): void {
  const wrap = $("swatches");
  wrap.innerHTML = "";
  for (const c of PRESET_COLORS) {
    const b = document.createElement("button");
    b.style.background = c;
    b.dataset.color = c;
    b.title = c;
    b.onclick = () => {
      colorInput.value = c;
      commitColor();
    };
    wrap.appendChild(b);
  }
}

buildSwatches();
colorInput.addEventListener("input", commitColor);

$("refresh").onclick = () => net.send({ type: "listLobbies" });

// Create a lobby with defaults; the host then tunes settings in the lobby room.
$("create").onclick = () => {
  commitName();
  const name = ($("lobby-name") as HTMLInputElement).value.trim();
  net.send({ type: "createLobby", name, maxPlayers: 8, config: DEFAULT_GAME_CONFIG });
};

$("start").onclick = () => net.send({ type: "startGame" });

// ---- In-lobby game settings (host) ----
const ADV_KEYS = Object.keys(DEFAULT_GAME_CONFIG.adv) as (keyof AdvancedConfig)[];

function gatherAdvanced(): AdvancedConfig {
  const d = DEFAULT_GAME_CONFIG.adv;
  const out = {} as AdvancedConfig;
  for (const k of ADV_KEYS) {
    const v = Number(($(`adv-${k}`) as HTMLInputElement).value);
    out[k] = Number.isFinite(v) ? v : d[k];
  }
  return out;
}

function gatherConfig(): { maxPlayers: number; config: GameConfig } {
  const sel = (id: string) => ($(id) as HTMLSelectElement).value;
  const num = (id: string, d: number) => Number(($(id) as HTMLInputElement).value) || d;
  return {
    maxPlayers: num("max-players", 8),
    config: {
      mode: sel("mode") as GameMode,
      wallStyle: sel("walls") as WallStyle,
      mapSize: sel("map-size") as MapSize,
      rounds: num("rounds", 3),
      allowLateJoin: sel("allow-late") === "on",
      tankSpeedPct: num("tank-speed", 100),
      hp: num("hp", 1),
      lives: Number(($("lives") as HTMLInputElement).value) || 0,
      respawnSeconds: num("cfg-respawn", 3),
      killPoints: num("kill-points", 60),
      deathPenaltyPct: Number(($("death-penalty") as HTMLInputElement).value) || 0,
      winScore: num("win-score", 300),
      teamCount: num("team-count", 2),
      friendlyFire: sel("friendly-fire") === "on",
      teamKillPenalty: Number(($("team-kill") as HTMLInputElement).value) || 0,
      adv: gatherAdvanced(),
      powerups: sel("powerups") === "on",
      powerupEverySeconds: num("pwr-every", 8),
      powerupDespawnSeconds: num("pwr-despawn", 12),
      powerupCharges: num("pwr-charges", 3),
    },
  };
}

function applyConfigToControls(c: GameConfig, maxPlayers: number): void {
  const set = (id: string, v: string | number) => (($(id) as HTMLInputElement).value = String(v));
  set("max-players", maxPlayers);
  set("mode", c.mode);
  set("walls", c.wallStyle);
  set("map-size", c.mapSize);
  set("rounds", c.rounds);
  set("allow-late", c.allowLateJoin ? "on" : "off");
  set("team-count", c.teamCount);
  set("tank-speed", c.tankSpeedPct);
  set("hp", c.hp);
  set("lives", c.lives);
  set("cfg-respawn", c.respawnSeconds);
  set("kill-points", c.killPoints);
  set("death-penalty", c.deathPenaltyPct);
  set("win-score", c.winScore);
  set("friendly-fire", c.friendlyFire ? "on" : "off");
  set("team-kill", c.teamKillPenalty);
  set("powerups", c.powerups ? "on" : "off");
  set("pwr-every", c.powerupEverySeconds);
  set("pwr-charges", c.powerupCharges);
  set("pwr-despawn", c.powerupDespawnSeconds);
  for (const k of ADV_KEYS) set(`adv-${k}`, c.adv[k]);
  renderWallPicker();
  applyModeVisibility();
}

/** Show only the settings relevant to the selected mode. */
function applyModeVisibility(): void {
  const mode = ($("mode") as HTMLSelectElement).value;
  const cfg = $("lobby-config");
  cfg.querySelectorAll(".cfg-teams").forEach((el) =>
    el.classList.toggle("hidden", mode !== "teams")
  );
  cfg.querySelectorAll(".cfg-haswin").forEach((el) =>
    el.classList.toggle("hidden", mode === "lms")
  );
}

$("lobby-config").addEventListener("change", () => {
  if (!currentLobby || currentLobby.hostId !== playerId) return;
  applyModeVisibility();
  const { maxPlayers, config } = gatherConfig();
  net.send({ type: "updateConfig", maxPlayers, config });
});

$("adv-toggle").onclick = () => $("adv-panel").classList.toggle("hidden");

// ---- Per-player settings (gear) ----
function applyMoveSetting(): void {
  ($("move-mode") as HTMLSelectElement).value = moveMode;
  $("move-hint").textContent =
    moveMode === "eight"
      ? "Move any direction; the cannon aims separately."
      : "Drive forward/back and rotate; the cannon aims separately.";
  if (input) input.eightDir = moveMode === "eight";
  renderMovePicker();
}

// Two control schemes, picked from icons (no dropdown).
const MOVE_OPTS: Array<{ id: "relative" | "eight"; name: string; sub: string; icon: string }> = [
  {
    id: "relative",
    name: "Rotate & drive",
    sub: "Tank-style steering",
    icon:
      `<rect class="mv-body" x="42" y="30" width="16" height="15" rx="2" />` +
      `<line x1="50" y1="31" x2="50" y2="18" />` +
      `<path d="M72 28 A 24 24 0 0 1 72 52" />` +
      `<polygon points="72,53 65,48 76,45" />`,
  },
  {
    id: "eight",
    name: "8-direction",
    sub: "Strafe any way",
    icon: moveEightArrows(),
  },
];

/** SVG inner content: eight short arrows radiating from the centre. */
function moveEightArrows(): string {
  const cx = 50;
  const cy = 35;
  let s = "";
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const x1 = cx + ux * 9;
    const y1 = cy + uy * 9;
    const x2 = cx + ux * 23;
    const y2 = cy + uy * 23;
    const h = 6;
    const ax = x2 + Math.cos(a + Math.PI * 0.82) * h;
    const ay = y2 + Math.sin(a + Math.PI * 0.82) * h;
    const bx = x2 + Math.cos(a - Math.PI * 0.82) * h;
    const by = y2 + Math.sin(a - Math.PI * 0.82) * h;
    s +=
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" />` +
      `<polygon points="${x2.toFixed(1)},${y2.toFixed(1)} ${ax.toFixed(1)},${ay.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}" />`;
  }
  return s;
}

/** Build the movement scheme picker (icons, syncing the hidden select). */
function renderMovePicker(): void {
  const picker = $("move-picker");
  picker.innerHTML = MOVE_OPTS.map(
    (o) =>
      `<button type="button" class="move-opt${o.id === moveMode ? " selected" : ""}" data-move="${o.id}">` +
      `<svg class="move-ic" viewBox="0 0 100 70" aria-hidden="true">${o.icon}</svg>` +
      `<span><b>${o.name}</b><small>${o.sub}</small></span></button>`
  ).join("");
  picker.querySelectorAll<HTMLButtonElement>(".move-opt").forEach((b) => {
    b.onclick = () => {
      const sel = $("move-mode") as HTMLSelectElement;
      sel.value = b.dataset.move ?? "relative";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    };
  });
}
$("settings-gear").onclick = () => $("settings-panel").classList.toggle("hidden");
$("move-mode").addEventListener("change", () => {
  moveMode = ($("move-mode") as HTMLSelectElement).value === "eight" ? "eight" : "relative";
  localStorage.setItem(MOVE_KEY, moveMode);
  applyMoveSetting();
});
moveMode = localStorage.getItem(MOVE_KEY) === "eight" ? "eight" : "relative";
applyMoveSetting();

$("leave").onclick = () => {
  net.send({ type: "leaveLobby" });
  currentLobby = null;
  show("menu");
};

// ---- Pause / in-game menu (Esc) ----
// The config editor (#lobby-config) is a single element shared between the
// lobby screen and the pause menu. A comment anchor marks its lobby home so we
// can return it after the host finishes editing mid-match.
const configEl = $("lobby-config");
const configHomeAnchor = document.createComment("lobby-config-home");
configEl.parentElement?.insertBefore(configHomeAnchor, configEl);

function moveConfigToPause(): void {
  $("pause-config-slot").appendChild(configEl);
  configEl.classList.remove("hidden");
}
function moveConfigHome(): void {
  configHomeAnchor.parentElement?.insertBefore(configEl, configHomeAnchor.nextSibling);
}

function openPause(): void {
  if (!inGame) return;
  paused = true;
  const idle = encodeInput(IDLE_INPUT); // halt the tank while paused
  net.sendBinary(idle);
  lastInputBytes = idle;
  const isHost = !!currentLobby && currentLobby.hostId === playerId;
  $("pause-host").classList.toggle("hidden", !isHost);
  // Wide "landscape" card only while the host is editing settings.
  $("pause").querySelector(".pause-card")?.classList.toggle("host-editing", isHost);
  if (isHost && currentLobby) {
    moveConfigToPause();
    applyConfigToControls(currentLobby.config, currentLobby.maxPlayers);
    applyModeVisibility();
  }
  $("pause").classList.remove("hidden");
}
function closePause(): void {
  paused = false;
  $("pause").classList.add("hidden");
  $("pause").querySelector(".pause-card")?.classList.remove("host-editing");
  moveConfigHome(); // return the editor to the lobby (no-op if already there)
}
$("resume").onclick = closePause;
$("pause-restart").onclick = () => {
  net.send({ type: "restartGame" });
  closePause();
};
$("leave-game").onclick = () => {
  closePause();
  net.send({ type: "leaveLobby" });
  inGame = false;
  $("respawn").classList.add("hidden");
  input?.dispose();
  input = null;
  currentLobby = null;
  leaveToMenu();
};
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && inGame) {
    e.preventDefault();
    paused ? closePause() : openPause();
  } else if (e.key === "Tab" && inGame) {
    e.preventDefault();
    scoreboardOpen ? closeScoreboard() : openScoreboard();
  }
});

// Touch equivalents of Esc (menu) and Tab (scoreboard).
$("touch-pause").onclick = () => (paused ? closePause() : openPause());
$("touch-score").onclick = () => (scoreboardOpen ? closeScoreboard() : openScoreboard());

$("back-to-lobby").onclick = () => {
  $("gameover").classList.add("hidden");
  if (currentLobby) {
    renderLobby(currentLobby, true);
    show("lobby");
  } else {
    leaveToMenu();
  }
};

function modeLabel(mode: GameMode): string {
  return mode === "lms" ? "Last Man Standing" : mode === "teams" ? "Team VS" : "Free-for-all";
}

const TEAM_TINT = ["#3f8ce6", "#e6453f", "#46c24f", "#e6c23f"];

const WALL_LABEL: Record<WallStyle, string> = {
  maze: "Maze",
  sparse: "Sparse",
  open: "Open",
  cross: "Cross",
  lshape: "L-Shape",
  tunnels: "Tunnels",
  box: "Box",
  dots: "Dots",
};

// Schematic wall segments per map for the picker thumbnails (100×70 viewBox).
const WALL_THUMB_SEGS: Record<WallStyle, number[][]> = {
  open: [],
  maze: [[35, 8, 35, 45], [35, 45, 68, 45], [68, 20, 68, 45], [18, 24, 50, 24], [50, 24, 50, 38]],
  sparse: [[28, 14, 40, 14], [60, 40, 60, 56], [18, 46, 18, 60], [68, 16, 82, 16], [46, 52, 58, 52]],
  cross: [[50, 16, 50, 54], [24, 35, 76, 35]],
  lshape: [[50, 35, 50, 60], [50, 35, 80, 35]],
  tunnels: [[34, 8, 34, 46], [66, 24, 66, 62]],
  box: [
    [28, 18, 44, 18], [56, 18, 72, 18], // top (centre gap)
    [28, 52, 44, 52], [56, 52, 72, 52], // bottom
    [28, 18, 28, 29], [28, 41, 28, 52], // left
    [72, 18, 72, 29], [72, 41, 72, 52], // right
  ],
  dots: [
    [18, 22, 32, 22], [43, 22, 57, 22], [68, 22, 82, 22],
    [18, 48, 32, 48], [43, 48, 57, 48], [68, 48, 82, 48],
  ],
};

/** Inline SVG thumbnail of a map's wall layout. */
function wallThumb(style: WallStyle): string {
  const lines = WALL_THUMB_SEGS[style]
    .map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`)
    .join("");
  return (
    `<svg class="wall-thumb" viewBox="0 0 100 70" preserveAspectRatio="xMidYMid meet" aria-hidden="true">` +
    `<rect class="wt-border" x="3" y="3" width="94" height="64" rx="3" />` +
    `<g class="wt-walls">${lines}</g></svg>`
  );
}

/** Build the visual map (walls) picker, syncing selection to the hidden select. */
function renderWallPicker(): void {
  const sel = $("walls") as HTMLSelectElement;
  const picker = $("wall-picker");
  picker.innerHTML = WALL_STYLES.map(
    (s) =>
      `<button type="button" class="wall-opt${s === sel.value ? " selected" : ""}" ` +
      `data-wall="${s}" title="${WALL_LABEL[s]}">${wallThumb(s)}<span>${WALL_LABEL[s]}</span></button>`
  ).join("");
  picker.querySelectorAll<HTMLButtonElement>(".wall-opt").forEach((b) => {
    b.onclick = () => {
      sel.value = b.dataset.wall ?? "maze";
      renderWallPicker(); // refresh highlight
      sel.dispatchEvent(new Event("change", { bubbles: true })); // -> updateConfig
    };
  });
}
const SIZE_LABEL: Record<MapSize, string> = {
  small: "Small",
  normal: "Normal",
  large: "Large",
  random: "Random",
};

function configSummary(c: GameConfig): string {
  const bits = [modeLabel(c.mode), `${WALL_LABEL[c.wallStyle]} · ${SIZE_LABEL[c.mapSize]} map`];
  if (c.rounds > 1) bits.push(`best of ${c.rounds}`);
  if (c.hp > 1) bits.push(`${c.hp} HP`);
  if (c.tankSpeedPct !== 100) bits.push(`${c.tankSpeedPct}% speed`);
  if (c.mode === "lms") bits.push(c.lives > 0 ? `${c.lives} lives` : "1 life");
  else if (c.mode === "teams") bits.push(`${c.teamCount} teams · first to ${c.winScore} pts`);
  else bits.push(`first to ${c.winScore} pts`);
  if (c.powerups) bits.push("power-ups");
  return bits.join(" · ");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

window.addEventListener("resize", () => {
  if (inGame) fitCanvas();
});

net.connect();
requestAnimationFrame(frame);

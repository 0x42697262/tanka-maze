import "./style.css";
import {
  DEFAULT_GAME_CONFIG,
  type AdvancedConfig,
  type GameConfig,
  type GameMode,
  type LobbyDTO,
  type LobbySummaryDTO,
  type MapSize,
  type MazeDTO,
  type ScoreDTO,
  type ServerMessage,
  type WallStyle,
} from "../shared/protocol.js";
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
let arena: { w: number; h: number } | null = null;

const IDLE_INPUT = {
  forward: false,
  backward: false,
  turnLeft: false,
  turnRight: false,
  fire: false,
  aim: 0,
};

const STORAGE_KEY = "tanka-maze-name";
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
    // Sync the chosen tank color so the server matches what's shown.
    const savedColor = localStorage.getItem(COLOR_KEY);
    if (savedColor) (colorInput as HTMLInputElement).value = savedColor;
    net.send({ type: "setColor", color: (colorInput as HTMLInputElement).value });
    updateSwatchSelection();
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
      startGame(msg.maze);
      renderer.push(msg.snapshot, performance.now());
      break;
    case "snapshot":
      if (inGame) renderer.push(msg.snapshot, performance.now());
      break;
    case "gameOver":
      endGame(msg.scores, msg.winnerName);
      break;
    case "error":
      toast(msg.message);
      break;
  }
});

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
    const joinable = l.playerCount < l.maxPlayers;
    li.innerHTML = `
      <div class="lobby-info">
        <span class="name">${escapeHtml(l.name)}</span>
        <span class="sub">host ${escapeHtml(l.hostName)} · ${modeLabel(l.mode)}</span>
      </div>
      <span class="badge ${l.inGame ? "live" : ""}">
        ${l.inGame ? "● live" : ""} ${l.playerCount}/${l.maxPlayers}
      </span>`;
    const btn = document.createElement("button");
    btn.className = "ghost small";
    btn.textContent = !joinable ? "Full" : l.inGame ? "Join live" : "Join";
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

  // Host configures the game here; populate the controls once on entry.
  $("lobby-config").classList.toggle("hidden", !isHost);
  if (isHost && firstRender) applyConfigToControls(lobby.config, lobby.maxPlayers);
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
  li.innerHTML = `<span><span class="swatch" style="background:${p.color}"></span>${escapeHtml(p.name)}${tag}</span>`;
  if (p.id === hostId) {
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = "HOST";
    li.appendChild(host);
  }
  return li;
}

function leaveToMenu(): void {
  inGame = false;
  show("menu");
  net.send({ type: "listLobbies" });
}

// ---------------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------------
function startGame(maze: MazeDTO): void {
  renderer.setMaze(maze);
  const adv = currentLobby?.config.adv ?? DEFAULT_GAME_CONFIG.adv;
  renderer.setParams(adv.tankRadius, adv.bulletRadius);
  arena = { w: maze.width, h: maze.height };
  inGame = true;
  $("gh-lobby").textContent = currentLobby?.name ?? "";
  closePause();
  $("gameover").classList.add("hidden");
  $("respawn").classList.add("hidden");
  input?.dispose();
  input = new Input(canvas);
  show("game");
  fitCanvas();
}

/**
 * Scale the canvas's *display* size to fill the browser window while preserving
 * the arena's aspect ratio. The drawing buffer stays at native resolution, so
 * the game world is unchanged — only the on-screen size grows/shrinks. Input
 * mapping divides by the element's rendered size, so aiming stays accurate.
 */
function fitCanvas(): void {
  if (!arena) return;
  const hint = (document.querySelector("#game .hint") as HTMLElement)?.offsetHeight ?? 24;
  const header = (document.querySelector("#game .game-header") as HTMLElement)?.offsetHeight ?? 0;
  // Reserve room for the header, hint line, flex gaps, and page padding.
  const reservedV = header + hint + 72;
  // Reserve the leaderboard side column (200px + 14px gap) plus page padding.
  const availW = window.innerWidth - 48 - 214;
  const availH = window.innerHeight - reservedV;
  const scale = Math.max(0.1, Math.min(availW / arena.w, availH / arena.h));
  canvas.style.width = `${Math.floor(arena.w * scale)}px`;
  canvas.style.height = `${Math.floor(arena.h * scale)}px`;
}

function endGame(scores: ScoreDTO[], winnerName: string): void {
  inGame = false;
  closePause();
  $("respawn").classList.add("hidden");
  input?.dispose();
  input = null;

  $("winner").textContent = winnerName ? `🏆 ${winnerName} wins!` : "Game Over";
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
      const state = input.getState(me.x, me.y);
      // Throttle outgoing input to ~30 Hz.
      if (now - lastInputSent > 1000 / 30) {
        net.send({ type: "input", input: state });
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
  net.send({ type: "createLobby", name, maxPlayers: 4, config: DEFAULT_GAME_CONFIG });
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
    maxPlayers: num("max-players", 4),
    config: {
      mode: sel("mode") as GameMode,
      wallStyle: sel("walls") as WallStyle,
      mapSize: sel("map-size") as MapSize,
      tankSpeedPct: num("tank-speed", 100),
      hp: num("hp", 1),
      lives: Number(($("lives") as HTMLInputElement).value) || 0,
      respawnSeconds: num("cfg-respawn", 3),
      killPoints: num("kill-points", 60),
      deathPenaltyPct: Number(($("death-penalty") as HTMLInputElement).value) || 0,
      winScore: num("win-score", 300),
      teamCount: num("team-count", 2),
      friendlyFire: sel("friendly-fire") === "on",
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
  set("team-count", c.teamCount);
  set("tank-speed", c.tankSpeedPct);
  set("hp", c.hp);
  set("lives", c.lives);
  set("cfg-respawn", c.respawnSeconds);
  set("kill-points", c.killPoints);
  set("death-penalty", c.deathPenaltyPct);
  set("win-score", c.winScore);
  set("friendly-fire", c.friendlyFire ? "on" : "off");
  set("powerups", c.powerups ? "on" : "off");
  set("pwr-every", c.powerupEverySeconds);
  set("pwr-charges", c.powerupCharges);
  set("pwr-despawn", c.powerupDespawnSeconds);
  for (const k of ADV_KEYS) set(`adv-${k}`, c.adv[k]);
}

$("lobby-config").addEventListener("change", () => {
  if (!currentLobby || currentLobby.hostId !== playerId) return;
  const { maxPlayers, config } = gatherConfig();
  net.send({ type: "updateConfig", maxPlayers, config });
});

$("adv-toggle").onclick = () => $("adv-panel").classList.toggle("hidden");

$("leave").onclick = () => {
  net.send({ type: "leaveLobby" });
  currentLobby = null;
  show("menu");
};

// ---- Pause / in-game menu (Esc) ----
function openPause(): void {
  if (!inGame) return;
  paused = true;
  net.send({ type: "input", input: IDLE_INPUT }); // halt the tank while paused
  $("pause").classList.remove("hidden");
}
function closePause(): void {
  paused = false;
  $("pause").classList.add("hidden");
}
$("resume").onclick = closePause;
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
  }
});

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
};
const SIZE_LABEL: Record<MapSize, string> = {
  small: "Small",
  normal: "Normal",
  large: "Large",
  random: "Random",
};

function configSummary(c: GameConfig): string {
  const bits = [modeLabel(c.mode), `${WALL_LABEL[c.wallStyle]} · ${SIZE_LABEL[c.mapSize]} map`];
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

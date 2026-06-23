import "./style.css";
import type {
  LobbyDTO,
  LobbySummaryDTO,
  MazeDTO,
  ScoreDTO,
  ServerMessage,
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
    case "lobbyUpdate":
      currentLobby = msg.lobby;
      if (!inGame) {
        renderLobby(msg.lobby);
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
        <span class="sub">host ${escapeHtml(l.hostName)} · first to ${l.winScore} pts</span>
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

function renderLobby(lobby: LobbyDTO): void {
  $("lobby-title").textContent = lobby.name;
  $("lobby-meta").textContent =
    `${lobby.players.length}/${lobby.maxPlayers} players · first to ${lobby.winScore} pts`;

  const ul = $("lobby-players");
  ul.innerHTML = "";
  lobby.players.forEach((p) => {
    const li = document.createElement("li");
    if (!p.connected) li.className = "offline";
    const you = p.id === playerId ? " (you)" : "";
    const tag = p.connected ? you : " (reconnecting…)";
    // p.color is validated to a hex string server-side before it reaches here.
    li.innerHTML = `<span><span class="swatch" style="background:${p.color}"></span>${escapeHtml(p.name)}${tag}</span>`;
    if (p.isHost) {
      const host = document.createElement("span");
      host.className = "host";
      host.textContent = "HOST";
      li.appendChild(host);
    }
    ul.appendChild(li);
  });

  const isHost = lobby.hostId === playerId;
  $("start").classList.toggle("hidden", !isHost);
  $("waiting-host").classList.toggle("hidden", isHost);
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
  arena = { w: maze.width, h: maze.height };
  inGame = true;
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
  // Reserve room for the hint line, flex gap, and page padding.
  const reservedV = hint + 64;
  const availW = window.innerWidth - 48;
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

/** In-arena leaderboard, ranked by points; scales to many players. */
function renderLeaderboard(): void {
  const snap = renderer.latest();
  if (!snap) return;
  const ol = $("leaderboard-rows");
  ol.innerHTML = "";
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
  }
  requestAnimationFrame(frame);
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

$("create").onclick = () => {
  commitName();
  const name = ($("lobby-name") as HTMLInputElement).value.trim();
  const maxPlayers = Number(($("max-players") as HTMLInputElement).value) || 4;
  const winScore = Number(($("win-score") as HTMLInputElement).value) || 300;
  net.send({ type: "createLobby", name, maxPlayers, winScore });
};

$("start").onclick = () => net.send({ type: "startGame" });

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
    renderLobby(currentLobby);
    show("lobby");
  } else {
    leaveToMenu();
  }
};

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

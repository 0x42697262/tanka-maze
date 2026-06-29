// Client entry point: wires the network handlers, the render/input loop, and
// all the DOM event listeners. UI rendering + game logic live in focused
// modules (dom, state, labels, settings, lobby, hud, scoreboard, lifecycle).

import "./style.css";
import { DEFAULT_GAME_CONFIG, gameConfigWithDefaults, type LobbyDTO, type ServerMessage } from "../shared/protocol.js";
import { bytesEqual, decodeSnapshot, encodeInput } from "../shared/wire.js";
import { $, show, toast } from "./dom.js";
import { announceKill } from "./announce.js";
import { logKillEvent, renderAmmo, renderLeaderboard, updateRespawnOverlay } from "./hud.js";
import {
  buildSwatches,
  commitColor,
  commitName,
  refreshPings,
  renderLobby,
  renderLobbyList,
} from "./lobby.js";
import {
  closePause,
  endGame,
  fitCanvas,
  leaveToMenu,
  openPause,
  applyRendererConfig,
  showRoundOver,
  startGame,
} from "./lifecycle.js";
import { closeScoreboard, openScoreboard, renderScoreboard } from "./scoreboard.js";
import {
  applyModeVisibility,
  applyConfigToControls,
  applyMoveSetting,
  buildPowerupAdvInputs,
  gatherConfig,
} from "./settings.js";
import {
  colorInput,
  IS_TOUCH,
  latencies,
  MOVE_KEY,
  net,
  renderer,
  SESSION_KEY,
  state,
  STORAGE_KEY,
} from "./state.js";

if (IS_TOUCH) document.body.classList.add("touch");

function lobbyWithConfigDefaults(lobby: LobbyDTO): LobbyDTO {
  return { ...lobby, config: gameConfigWithDefaults(lobby.config) };
}

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
    if (state.inGame) toast("Connection lost — reconnecting…");
  }
});

net.onMessage((msg: ServerMessage) => {
  switch (msg.type) {
    case "welcome":
      state.playerId = msg.playerId;
      sessionStorage.setItem(SESSION_KEY, msg.sessionId);
      if (msg.resumed && state.inGame) {
        toast("Reconnected");
      } else if (!msg.resumed && state.inGame) {
        // Session couldn't be restored (e.g., server restarted) — back to menu.
        state.inGame = false;
        state.input?.dispose();
        state.input = null;
        state.currentLobby = null;
        leaveToMenu();
      }
      break;
    case "lobbyList":
      renderLobbyList(msg.lobbies);
      break;
    case "lobbyJoined":
      state.currentLobby = lobbyWithConfigDefaults(msg.lobby);
      if (!state.inGame) {
        renderLobby(state.currentLobby, true);
        show("lobby");
      }
      break;
    case "lobbyUpdate":
      state.currentLobby = lobbyWithConfigDefaults(msg.lobby);
      if (state.inGame) applyRendererConfig(state.currentLobby.config);
      if (!state.inGame) {
        renderLobby(state.currentLobby, false);
        show("lobby");
      }
      break;
    case "lobbyClosed":
      toast(msg.reason);
      state.currentLobby = null;
      leaveToMenu();
      break;
    case "gameStart":
      state.roster = new Map(msg.roster.map((r) => [r.index, r]));
      startGame(
        msg.maze,
        msg.spawnZones,
        msg.hazardZones,
        gameConfigWithDefaults(msg.config),
        msg.round,
        msg.totalRounds,
        msg.standing
      );
      // The first snapshot arrives next as a binary frame.
      break;
    case "roster":
      state.roster = new Map(msg.roster.map((r) => [r.index, r]));
      break;
    case "roundOver":
      showRoundOver(msg.round, msg.totalRounds, msg.winnerName, msg.standing, msg.nextInSeconds);
      break;
    case "gameOver":
      endGame(msg.scores, msg.winnerName, msg.standing, msg.totalRounds);
      break;
    case "latencies":
      for (const p of msg.pings) latencies.set(p.id, p.ms);
      if (state.scoreboardOpen) renderScoreboard();
      // Update only the ping badges in the lobby — re-rendering the whole lobby
      // here would wipe the team name/color inputs mid-edit.
      if (!state.inGame && state.currentLobby) refreshPings();
      break;
    case "kicked":
      closeScoreboard();
      closePause();
      state.input?.dispose();
      state.input = null;
      state.currentLobby = null;
      toast(msg.reason);
      leaveToMenu();
      break;
    case "error":
      toast(msg.message);
      break;
  }
});

// Snapshots arrive as binary frames; decode against the current roster. Effects
// (kill log, explosions, deaths) are applied later by the renderer on the
// interpolation clock, so they line up with the delayed on-screen world.
net.onBinary((buf) => {
  if (!state.inGame) return;
  renderer.push(decodeSnapshot(buf, state.roster), performance.now());
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
function frame(): void {
  const now = performance.now();
  if (state.inGame) {
    const snap = renderer.latest();
    const me = snap?.tanks.find((t) => t.id === state.playerId);
    if (state.input && me && !state.paused) {
      const bytes = encodeInput(state.input.getState(me.x, me.y));
      // Send only when the input actually changed (capped at ~30 Hz). The server
      // keeps applying the last input, so idle players send nothing.
      if (now - state.lastInputSent > 1000 / 30 && !bytesEqual(state.lastInputBytes, bytes)) {
        net.sendBinary(bytes);
        state.lastInputBytes = bytes;
        state.lastInputSent = now;
      }
    }
    renderer.render(state.playerId, now);
    // Kill log fires on the interpolation clock (in sync with the explosion).
    for (const e of renderer.takeEvents()) {
      logKillEvent(e);
      announceKill(e);
    }
    renderLeaderboard();
    // The death overlay follows the *displayed* (interpolated) world so it pops
    // with the on-screen explosion, not the instant the server signalled it.
    const shownMe = renderer.displayed()?.tanks.find((t) => t.id === state.playerId);
    updateRespawnOverlay(shownMe ?? me);
    renderAmmo(me);
    if (snap) {
      const alive = snap.tanks.filter((t) => t.alive).length;
      $("gh-count").textContent = `${snap.tanks.length} players · ${alive} alive`;
    }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Wire up controls
// ---------------------------------------------------------------------------
$("name").addEventListener("change", commitName);

buildSwatches();
colorInput.addEventListener("input", commitColor);

$("refresh").onclick = () => net.send({ type: "listLobbies" });

// Create a lobby with defaults; the host then tunes settings in the lobby room.
$("create").onclick = () => {
  commitName();
  const name = ($("lobby-name") as HTMLInputElement).value.trim();
  net.send({ type: "createLobby", name, maxPlayers: 8, config: {} });
};

$("start").onclick = () => net.send({ type: "startGame" });

// In-lobby game settings (host).
buildPowerupAdvInputs();
applyConfigToControls(DEFAULT_GAME_CONFIG, 8);
$("lobby-config").addEventListener("change", (e) => {
  if (!state.currentLobby || state.currentLobby.hostId !== state.playerId) return;
  // CTF: defaults scale with rival count — captures-per-round and conquest
  // points-to-win are one/100 per rival (1/100 for 2 teams, 3/300 for 4).
  const target = e.target as HTMLElement | null;
  const ctfTeams = () => Number(($("ctf-team-count") as HTMLSelectElement).value) || 2;
  const scoreMode = () => ($("ctf-score-mode") as HTMLSelectElement).value;
  const usesPoints = () => scoreMode() === "conquest" || scoreMode() === "carry";
  if (target?.id === "ctf-team-count") {
    const teams = ctfTeams();
    ($("flags-per-round") as HTMLInputElement).value = String(Math.max(1, teams - 1));
    if (usesPoints()) ($("ctf-points") as HTMLInputElement).value = String(100 * Math.max(1, teams - 1));
  }
  // Switching to a points-scoring mode seeds a sensible target (100 per rival team).
  // Carry defaults steal-on-touch off (kill to drop) and pins team-carry on (flags
  // only ride tanks, never returning to a base), since both ride the carrier.
  if (target?.id === "ctf-score-mode") {
    if (usesPoints()) ($("ctf-points") as HTMLInputElement).value = String(100 * Math.max(1, ctfTeams() - 1));
    if (scoreMode() === "carry") {
      ($("flag-steal") as HTMLSelectElement).value = "off";
      ($("flag-team-carry") as HTMLSelectElement).value = "on";
    }
  }
  applyModeVisibility();
  const { maxPlayers, config } = gatherConfig();
  net.send({ type: "updateConfig", maxPlayers, config });
});
$("adv-toggle").onclick = () => $("adv-panel").classList.toggle("hidden");

// Per-player settings (gear).
$("settings-gear").onclick = () => $("settings-panel").classList.toggle("hidden");
$("move-mode").addEventListener("change", () => {
  state.moveMode = ($("move-mode") as HTMLSelectElement).value === "eight" ? "eight" : "relative";
  localStorage.setItem(MOVE_KEY, state.moveMode);
  applyMoveSetting();
});
state.moveMode = localStorage.getItem(MOVE_KEY) === "eight" ? "eight" : "relative";
applyMoveSetting();

$("leave").onclick = () => {
  net.send({ type: "leaveLobby" });
  state.currentLobby = null;
  show("menu");
};

// Pause / scoreboard controls.
$("resume").onclick = closePause;
$("pause-restart").onclick = () => {
  net.send({ type: "restartGame" });
  closePause();
};
$("leave-game").onclick = () => {
  closePause();
  net.send({ type: "leaveLobby" });
  state.inGame = false;
  $("respawn").classList.add("hidden");
  state.input?.dispose();
  state.input = null;
  state.currentLobby = null;
  leaveToMenu();
};
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.inGame) {
    e.preventDefault();
    state.paused ? closePause() : openPause();
  } else if (e.key === "Tab" && state.inGame) {
    e.preventDefault();
    state.scoreboardOpen ? closeScoreboard() : openScoreboard();
  }
});

// Touch: one menu button (Esc). The scoreboard (Tab) opens from inside it.
$("touch-menu").onclick = () => (state.paused ? closePause() : openPause());
$("pause-config").onclick = () => {
  closePause();
  openScoreboard();
};
$("sb-close").onclick = closeScoreboard;

$("back-to-lobby").onclick = () => {
  $("gameover").classList.add("hidden");
  if (state.currentLobby) {
    renderLobby(state.currentLobby, true);
    show("lobby");
  } else {
    leaveToMenu();
  }
};

window.addEventListener("resize", () => {
  if (state.inGame) fitCanvas();
});

net.connect();
requestAnimationFrame(frame);

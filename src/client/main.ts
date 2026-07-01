// Client entry point: wires the network handlers, the render/input loop, and
// all the DOM event listeners. UI rendering + game logic live in focused
// modules (dom, state, labels, settings, lobby, hud, scoreboard, lifecycle).

import "./style.css";
import { DEFAULT_GAME_CONFIG, gameConfigWithDefaults, type LobbyDTO, type ServerMessage } from "../shared/protocol.js";
import { bytesEqual, decodeSnapshot, encodeInput } from "../shared/wire.js";
import { AssetLoader } from "./core/AssetLoader.js";
import { Engine, type Scene } from "./core/Engine.js";
import { $, show, toast } from "./dom.js";
import { announceKill } from "./announce.js";
import { logKillEvent, renderHud, renderLeaderboard, updateRespawnOverlay } from "./hud.js";
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
  buildPowerupTypeToggles,
  enhanceNumberInputs,
  gatherConfig,
} from "./settings.js";
import {
  canvas,
  colorInput,
  FPS_KEY,
  IS_TOUCH,
  latencies,
  MOVE_KEY,
  net,
  QUALITY_DPR,
  QUALITY_KEY,
  renderer,
  SESSION_KEY,
  state,
  STORAGE_KEY,
  BGM_KEY,
  BGM_VOL_KEY,
  SFX_VOL_KEY,
  RADAR_KEY,
  RETRO_KEY,
  BATTLECITY_KEY,
  BCTANK_KEY,
  MODERN_KEY,
  MODERN_STYLE_KEY,
  REALISTIC_KEY,
  REALISTIC_STYLE_KEY,
} from "./state.js";

if (IS_TOUCH) document.body.classList.add("touch");

// The render/update engine. Created in bootstrap(); referenced earlier by the
// display-settings + visibility handlers (safe via optional chaining until set).
let engine: Engine | undefined;

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
  renderer.push(decodeSnapshot(buf, state.roster, renderer.latest()), performance.now());
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
import { setSfxVolume, isVroomPlaying, playVroom, pauseVroom, updateVroom, playBgm, pauseBgm, setBgmVolume, isBgmPlaying } from "./audio.js";

let lastHudMs = 0;
function frame(now: number): void {
  let isMoving = false;
  let me: any = undefined;
  if (state.inGame) {
    const snap = renderer.latest();
    me = snap?.tanks.find((t) => t.id === state.playerId);

    if (state.input && me && !state.paused) {
      const inputState = state.input.getState(me.x, me.y);
      if (me.alive) {
        isMoving = inputState.forward || inputState.backward || inputState.turnLeft || inputState.turnRight || (inputState.eightDir && inputState.joystick);
      }
      const bytes = encodeInput(inputState);
      // Send only when the input actually changed (capped at ~30 Hz). The server
      // keeps applying the last input, so idle players send nothing.
      if (now - state.lastInputSent > 1000 / 30 && !bytesEqual(state.lastInputBytes, bytes)) {
        net.sendBinary(bytes);
        state.lastInputBytes = bytes;
        state.lastInputSent = now;
      }
    }
    renderer.render(state.playerId, now);
    // Kill log fires on the interpolation clock (in sync with the explosion) —
    // must drain every rendered frame so it stays aligned with the blast.
    for (const e of renderer.takeEvents()) {
      logKillEvent(e);
      announceKill(e);
    }
    // HUD/DOM writes are comparatively expensive and don't need per-frame
    // freshness; refresh them at ~10 Hz to cut CPU.
    if (now - lastHudMs >= 100) {
      lastHudMs = now;
      renderLeaderboard();
      // The death overlay follows the *displayed* (interpolated) world so it pops
      // with the on-screen explosion, not the instant the server signalled it.
      const shownMe = renderer.displayed()?.tanks.find((t) => t.id === state.playerId);
      updateRespawnOverlay(shownMe ?? me);
      renderHud(me);
      if (snap) {
        const alive = snap.tanks.filter((t) => t.alive).length;
        $("gh-count").textContent = `${snap.tanks.length} players · ${alive} alive`;
      }
    }
  }
  
  const shouldPlayEngine = state.inGame && me && me.alive && !state.paused;
  if (shouldPlayEngine) {
    if (!isVroomPlaying) {
      playVroom();
    }
    updateVroom(isMoving, me.boosted);
  } else if (isVroomPlaying) {
    pauseVroom();
  }
}

const scene: Scene = {
  update: () => {},
  render: (_alpha, now) => frame(now),
};

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
buildPowerupTypeToggles();
enhanceNumberInputs();
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
      ($("flag-team-carry") as HTMLInputElement).checked = true;
    }
  }
  applyModeVisibility();
  const { maxPlayers, config } = gatherConfig();
  net.send({ type: "updateConfig", maxPlayers, config });
});

// Per-player settings (gear).
$("settings-gear").onclick = () => $("settings-panel").classList.toggle("hidden");
$("move-mode").addEventListener("change", () => {
  state.moveMode = ($("move-mode") as HTMLSelectElement).value === "eight" ? "eight" : "relative";
  localStorage.setItem(MOVE_KEY, state.moveMode);
  applyMoveSetting();
});
state.moveMode = localStorage.getItem(MOVE_KEY) === "eight" ? "eight" : "relative";
applyMoveSetting();

// Display settings (frame-rate cap + render quality) — client-side, per player.
// Apply re-reads state and pushes it to the loop + renderer.
function applyDisplaySettings(): void {
  engine?.setRenderHz(state.fpsCap);
  renderer.setMaxDpr(QUALITY_DPR[state.quality]);
  ($("fps-cap") as HTMLSelectElement).value = String(state.fpsCap);
  ($("quality") as HTMLSelectElement).value = state.quality;

  const retroToggle = $("retro-toggle") as HTMLInputElement;
  retroToggle.checked = state.retroEnabled;
  if (state.retroEnabled) {
    document.body.classList.add("retro-mode");
    canvas.parentElement?.classList.add("retro-mode");
  } else {
    document.body.classList.remove("retro-mode");
    canvas.parentElement?.classList.remove("retro-mode");
  }

  const bcToggle = $("battlecity-toggle") as HTMLInputElement;
  bcToggle.checked = state.battleCityEnabled;
  if (state.battleCityEnabled) {
    document.body.classList.add("battlecity-mode");
    canvas.parentElement?.classList.add("battlecity-mode");
  } else {
    document.body.classList.remove("battlecity-mode");
    canvas.parentElement?.classList.remove("battlecity-mode");
  }

  const bcStyleRow = $("bc-style-row") as HTMLElement;
  const bcStyleSelect = $("bc-style-select") as HTMLSelectElement;
  bcStyleSelect.value = state.retroStyle;
  if (state.battleCityEnabled) {
    bcStyleRow.classList.remove("hidden");
  } else {
    bcStyleRow.classList.add("hidden");
  }

  const modernToggle = $("modern-toggle") as HTMLInputElement;
  modernToggle.checked = state.modernEnabled;
  if (state.modernEnabled) {
    document.body.classList.add("modern-mode");
    canvas.parentElement?.classList.add("modern-mode");
  } else {
    document.body.classList.remove("modern-mode");
    canvas.parentElement?.classList.remove("modern-mode");
  }

  const modernStyleRow = $("modern-style-row") as HTMLElement;
  const modernStyleSelect = $("modern-style-select") as HTMLSelectElement;
  modernStyleSelect.value = state.modernStyle;
  if (state.modernEnabled) {
    modernStyleRow.classList.remove("hidden");
  } else {
    modernStyleRow.classList.add("hidden");
  }

  const realisticToggle = $("realistic-toggle") as HTMLInputElement;
  realisticToggle.checked = state.realisticEnabled;
  if (state.realisticEnabled) {
    document.body.classList.add("realistic-mode");
    canvas.parentElement?.classList.add("realistic-mode");
  } else {
    document.body.classList.remove("realistic-mode");
    canvas.parentElement?.classList.remove("realistic-mode");
  }

  const realisticStyleRow = $("realistic-style-row") as HTMLElement;
  const realisticStyleSelect = $("realistic-style-select") as HTMLSelectElement;
  realisticStyleSelect.value = state.realisticStyle;
  if (state.realisticEnabled) {
    realisticStyleRow.classList.remove("hidden");
  } else {
    realisticStyleRow.classList.add("hidden");
  }
}
const savedFps = Number(localStorage.getItem(FPS_KEY));
state.fpsCap = savedFps === 30 || savedFps === 120 ? savedFps : 60;
const savedQuality = localStorage.getItem(QUALITY_KEY);
state.quality = savedQuality === "low" || savedQuality === "high" ? savedQuality : "medium";
$("fps-cap").addEventListener("change", () => {
  const v = Number(($("fps-cap") as HTMLSelectElement).value);
  state.fpsCap = v === 30 || v === 120 ? v : 60;
  localStorage.setItem(FPS_KEY, String(state.fpsCap));
  applyDisplaySettings();
});
$("quality").addEventListener("change", () => {
  const v = ($("quality") as HTMLSelectElement).value;
  state.quality = v === "low" || v === "high" ? v : "medium";
  localStorage.setItem(QUALITY_KEY, state.quality);
  applyDisplaySettings();
});
$("retro-toggle").addEventListener("change", () => {
  const v = ($("retro-toggle") as HTMLInputElement).checked;
  state.retroEnabled = v;
  localStorage.setItem(RETRO_KEY, String(v));
  applyDisplaySettings();
  if (state.arena) {
    renderer.resizeDrawingBuffer(state.arena.w, state.arena.h);
  }
});
$("battlecity-toggle").addEventListener("change", () => {
  const v = ($("battlecity-toggle") as HTMLInputElement).checked;
  state.battleCityEnabled = v;
  localStorage.setItem(BATTLECITY_KEY, String(v));
  if (v) {
    state.modernEnabled = false;
    localStorage.setItem(MODERN_KEY, "false");
    state.realisticEnabled = false;
    localStorage.setItem(REALISTIC_KEY, "false");
  }
  applyDisplaySettings();
});
$("bc-style-select").addEventListener("change", () => {
  const v = ($("bc-style-select") as HTMLSelectElement).value as any;
  state.retroStyle = v;
  localStorage.setItem(BCTANK_KEY, v);
  applyDisplaySettings();
});
$("modern-toggle").addEventListener("change", () => {
  const v = ($("modern-toggle") as HTMLInputElement).checked;
  state.modernEnabled = v;
  localStorage.setItem(MODERN_KEY, String(v));
  if (v) {
    state.battleCityEnabled = false;
    localStorage.setItem(BATTLECITY_KEY, "false");
    state.realisticEnabled = false;
    localStorage.setItem(REALISTIC_KEY, "false");
  }
  applyDisplaySettings();
});
$("modern-style-select").addEventListener("change", () => {
  const v = ($("modern-style-select") as HTMLSelectElement).value as any;
  state.modernStyle = v;
  localStorage.setItem(MODERN_STYLE_KEY, v);
  applyDisplaySettings();
});
$("realistic-toggle").addEventListener("change", () => {
  const v = ($("realistic-toggle") as HTMLInputElement).checked;
  state.realisticEnabled = v;
  localStorage.setItem(REALISTIC_KEY, String(v));
  if (v) {
    state.battleCityEnabled = false;
    localStorage.setItem(BATTLECITY_KEY, "false");
    state.modernEnabled = false;
    localStorage.setItem(MODERN_KEY, "false");
  }
  applyDisplaySettings();
});
$("realistic-style-select").addEventListener("change", () => {
  const v = ($("realistic-style-select") as HTMLSelectElement).value as any;
  state.realisticStyle = v;
  localStorage.setItem(REALISTIC_STYLE_KEY, v);
  applyDisplaySettings();
});
applyDisplaySettings();

// Background Music
const bgmToggle = $("bgm-toggle") as HTMLInputElement;

function applyBgmSetting() {
  bgmToggle.checked = state.bgmEnabled;
  if (state.bgmEnabled) {
    playBgm();
  } else {
    pauseBgm();
  }
}

bgmToggle.addEventListener("change", () => {
  state.bgmEnabled = bgmToggle.checked;
  localStorage.setItem(BGM_KEY, state.bgmEnabled ? "true" : "false");
  applyBgmSetting();
});

state.bgmEnabled = localStorage.getItem(BGM_KEY) !== "false";
applyBgmSetting();

// Personal radar toggle (the host's game setting can still force it off for all).
const radarToggle = $("radar-toggle") as HTMLInputElement;
radarToggle.checked = state.radarEnabled;
radarToggle.addEventListener("change", () => {
  state.radarEnabled = radarToggle.checked;
  localStorage.setItem(RADAR_KEY, state.radarEnabled ? "true" : "false");
});

const bgmVolumeInput = $("bgm-volume") as HTMLInputElement;
const sfxVolumeInput = $("sfx-volume") as HTMLInputElement;

bgmVolumeInput.value = state.bgmVolume.toString();
sfxVolumeInput.value = state.sfxVolume.toString();
setBgmVolume(state.bgmVolume);
setSfxVolume(state.sfxVolume);

bgmVolumeInput.addEventListener("input", () => {
  state.bgmVolume = parseFloat(bgmVolumeInput.value);
  setBgmVolume(state.bgmVolume);
  localStorage.setItem(BGM_VOL_KEY, state.bgmVolume.toString());
});

sfxVolumeInput.addEventListener("input", () => {
  state.sfxVolume = parseFloat(sfxVolumeInput.value);
  setSfxVolume(state.sfxVolume);
  localStorage.setItem(SFX_VOL_KEY, state.sfxVolume.toString());
});

// Controls Hint Bar
const controlsHint = $("controls-hint");
const hintToggle = $("hint-toggle");
if (localStorage.getItem("tanka-hint-collapsed") === "true") {
  controlsHint.classList.add("collapsed");
}
hintToggle.addEventListener("click", () => {
  controlsHint.classList.toggle("collapsed");
  localStorage.setItem("tanka-hint-collapsed", controlsHint.classList.contains("collapsed") ? "true" : "false");
});

// Browsers block autoplay until user interaction. Start BGM on first click if enabled.
document.body.addEventListener("pointerdown", () => {
  if (state.bgmEnabled && !isBgmPlaying) {
    playBgm();
  }
}, { once: true });

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

async function bootstrap(): Promise<void> {
  const assets = new AssetLoader();
  // The game is currently vector/canvas-driven. Keeping the preload boundary here
  // means future sprite/audio/json assets can be registered without changing the
  // engine startup path or breaking Vite's hashed production asset URLs.
  await assets.loadAll([]);

  engine = new Engine();
  engine.setScene(scene);
  applyDisplaySettings(); // push the saved FPS cap now that the engine exists
  net.connect();
  engine.start();
}

// Stop drawing entirely while the tab is hidden; resume on return. rAF already
// throttles hidden tabs, but stopping guarantees zero work, and start() resets
// the loop clock so there's no catch-up spike on resume.
document.addEventListener("visibilitychange", () => {
  if (!engine) return;
  if (document.hidden) engine.stop();
  else engine.start();
});

void bootstrap().catch((err) => {
  console.error(err);
  toast("Failed to start client.");
});

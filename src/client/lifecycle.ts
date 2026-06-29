// Match lifecycle: starting/ending a game, the between-rounds banner, the pause
// menu (incl. moving the host config editor in/out), canvas sizing, and the
// return-to-menu transition.

import {
  DEFAULT_GAME_CONFIG,
  gameConfigWithDefaults,
  type GameConfig,
  type HazardZoneDTO,
  type MazeDTO,
  type RoundStanding,
  type ScoreDTO,
  type SpawnZoneDTO,
} from "../shared/protocol.js";
import { encodeInput } from "../shared/wire.js";
import { $, escapeHtml, show } from "./dom.js";
import { resetAnnouncements } from "./announce.js";
import { clearKillLog, renderRoundBadge, renderSeriesBoard } from "./hud.js";
import { Input } from "./input.js";
import { roundsToWin, standingHtml } from "./labels.js";
import { closeScoreboard } from "./scoreboard.js";
import { applyConfigToControls, applyModeVisibility } from "./settings.js";
import { canvas, IDLE_INPUT, IS_TOUCH, net, renderer, state } from "./state.js";

export function startGame(
  maze: MazeDTO,
  spawnZones: SpawnZoneDTO[] = [],
  hazardZones: HazardZoneDTO[] = [],
  config: GameConfig = state.currentLobby?.config ?? DEFAULT_GAME_CONFIG,
  round = 1,
  totalRounds = 1,
  standing: RoundStanding[] = []
): void {
  renderer.setMaze(maze);
  renderer.setSpawnZones(spawnZones);
  renderer.setHazards(hazardZones);
  applyRendererConfig(config);
  state.arena = { w: maze.width, h: maze.height };
  state.inGame = true;
  if (state.roundCountdown) {
    clearInterval(state.roundCountdown);
    state.roundCountdown = null;
  }
  state.roundInfo = { round, total: totalRounds };
  state.roundStanding = standing;
  state.lastInputBytes = null; // force the first input of the new game to send
  // Full config + players live in the Tab scoreboard now; the header just names
  // the lobby and hints at Tab.
  $("gh-lobby").textContent = state.currentLobby ? state.currentLobby.name : "";
  renderRoundBadge();
  renderSeriesBoard();
  closePause();
  $("gameover").classList.add("hidden");
  $("roundover").classList.add("hidden");
  $("respawn").classList.add("hidden");
  state.input?.dispose();
  state.input = new Input(canvas);
  state.input.eightDir = state.moveMode === "eight";
  if (IS_TOUCH) {
    state.input.enableTouch($("stick-move"), $("touch-fire"));
    $("touch-controls").classList.remove("hidden");
  }
  clearKillLog();
  resetAnnouncements();
  show("game");
  fitCanvas();
}

/** Apply host-tunable rendering params that can change while a match is live. */
export function applyRendererConfig(cfg: GameConfig): void {
  cfg = gameConfigWithDefaults(cfg);
  const adv = cfg.adv;
  renderer.setParams(adv.tankRadius, adv.bulletRadius);
  renderer.setFog(cfg.fogOfWar, cfg.visionRadius, cfg.fogBaseVision, cfg.fogFlagVision);
  renderer.setDestructibleWalls(cfg.destructibleWalls, adv.wallHp);
  renderer.setScope({
    bulletSpeed: adv.bulletSpeed,
    bulletLifetime: adv.bulletLifetime,
    bulletBounces: adv.bulletBounces,
    sniperSpeedMult: adv.sniperSpeedMult,
    sniperWallPierce: adv.sniperWallPierce,
    trackingLifetime: adv.trackingLifetime,
    trackingBounces: adv.trackingBounces,
    laserRange: adv.laserRange,
    explosionRadius: adv.explosionRadius,
    multiCount: adv.multishotCount,
    multiSpread: adv.multishotSpread,
  });
}

/**
 * Scale the canvas's *display* size to fill the browser window while preserving
 * the arena's aspect ratio. The drawing buffer stays at native resolution, so
 * the game world is unchanged — only the on-screen size grows/shrinks. Input
 * mapping divides by the element's rendered size, so aiming stays accurate.
 */
export function fitCanvas(): void {
  if (!state.arena) return;
  // On compact/touch screens the header, sidebar and hint are hidden, so the
  // arena fills the viewport (controls overlay it). Otherwise reserve the chrome.
  const compact = window.innerWidth <= 760 || IS_TOUCH;
  const hintEl = document.querySelector("#game .hint") as HTMLElement;
  const hint = compact ? 0 : hintEl?.offsetHeight ?? 24;
  const header = (document.querySelector("#game .game-header") as HTMLElement)?.offsetHeight ?? 0;
  const reservedV = header + hint + (compact ? 8 : 72);
  const sidebar = compact ? 0 : 214; // leaderboard column (200 + gap)
  const pad = compact ? 6 : 48;
  const availW = window.innerWidth - pad - sidebar;
  const availH = window.innerHeight - reservedV;
  const scale = Math.max(0.1, Math.min(availW / state.arena.w, availH / state.arena.h));
  canvas.style.width = `${Math.floor(state.arena.w * scale)}px`;
  canvas.style.height = `${Math.floor(state.arena.h * scale)}px`;
}

/**
 * Between-rounds indication. The game is NOT paused — the arena keeps animating
 * with players locked — so this is a slim, non-blocking banner, not a modal. The
 * full tally lives in the persistent series scoreboard in the sidebar.
 */
export function showRoundOver(
  round: number,
  total: number,
  winnerName: string,
  standing: RoundStanding[],
  nextInSeconds: number
): void {
  state.roundInfo = { round, total };
  state.roundStanding = standing;
  renderRoundBadge();
  renderSeriesBoard();
  $("respawn").classList.add("hidden");
  $("ro-title").textContent = winnerName
    ? `🏆 ${winnerName} takes round ${round}`
    : `Round ${round} drawn`;
  const countEl = $("ro-count");
  let secs = Math.max(1, Math.round(nextInSeconds));
  countEl.textContent = String(secs);
  const cfg = state.currentLobby?.config;
  $("ro-sub").textContent = cfg
    ? `Round ${round + 1} · first to ${roundsToWin(cfg)} · next in `
    : `Round ${round + 1} in `;
  $("roundover").classList.remove("hidden");
  if (state.roundCountdown) clearInterval(state.roundCountdown);
  state.roundCountdown = setInterval(() => {
    secs -= 1;
    countEl.textContent = String(Math.max(0, secs));
    if (secs <= 0 && state.roundCountdown) {
      clearInterval(state.roundCountdown);
      state.roundCountdown = null;
    }
  }, 1000);
}

export function endGame(
  scores: ScoreDTO[],
  winnerName: string,
  standing: RoundStanding[] = [],
  totalRounds = 1
): void {
  state.inGame = false;
  closePause();
  closeScoreboard();
  $("touch-controls").classList.add("hidden");
  if (state.roundCountdown) {
    clearInterval(state.roundCountdown);
    state.roundCountdown = null;
  }
  $("respawn").classList.add("hidden");
  $("roundover").classList.add("hidden");
  state.input?.dispose();
  state.input = null;

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

export function leaveToMenu(): void {
  state.inGame = false;
  closeScoreboard();
  $("touch-controls").classList.add("hidden");
  if (state.roundCountdown) {
    clearInterval(state.roundCountdown);
    state.roundCountdown = null;
  }
  $("roundover").classList.add("hidden");
  $("gameover").classList.add("hidden");
  show("menu");
  net.send({ type: "listLobbies" });
}

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

export function openPause(): void {
  if (!state.inGame) return;
  state.paused = true;
  const idle = encodeInput(IDLE_INPUT); // halt the tank while paused
  net.sendBinary(idle);
  state.lastInputBytes = idle;
  const isHost = !!state.currentLobby && state.currentLobby.hostId === state.playerId;
  $("pause-host").classList.toggle("hidden", !isHost);
  // Wide "landscape" card only while the host is editing settings.
  $("pause").querySelector(".pause-card")?.classList.toggle("host-editing", isHost);
  if (isHost && state.currentLobby) {
    moveConfigToPause();
    applyConfigToControls(state.currentLobby.config, state.currentLobby.maxPlayers);
    applyModeVisibility();
  }
  $("pause").classList.remove("hidden");
}

export function closePause(): void {
  state.paused = false;
  $("pause").classList.add("hidden");
  $("pause").querySelector(".pause-card")?.classList.remove("host-editing");
  moveConfigHome(); // return the editor to the lobby (no-op if already there)
}

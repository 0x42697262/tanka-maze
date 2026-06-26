// Host game-settings editor (gather/apply config + the map & movement pickers).
// These functions only read/write DOM inputs + shared state; the wiring that
// reacts to changes lives in main.ts.

import {
  DEFAULT_GAME_CONFIG,
  POWERUP_DEFS,
  WALL_STYLES,
  type AdvancedConfig,
  type GameConfig,
  type GameMode,
  type MapSize,
  type WallStyle,
} from "../shared/protocol.js";
import { $ } from "./dom.js";
import { WALL_LABEL } from "./labels.js";
import { state } from "./state.js";

export const ADV_KEYS = Object.keys(DEFAULT_GAME_CONFIG.adv) as (keyof AdvancedConfig)[];

/**
 * Generate the per-power-up tuning inputs in the Advanced panel from the
 * registry, so a new power-up's config appears automatically (ids are
 * `adv-<key>`, matching ADV_KEYS / gatherAdvanced / applyConfigToControls).
 */
export function buildPowerupAdvInputs(): void {
  $("adv-powerups").innerHTML = POWERUP_DEFS.filter((d) => d.config.length > 0)
    .map((def) => {
      let rows = "";
      for (let i = 0; i < def.config.length; i += 2) {
        const pair = def.config.slice(i, i + 2);
        rows +=
          `<div class="row${pair.length === 2 ? " two" : ""}">` +
          pair
            .map(
              (fld) =>
                `<label for="adv-${fld.key}">${fld.label}</label>` +
                `<input id="adv-${fld.key}" type="number" min="${fld.min}" max="${fld.max}" step="${fld.step}" />`
            )
            .join("") +
          `</div>`;
      }
      return `<h4 class="adv-h">Power-ups · ${def.label}</h4>${rows}`;
    })
    .join("");
}

export function gatherAdvanced(): AdvancedConfig {
  const d = DEFAULT_GAME_CONFIG.adv;
  const out = {} as AdvancedConfig;
  for (const k of ADV_KEYS) {
    const v = Number(($(`adv-${k}`) as HTMLInputElement).value);
    out[k] = Number.isFinite(v) ? v : d[k];
  }
  return out;
}

export function gatherConfig(): { maxPlayers: number; config: GameConfig } {
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
      teamSpawnZones: sel("team-spawn-zones") === "on",
      maxFlags: num("max-flags", 3),
      flagTeamCarry: sel("flag-team-carry") === "on",
      flagStealOnContact: sel("flag-steal") === "on",
      adv: gatherAdvanced(),
      powerups: sel("powerups") === "on",
      powerupEverySeconds: num("pwr-every", 8),
      powerupDespawnSeconds: num("pwr-despawn", 12),
      powerupCharges: num("pwr-charges", 1),
    },
  };
}

export function applyConfigToControls(c: GameConfig, maxPlayers: number): void {
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
  set("team-spawn-zones", c.teamSpawnZones ? "on" : "off");
  set("max-flags", c.maxFlags);
  set("flag-team-carry", c.flagTeamCarry ? "on" : "off");
  set("flag-steal", c.flagStealOnContact ? "on" : "off");
  set("powerups", c.powerups ? "on" : "off");
  set("pwr-every", c.powerupEverySeconds);
  set("pwr-charges", c.powerupCharges);
  set("pwr-despawn", c.powerupDespawnSeconds);
  for (const k of ADV_KEYS) set(`adv-${k}`, c.adv[k]);
  renderWallPicker();
  applyModeVisibility();
}

/** Show only the settings relevant to the selected mode. */
export function applyModeVisibility(): void {
  const mode = ($("mode") as HTMLSelectElement).value;
  const cfg = $("lobby-config");
  const ctf = mode === "ctf";
  const toggle = (sel: string, hidden: boolean) =>
    cfg.querySelectorAll(sel).forEach((el) => el.classList.toggle("hidden", hidden));
  // Team-only controls (team count, team-kill, spawn-zones) — CTF locks these,
  // so they're hidden there too.
  toggle(".cfg-teams", mode !== "teams");
  toggle(".cfg-haswin", mode === "lms");
  // CTF-only (flags to win) vs the point-scoring/rounds controls it replaces.
  toggle(".cfg-ctf", !ctf);
  toggle(".cfg-nctf", ctf);
}

// ---- Map (walls) image picker ----
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
export function renderWallPicker(): void {
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

// ---- Per-player movement scheme picker ----
export function applyMoveSetting(): void {
  ($("move-mode") as HTMLSelectElement).value = state.moveMode;
  $("move-hint").textContent =
    state.moveMode === "eight"
      ? "Move any direction; the cannon aims separately."
      : "Drive forward/back and rotate; the cannon aims separately.";
  if (state.input) state.input.eightDir = state.moveMode === "eight";
  renderMovePicker();
}

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

/** Build the movement scheme picker (icons, syncing the hidden select). */
export function renderMovePicker(): void {
  const picker = $("move-picker");
  picker.innerHTML = MOVE_OPTS.map(
    (o) =>
      `<button type="button" class="move-opt${o.id === state.moveMode ? " selected" : ""}" data-move="${o.id}">` +
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

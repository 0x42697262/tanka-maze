// Pure presentation helpers: human labels, the config summary line, and the
// read-only config details markup (shared by the lobby panel + scoreboard).

import {
  POWERUP_DEFS,
  type GameConfig,
  type GameMode,
  type LobbyDTO,
  type MapSize,
  type RoundStanding,
  type WallStyle,
} from "../shared/protocol.js";
import { escapeHtml } from "./dom.js";

export function modeLabel(mode: GameMode): string {
  return mode === "lms" ? "Last Man Standing" : mode === "teams" ? "Team VS" : "Free-for-all";
}

export const WALL_LABEL: Record<WallStyle, string> = {
  maze: "Maze",
  sparse: "Sparse",
  open: "Open",
  cross: "Cross",
  lshape: "L-Shape",
  tunnels: "Tunnels",
  box: "Box",
  dots: "Dots",
};

export const SIZE_LABEL: Record<MapSize, string> = {
  small: "Small",
  normal: "Normal",
  large: "Large",
  random: "Random",
};

/** One-line summary shown in the lobby list + waiting room. */
export function configSummary(c: GameConfig): string {
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

/** Markup for a series tally (round wins per player/team), best first. */
export function standingHtml(standing: RoundStanding[]): string {
  return standing
    .map(
      (s) =>
        `<li><span class="swatch" style="background:${s.color}"></span>` +
        `<span class="lg-name">${escapeHtml(s.name)}</span>` +
        `<span class="pts">${"●".repeat(s.wins) || "—"} ${s.wins}</span></li>`
    )
    .join("");
}

/** Build the complete (read-only) config as organized HTML groups. */
export function buildConfigDetailsHtml(lobby: LobbyDTO): string {
  const c = lobby.config;
  const a = c.adv;
  const teams = c.mode === "teams";
  const hasWin = c.mode !== "lms";
  const onOff = (b: boolean) => (b ? "On" : "Off");
  type Row = [string, string | number];
  const groups: Array<{ title: string; rows: Row[] }> = [];

  const mode: Row[] = [["Mode", modeLabel(c.mode)]];
  if (teams) mode.push(["Teams", c.teamCount]);
  // Friendly fire governs self-damage in every mode (and teammate damage in Team VS).
  mode.push(["Friendly fire", onOff(c.friendlyFire)]);
  if (teams) {
    mode.push(["Team-kill penalty", `${c.teamKillPenalty} pts`]);
    mode.push(["Spawn zones", onOff(c.teamSpawnZones)]);
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
  // Power-up tuning — generated from the registry so every power-up's config
  // shows up here automatically (one group per power-up).
  for (const def of POWERUP_DEFS) {
    if (def.config.length === 0) continue;
    groups.push({
      title: `Adv · ${def.label}`,
      rows: def.config.map((field) => [field.label, a[field.key]] as Row),
    });
  }

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

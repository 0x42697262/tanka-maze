// Pure presentation helpers: human labels, the config summary line, and the
// read-only config details markup (shared by the lobby panel + scoreboard).

import {
  POWERUP_DEFS,
  gameConfigWithDefaults,
  type FogVisionMode,
  type GameConfig,
  type GameMode,
  type HazardType,
  type LobbyDTO,
  type MapSize,
  type RoundStanding,
  type WallStyle,
} from "../shared/protocol.js";
import { escapeHtml } from "./dom.js";

export function modeLabel(mode: GameMode): string {
  return mode === "lms"
    ? "Last Man Standing"
    : mode === "teams"
      ? "Team VS"
      : mode === "ctf"
        ? "Capture the Flag"
        : "Free-for-all";
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

const FOG_VISION_LABEL: Record<FogVisionMode, string> = {
  off: "Off",
  team: "Own team",
  all: "All teams",
};

const FLAG_VISION_LABEL: Record<FogVisionMode, string> = { ...FOG_VISION_LABEL, all: "All flags" };

const HAZARD_LABEL: Record<HazardType, string> = {
  lava: "Lava",
  mud: "Mud",
  ice: "Ice",
  heal: "Heal",
};

/** Round wins needed to take the match (CTF counts captured rounds via maxFlags). */
export function roundsToWin(c: GameConfig): number {
  const cfg = gameConfigWithDefaults(c);
  return cfg.mode === "ctf" ? cfg.maxFlags : cfg.rounds;
}

/** One-line summary shown in the lobby list + waiting room. */
export function configSummary(c: GameConfig): string {
  const cfg = gameConfigWithDefaults(c);
  const bits = [modeLabel(cfg.mode), `${WALL_LABEL[cfg.wallStyle]} · ${SIZE_LABEL[cfg.mapSize]} map`];
  if (cfg.mode !== "ctf" && cfg.rounds > 1) bits.push(`first to ${cfg.rounds} rounds`);
  if (cfg.hp > 1) bits.push(`${cfg.hp} HP`);
  if (cfg.tankSpeedPct !== 100) bits.push(`${cfg.tankSpeedPct}% speed`);
  if (cfg.mode === "ctf") bits.push(`${cfg.teamCount} teams · first to ${cfg.maxFlags} rounds`);
  else if (cfg.mode === "lms") bits.push(cfg.lives > 0 ? `${cfg.lives} lives` : "1 life");
  else if (cfg.mode === "teams") bits.push(`${cfg.teamCount} teams · first to ${cfg.winScore} pts`);
  else bits.push(`first to ${cfg.winScore} pts`);
  if (cfg.powerups) bits.push("power-ups");
  if (cfg.fogOfWar) bits.push("fog");
  if (cfg.hazardDensity > 0) bits.push("hazards");
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
  const c = gameConfigWithDefaults(lobby.config);
  const a = c.adv;
  const ctf = c.mode === "ctf";
  const teams = c.mode === "teams";
  const teamBased = teams || ctf;
  const hasWin = c.mode !== "lms" && !ctf;
  const onOff = (b: boolean) => (b ? "On" : "Off");
  type Row = [string, string | number];
  const groups: Array<{ title: string; rows: Row[] }> = [];

  const mode: Row[] = [["Mode", modeLabel(c.mode)]];
  if (teamBased) mode.push(["Teams", c.teamCount]);
  // Friendly fire governs self-damage in every mode (and teammate damage in Team VS).
  mode.push(["Friendly fire", onOff(c.friendlyFire)]);
  if (ctf) {
    const sm = c.ctfScoreMode;
    const points = sm === "conquest" || sm === "carry";
    mode.push(["Scoring", sm === "carry" ? "Carry" : sm === "conquest" ? "Conquest" : "Deliver"]);
    mode.push(["Rounds to win", c.maxFlags]);
    mode.push(points ? ["Points to win", c.winScore] : ["Captures/round", c.flagsPerRound]);
    mode.push(["Respawn +/death", `${c.ctfRespawnBonus}s`]);
  }
  if (teams) mode.push(["Team-kill penalty", `${c.teamKillPenalty} pts`]);
  if (teamBased) mode.push(["Spawn zones", ctf ? "On (bases)" : onOff(c.teamSpawnZones)]);
  groups.push({ title: "Mode", rows: mode });

  groups.push({
    title: "Map",
    rows: [
      ["Walls", WALL_LABEL[c.wallStyle]],
      ["Size", SIZE_LABEL[c.mapSize]],
      ["Destructible walls", onOff(c.destructibleWalls)],
      ["Radar", onOff(c.radar)],
    ],
  });

  const fog: Row[] = [["Fog of war", onOff(c.fogOfWar)]];
  if (c.fogOfWar) {
    fog.push(["Radius", `${c.visionRadius}px`]);
    if (teamBased) fog.push(["Base vision", FOG_VISION_LABEL[c.fogBaseVision]]);
    if (ctf) fog.push(["Flag vision", FLAG_VISION_LABEL[c.fogFlagVision]]);
    if (ctf) fog.push(["Hide carried flag", onOff(c.fogHideCarriedFlag)]);
  }
  groups.push({ title: "Fog of War", rows: fog });

  const hazards: Row[] = [["Hazards", c.hazardDensity > 0 ? `${c.hazardDensity} zones` : "Off"]];
  if (c.hazardDensity > 0) {
    hazards.push([
      "Types",
      c.hazardTypes.length > 0 ? c.hazardTypes.map((t) => HAZARD_LABEL[t]).join(", ") : "None",
    ]);
    if (c.hazardTypes.includes("lava")) hazards.push(["Lava DPS", c.hazardDamage]);
    if (c.hazardTypes.includes("mud")) hazards.push(["Mud slow", c.hazardSlowMult]);
    if (c.hazardTypes.includes("heal")) hazards.push(["Heal HP/s", c.hazardHealRate]);
  }
  groups.push({ title: "Hazards", rows: hazards });

  const match: Row[] = [];
  // CTF is a round series: each round is won by capturing flagsPerRound flags,
  // the match by winning maxFlags rounds.
  if (ctf) match.push(["Win", `first to ${c.maxFlags} rounds`]);
  else match.push(["Rounds", c.rounds > 1 ? `first to ${c.rounds} rounds` : "single round"]);
  match.push(["Max players", lobby.maxPlayers]);
  match.push(["Join after start", c.allowLateJoin ? "Allowed" : "Closed"]);
  match.push(["Tank speed", `${c.tankSpeedPct}%`]);
  match.push(["HP", c.hp]);
  match.push(["Lives", c.lives > 0 ? c.lives : "∞"]);
  match.push(["Respawn", `${c.respawnSeconds}s`]);
  groups.push({ title: "Match", rows: match });

  // No point-scoring in CTF — it's won by captures, so the scoring group is omitted.
  if (!ctf) {
    const scoring: Row[] = [
      ["Kill", `${c.killPoints} pts`],
      ["Death penalty", `${c.deathPenaltyPct}%`],
    ];
    if (hasWin) scoring.push(["Points to win", `${c.winScore}`]);
    groups.push({ title: "Scoring", rows: scoring });
  }

  const pwr: Row[] = [["Power-ups", onOff(c.powerups)]];
  if (c.powerups) {
    pwr.push(["Spawn every", `${c.powerupEverySeconds}s`]);
    pwr.push(["Despawn after", `${c.powerupDespawnSeconds}s`]);
    pwr.push(["Charges / pickup", c.powerupCharges]);
    pwr.push(["Stacking", onOff(c.powerupStacking)]);
    pwr.push(["Combine", onOff(c.combineWeapons)]);
    pwr.push(["Per spawn tick", c.powerupSpawnCount]);
    pwr.push([
      "Spawn types",
      c.powerupTypes.length > 0
        ? POWERUP_DEFS.filter((d) => c.powerupTypes.includes(d.id)).map((d) => d.label).join(", ")
        : "None",
    ]);
  }
  groups.push({ title: "Power-ups", rows: pwr });

  // Advanced engine tuning, grouped the same way as the host's editor.
  groups.push({
    title: "Adv · Tank",
    rows: [
      ["Size", a.tankRadius],
      ["Turn rate", a.tankTurnSpeed],
      ["Accel", a.tankAccel],
      ["Decel", a.tankDecel],
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
      ["Wall HP", a.wallHp],
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

// Wire protocol shared by client and server. All messages are JSON objects with
// a discriminant `type` field.

import {
  BULLET_LIFETIME,
  BULLET_MAX_BOUNCES,
  BULLET_RADIUS,
  BULLET_SPEED,
  CELL,
  EXPLOSION_RADIUS,
  FIRE_COOLDOWN,
  LASER_DELAY,
  LASER_RANGE,
  MAX_AMMO,
  MULTISHOT_COUNT,
  MULTISHOT_SPREAD_DEG,
  ROUNDS_DEFAULT,
  SCOPE_SECONDS,
  RELOAD_SECONDS,
  SHIELD_SECONDS,
  SNIPER_SPEED_MULT,
  SNIPER_WALL_PIERCE,
  SPEED_BOOST_MULT,
  SPEED_BOOST_SECONDS,
  TANK_ACCEL,
  TANK_DECEL,
  TANK_RADIUS,
  TANK_TURN_SPEED,
  TRACKING_BOUNCES,
  TRACKING_LIFETIME,
  TRACKING_TURN_RATE,
  VISION_RADIUS,
  WALL_THICKNESS,
} from "./constants.js";

/**
 * Advanced, normally-hardcoded tuning values, exposed so a host can override
 * every object's behaviour. Defaults mirror the engine constants.
 */
export interface AdvancedConfig {
  tankRadius: number;
  tankTurnSpeed: number; // rad/s
  tankAccel: number; // px/s² while a movement key is held (momentum wind-up)
  tankDecel: number; // px/s² while no movement input (momentum slow-down)
  fireCooldown: number; // s between shots
  maxAmmo: number;
  reloadSeconds: number;
  bulletSpeed: number; // px/s
  bulletRadius: number;
  bulletBounces: number;
  bulletLifetime: number; // s
  cellSize: number; // px per maze cell
  wallThickness: number; // px
  speedBoostMult: number;
  speedBoostSeconds: number;
  shieldSeconds: number;
  laserDelay: number; // s windup
  sniperSpeedMult: number;
  sniperWallPierce: number; // walls a sniper round punches through (0 = none)
  explosionRadius: number;
  scopeSeconds: number; // duration of the line-of-sight scope buff
  trackingTurnRate: number; // rad/s
  trackingLifetime: number; // s a tracking round lives (governs its range)
  trackingBounces: number; // wall bounces a tracking round survives
  multishotCount: number; // pellets released per multishot
  multishotSpread: number; // total fan angle (degrees) of a multishot
  laserRange: number; // px total beam length
}

export const DEFAULT_ADVANCED: AdvancedConfig = {
  tankRadius: TANK_RADIUS,
  tankTurnSpeed: TANK_TURN_SPEED,
  tankAccel: TANK_ACCEL,
  tankDecel: TANK_DECEL,
  fireCooldown: FIRE_COOLDOWN,
  maxAmmo: MAX_AMMO,
  reloadSeconds: RELOAD_SECONDS,
  bulletSpeed: BULLET_SPEED,
  bulletRadius: BULLET_RADIUS,
  bulletBounces: BULLET_MAX_BOUNCES,
  bulletLifetime: BULLET_LIFETIME,
  cellSize: CELL,
  wallThickness: WALL_THICKNESS,
  speedBoostMult: SPEED_BOOST_MULT,
  speedBoostSeconds: SPEED_BOOST_SECONDS,
  shieldSeconds: SHIELD_SECONDS,
  laserDelay: LASER_DELAY,
  sniperSpeedMult: SNIPER_SPEED_MULT,
  sniperWallPierce: SNIPER_WALL_PIERCE,
  explosionRadius: EXPLOSION_RADIUS,
  scopeSeconds: SCOPE_SECONDS,
  trackingTurnRate: TRACKING_TURN_RATE,
  trackingLifetime: TRACKING_LIFETIME,
  trackingBounces: TRACKING_BOUNCES,
  multishotCount: MULTISHOT_COUNT,
  multishotSpread: MULTISHOT_SPREAD_DEG,
  laserRange: LASER_RANGE,
};

// ---------------------------------------------------------------------------
// Game configuration (set by the host when creating a lobby)
// ---------------------------------------------------------------------------

export type GameMode = "ffa" | "lms" | "teams" | "ctf";
/** How CTF is scored. "deliver" = bring an enemy flag into your own base for a
 *  capture; "conquest" = hold enemy flags at your base for points/second over
 *  time; "carry" = a tank earns points/second for every enemy flag it personally
 *  carries (flags never sit at a base — they only drop when their carrier dies). */
export type CtfScoreMode = "deliver" | "conquest" | "carry";
export const CTF_SCORE_MODES: CtfScoreMode[] = ["deliver", "conquest", "carry"];
/** How a flag can change hands by touch (besides being dropped on a kill).
 *  "any" = anyone who touches the carrier takes it; "team" = only teammates
 *  (relay) — enemies must kill the carrier; "off" = only a kill drops it. */
export type FlagStealMode = "any" | "team" | "off";
export const FLAG_STEAL_MODES: FlagStealMode[] = ["any", "team", "off"];
export type WallStyle =
  | "maze"
  | "sparse"
  | "open"
  | "cross" // a plus-shaped wall through the center
  | "lshape" // an L-shaped wall at the center
  | "tunnels" // Nokia-snake: vertical bars with staggered gaps
  | "box" // Nokia-snake: an inner room with doorways
  | "dots"; // Nokia-snake: a regular field of short pillars
export const WALL_STYLES: WallStyle[] = [
  "maze",
  "sparse",
  "open",
  "cross",
  "lshape",
  "tunnels",
  "box",
  "dots",
];
export type MapSize = "small" | "normal" | "large" | "random";

/** Pickup types. "speed"/"shield" are buffs; the rest change your shot. */
export type PowerupType =
  | "speed"
  | "shield"
  | "sniper"
  | "explosive"
  | "laser"
  | "tracking"
  | "multishot"
  | "scope";
/** One tunable belonging to a power-up (an AdvancedConfig field + its UI range). */
export interface PowerupConfigField {
  key: keyof AdvancedConfig;
  label: string;
  min: number;
  max: number;
  step: number;
  int?: boolean; // clamp to a whole number
}

/**
 * The single source of truth for every power-up. Adding one here wires it into
 * the spawn pool, the binary protocol, the crate art, the HUD label, the lobby
 * settings editor, and the read-only config panels — all derived from this list
 * — so a new power-up can't silently go missing from the config or lobby info.
 *
 *  - `kind: "buff"` applies a timed/charged effect (see the server's buff
 *    commands); `kind: "weapon"` becomes the tank's active weapon.
 *  - `config` lists the AdvancedConfig fields this power-up owns; they're
 *    generated into the editor and shown in the details/scoreboard panels.
 */
export interface PowerupDef {
  id: PowerupType;
  kind: "buff" | "weapon";
  label: string; // HUD / config label
  emblem: string; // glyph drawn on the crate
  color: string; // emblem color
  config: PowerupConfigField[];
}

export const POWERUP_DEFS: PowerupDef[] = [
  {
    id: "speed",
    kind: "buff",
    label: "Speed",
    emblem: "»",
    color: "#e6c23f",
    config: [
      { key: "speedBoostMult", label: "Boost ×", min: 1, max: 4, step: 0.1 },
      { key: "speedBoostSeconds", label: "Boost s", min: 1, max: 60, step: 1 },
    ],
  },
  {
    id: "shield",
    kind: "buff",
    label: "Shield",
    emblem: "◈",
    color: "#4fd6a0",
    config: [{ key: "shieldSeconds", label: "Shield s", min: 1, max: 60, step: 1 }],
  },
  {
    id: "sniper",
    kind: "weapon",
    label: "Sniper",
    emblem: "•",
    color: "#2fb8d6",
    config: [
      { key: "sniperSpeedMult", label: "Sniper ×", min: 1, max: 30, step: 0.5 },
      { key: "sniperWallPierce", label: "Sniper walls", min: 0, max: 20, step: 1, int: true },
    ],
  },
  {
    id: "explosive",
    kind: "weapon",
    label: "Explosive",
    emblem: "✸",
    color: "#b23b2e",
    config: [{ key: "explosionRadius", label: "Blast radius", min: 10, max: 300, step: 2 }],
  },
  {
    id: "laser",
    kind: "weapon",
    label: "Laser",
    emblem: "≡",
    color: "#9b3fd6",
    config: [
      { key: "laserDelay", label: "Laser windup", min: 0, max: 5, step: 0.1 },
      { key: "laserRange", label: "Laser range", min: 100, max: 5000, step: 50 },
    ],
  },
  {
    id: "tracking",
    kind: "weapon",
    label: "Tracking",
    emblem: "◎",
    color: "#3f9b46",
    config: [
      { key: "trackingTurnRate", label: "Track turn", min: 0.5, max: 20, step: 0.5 },
      { key: "trackingLifetime", label: "Track life s", min: 0.5, max: 30, step: 0.5 },
      { key: "trackingBounces", label: "Track bounces", min: 0, max: 50, step: 1, int: true },
    ],
  },
  {
    id: "multishot",
    kind: "weapon",
    label: "Multishot",
    emblem: "⋔",
    color: "#d6822f",
    config: [
      { key: "multishotCount", label: "Pellets", min: 1, max: 24, step: 1, int: true },
      { key: "multishotSpread", label: "Spread °", min: 0, max: 180, step: 5 },
    ],
  },
  {
    id: "scope",
    kind: "buff",
    label: "Scope",
    emblem: "ⓘ",
    color: "#5b8def",
    config: [{ key: "scopeSeconds", label: "Scope s", min: 1, max: 120, step: 1 }],
  },
];

export const POWERUP_TYPES: PowerupType[] = POWERUP_DEFS.map((d) => d.id);
const POWERUP_BY_ID: Record<string, PowerupDef> = Object.fromEntries(
  POWERUP_DEFS.map((d) => [d.id, d])
);
/** Look up a power-up's definition. */
export function powerupDef(id: PowerupType): PowerupDef {
  return POWERUP_BY_ID[id];
}
/** Power-ups that become the active weapon (in registry order). */
export const WEAPON_POWERUPS: PowerupType[] = POWERUP_DEFS.filter((d) => d.kind === "weapon").map(
  (d) => d.id
);
/** What a fired round is. "normal" plus the offensive power-up kinds. */
export type BulletKind = "normal" | "sniper" | "explosive" | "laser" | "tracking";

export interface GameConfig {
  mode: GameMode;
  wallStyle: WallStyle;
  mapSize: MapSize;
  rounds: number; // round wins needed to take the match (first to N, any # of sides)
  allowLateJoin: boolean; // may players join after the match has started?
  tankSpeedPct: number; // 50..200 (% of base speed)
  hp: number; // 1..10 hits to destroy
  lives: number; // 0 = unlimited respawns; otherwise max respawns
  respawnSeconds: number; // 1..10
  killPoints: number; // points per kill
  deathPenaltyPct: number; // 0..90 (% of score lost on death)
  winScore: number; // points to win (FFA / total per team in Team VS)
  teamCount: number; // 2..4 (Team VS only)
  friendlyFire: boolean; // allow damaging yourself (any mode) and teammates (Team VS)
  teamKillPenalty: number; // points lost for killing a teammate (Team VS)
  teamSpawnZones: boolean; // Team VS: spawn each team in its own corner zone (off = randomized)
  maxFlags: number; // Capture the Flag: captures needed to win the match
  // CTF: your team carries a dropped flag back instead of it teleporting home on
  // touch; it only returns to base once a carrier brings it inside the base.
  flagTeamCarry: boolean;
  // CTF: how a flag changes hands by touch — any/team(mate)/off (kill to drop).
  flagStealMode: FlagStealMode;
  // CTF (deliver): captures a team must score to win a round (default scales with
  // team count: 1 for 2 teams, 3 for 4 teams — i.e. one per rival).
  flagsPerRound: number;
  // CTF: "deliver" = carry an enemy flag home to capture; "conquest" = hold enemy
  // flags at your base for points/sec; "carry" = a tank scores points/sec per
  // enemy flag it carries. First to winScore points takes the round (conquest/carry).
  ctfScoreMode: CtfScoreMode;
  // CTF: extra seconds added to the respawn delay on death (0 = none).
  ctfRespawnBonus: number;
  adv: AdvancedConfig; // advanced engine tuning
  // Fog of war: enemies only render within visionRadius of the local tank AND
  // when no wall blocks line of sight. The scope power-up doubles the radius
  // and grants x-ray through walls. Client-side only — the server still
  // broadcasts all tanks (a patched client could see through walls).
  fogOfWar: boolean;
  visionRadius: number; // px base sight radius (scope doubles this)
  // Power-ups
  powerups: boolean; // spawn pickups on the map
  powerupEverySeconds: number; // spawn cadence
  powerupDespawnSeconds: number; // uncollected pickups vanish after this
  powerupCharges: number; // uses granted per pickup (weapon types)
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  mode: "ffa",
  wallStyle: "maze",
  mapSize: "random",
  rounds: ROUNDS_DEFAULT,
  allowLateJoin: true,
  tankSpeedPct: 100,
  hp: 1,
  lives: 0,
  respawnSeconds: 3,
  killPoints: 60,
  deathPenaltyPct: 25,
  winScore: 300,
  teamCount: 2,
  friendlyFire: false,
  teamKillPenalty: 60,
  teamSpawnZones: true,
  maxFlags: 3,
  flagTeamCarry: true,
  flagStealMode: "any",
  flagsPerRound: 1,
  ctfScoreMode: "deliver",
  ctfRespawnBonus: 3,
  adv: DEFAULT_ADVANCED,
  fogOfWar: false,
  visionRadius: VISION_RADIUS,
  powerups: true,
  powerupEverySeconds: 8,
  powerupDespawnSeconds: 12,
  powerupCharges: 1,
};

// ---------------------------------------------------------------------------
// Data transfer objects
// ---------------------------------------------------------------------------

export interface LobbyPlayerDTO {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  connected: boolean;
  team: number;
}

export interface LobbySummaryDTO {
  id: string;
  name: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  mode: GameMode;
  inGame: boolean;
  allowLateJoin: boolean; // whether a started match still accepts players
}

export interface LobbyDTO {
  id: string;
  name: string;
  hostId: string;
  maxPlayers: number;
  inGame: boolean;
  config: GameConfig;
  players: LobbyPlayerDTO[];
  /** Per-team display name (index = team), Team VS. */
  teamNames: string[];
  /** Per-team color (index = team), Team VS. */
  teamColors: string[];
}

/** An axis-aligned wall segment in arena pixel coordinates. */
export interface WallDTO {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A team's designated spawn area (Team VS), as a pixel rectangle + tint. */
export interface SpawnZoneDTO {
  team: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string; // the team's color (rendered faintly)
}

export interface MazeDTO {
  /** Arena width in pixels. */
  width: number;
  /** Arena height in pixels. */
  height: number;
  /** Rendered/collision thickness of a wall line. */
  thickness: number;
  /** Wall line segments, including the outer border. */
  walls: WallDTO[];
}

/** Static per-player info, sent once via the roster (not in every snapshot). */
export interface RosterEntry {
  index: number; // compact id used in binary snapshots
  id: string;
  name: string;
  color: string;
  team: number;
  maxHp: number;
  maxAmmo: number;
}

export interface TankDTO {
  /** Compact per-game index (matches a RosterEntry). */
  index: number;
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  bodyAngle: number;
  turretAngle: number;
  alive: boolean;
  score: number;
  /** Seconds left until respawn, 0 when alive. */
  respawnIn: number;
  hp: number;
  maxHp: number;
  ammo: number;
  maxAmmo: number;
  /** Seconds left on a reload, 0 when not reloading. */
  reloadIn: number;
  /** Active power-up weapon, or null. */
  weapon: PowerupType | null;
  /** Charges left on the active weapon (0 for none / speed buff). */
  weaponCharges: number;
  /** Lives remaining (finite-lives modes, e.g. LMS); 0 when lives are infinite. */
  livesLeft: number;
  /** Whether a speed boost is currently active. */
  boosted: boolean;
  /** Whether a shield is currently active (invulnerable). */
  shielded: boolean;
  /** Whether a laser is winding up to fire. */
  charging: boolean;
  /** Whether the line-of-sight scope (aiming guide) is active. */
  scoped: boolean;
  /** Team index (Team VS); 0 in other modes. */
  team: number;
  /** Flags this tank has captured so far this match (Capture the Flag). */
  captures: number;
}

export interface BulletDTO {
  id: number;
  x: number;
  y: number;
  ownerId: string;
  kind: BulletKind;
  /** Travel direction (radians), filled client-side from interpolation. */
  dir?: number;
}

/** A kill/suicide/team-kill event for the in-game log. */
export interface KillEvent {
  /** 0 = kill, 1 = suicide/self-destruct, 2 = team-kill (friendly fire). */
  type: number;
  /** Roster index of the attacker (255 = none/environment). */
  killer: number;
  /** Roster index of the victim. */
  victim: number;
  /** Signed point delta (positive for the killer's gain, negative for a loss). */
  points: number;
  /** Kill-streak announcement tier (server-decided): 0 none, 1 first blood,
   *  2 double, 3 triple, 4 maniac, 5 savage, 6 betrayal, 7 traitor, 8 kinslayer. */
  streak: number;
  /** Succession multiplier for repeated savage/kinslayer (≥2; 0 = none). The
   *  first savage/kinslayer has no multiplier; each one after bumps it. */
  mult: number;
}

export interface PowerupDTO {
  id: number;
  type: PowerupType;
  x: number;
  y: number;
}

/** A laser beam fired this tick (for transient rendering). */
export interface BeamDTO {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// "held" = an enemy flag placed/stacked at a captor's base (conquest scoring).
export type FlagState = "home" | "carried" | "dropped" | "held";

/** A team's flag in Capture the Flag: its team (home base) + live position. */
export interface FlagDTO {
  team: number;
  x: number;
  y: number;
  state: FlagState;
  /** Carrier's tank index when carried, else 255 — lets the client stack a
   *  carrier's flags so multiple held flags are all visible. */
  carrier: number;
}

export interface SnapshotDTO {
  t: number; // server timestamp (ms)
  tanks: TankDTO[];
  bullets: BulletDTO[];
  powerups: PowerupDTO[];
  /** Capture-the-Flag flags (one per team); empty in other modes. */
  flags: FlagDTO[];
  /** Explosion centers that occurred this tick (transient). */
  blasts: { x: number; y: number }[];
  /** Laser beams fired this tick (transient). */
  beams: BeamDTO[];
  /** Kill/suicide/team-kill events this tick (transient; for the log). */
  events: KillEvent[];
}

export interface ScoreDTO {
  id: string;
  name: string;
  color: string;
  score: number;
}

/** A competitor's standing in the round series (a player in FFA/LMS, a team in
 *  Team VS). `key` is the player id or `t<team>`. */
export interface RoundStanding {
  key: string;
  name: string;
  color: string;
  wins: number;
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export interface InputState {
  /** Drive forward along the tank's heading (W / Up). */
  forward: boolean;
  /** Reverse (S / Down). */
  backward: boolean;
  /** Rotate the tank's heading counter-clockwise (A / Left). */
  turnLeft: boolean;
  /** Rotate the tank's heading clockwise (D / Right). */
  turnRight: boolean;
  fire: boolean;
  /** Turret aim angle in radians (world space), pointed at the cursor. */
  aim: number;
  /** Per-player control scheme: true = 8-direction world movement (WASD =
   *  up/left/down/right), false = tank-relative (A/D rotate, W/S drive). */
  eightDir: boolean;
  /** Mobile joystick: move (and face) the full 360° toward `aim` while
   *  `forward` is held; the turret/heading both follow `aim`. Overrides the
   *  other movement schemes when set. */
  joystick: boolean;
}

export type ClientMessage =
  // First message after connecting; an existing sessionId resumes that session.
  | { type: "identify"; sessionId?: string }
  | { type: "setName"; name: string }
  | { type: "setColor"; color: string }
  | { type: "setTeam"; team: number }
  | { type: "setTeamName"; team: number; name: string }
  | { type: "setTeamColor"; team: number; color: string }
  | { type: "listLobbies" }
  | { type: "createLobby"; name: string; maxPlayers: number; config: GameConfig }
  | { type: "updateConfig"; maxPlayers: number; config: GameConfig }
  | { type: "joinLobby"; lobbyId: string }
  | { type: "leaveLobby" }
  | { type: "startGame" }
  // Host-only, mid-match: restart the match with the current config, or remove a player.
  | { type: "restartGame" }
  | { type: "kickPlayer"; targetId: string }
  | { type: "input"; input: InputState };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  // `sessionId` is the secret reconnect token; `resumed` is true when an
  // existing session (and its in-game progress) was restored.
  | { type: "welcome"; playerId: string; sessionId: string; resumed: boolean }
  | { type: "lobbyList"; lobbies: LobbySummaryDTO[] }
  | { type: "lobbyJoined"; lobby: LobbyDTO }
  | { type: "lobbyUpdate"; lobby: LobbyDTO }
  | { type: "lobbyClosed"; reason: string }
  // Snapshots are sent as binary frames (see shared/wire.ts), not JSON.
  // gameStart carries the maze + roster; the first snapshot follows as binary.
  | {
      type: "gameStart";
      maze: MazeDTO;
      spawnZones: SpawnZoneDTO[];
      roster: RosterEntry[];
      round: number;
      totalRounds: number;
      standing: RoundStanding[];
    }
  | { type: "roster"; roster: RosterEntry[] }
  // A round ended but the match continues; the next round starts after the break.
  | {
      type: "roundOver";
      round: number;
      totalRounds: number;
      winnerName: string;
      standing: RoundStanding[];
      nextInSeconds: number;
    }
  | {
      type: "gameOver";
      scores: ScoreDTO[];
      winnerName: string;
      round: number;
      totalRounds: number;
      standing: RoundStanding[];
    }
  // Periodic round-trip latency per player (id -> ms), for the scoreboard.
  | { type: "latencies"; pings: Array<{ id: string; ms: number }> }
  // This client was removed from the lobby by the host.
  | { type: "kicked"; reason: string }
  | { type: "error"; message: string };

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(data: string): T {
  return JSON.parse(data) as T;
}

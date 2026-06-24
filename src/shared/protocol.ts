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
  RELOAD_SECONDS,
  SHIELD_SECONDS,
  SNIPER_SPEED_MULT,
  SNIPER_WALL_PIERCE,
  SPEED_BOOST_MULT,
  SPEED_BOOST_SECONDS,
  TANK_RADIUS,
  TANK_TURN_SPEED,
  TRACKING_TURN_RATE,
  WALL_THICKNESS,
} from "./constants.js";

/**
 * Advanced, normally-hardcoded tuning values, exposed so a host can override
 * every object's behaviour. Defaults mirror the engine constants.
 */
export interface AdvancedConfig {
  tankRadius: number;
  tankTurnSpeed: number; // rad/s
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
  trackingTurnRate: number; // rad/s
  laserRange: number; // px total beam length
}

export const DEFAULT_ADVANCED: AdvancedConfig = {
  tankRadius: TANK_RADIUS,
  tankTurnSpeed: TANK_TURN_SPEED,
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
  trackingTurnRate: TRACKING_TURN_RATE,
  laserRange: LASER_RANGE,
};

// ---------------------------------------------------------------------------
// Game configuration (set by the host when creating a lobby)
// ---------------------------------------------------------------------------

export type GameMode = "ffa" | "lms" | "teams";
export type WallStyle = "maze" | "sparse" | "open";
export type MapSize = "small" | "normal" | "large" | "random";

/** Pickup types. "speed"/"shield" are buffs; the rest change your shot. */
export type PowerupType = "speed" | "shield" | "sniper" | "explosive" | "laser" | "tracking";
export const POWERUP_TYPES: PowerupType[] = [
  "speed",
  "shield",
  "sniper",
  "explosive",
  "laser",
  "tracking",
];
/** What a fired round is. "normal" plus the offensive power-up kinds. */
export type BulletKind = "normal" | "sniper" | "explosive" | "laser" | "tracking";

export interface GameConfig {
  mode: GameMode;
  wallStyle: WallStyle;
  mapSize: MapSize;
  tankSpeedPct: number; // 50..200 (% of base speed)
  hp: number; // 1..10 hits to destroy
  lives: number; // 0 = unlimited respawns; otherwise max respawns
  respawnSeconds: number; // 1..10
  killPoints: number; // points per kill
  deathPenaltyPct: number; // 0..90 (% of score lost on death)
  winScore: number; // points to win (FFA / total per team in Team VS)
  teamCount: number; // 2..4 (Team VS only)
  friendlyFire: boolean; // Team VS: allow damaging teammates
  teamKillPenalty: number; // points lost for killing a teammate (Team VS)
  adv: AdvancedConfig; // advanced engine tuning
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
  tankSpeedPct: 100,
  hp: 1,
  lives: 0,
  respawnSeconds: 3,
  killPoints: 60,
  deathPenaltyPct: 25,
  winScore: 300,
  teamCount: 2,
  friendlyFire: true,
  teamKillPenalty: 60,
  adv: DEFAULT_ADVANCED,
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
  /** Whether a speed boost is currently active. */
  boosted: boolean;
  /** Whether a shield is currently active (invulnerable). */
  shielded: boolean;
  /** Whether a laser is winding up to fire. */
  charging: boolean;
  /** Team index (Team VS); 0 in other modes. */
  team: number;
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

export interface SnapshotDTO {
  t: number; // server timestamp (ms)
  tanks: TankDTO[];
  bullets: BulletDTO[];
  powerups: PowerupDTO[];
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
  | { type: "gameStart"; maze: MazeDTO; roster: RosterEntry[] }
  | { type: "roster"; roster: RosterEntry[] }
  | { type: "gameOver"; scores: ScoreDTO[]; winnerName: string }
  | { type: "error"; message: string };

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(data: string): T {
  return JSON.parse(data) as T;
}

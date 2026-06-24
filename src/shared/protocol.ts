// Wire protocol shared by client and server. All messages are JSON objects with
// a discriminant `type` field.

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
  deathPenaltyPct: 33,
  winScore: 300,
  teamCount: 2,
  powerups: false,
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

export interface TankDTO {
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
}

export type ClientMessage =
  // First message after connecting; an existing sessionId resumes that session.
  | { type: "identify"; sessionId?: string }
  | { type: "setName"; name: string }
  | { type: "setColor"; color: string }
  | { type: "setTeam"; team: number }
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
  | { type: "gameStart"; maze: MazeDTO; snapshot: SnapshotDTO }
  | { type: "snapshot"; snapshot: SnapshotDTO }
  | { type: "gameOver"; scores: ScoreDTO[]; winnerName: string }
  | { type: "error"; message: string };

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(data: string): T {
  return JSON.parse(data) as T;
}

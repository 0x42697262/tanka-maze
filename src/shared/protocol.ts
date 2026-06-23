// Wire protocol shared by client and server. All messages are JSON objects with
// a discriminant `type` field.

// ---------------------------------------------------------------------------
// Data transfer objects
// ---------------------------------------------------------------------------

export interface LobbyPlayerDTO {
  id: string;
  name: string;
  color: string;
  isHost: boolean;
  connected: boolean;
}

export interface LobbySummaryDTO {
  id: string;
  name: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  winScore: number;
  inGame: boolean;
}

export interface LobbyDTO {
  id: string;
  name: string;
  hostId: string;
  maxPlayers: number;
  winScore: number;
  inGame: boolean;
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
}

export interface BulletDTO {
  id: number;
  x: number;
  y: number;
  ownerId: string;
}

export interface SnapshotDTO {
  t: number; // server timestamp (ms)
  tanks: TankDTO[];
  bullets: BulletDTO[];
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
  | { type: "listLobbies" }
  | { type: "createLobby"; name: string; maxPlayers: number; winScore: number }
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

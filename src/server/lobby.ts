import type { WebSocket } from "ws";
import {
  DEFAULT_MAX_PLAYERS,
  DEFAULT_WIN_SCORE,
  MAX_WIN_SCORE,
  MIN_WIN_SCORE,
  TICK_MS,
} from "../shared/constants.js";
import {
  encode,
  type InputState,
  type LobbyDTO,
  type LobbySummaryDTO,
  type ServerMessage,
} from "../shared/protocol.js";
import { Game } from "./game.js";
import { Maze, randomMazeDimensions } from "./maze.js";

export interface Client {
  id: string; // public player id (used as tank id)
  sessionId: string; // secret reconnect token
  ws: WebSocket;
  name: string;
  color: string;
  lobbyId: string | null;
  connected: boolean;
  removalTimer: ReturnType<typeof setTimeout> | null;
}

const IDLE_INPUT: InputState = {
  forward: false,
  backward: false,
  turnLeft: false,
  turnRight: false,
  fire: false,
  aim: 0,
};

/**
 * A single room. Holds its members, an optional running game, and the fixed
 * timestep loop that drives + broadcasts that game.
 */
export class Lobby {
  readonly id: string;
  name: string;
  hostId: string;
  maxPlayers: number;
  winScore: number;
  members: Client[] = [];

  private game: Game | null = null;
  private maze: Maze | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private lastStep = 0;
  private onChange: () => void;

  constructor(
    id: string,
    name: string,
    host: Client,
    maxPlayers: number,
    winScore: number,
    onChange: () => void
  ) {
    this.id = id;
    this.name = name;
    this.hostId = host.id;
    this.maxPlayers = clamp(maxPlayers, 2, 8) || DEFAULT_MAX_PLAYERS;
    this.winScore = clamp(winScore, MIN_WIN_SCORE, MAX_WIN_SCORE) || DEFAULT_WIN_SCORE;
    this.onChange = onChange;
  }

  get inGame(): boolean {
    return this.game !== null;
  }

  get isEmpty(): boolean {
    return this.members.length === 0;
  }

  isFull(): boolean {
    return this.members.length >= this.maxPlayers;
  }

  add(client: Client): void {
    this.members.push(client);
    client.lobbyId = this.id;
  }

  /** Remove a member; returns true if the lobby should be destroyed. */
  remove(clientId: string): boolean {
    const idx = this.members.findIndex((m) => m.id === clientId);
    if (idx === -1) return this.isEmpty;
    this.members.splice(idx, 1);

    if (this.game) {
      this.game.removePlayer(clientId);
    }

    if (this.isEmpty) {
      this.stopGame();
      return true;
    }

    if (this.hostId === clientId) {
      this.hostId = this.members[0].id;
    }
    return false;
  }

  startGame(requesterId: string): string | null {
    if (this.inGame) return "Game already in progress.";
    if (requesterId !== this.hostId) return "Only the host can start the game.";
    if (this.members.length < 1) return "Need at least one player.";

    const { cols, rows } = randomMazeDimensions();
    this.maze = new Maze(cols, rows);
    this.game = new Game(
      this.maze,
      this.members.map((m) => ({ id: m.id, name: m.name, color: m.color })),
      this.winScore
    );

    this.lastStep = Date.now();
    const snapshot = this.game.snapshot(this.lastStep);
    this.broadcast({ type: "gameStart", maze: this.maze.toDTO(), snapshot });
    this.onChange(); // lobby list now shows inGame

    this.loop = setInterval(() => this.tick(), TICK_MS);
    return null;
  }

  /**
   * Drop a client into the game already in progress: spawn their tank and send
   * them the current maze + snapshot so their client switches to the arena.
   */
  spawnLateJoiner(client: Client): void {
    if (!this.game || !this.maze) return;
    this.game.addPlayer({ id: client.id, name: client.name, color: client.color });
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(
        encode({
          type: "gameStart",
          maze: this.maze.toDTO(),
          snapshot: this.game.snapshot(Date.now()),
        })
      );
    }
  }

  setInput(clientId: string, input: InputState): void {
    this.game?.setInput(clientId, input);
  }

  /**
   * A member's socket dropped. Keep their slot (and in-game tank/score), but
   * halt the tank so it doesn't drift on stale input, and hand off host duties
   * to a still-connected member so the lobby isn't stuck.
   */
  markDisconnected(clientId: string): void {
    this.game?.setInput(clientId, IDLE_INPUT);
    this.game?.setConnected(clientId, false);
    if (this.hostId === clientId) {
      const next = this.members.find((m) => m.connected && m.id !== clientId);
      if (next) this.hostId = next.id;
    }
    this.broadcast({ type: "lobbyUpdate", lobby: this.toDTO() });
  }

  /** A member reconnected: bring their tank back (respawns it if it died away). */
  markReconnected(clientId: string): void {
    this.game?.setConnected(clientId, true);
  }

  /** Re-send the current lobby (or live game) to a member who just reconnected. */
  sendResume(client: Client): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    if (this.game && this.maze) {
      client.ws.send(
        encode({
          type: "gameStart",
          maze: this.maze.toDTO(),
          snapshot: this.game.snapshot(Date.now()),
        })
      );
    } else {
      client.ws.send(encode({ type: "lobbyJoined", lobby: this.toDTO() }));
    }
  }

  private tick(): void {
    if (!this.game) return;
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastStep) / 1000);
    this.lastStep = now;

    this.game.step(dt);

    if (this.game.isFinished) {
      this.broadcast({
        type: "gameOver",
        scores: this.game.scores(),
        winnerName: this.game.getWinnerName(),
      });
      this.stopGame();
      this.broadcast({ type: "lobbyUpdate", lobby: this.toDTO() });
      this.onChange();
      return;
    }

    this.broadcast({ type: "snapshot", snapshot: this.game.snapshot(now) });
  }

  private stopGame(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.game = null;
    this.maze = null;
  }

  broadcast(msg: ServerMessage): void {
    const data = encode(msg);
    for (const m of this.members) {
      if (m.ws.readyState === m.ws.OPEN) m.ws.send(data);
    }
  }

  toDTO(): LobbyDTO {
    return {
      id: this.id,
      name: this.name,
      hostId: this.hostId,
      maxPlayers: this.maxPlayers,
      winScore: this.winScore,
      inGame: this.inGame,
      players: this.members.map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        isHost: m.id === this.hostId,
        connected: m.connected,
      })),
    };
  }

  toSummary(): LobbySummaryDTO {
    const host = this.members.find((m) => m.id === this.hostId);
    return {
      id: this.id,
      name: this.name,
      hostName: host?.name ?? "?",
      playerCount: this.members.length,
      maxPlayers: this.maxPlayers,
      winScore: this.winScore,
      inGame: this.inGame,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return NaN;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

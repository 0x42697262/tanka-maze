import type { WebSocket } from "ws";
import {
  DEFAULT_MAX_PLAYERS,
  ROUND_INTERMISSION_SECONDS,
  SNAPSHOT_EVERY_TICKS,
  TANK_COLORS,
  TEAM_COLORS,
  TICK_MS,
} from "../shared/constants.js";
import {
  encode,
  type GameConfig,
  type InputState,
  type LobbyDTO,
  type LobbySummaryDTO,
  type ServerMessage,
} from "../shared/protocol.js";
import { bytesEqual, encodeSnapshot } from "../shared/wire.js";
import { Game } from "./game.js";
import { Maze, mazeDimensions } from "./maze.js";

export interface Client {
  id: string; // public player id (used as tank id)
  sessionId: string; // secret reconnect token
  ws: WebSocket;
  name: string;
  color: string;
  lobbyId: string | null;
  connected: boolean;
  removalTimer: ReturnType<typeof setTimeout> | null;
  team: number;
  /** Last measured round-trip latency in ms (via WebSocket ping/pong). */
  latency: number;
  /** Timestamp (ms) the outstanding ping was sent, or 0 if none pending. */
  pingAt: number;
}

const IDLE_INPUT: InputState = {
  forward: false,
  backward: false,
  turnLeft: false,
  turnRight: false,
  fire: false,
  aim: 0,
  eightDir: false,
  joystick: false,
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
  config: GameConfig;
  members: Client[] = [];
  teamNames: string[] = [];
  teamColors: string[] = [];

  private game: Game | null = null;
  private maze: Maze | null = null;
  private lastSnapBytes: Uint8Array | null = null;
  private tickCount = 0;
  private loop: ReturnType<typeof setInterval> | null = null;
  private lastStep = 0;
  private roundBreak: ReturnType<typeof setTimeout> | null = null;
  private onChange: () => void;

  constructor(
    id: string,
    name: string,
    host: Client,
    maxPlayers: number,
    config: GameConfig,
    onChange: () => void
  ) {
    this.id = id;
    this.name = name;
    this.hostId = host.id;
    this.maxPlayers = clamp(maxPlayers, 2, 32) || DEFAULT_MAX_PLAYERS;
    this.config = config;
    this.onChange = onChange;
    this.ensureTeams();
  }

  /** Size the team name/color arrays to teamCount, filling sensible defaults. */
  private ensureTeams(): void {
    const n = this.config.teamCount;
    for (let i = 0; i < n; i++) {
      if (!this.teamNames[i]) this.teamNames[i] = `Team ${i + 1}`;
      if (!this.teamColors[i]) this.teamColors[i] = TEAM_COLORS[i % TEAM_COLORS.length];
    }
    this.teamNames.length = n;
    this.teamColors.length = n;
  }

  /** A member's in-game color: their team's color in Team VS, else their own. */
  private colorFor(client: Client): string {
    return this.config.mode === "teams" ? this.teamColors[client.team] ?? client.color : client.color;
  }

  /** True if `clientId` is the first member (captain) of `team`. */
  private isTeamCaptain(clientId: string, team: number): boolean {
    const first = this.members.find((m) => m.team === team);
    return !!first && first.id === clientId;
  }

  /** Captain renames their team. `name` is pre-sanitized by the caller. */
  setTeamName(requesterId: string, team: number, name: string): void {
    if (this.inGame || team < 0 || team >= this.config.teamCount) return;
    if (!this.isTeamCaptain(requesterId, team) || !name) return;
    this.teamNames[team] = name;
    this.broadcast({ type: "lobbyUpdate", lobby: this.toDTO() });
  }

  /** Captain recolors their team. `color` is pre-validated by the caller. */
  setTeamColor(requesterId: string, team: number, color: string): void {
    if (this.inGame || team < 0 || team >= this.config.teamCount) return;
    if (!this.isTeamCaptain(requesterId, team)) return;
    this.teamColors[team] = color;
    this.broadcast({ type: "lobbyUpdate", lobby: this.toDTO() });
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
    client.team = this.balancedTeam();
    client.color = this.pickUnusedColor();
    this.members.push(client);
    client.lobbyId = this.id;
  }

  /** First palette color not already worn by a member (falls back if all taken). */
  private pickUnusedColor(): string {
    const taken = new Set(this.members.map((m) => m.color.toLowerCase()));
    return TANK_COLORS.find((c) => !taken.has(c.toLowerCase())) ?? TANK_COLORS[this.members.length % TANK_COLORS.length];
  }

  /** Pick the team with the fewest members (for auto-balanced joins). */
  private balancedTeam(): number {
    const counts = new Array<number>(Math.max(2, this.config.teamCount)).fill(0);
    for (const m of this.members) counts[m.team % counts.length]++;
    let best = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] < counts[best]) best = i;
    return best;
  }

  /** Switch a member's team (Team VS, lobby only). */
  setTeam(clientId: string, team: number): void {
    const m = this.members.find((c) => c.id === clientId);
    if (!m || this.inGame) return;
    if (team < 0 || team >= this.config.teamCount) return;
    m.team = team;
    this.broadcast({ type: "lobbyUpdate", lobby: this.toDTO() });
  }

  /**
   * Host updates the game settings. Allowed both in the lobby and mid-match: a
   * running game picks up live-applicable tuning (speeds, scoring, power-ups,
   * bullet/adv values) immediately; structural changes (mode, map, team count)
   * are stored and take effect on the next start/restart.
   */
  setConfig(requesterId: string, maxPlayers: number, config: GameConfig): void {
    if (requesterId !== this.hostId) return;
    this.config = config;
    this.maxPlayers = clamp(maxPlayers, 2, 32) || this.maxPlayers;
    this.ensureTeams();
    if (this.inGame) {
      this.game?.updateConfig(config);
    } else {
      // Keep team assignments valid if the team count shrank.
      for (const m of this.members) {
        if (m.team >= config.teamCount) m.team = config.teamCount - 1;
      }
    }
    this.broadcast({ type: "lobbyUpdate", lobby: this.toDTO() });
    this.onChange(); // listing shows the new mode
  }

  /** Host restarts the match with the current config (fresh maze, scores, rounds). */
  restartGame(requesterId: string): void {
    if (!this.game || requesterId !== this.hostId) return;
    if (this.roundBreak) {
      clearTimeout(this.roundBreak);
      this.roundBreak = null;
    }
    this.createMatch();
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

    this.createMatch();
    this.loop = setInterval(() => this.tick(), TICK_MS);
    this.onChange(); // lobby list now shows inGame
    return null;
  }

  /** Build a fresh maze + Game from the current members/config and broadcast it. */
  private createMatch(): void {
    this.maze = this.buildMaze();
    this.game = new Game(
      this.maze,
      this.members.map((m) => ({ id: m.id, name: m.name, color: this.colorFor(m), team: m.team })),
      this.config,
      this.teamNames
    );
    this.lastSnapBytes = null;
    this.lastStep = Date.now();
    this.broadcast({
      type: "gameStart",
      maze: this.maze.toDTO(),
      roster: this.game.roster(),
      round: this.game.currentRound,
      totalRounds: this.game.roundCount,
      standing: this.game.roundStandings(),
    });
    this.broadcastSnapshot(true); // initial state (binary)
  }

  /** A fresh maze sized for the configured map size + wall style. */
  private buildMaze(): Maze {
    const { cols, rows } = mazeDimensions(this.config.mapSize);
    return new Maze(
      cols,
      rows,
      this.config.wallStyle,
      this.config.adv.cellSize,
      this.config.adv.wallThickness
    );
  }

  /** Send the maze + roster (JSON) and current snapshot (binary) to one client. */
  private sendStateTo(client: Client): void {
    if (!this.game || !this.maze || client.ws.readyState !== client.ws.OPEN) return;
    client.ws.send(
      encode({
        type: "gameStart",
        maze: this.maze.toDTO(),
        roster: this.game.roster(),
        round: this.game.currentRound,
        totalRounds: this.game.roundCount,
        standing: this.game.roundStandings(),
      })
    );
    client.ws.send(encodeSnapshot(this.game.snapshot(Date.now())));
  }

  /** Broadcast the current snapshot as binary — only if it changed (gating). */
  private broadcastSnapshot(force = false): void {
    if (!this.game) return;
    const bytes = encodeSnapshot(this.game.snapshot(Date.now()));
    if (!force && bytesEqual(this.lastSnapBytes, bytes)) return;
    this.lastSnapBytes = bytes;
    for (const m of this.members) {
      if (m.ws.readyState === m.ws.OPEN) m.ws.send(bytes);
    }
  }

  /**
   * Drop a client into the game already in progress: spawn their tank and send
   * them the current maze + snapshot so their client switches to the arena.
   */
  spawnLateJoiner(client: Client): void {
    if (!this.game || !this.maze) return;
    this.game.addPlayer({
      id: client.id,
      name: client.name,
      color: this.colorFor(client),
      team: client.team,
    });
    // Existing players need the new index before the next snapshot references it.
    this.broadcast({ type: "roster", roster: this.game.roster() });
    this.sendStateTo(client);
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
      this.sendStateTo(client);
    } else {
      client.ws.send(encode({ type: "lobbyJoined", lobby: this.toDTO() }));
    }
  }

  private tick(): void {
    if (!this.game) return;
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastStep) / 1000);
    this.lastStep = now;

    this.game.step(dt); // physics every tick (smooth)

    if (this.game.isFinished) {
      this.broadcast({
        type: "gameOver",
        scores: this.game.scores(),
        winnerName: this.game.getWinnerName(),
        round: this.game.currentRound,
        totalRounds: this.game.roundCount,
        standing: this.game.roundStandings(),
      });
      this.stopGame();
      this.broadcast({ type: "lobbyUpdate", lobby: this.toDTO() });
      this.onChange();
      return;
    }

    // A round ended but the match continues: announce it once, then start the
    // next round on a fresh maze after a short intermission. The simulation
    // keeps running (players locked, bullets still in flight) so the arena
    // stays alive on screen — hence we fall through to the snapshot broadcast.
    if (this.game.isRoundOver && !this.roundBreak) {
      this.broadcast({
        type: "roundOver",
        round: this.game.currentRound,
        totalRounds: this.game.roundCount,
        winnerName: this.game.getRoundWinnerName(),
        standing: this.game.roundStandings(),
        nextInSeconds: ROUND_INTERMISSION_SECONDS,
      });
      this.roundBreak = setTimeout(() => this.beginNextRound(), ROUND_INTERMISSION_SECONDS * 1000);
    }

    // Broadcast only every Nth tick (network rate < sim rate); still gated so an
    // unchanged world sends nothing. Force a send on ticks that produced a blast
    // or beam so those transient effects are never dropped on a skipped tick.
    this.tickCount += 1;
    if (this.tickCount % SNAPSHOT_EVERY_TICKS === 0 || this.game.hasEffects()) {
      this.broadcastSnapshot();
    }
  }

  /** Intermission elapsed: rebuild the arena and broadcast the next round. */
  private beginNextRound(): void {
    this.roundBreak = null;
    if (!this.game) return;
    this.maze = this.buildMaze();
    this.game.startNextRound(this.maze);
    this.lastSnapBytes = null;
    this.lastStep = Date.now();
    this.broadcast({
      type: "gameStart",
      maze: this.maze.toDTO(),
      roster: this.game.roster(),
      round: this.game.currentRound,
      totalRounds: this.game.roundCount,
      standing: this.game.roundStandings(),
    });
    this.broadcastSnapshot(true);
  }

  private stopGame(): void {
    if (this.loop) clearInterval(this.loop);
    if (this.roundBreak) clearTimeout(this.roundBreak);
    this.loop = null;
    this.roundBreak = null;
    this.game = null;
    this.maze = null;
    this.lastSnapBytes = null;
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
      inGame: this.inGame,
      config: this.config,
      players: this.members.map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        isHost: m.id === this.hostId,
        connected: m.connected,
        team: m.team,
      })),
      teamNames: this.teamNames.slice(0, this.config.teamCount),
      teamColors: this.teamColors.slice(0, this.config.teamCount),
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
      mode: this.config.mode,
      inGame: this.inGame,
      allowLateJoin: this.config.allowLateJoin,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return NaN;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

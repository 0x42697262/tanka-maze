import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import {
  CTF_SCORE_MODES,
  FLAG_STEAL_MODES,
  decode,
  DEFAULT_ADVANCED,
  DEFAULT_GAME_CONFIG,
  encode,
  FOG_VISION_MODES,
  HAZARD_TYPES,
  POWERUP_DEFS,
  POWERUP_TYPES,
  type AdvancedConfig,
  type ClientMessage,
  type GameConfig,
  type InputState,
  type ServerMessage,
} from "../shared/protocol.js";
import { decodeInput, MSG_INPUT } from "../shared/wire.js";
import { RECONNECT_GRACE_MS, TANK_COLORS } from "../shared/constants.js";
import { Lobby, type Client } from "./lobby.js";

const PORT = Number(process.env.PORT ?? 8080);
const CLIENT_DIR = fileURLToPath(new URL("../client", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// Hub: owns all clients and lobbies.
// ---------------------------------------------------------------------------

class Hub {
  // Keyed by secret sessionId so a reconnecting socket rebinds to the same
  // Client (preserving lobby membership, tank, and score).
  private sessions = new Map<string, Client>();
  private lobbies = new Map<string, Lobby>();
  private pingPulseCount = 0;

  /** Bind a (re)connecting socket. With a known sessionId, resume that session;
   *  otherwise mint a new one. */
  attach(ws: WebSocket, sessionId?: string): Client {
    const existing = sessionId ? this.sessions.get(sessionId) : undefined;
    if (existing) {
      if (existing.removalTimer) {
        clearTimeout(existing.removalTimer);
        existing.removalTimer = null;
      }
      existing.ws = ws;
      existing.connected = true;
      this.send(existing, {
        type: "welcome",
        playerId: existing.id,
        sessionId: existing.sessionId,
        resumed: true,
      });
      const lobby = this.lobbyOf(existing);
      if (lobby) {
        lobby.markReconnected(existing.id);
        lobby.sendResume(existing);
        lobby.broadcast({ type: "lobbyUpdate", lobby: lobby.toDTO() });
      } else {
        this.sendLobbyList(existing);
      }
      return existing;
    }

    const client: Client = {
      id: randomUUID(),
      sessionId: randomUUID(),
      ws,
      name: `Player-${Math.floor(1000 + Math.random() * 9000)}`,
      color: TANK_COLORS[Math.floor(Math.random() * TANK_COLORS.length)],
      lobbyId: null,
      connected: true,
      removalTimer: null,
      team: 0,
      latency: 0,
      pingAt: 0,
    };
    this.sessions.set(client.sessionId, client);
    this.send(client, { type: "welcome", playerId: client.id, sessionId: client.sessionId, resumed: false });
    this.sendLobbyList(client);
    return client;
  }

  /** Socket dropped: hold the slot open for a grace period, then remove. */
  onDisconnect(client: Client, ws: WebSocket): void {
    // Ignore a stale socket closing after the client already reconnected on a
    // new one — otherwise we'd wrongly halt/remove an active player.
    if (client.ws !== ws) return;
    if (!client.connected) return;
    client.connected = false;
    this.lobbyOf(client)?.markDisconnected(client.id);
    if (client.removalTimer) clearTimeout(client.removalTimer);
    client.removalTimer = setTimeout(() => this.removeClient(client), RECONNECT_GRACE_MS);
  }

  private removeClient(client: Client): void {
    if (client.removalTimer) {
      clearTimeout(client.removalTimer);
      client.removalTimer = null;
    }
    this.leaveLobby(client);
    this.sessions.delete(client.sessionId);
  }

  handle(client: Client, msg: ClientMessage): void {
    switch (msg.type) {
      case "identify":
        // Handshake is consumed when the socket attaches; ignore duplicates.
        break;
      case "setName": {
        const name = sanitizeName(msg.name);
        if (name) client.name = name;
        const lobby = this.lobbyOf(client);
        if (lobby) lobby.broadcast({ type: "lobbyUpdate", lobby: lobby.toDTO() });
        break;
      }
      case "setColor": {
        const color = sanitizeColor(msg.color);
        if (color) client.color = color;
        const lobby = this.lobbyOf(client);
        if (lobby) lobby.broadcast({ type: "lobbyUpdate", lobby: lobby.toDTO() });
        break;
      }
      case "setTeam": {
        const lobby = this.lobbyOf(client);
        if (lobby && Number.isFinite(msg.team)) lobby.setTeam(client.id, Math.floor(msg.team));
        break;
      }
      case "setTeamName": {
        const lobby = this.lobbyOf(client);
        const name = sanitizeTeamName(msg.name);
        if (lobby && Number.isFinite(msg.team) && name) {
          lobby.setTeamName(client.id, Math.floor(msg.team), name);
        }
        break;
      }
      case "setTeamColor": {
        const lobby = this.lobbyOf(client);
        const color = sanitizeColor(msg.color);
        if (lobby && Number.isFinite(msg.team) && color) {
          lobby.setTeamColor(client.id, Math.floor(msg.team), color);
        }
        break;
      }
      case "updateConfig": {
        const lobby = this.lobbyOf(client);
        if (lobby) lobby.setConfig(client.id, Math.floor(Number(msg.maxPlayers)), sanitizeConfig(msg.config));
        break;
      }
      case "listLobbies":
        this.sendLobbyList(client);
        break;
      case "createLobby":
        this.createLobby(client, msg.name, msg.maxPlayers, sanitizeConfig(msg.config));
        break;
      case "joinLobby":
        this.joinLobby(client, msg.lobbyId);
        break;
      case "leaveLobby":
        this.leaveLobby(client);
        this.sendLobbyList(client);
        break;
      case "startGame": {
        const lobby = this.lobbyOf(client);
        if (!lobby) return this.send(client, { type: "error", message: "Not in a lobby." });
        const err = lobby.startGame(client.id);
        if (err) this.send(client, { type: "error", message: err });
        break;
      }
      case "restartGame": {
        this.lobbyOf(client)?.restartGame(client.id);
        break;
      }
      case "transferHost": {
        const lobby = this.lobbyOf(client);
        if (lobby && typeof msg.targetId === "string") lobby.transferHost(client.id, msg.targetId);
        break;
      }
      case "kickPlayer": {
        const lobby = this.lobbyOf(client);
        if (!lobby || lobby.hostId !== client.id) break;
        const target = this.clientById(msg.targetId);
        if (!target || target.id === client.id || target.lobbyId !== lobby.id) break;
        this.send(target, { type: "kicked", reason: "You were removed by the host." });
        this.leaveLobby(target);
        break;
      }
      case "input": {
        const lobby = this.lobbyOf(client);
        lobby?.setInput(client.id, msg.input);
        break;
      }
    }
  }

  private createLobby(
    client: Client,
    name: string,
    maxPlayers: number,
    config: GameConfig
  ): void {
    this.leaveLobby(client);
    const id = shortId();
    const lobby = new Lobby(
      id,
      sanitizeLobbyName(name) || `${client.name}'s game`,
      client,
      maxPlayers,
      config,
      () => this.broadcastLobbyList()
    );
    lobby.add(client);
    this.lobbies.set(id, lobby);
    this.send(client, { type: "lobbyJoined", lobby: lobby.toDTO() });
    this.broadcastLobbyList();
  }

  private joinLobby(client: Client, lobbyId: string): void {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) return this.send(client, { type: "error", message: "Lobby not found." });
    if (lobby.isFull()) return this.send(client, { type: "error", message: "Lobby is full." });
    if (lobby.inGame && !lobby.config.allowLateJoin) {
      return this.send(client, { type: "error", message: "This match is closed to late joiners." });
    }

    this.leaveLobby(client);
    lobby.add(client);
    if (lobby.inGame) {
      // Late join: drop straight into the running match.
      lobby.spawnLateJoiner(client);
    } else {
      this.send(client, { type: "lobbyJoined", lobby: lobby.toDTO() });
    }
    lobby.broadcast({ type: "lobbyUpdate", lobby: lobby.toDTO() });
    this.broadcastLobbyList();
  }

  private leaveLobby(client: Client): void {
    const lobby = this.lobbyOf(client);
    client.lobbyId = null;
    if (!lobby) return;
    const destroy = lobby.remove(client.id);
    if (destroy) {
      this.lobbies.delete(lobby.id);
    } else {
      lobby.broadcast({ type: "lobbyUpdate", lobby: lobby.toDTO() });
    }
    this.broadcastLobbyList();
  }

  private lobbyOf(client: Client): Lobby | undefined {
    return client.lobbyId ? this.lobbies.get(client.lobbyId) : undefined;
  }

  /** Find a connected client by its public player id. */
  clientById(id: string): Client | undefined {
    for (const c of this.sessions.values()) if (c.id === id) return c;
    return undefined;
  }

  /** Record a pong reply's round-trip time against the client. */
  notePong(client: Client): void {
    if (client.pingAt) {
      client.latency = Math.max(0, Date.now() - client.pingAt);
      client.pingAt = 0;
    }
  }

  /**
   * Periodic latency tick: broadcast each lobby's current per-player latencies,
   * then ping every connected socket so the next tick has fresh measurements.
   */
  pingPulse(): void {
    this.pingPulseCount += 1;
    for (const lobby of this.lobbies.values()) {
      // In-game pings are informational UI, not simulation data. During a match,
      // send them less often so idle/large rooms are not dominated by JSON status
      // chatter; lobbies still update every pulse while players are forming teams.
      if (lobby.inGame && this.pingPulseCount % 5 !== 0) continue;
      const pings = lobby.members.map((m) => ({ id: m.id, ms: m.latency }));
      lobby.broadcast({ type: "latencies", pings });
    }
    const now = Date.now();
    for (const c of this.sessions.values()) {
      if (!c.connected || c.ws.readyState !== c.ws.OPEN) continue;
      c.pingAt = now;
      try {
        c.ws.ping();
      } catch {
        /* socket may be closing; ignore */
      }
    }
  }

  private sendLobbyList(client: Client): void {
    this.send(client, { type: "lobbyList", lobbies: this.summaries() });
  }

  private broadcastLobbyList(): void {
    const msg: ServerMessage = { type: "lobbyList", lobbies: this.summaries() };
    const data = encode(msg);
    // Only connected clients sitting in the browser (not in a lobby) need it.
    for (const c of this.sessions.values()) {
      if (c.connected && !c.lobbyId && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  }

  private summaries() {
    return [...this.lobbies.values()].map((l) => l.toSummary());
  }

  /** Apply decoded binary input to the client's in-game tank. */
  applyInput(client: Client, input: InputState): void {
    this.lobbyOf(client)?.setInput(client.id, input);
  }

  private send(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(encode(msg));
  }
}

function sanitizeName(raw: string): string {
  return typeof raw === "string" ? raw.trim().slice(0, 16).replace(/[\x00-\x1f]/g, "") : "";
}

/** Lobby names get more room than callsigns; matches the client input's maxlength=24. */
function sanitizeLobbyName(raw: string): string {
  return typeof raw === "string" ? raw.trim().slice(0, 24).replace(/[\x00-\x1f]/g, "") : "";
}

/** Accept only a strict 6-digit hex color; anything else is rejected. This is
 *  a security boundary — the color is rendered into other clients' DOM. */
function sanitizeColor(raw: unknown): string | null {
  return typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : null;
}

/** Team names may contain spaces; strip markup-significant characters. */
function sanitizeTeamName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[<>"'&]/g, "").trim().slice(0, 16) : "";
}

/** Clamp/validate the advanced (engine tuning) sub-config. */
function sanitizeAdvanced(raw: unknown): AdvancedConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_ADVANCED;
  const f = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const i = (v: unknown, lo: number, hi: number, dflt: number): number =>
    Math.round(f(v, lo, hi, dflt));
  // Non-power-up engine fields are clamped explicitly; power-up fields are
  // clamped from the registry (each PowerupDef carries its own ranges), so a new
  // power-up's tuning is validated automatically.
  const adv: AdvancedConfig = {
    ...d,
    tankRadius: f(c.tankRadius, 4, 40, d.tankRadius),
    tankTurnSpeed: f(c.tankTurnSpeed, 0.5, 12, d.tankTurnSpeed),
    tankAccel: f(c.tankAccel, 50, 4000, d.tankAccel),
    tankDecel: f(c.tankDecel, 50, 8000, d.tankDecel),
    fireCooldown: f(c.fireCooldown, 0.05, 5, d.fireCooldown),
    maxAmmo: i(c.maxAmmo, 1, 50, d.maxAmmo),
    reloadSeconds: f(c.reloadSeconds, 0.2, 20, d.reloadSeconds),
    bulletSpeed: f(c.bulletSpeed, 40, 2000, d.bulletSpeed),
    bulletRadius: f(c.bulletRadius, 1, 30, d.bulletRadius),
    bulletBounces: i(c.bulletBounces, 0, 20, d.bulletBounces),
    bulletLifetime: f(c.bulletLifetime, 0.5, 20, d.bulletLifetime),
    cellSize: i(c.cellSize, 40, 200, d.cellSize),
    wallThickness: f(c.wallThickness, 2, 30, d.wallThickness),
    wallHp: i(c.wallHp, 1, 50, d.wallHp),
    buffStackBonusPct: f(c.buffStackBonusPct, 0, 100, d.buffStackBonusPct),
  };
  for (const def of POWERUP_DEFS) {
    for (const field of def.config) {
      const clamp = field.int ? i : f;
      adv[field.key] = clamp(c[field.key], field.min, field.max, d[field.key]);
    }
  }
  return adv;
}

/** Clamp/validate a client-supplied game config against the allowed ranges. */
function sanitizeConfig(raw: unknown): GameConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_GAME_CONFIG;
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
  const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const clampFloat = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const mode = oneOf(c.mode, ["ffa", "lms", "teams", "ctf"] as const, d.mode);
  const ctf = mode === "ctf";
  const rawHazardTypes = c.hazardTypes;
  const hazardTypes = Array.isArray(rawHazardTypes)
    ? HAZARD_TYPES.filter((t) => rawHazardTypes.includes(t))
    : d.hazardTypes;
  const rawPowerupTypes = c.powerupTypes;
  const powerupTypes = Array.isArray(rawPowerupTypes)
    ? POWERUP_TYPES.filter((t) => rawPowerupTypes.includes(t))
    : d.powerupTypes;
  let lives = clampInt(c.lives, 0, 99, d.lives);
  // Last Man Standing needs finite lives, or it could never end.
  if (mode === "lms" && lives < 1) lives = 3;
  // CTF: respawn-at-base means nobody is ever eliminated, so lives are infinite.
  if (ctf) lives = 0;
  // CTF runs 2 or 4 teams; other modes allow 2–4.
  const teamCount = ctf
    ? clampInt(c.teamCount, 2, 4, 2) >= 3
      ? 4
      : 2
    : clampInt(c.teamCount, 2, 4, d.teamCount);
  return {
    mode,
    wallStyle: oneOf(
      c.wallStyle,
      ["maze", "sparse", "open", "cross", "lshape", "tunnels", "box", "dots"] as const,
      d.wallStyle
    ),
    mapSize: oneOf(c.mapSize, ["small", "normal", "large", "random"] as const, d.mapSize),
    rounds: clampInt(c.rounds, 1, 15, d.rounds),
    allowLateJoin: typeof c.allowLateJoin === "boolean" ? c.allowLateJoin : d.allowLateJoin,
    tankSpeedPct: clampInt(c.tankSpeedPct, 50, 200, d.tankSpeedPct),
    hp: clampInt(c.hp, 1, 10, d.hp),
    lives,
    respawnSeconds: clampInt(c.respawnSeconds, 1, 10, d.respawnSeconds),
    killPoints: clampInt(c.killPoints, 1, 500, d.killPoints),
    deathPenaltyPct: clampInt(c.deathPenaltyPct, 0, 90, d.deathPenaltyPct),
    winScore: clampInt(c.winScore, 60, 6000, d.winScore),
    // CTF plays out of corner bases (spawn zones forced on) with 2 or 4 teams.
    teamCount,
    friendlyFire: typeof c.friendlyFire === "boolean" ? c.friendlyFire : d.friendlyFire,
    teamKillPenalty: clampInt(c.teamKillPenalty, 0, 500, d.teamKillPenalty),
    teamSpawnZones: ctf ? true : typeof c.teamSpawnZones === "boolean" ? c.teamSpawnZones : d.teamSpawnZones,
    maxFlags: clampInt(c.maxFlags, 1, 20, d.maxFlags),
    flagTeamCarry: typeof c.flagTeamCarry === "boolean" ? c.flagTeamCarry : d.flagTeamCarry,
    flagStealMode: oneOf(c.flagStealMode, FLAG_STEAL_MODES, d.flagStealMode),
    // Captures to win a round; defaults to one per rival team (1 for 2, 3 for 4).
    flagsPerRound: clampInt(c.flagsPerRound, 1, 50, Math.max(1, teamCount - 1)),
    ctfScoreMode: oneOf(c.ctfScoreMode, CTF_SCORE_MODES, d.ctfScoreMode),
    ctfRespawnBonus: clampInt(c.ctfRespawnBonus, 0, 60, d.ctfRespawnBonus),
    adv: sanitizeAdvanced(c.adv),
    fogOfWar: typeof c.fogOfWar === "boolean" ? c.fogOfWar : d.fogOfWar,
    visionRadius: clampInt(c.visionRadius, 80, 1600, d.visionRadius),
    fogBaseVision: oneOf(c.fogBaseVision, FOG_VISION_MODES, d.fogBaseVision),
    fogFlagVision: oneOf(c.fogFlagVision, FOG_VISION_MODES, d.fogFlagVision),
    fogHideCarriedFlag: typeof c.fogHideCarriedFlag === "boolean" ? c.fogHideCarriedFlag : d.fogHideCarriedFlag,
    hazardDensity: clampInt(c.hazardDensity, 0, 10, d.hazardDensity),
    hazardTypes,
    hazardDamage: clampInt(c.hazardDamage, 1, 20, d.hazardDamage),
    hazardSlowMult: clampFloat(c.hazardSlowMult, 0, 1, d.hazardSlowMult),
    hazardHealRate: clampFloat(c.hazardHealRate, 0.5, 10, d.hazardHealRate),
    destructibleWalls: typeof c.destructibleWalls === "boolean" ? c.destructibleWalls : d.destructibleWalls,
    powerups: typeof c.powerups === "boolean" ? c.powerups : d.powerups,
    powerupEverySeconds: clampInt(c.powerupEverySeconds, 3, 60, d.powerupEverySeconds),
    powerupDespawnSeconds: clampInt(c.powerupDespawnSeconds, 3, 60, d.powerupDespawnSeconds),
    powerupCharges: clampInt(c.powerupCharges, 1, 20, d.powerupCharges),
    powerupSpawnCount: clampInt(c.powerupSpawnCount, 1, 20, d.powerupSpawnCount),
    powerupTypes,
    powerupStacking: typeof c.powerupStacking === "boolean" ? c.powerupStacking : d.powerupStacking,
    combineWeapons: typeof c.combineWeapons === "boolean" ? c.combineWeapons : d.combineWeapons,
    tankCollision: mode === "ffa"
      ? typeof c.tankCollision === "boolean" ? c.tankCollision : d.tankCollision
      : false,
    radar: typeof c.radar === "boolean" ? c.radar : d.radar,
  };
}

function shortId(): string {
  return randomUUID().slice(0, 6);
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket wiring
// ---------------------------------------------------------------------------

const hub = new Hub();

const httpServer = createServer((req, res) => serveStatic(req, res));
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  // The client is created/resumed on its first message (the `identify`
  // handshake), so a reconnecting socket can rebind to its existing session.
  let client: Client | null = null;

  ws.on("message", (raw, isBinary) => {
    // Binary frames are packed player input (the high-frequency path).
    if (isBinary) {
      if (!client) return;
      const u8 = raw as Buffer;
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
      try {
        if (new Uint8Array(ab)[0] === MSG_INPUT) hub.applyInput(client, decodeInput(ab));
      } catch (err) {
        console.error("input decode error", err);
      }
      return;
    }

    let msg: ClientMessage;
    try {
      msg = decode<ClientMessage>(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    try {
      if (!client) {
        const sessionId = msg.type === "identify" ? msg.sessionId : undefined;
        client = hub.attach(ws, sessionId);
        if (msg.type === "identify") return; // handshake consumed
      }
      hub.handle(client, msg);
    } catch (err) {
      console.error("handler error", err);
    }
  });

  ws.on("pong", () => {
    if (client) hub.notePong(client);
  });
  ws.on("close", () => {
    if (client) hub.onDisconnect(client, ws);
  });
  ws.on("error", () => {
    if (client) hub.onDisconnect(client, ws);
  });
});

// Measure & broadcast per-player latency a couple times a second.
setInterval(() => hub.pingPulse(), 2000);

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    // Prevent path traversal.
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(CLIENT_DIR, safe);

    let body: Buffer;
    try {
      body = await readFile(filePath);
    } catch {
      // SPA fallback: serve index.html for unknown routes.
      filePath = join(CLIENT_DIR, "index.html");
      body = await readFile(filePath);
    }

    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found. Build the client with `npm run build` first.");
  }
}

httpServer.listen(PORT, () => {
  // Binds all interfaces; the client connects over the same origin in prod.
  console.log(`tanka-maze server listening on port ${PORT}`);
});

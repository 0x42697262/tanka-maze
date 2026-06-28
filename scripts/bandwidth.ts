import WebSocket from "ws";

import { DEFAULT_GAME_CONFIG, decode, encode, type ClientMessage, type InputState, type ServerMessage } from "../src/shared/protocol.js";
import { bytesEqual, encodeInput, MSG_INPUT, MSG_SNAPSHOT } from "../src/shared/wire.js";

type Scenario = "idle" | "drive" | "drive-fire";

interface Options {
  readonly url: string;
  readonly players: readonly number[];
  readonly durationSeconds: number;
  readonly scenario: Scenario;
  readonly inputHz: number;
  readonly logEverySeconds: number;
  readonly sendUnchangedInputs: boolean;
}

interface DirectionTotals {
  bytes: number;
  messages: number;
  jsonBytes: number;
  jsonMessages: number;
  binaryBytes: number;
  binaryMessages: number;
  byType: Map<string, { bytes: number; messages: number }>;
}

interface ClientTotals {
  inbound: DirectionTotals;
  outbound: DirectionTotals;
}

interface TrialSummary {
  readonly players: number;
  readonly seconds: number;
  readonly inboundBytes: number;
  readonly outboundBytes: number;
  readonly totalBytes: number;
  readonly perPlayerBytesPerSecond: number;
  readonly serverBytesPerSecond: number;
  readonly inboundByType: ReadonlyMap<string, { bytes: number; messages: number }>;
  readonly outboundByType: ReadonlyMap<string, { bytes: number; messages: number }>;
}

const DEFAULT_URL = "ws://localhost:8080";
const DEFAULT_PLAYERS = [1, 2, 4, 8, 16];
const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_INPUT_HZ = 30;
const DEFAULT_LOG_EVERY_SECONDS = 1;
const CONNECT_TIMEOUT_MS = 10_000;

function totals(): DirectionTotals {
  return {
    bytes: 0,
    messages: 0,
    jsonBytes: 0,
    jsonMessages: 0,
    binaryBytes: 0,
    binaryMessages: 0,
    byType: new Map(),
  };
}

function emptyClientTotals(): ClientTotals {
  return { inbound: totals(), outbound: totals() };
}

class LoadClient {
  readonly totals = emptyClientTotals();
  playerId = "";
  latestLobbyId = "";
  gameStarted = false;
  private lastInputBytes: Uint8Array | null = null;
  private readonly handlers = new Set<(message: ServerMessage) => void>();
  private ws: WebSocket | null = null;

  constructor(
    readonly index: number,
    private readonly url: string
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.on("message", (data, isBinary) => this.recordInbound(data, isBinary));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Client ${this.index} connect timeout`)), CONNECT_TIMEOUT_MS);
      ws.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  sendJson(message: ClientMessage): void {
    const data = encode(message);
    this.recordOutboundText(data, message.type);
    this.requireSocket().send(data);
  }

  sendInput(input: InputState, sendUnchanged: boolean): void {
    const bytes = encodeInput(input);
    if (!sendUnchanged && bytesEqual(this.lastInputBytes, bytes)) return;
    this.lastInputBytes = bytes;
    this.recordOutboundBinary(bytes.byteLength, `binary:${MSG_INPUT}:input`);
    this.requireSocket().send(bytes);
  }

  resetTotals(): void {
    this.totals.inbound = totals();
    this.totals.outbound = totals();
    this.lastInputBytes = null;
  }

  waitFor(predicate: (message: ServerMessage) => boolean, label: string): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.handlers.delete(handler);
        reject(new Error(`Client ${this.index} timed out waiting for ${label}`));
      }, CONNECT_TIMEOUT_MS);
      const handler = (message: ServerMessage): void => {
        if (!predicate(message)) return;
        clearTimeout(timeout);
        this.handlers.delete(handler);
        resolve(message);
      };
      this.handlers.add(handler);
    });
  }

  close(): void {
    this.ws?.close();
    this.handlers.clear();
  }

  private requireSocket(): WebSocket {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error(`Client ${this.index} socket is not open`);
    return this.ws;
  }

  private recordInbound(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      const bytes = byteLength(data);
      const tag = firstByte(data);
      this.recordDirectionBinary(this.totals.inbound, bytes, tag === MSG_SNAPSHOT ? `binary:${tag}:snapshot` : `binary:${tag}:unknown`);
      return;
    }

    const text = data.toString();
    const bytes = Buffer.byteLength(text);
    let message: ServerMessage | null = null;
    try {
      message = decode<ServerMessage>(text);
    } catch {
      // Keep malformed text in the byte totals but type it explicitly.
    }
    this.recordDirectionText(this.totals.inbound, bytes, message?.type ?? "json:malformed");
    if (!message) return;
    if (message.type === "welcome") this.playerId = message.playerId;
    if (message.type === "lobbyJoined" || message.type === "lobbyUpdate") this.latestLobbyId = message.lobby.id;
    if (message.type === "gameStart") this.gameStarted = true;
    for (const handler of this.handlers) handler(message);
  }

  private recordOutboundText(data: string, type: string): void {
    this.recordDirectionText(this.totals.outbound, Buffer.byteLength(data), type);
  }

  private recordOutboundBinary(bytes: number, type: string): void {
    this.recordDirectionBinary(this.totals.outbound, bytes, type);
  }

  private recordDirectionText(direction: DirectionTotals, bytes: number, type: string): void {
    direction.bytes += bytes;
    direction.messages += 1;
    direction.jsonBytes += bytes;
    direction.jsonMessages += 1;
    addType(direction.byType, type, bytes);
  }

  private recordDirectionBinary(direction: DirectionTotals, bytes: number, type: string): void {
    direction.bytes += bytes;
    direction.messages += 1;
    direction.binaryBytes += bytes;
    direction.binaryMessages += 1;
    addType(direction.byType, type, bytes);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  console.log(`[bandwidth] url=${options.url} players=${options.players.join(",")} duration=${options.durationSeconds}s scenario=${options.scenario} inputHz=${options.inputHz} sendUnchanged=${options.sendUnchangedInputs}`);
  const summaries: TrialSummary[] = [];
  for (const playerCount of options.players) {
    summaries.push(await runTrial(options, playerCount));
  }
  printProjectionTable(summaries);
}

async function runTrial(options: Options, playerCount: number): Promise<TrialSummary> {
  console.log(`\n[trial] players=${playerCount} scenario=${options.scenario}`);
  const clients: LoadClient[] = [];
  let inputTimer: ReturnType<typeof setInterval> | null = null;
  let logTimer: ReturnType<typeof setInterval> | null = null;

  try {
    const host = new LoadClient(0, options.url);
    clients.push(host);
    await connectAndIdentify(host);
    host.sendJson({ type: "setName", name: "Bot-1" });
    host.sendJson({
      type: "createLobby",
      name: `Bandwidth ${Date.now()}`,
      maxPlayers: Math.max(2, playerCount),
      config: {
        ...DEFAULT_GAME_CONFIG,
        mapSize: "normal",
        wallStyle: "maze",
        powerups: false,
      },
    });
    const joined = await host.waitFor((message) => message.type === "lobbyJoined", "host lobbyJoined");
    const lobbyId = joined.type === "lobbyJoined" ? joined.lobby.id : host.latestLobbyId;

    for (let i = 1; i < playerCount; i++) {
      const client = new LoadClient(i, options.url);
      clients.push(client);
      await connectAndIdentify(client);
      client.sendJson({ type: "setName", name: `Bot-${i + 1}` });
      client.sendJson({ type: "joinLobby", lobbyId });
      await client.waitFor((message) => message.type === "lobbyJoined", "join lobbyJoined");
    }

    await waitForLobbySize(host, playerCount);
    host.sendJson({ type: "startGame" });
    await Promise.all(clients.map((client) => client.waitFor((message) => message.type === "gameStart", "gameStart")));
    for (const client of clients) client.resetTotals();

    const startedAt = Date.now();
    let tick = 0;
    sendScenarioInputs(clients, options.scenario, tick, options.inputHz, options.sendUnchangedInputs);
    inputTimer = setInterval(() => {
      tick += 1;
      sendScenarioInputs(clients, options.scenario, tick, options.inputHz, options.sendUnchangedInputs);
    }, 1000 / options.inputHz);

    logTimer = setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      printLiveLine(clients, elapsed, playerCount);
    }, options.logEverySeconds * 1000);

    await sleep(options.durationSeconds * 1000);
    if (inputTimer) clearInterval(inputTimer);
    if (logTimer) clearInterval(logTimer);

    const seconds = (Date.now() - startedAt) / 1000;
    const summary = summarize(clients, playerCount, seconds);
    printTrialSummary(summary);
    return summary;
  } finally {
    if (inputTimer) clearInterval(inputTimer);
    if (logTimer) clearInterval(logTimer);
    for (const client of clients) client.close();
    await sleep(100);
  }
}

async function connectAndIdentify(client: LoadClient): Promise<void> {
  await client.connect();
  const welcome = client.waitFor((message) => message.type === "welcome", "welcome");
  client.sendJson({ type: "identify" });
  await welcome;
}

async function waitForLobbySize(host: LoadClient, size: number): Promise<void> {
  if (size <= 1) return;
  await host.waitFor(
    (message) => (message.type === "lobbyUpdate" || message.type === "lobbyJoined") && message.lobby.players.length >= size,
    `lobby size ${size}`
  );
}

function sendScenarioInputs(clients: readonly LoadClient[], scenario: Scenario, tick: number, inputHz: number, sendUnchanged: boolean): void {
  for (const client of clients) client.sendInput(inputFor(client.index, scenario, tick, inputHz), sendUnchanged);
}

function inputFor(index: number, scenario: Scenario, tick: number, inputHz: number): InputState {
  const phase = tick / inputHz + index * 0.37;
  const aim = scenario === "idle" ? 0 : phase * Math.PI * 0.75;
  return {
    forward: scenario !== "idle",
    backward: false,
    turnLeft: false,
    turnRight: scenario === "drive" && tick % 120 < 60,
    fire: scenario === "drive-fire" && tick % 10 === 0,
    aim,
    eightDir: false,
    joystick: false,
  };
}

function summarize(clients: readonly LoadClient[], players: number, seconds: number): TrialSummary {
  const inboundByType = new Map<string, { bytes: number; messages: number }>();
  const outboundByType = new Map<string, { bytes: number; messages: number }>();
  let inboundBytes = 0;
  let outboundBytes = 0;
  for (const client of clients) {
    inboundBytes += client.totals.inbound.bytes;
    outboundBytes += client.totals.outbound.bytes;
    mergeTypes(inboundByType, client.totals.inbound.byType);
    mergeTypes(outboundByType, client.totals.outbound.byType);
  }
  const totalBytes = inboundBytes + outboundBytes;
  return {
    players,
    seconds,
    inboundBytes,
    outboundBytes,
    totalBytes,
    perPlayerBytesPerSecond: totalBytes / players / seconds,
    serverBytesPerSecond: totalBytes / seconds,
    inboundByType,
    outboundByType,
  };
}

function printLiveLine(clients: readonly LoadClient[], elapsed: number, players: number): void {
  const summary = summarize(clients, players, Math.max(0.001, elapsed));
  console.log(
    `[live] players=${players} elapsed=${elapsed.toFixed(1)}s server=${formatRate(summary.serverBytesPerSecond)} perPlayer=${formatRate(summary.perPlayerBytesPerSecond)} in=${formatRate(summary.inboundBytes / elapsed)} out=${formatRate(summary.outboundBytes / elapsed)}`
  );
}

function printTrialSummary(summary: TrialSummary): void {
  console.log(`[summary] players=${summary.players} seconds=${summary.seconds.toFixed(2)}`);
  console.log(`  server total: ${formatBytes(summary.totalBytes)} (${formatRate(summary.serverBytesPerSecond)}, ${formatPerMinute(summary.serverBytesPerSecond)}, ${formatPerHour(summary.serverBytesPerSecond)})`);
  console.log(`  server inbound: ${formatBytes(summary.outboundBytes)} from clients (${formatRate(summary.outboundBytes / summary.seconds)})`);
  console.log(`  server outbound: ${formatBytes(summary.inboundBytes)} to clients (${formatRate(summary.inboundBytes / summary.seconds)})`);
  console.log(`  per player avg: ${formatRate(summary.perPlayerBytesPerSecond)}, ${formatPerMinute(summary.perPlayerBytesPerSecond)}, ${formatPerHour(summary.perPlayerBytesPerSecond)}`);
  printTypeBreakdown("server outbound by message", summary.inboundByType, summary.seconds);
  printTypeBreakdown("server inbound by message", summary.outboundByType, summary.seconds);
}

function printTypeBreakdown(label: string, byType: ReadonlyMap<string, { bytes: number; messages: number }>, seconds: number): void {
  console.log(`  ${label}:`);
  for (const [type, value] of [...byType.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12)) {
    console.log(`    ${type}: ${formatRate(value.bytes / seconds)} (${value.messages} msgs, ${formatBytes(value.bytes)})`);
  }
}

function printProjectionTable(summaries: readonly TrialSummary[]): void {
  console.log("\n[projection] measured payload bandwidth");
  console.log("players,server_Bps,server_KB_per_min,server_MB_per_hour,per_player_Bps,per_player_KB_per_min,per_player_MB_per_hour");
  for (const summary of summaries) {
    console.log([
      summary.players,
      summary.serverBytesPerSecond.toFixed(1),
      (summary.serverBytesPerSecond * 60 / 1024).toFixed(2),
      (summary.serverBytesPerSecond * 3600 / 1024 / 1024).toFixed(2),
      summary.perPlayerBytesPerSecond.toFixed(1),
      (summary.perPlayerBytesPerSecond * 60 / 1024).toFixed(2),
      (summary.perPlayerBytesPerSecond * 3600 / 1024 / 1024).toFixed(2),
    ].join(","));
  }
}

function addType(target: Map<string, { bytes: number; messages: number }>, type: string, bytes: number): void {
  const current = target.get(type) ?? { bytes: 0, messages: 0 };
  current.bytes += bytes;
  current.messages += 1;
  target.set(type, current);
}

function mergeTypes(target: Map<string, { bytes: number; messages: number }>, source: ReadonlyMap<string, { bytes: number; messages: number }>): void {
  for (const [type, value] of source) {
    const current = target.get(type) ?? { bytes: 0, messages: 0 };
    current.bytes += value.bytes;
    current.messages += value.messages;
    target.set(type, current);
  }
}

function byteLength(data: WebSocket.RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((sum, item) => sum + item.byteLength, 0);
  return Buffer.byteLength(String(data));
}

function firstByte(data: WebSocket.RawData): number {
  if (Buffer.isBuffer(data)) return data[0] ?? 0;
  if (data instanceof ArrayBuffer) return new Uint8Array(data)[0] ?? 0;
  if (Array.isArray(data)) return data[0]?.[0] ?? 0;
  return 0;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes.toFixed(0)} B`;
}

function formatRate(bytesPerSecond: number): string {
  return `${bytesPerSecond.toFixed(1)} B/s`;
}

function formatPerMinute(bytesPerSecond: number): string {
  return `${(bytesPerSecond * 60 / 1024).toFixed(2)} KB/min`;
}

function formatPerHour(bytesPerSecond: number): string {
  return `${(bytesPerSecond * 3600 / 1024 / 1024).toFixed(2)} MB/hr`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOptions(args: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    values.set(arg.slice(2), args[i + 1] ?? "");
    i += 1;
  }

  const scenario = (values.get("scenario") ?? "drive-fire") as Scenario;
  if (!["idle", "drive", "drive-fire"].includes(scenario)) throw new Error(`Invalid scenario: ${scenario}`);

  return {
    url: values.get("url") ?? DEFAULT_URL,
    players: parsePlayers(values.get("players") ?? DEFAULT_PLAYERS.join(",")),
    durationSeconds: positiveNumber(values.get("duration"), DEFAULT_DURATION_SECONDS),
    scenario,
    inputHz: positiveNumber(values.get("input-hz"), DEFAULT_INPUT_HZ),
    logEverySeconds: positiveNumber(values.get("log-every"), DEFAULT_LOG_EVERY_SECONDS),
    sendUnchangedInputs: values.has("send-unchanged"),
  };
}

function parsePlayers(raw: string): readonly number[] {
  const players = raw.split(",").map((part) => Math.max(1, Math.floor(Number(part.trim())))).filter(Number.isFinite);
  return players.length > 0 ? players : DEFAULT_PLAYERS;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

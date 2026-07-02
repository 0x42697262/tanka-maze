import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_GAME_CONFIG, type GameConfig } from "../src/shared/protocol.js";
import { Lobby, type Client } from "../src/server/lobby.js";

// A stand-in socket: broadcast only checks readyState and calls send().
const fakeWs = () => ({ readyState: 0, OPEN: 1, send() {} }) as unknown as Client["ws"];

let seq = 0;
function client(name: string): Client {
  const id = `c${seq++}`;
  return {
    id,
    sessionId: `s-${id}`,
    ws: fakeWs(),
    name,
    color: "#ffffff",
    lobbyId: null,
    connected: true,
    removalTimer: null,
    team: 0,
    latency: 0,
    pingAt: 0,
  };
}

// Host (joins first) lands on team 0; the next member auto-balances onto team 1.
function teamLobby(): { lobby: Lobby; host: Client; first: Client } {
  const cfg: GameConfig = structuredClone(DEFAULT_GAME_CONFIG);
  cfg.mode = "teams";
  cfg.teamCount = 2;
  const host = client("Host");
  const lobby = new Lobby("L1", "Room", host, 8, cfg, () => {});
  lobby.add(host); // team 0
  const first = client("First");
  lobby.add(first); // team 1
  return { lobby, host, first };
}

const teamMembers = (lobby: Lobby, team: number): string[] =>
  lobby.toDTO().players.filter((p) => p.team === team).map((p) => p.name);

describe("lobby: team roster order", () => {
  it("orders a team by who joined it first, even when an earlier lobby member switches in", () => {
    const { lobby, host } = teamLobby();
    // Host joined the lobby first but joins team 1 last, so they appear last.
    lobby.setTeam(host.id, 1);
    assert.deepEqual(teamMembers(lobby, 1), ["First", "Host"]);
  });

  it("keeps team captaincy with the original member when an earlier player switches in", () => {
    const { lobby, host, first } = teamLobby();
    lobby.setTeam(host.id, 1); // earlier-joined Host switches onto First's team

    // "First" was there first and keeps the right to rename/recolor the team.
    lobby.setTeamName(first.id, 1, "Bandits");
    lobby.setTeamName(host.id, 1, "Aces"); // ignored — Host isn't the captain
    assert.equal(lobby.toDTO().teamNames[1], "Bandits");
  });
});

// Force the running game to report finished, then run one tick so the lobby
// processes its game-over path (broadcasts, stops the loop, restores the host).
function finishGame(lobby: Lobby): void {
  const game = (lobby as unknown as { game: object }).game;
  Object.defineProperty(game, "isFinished", { get: () => true });
  (lobby as unknown as { tick(): void }).tick();
}

describe("lobby: host across a match", () => {
  it("restores the match host when the game ends after a mid-match drop", () => {
    const { lobby, host, first } = teamLobby();
    assert.equal(lobby.startGame(host.id), null);

    // Host's socket drops mid-match: host duties pass to a connected stand-in.
    host.connected = false;
    lobby.markDisconnected(host.id);
    assert.equal(lobby.hostId, first.id);

    host.connected = true;
    lobby.markReconnected(host.id);
    finishGame(lobby);
    assert.equal(lobby.hostId, host.id); // back with the match host
  });

  it("keeps the stand-in host when the match host is still disconnected at game end", () => {
    const { lobby, host, first } = teamLobby();
    assert.equal(lobby.startGame(host.id), null);
    host.connected = false;
    lobby.markDisconnected(host.id);

    finishGame(lobby);
    assert.equal(lobby.hostId, first.id);
  });

  it("keeps the new host at game end when the match host left and rejoined mid-match", () => {
    const { lobby, host, first } = teamLobby();
    assert.equal(lobby.startGame(host.id), null);

    // Deliberate leave (not a drop): host passes to First and the restore is forfeited.
    lobby.remove(host.id);
    assert.equal(lobby.hostId, first.id);
    lobby.add(host); // rejoins as a late joiner before the game ends

    finishGame(lobby);
    assert.equal(lobby.hostId, first.id);
  });

  it("lets the host hand off to another connected member, and keeps a deliberate mid-match transfer at game end", () => {
    const { lobby, host, first } = teamLobby();

    lobby.transferHost(first.id, host.id); // non-host requester: ignored
    assert.equal(lobby.hostId, host.id);
    first.connected = false;
    lobby.transferHost(host.id, first.id); // disconnected target: ignored
    assert.equal(lobby.hostId, host.id);
    first.connected = true;

    assert.equal(lobby.startGame(host.id), null);
    lobby.transferHost(host.id, first.id);
    assert.equal(lobby.hostId, first.id);

    // A deliberate handoff outlives the match — no snap back to the giver.
    finishGame(lobby);
    assert.equal(lobby.hostId, first.id);
  });
});

describe("lobby: team rebalance on team-count change", () => {
  const counts = (lobby: Lobby, n: number): number[] => {
    const c = new Array<number>(n).fill(0);
    for (const p of lobby.toDTO().players) c[p.team]++;
    return c;
  };

  it("spreads players evenly when the team count changes (4 → 2 → 4)", () => {
    const cfg: GameConfig = structuredClone(DEFAULT_GAME_CONFIG);
    cfg.mode = "teams";
    cfg.teamCount = 4;
    const host = client("Host");
    const lobby = new Lobby("L1", "Room", host, 8, cfg, () => {});
    lobby.add(host);
    for (const n of ["B", "C", "D", "E", "F", "G", "H"]) lobby.add(client(n)); // 8 total

    const to = (teamCount: number) => {
      const next = structuredClone(cfg);
      next.teamCount = teamCount;
      lobby.setConfig(host.id, 8, next);
    };

    to(2);
    assert.deepEqual(counts(lobby, 2), [4, 4]); // 8 split evenly, no team left empty
    to(4);
    assert.deepEqual(counts(lobby, 4), [2, 2, 2, 2]);
    to(3);
    assert.deepEqual(counts(lobby, 3).sort(), [2, 3, 3]); // 8 across 3 → 3/3/2
  });
});

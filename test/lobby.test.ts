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

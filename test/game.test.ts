import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_GAME_CONFIG,
  type AdvancedConfig,
  type GameConfig,
  type InputState,
} from "../src/shared/protocol.js";
import { Game } from "../src/server/game.js";
import { TEAMKILL_STREAK_WINDOW } from "../src/shared/constants.js";
import { Maze } from "../src/server/maze.js";

type Player = { id: string; name: string; color?: string; team?: number };

function makeGame(
  opts: {
    cfg?: Partial<GameConfig>;
    adv?: Partial<AdvancedConfig>;
    players?: Player[];
    teamNames?: string[];
    maze?: Maze;
  } = {}
): Game {
  const cfg = structuredClone(DEFAULT_GAME_CONFIG);
  Object.assign(cfg, opts.cfg);
  if (opts.adv) Object.assign(cfg.adv, opts.adv);
  const players = opts.players ?? [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const maze = opts.maze ?? new Maze(10, 8, "open");
  return new Game(maze, players, cfg, opts.teamNames);
}

// Reach into the simulation internals (private in TS, present at runtime).
const tank = (g: Game, id: string): any => (g as any).tanks.get(id);
const bullets = (g: Game): any[] => (g as any).bullets;
const apply = (g: Game, t: any, type: string): void => (g as any).applyPowerup(t, type);
const fire = (g: Game, t: any): void => (g as any).fire(t);
const scoredTank = (g: Game, id: string) =>
  g.snapshot(0).tanks.find((t) => t.id === id)!;

const input = (over: Partial<InputState> = {}): InputState => ({
  forward: false,
  backward: false,
  turnLeft: false,
  turnRight: false,
  fire: false,
  aim: 0,
  eightDir: false,
  joystick: false,
  ...over,
});

describe("power-ups: apply", () => {
  it("weapon pickups set the active weapon + the shared charge count", () => {
    const g = makeGame({ cfg: { powerupCharges: 4 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    for (const w of ["sniper", "explosive", "laser", "tracking", "multishot"]) {
      apply(g, a, w);
      assert.equal(a.weapon, w);
      assert.equal(a.weaponCharges, 4);
    }
  });

  it("buffs run their own command (speed / shield / scope)", () => {
    const g = makeGame({ adv: { speedBoostSeconds: 7, shieldSeconds: 9, scopeSeconds: 5 }, cfg: { powerupCharges: 2 } });
    const a = tank(g, "a");
    apply(g, a, "speed");
    assert.equal(a.boostTimer, 7);
    apply(g, a, "shield");
    assert.equal(a.shieldTimer, 9);
    apply(g, a, "scope");
    assert.equal(a.scopeTimer, 5);
    assert.equal(a.scopeShots, 2); // charges
  });
});

describe("scope", () => {
  it("is consumed one charge per shot and ends when depleted", () => {
    const g = makeGame({ cfg: { powerupCharges: 2 }, adv: { fireCooldown: 0, scopeSeconds: 30 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.shieldTimer = 0;
    apply(g, a, "scope");
    assert.equal(scoredTank(g, "a").scoped, true);
    fire(g, a);
    assert.equal(a.scopeShots, 1);
    fire(g, a);
    assert.equal(a.scopeShots, 0);
    assert.equal(scoredTank(g, "a").scoped, false);
  });
});

describe("multishot", () => {
  it("fires the configured pellet count across the configured spread", () => {
    const g = makeGame({ adv: { multishotCount: 5, multishotSpread: 40 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.turretAngle = 0;
    a.weapon = "multishot";
    a.weaponCharges = 1;
    fire(g, a);
    const angles = bullets(g).map((b) => Math.atan2(b.vy, b.vx));
    assert.equal(bullets(g).length, 5);
    const spanDeg = ((Math.max(...angles) - Math.min(...angles)) * 180) / Math.PI;
    assert.ok(Math.abs(spanDeg - 40) < 0.001, `span ${spanDeg}`);
    assert.equal(a.weaponCharges, 0); // consumed one volley
  });
});

describe("explosive", () => {
  it("detonates when its lifetime expires in open space, not only on a wall", () => {
    const g = makeGame({
      adv: { bulletLifetime: 0.2, fireCooldown: 0 },
      maze: new Maze(12, 9, "open"),
      players: [{ id: "a", name: "A" }],
    });
    const a = tank(g, "a");
    a.x = 500;
    a.y = 400;
    a.turretAngle = 0; // fires into open space; lifetime ends before any wall
    a.weapon = "explosive";
    a.weaponCharges = 1;
    fire(g, a);
    let blasts = 0;
    for (let i = 0; i < 12; i++) {
      g.step(1 / 30);
      blasts += g.snapshot(0).blasts.length;
    }
    assert.ok(blasts >= 1, "explosive should detonate on despawn");
    assert.equal(bullets(g).length, 0, "bullet removed after detonating");
  });
});

describe("capture the flag", () => {
  const ctfPlayers = [
    { id: "a", name: "A", color: "#ff0000", team: 0 },
    { id: "b", name: "B", color: "#0000ff", team: 1 },
  ];
  const makeCtf = (over: Partial<typeof DEFAULT_GAME_CONFIG> = {}, maze?: Maze) =>
    makeGame({
      cfg: { mode: "ctf", maxFlags: 3, hp: 3, ...over },
      players: ctfPlayers,
      maze: maze ?? new Maze(10, 8, "open"),
    });
  const flags = (g: Game): any[] => (g as any).flags;
  const flagOf = (g: Game, team: number) => flags(g).find((f) => f.team === team);
  const zoneOf = (g: Game, team: number) =>
    (g as any).spawnZones.find((z: any) => z.team === team);

  it("places one flag at the exact centre of each team's base", () => {
    const g = makeCtf();
    assert.equal(flags(g).length, 2);
    for (const team of [0, 1]) {
      const z = zoneOf(g, team);
      const f = flagOf(g, team);
      assert.equal(f.x, z.x + z.width / 2);
      assert.equal(f.y, z.y + z.height / 2);
      assert.equal(f.state, "home");
    }
  });

  it("clears maze walls inside every spawn base (open rooms)", () => {
    const g = makeCtf({}, new Maze(14, 11, "maze"));
    const maze = (g as any).maze as Maze;
    const cell = maze.cell;
    for (const z of (g as any).spawnZones) {
      const cx0 = Math.round(z.x / cell);
      const cy0 = Math.round(z.y / cell);
      const cx1 = cx0 + Math.round(z.width / cell);
      const cy1 = cy0 + Math.round(z.height / cell);
      for (let x = cx0; x < cx1; x++) {
        for (let y = cy0; y < cy1; y++) {
          if (x + 1 < cx1) assert.ok(maze.passable(x, y, x + 1, y), `wall inside base at ${x},${y}`);
          if (y + 1 < cy1) assert.ok(maze.passable(x, y, x, y + 1), `wall inside base at ${x},${y}`);
        }
      }
    }
  });

  it("an enemy tank picks up the flag on contact; bringing it home captures", () => {
    const g = makeCtf({ maxFlags: 2 });
    const a = tank(g, "a"); // team 0
    const enemyFlag = flagOf(g, 1);
    // Walk A onto the enemy flag, then step the flag logic.
    a.x = enemyFlag.x;
    a.y = enemyFlag.y;
    (g as any).stepFlags(0.1);
    assert.equal(enemyFlag.state, "carried");
    assert.equal(enemyFlag.carrierId, "a");

    // Carry it into A's own base → capture (ends the round, +1 to team 0).
    const base = zoneOf(g, 0);
    a.x = base.x + base.width / 2;
    a.y = base.y + base.height / 2;
    enemyFlag.x = a.x;
    enemyFlag.y = a.y;
    (g as any).stepFlags(0.1);
    assert.equal(a.captures, 1);
    assert.equal((g as any).roundWins.get("t0"), 1);
    assert.equal(g.isRoundOver, true);
  });

  it("a carried flag drops where the carrier dies and can be re-picked", () => {
    const g = makeCtf();
    const a = tank(g, "a");
    const enemyFlag = flagOf(g, 1);
    a.x = enemyFlag.x;
    a.y = enemyFlag.y;
    (g as any).stepFlags(0.1);
    assert.equal(enemyFlag.state, "carried");

    a.x = 400;
    a.y = 300;
    enemyFlag.x = a.x;
    enemyFlag.y = a.y;
    (g as any).kill(a, "b"); // A dies mid-carry
    assert.equal(enemyFlag.state, "dropped");
    assert.equal(enemyFlag.carrierId, null);
    assert.equal(enemyFlag.x, 400); // stays where it fell
  });

  it("default: a team carries its dropped flag back, returning it from base", () => {
    const g = makeCtf(); // flagTeamCarry on (default)
    const a = tank(g, "a"); // team 0 — steals team 1's flag
    const b = tank(g, "b"); // team 1 — owner of that flag
    const flag = flagOf(g, 1);
    const home = { x: flag.homeX, y: flag.homeY };

    a.x = flag.x;
    a.y = flag.y;
    (g as any).stepFlags(0.1);
    a.x = 400;
    a.y = 300;
    flag.x = a.x;
    flag.y = a.y;
    (g as any).kill(a, "b"); // dropped at (400, 300)
    assert.equal(flag.state, "dropped");

    // B (the flag's team) touches the dropped flag → carries it (no teleport).
    b.x = flag.x;
    b.y = flag.y;
    (g as any).stepFlags(0.1);
    assert.equal(flag.state, "carried");
    assert.equal(flag.carrierId, "b");

    // B brings it back into their own base → it returns home.
    const base = zoneOf(g, 1);
    b.x = base.x + base.width / 2;
    b.y = base.y + base.height / 2;
    (g as any).stepFlags(0.1);
    assert.equal(flag.state, "home");
    assert.equal(flag.x, home.x);
    assert.equal(flag.y, home.y);
    assert.equal(flag.carrierId, null);
  });

  it("legacy: with team-carry off, touching your dropped flag teleports it home", () => {
    const g = makeCtf({ flagTeamCarry: false });
    const a = tank(g, "a");
    const b = tank(g, "b");
    const flag = flagOf(g, 1);
    const home = { x: flag.homeX, y: flag.homeY };

    a.x = flag.x;
    a.y = flag.y;
    (g as any).stepFlags(0.1);
    a.x = 400;
    a.y = 300;
    flag.x = a.x;
    flag.y = a.y;
    (g as any).kill(a, "b");
    assert.equal(flag.state, "dropped");

    b.x = flag.x;
    b.y = flag.y;
    (g as any).stepFlags(0.1);
    assert.equal(flag.state, "home");
    assert.equal(flag.x, home.x);
    assert.equal(flag.y, home.y);
  });

  it("default: touching a flag carrier steals/relays it on contact", () => {
    const g = makeCtf(); // flagStealOnContact on (default)
    const a = tank(g, "a"); // team 0
    const b = tank(g, "b"); // team 1
    const flag = flagOf(g, 1); // team 1's flag

    a.x = flag.x;
    a.y = flag.y;
    (g as any).stepFlags(0.1); // A carries team 1's flag
    assert.equal(flag.carrierId, "a");

    // Move the carrier to neutral ground (not on a base), flag rides along.
    a.x = 400;
    a.y = 300;
    flag.x = a.x;
    flag.y = a.y;
    // B touches carrier A (cooldown elapsed) → B takes the flag without a kill.
    flag.stealCooldown = 0;
    b.x = a.x;
    b.y = a.y;
    (g as any).stepFlags(0.1);
    assert.equal(flag.state, "carried");
    assert.equal(flag.carrierId, "b");
  });

  it("with steal off, touching a carrier doesn't take the flag (kill to drop)", () => {
    const g = makeCtf({ flagStealOnContact: false });
    const a = tank(g, "a");
    const b = tank(g, "b");
    const flag = flagOf(g, 1);

    a.x = flag.x;
    a.y = flag.y;
    (g as any).stepFlags(0.1);
    assert.equal(flag.carrierId, "a");

    a.x = 400;
    a.y = 300;
    flag.x = a.x;
    flag.y = a.y;
    flag.stealCooldown = 0;
    b.x = a.x;
    b.y = a.y;
    (g as any).stepFlags(0.1);
    assert.equal(flag.carrierId, "a"); // unchanged — B must kill A to get it
  });

  it("a team can't pick up its own home flag", () => {
    const g = makeCtf();
    const a = tank(g, "a"); // team 0
    const ownFlag = flagOf(g, 0);
    a.x = ownFlag.x;
    a.y = ownFlag.y;
    (g as any).stepFlags(0.1);
    assert.equal(ownFlag.state, "home");
    assert.equal(ownFlag.carrierId, null);
  });

  it("respawn delay grows by ctfRespawnBonus with each death in the round", () => {
    const g = makeCtf({ respawnSeconds: 2, ctfRespawnBonus: 4 });
    const b = tank(g, "b");
    (g as any).kill(b, "a");
    assert.equal(b.respawnIn, 2); // 1st death: base respawn
    (g as any).respawn(b);
    (g as any).kill(b, "a");
    assert.equal(b.respawnIn, 6); // 2nd death: base + 1×bonus
    (g as any).respawn(b);
    (g as any).kill(b, "a");
    assert.equal(b.respawnIn, 10); // 3rd death: base + 2×bonus
  });

  it("kills award no points in CTF (won by captures, not score)", () => {
    const g = makeCtf();
    (g as any).kill(tank(g, "b"), "a");
    assert.equal(tank(g, "a").score, 0);
  });

  it("uses spawn-zone bases (2 teams by default)", () => {
    const g = makeCtf();
    assert.equal((g as any).spawnZones.length, 2);
    assert.equal(g.spawnZoneDTOs().length, 2);
  });

  it("supports 4 teams: a base + flag in each corner", () => {
    const g = makeCtf({ teamCount: 4 }, new Maze(14, 11, "maze"));
    assert.equal((g as any).spawnZones.length, 4);
    assert.equal(flags(g).length, 4);
    for (const team of [0, 1, 2, 3]) {
      const z = zoneOf(g, team);
      const f = flagOf(g, team);
      assert.equal(f.x, z.x + z.width / 2);
      assert.equal(f.y, z.y + z.height / 2);
    }
  });

  it("only a spawn point's own team can score a capture there", () => {
    const players = [
      { id: "a", name: "A", color: "#f00", team: 0 },
      { id: "b", name: "B", color: "#0f0", team: 1 },
      { id: "c", name: "C", color: "#00f", team: 2 },
      { id: "d", name: "D", color: "#ff0", team: 3 },
    ];
    const g = makeGame({
      cfg: { mode: "ctf", maxFlags: 3, hp: 3, teamCount: 4, flagsPerRound: 1 },
      players,
      maze: new Maze(14, 11, "maze"),
    });
    const a = tank(g, "a"); // team 0
    const f1 = flagOf(g, 1); // team 1's flag
    a.x = f1.x;
    a.y = f1.y;
    (g as any).stepFlags(0.1);
    assert.equal(f1.carrierId, "a");

    // Carry it into team 2's base → must NOT score (not team 0's base).
    const z2 = zoneOf(g, 2);
    a.x = z2.x + z2.width / 2;
    a.y = z2.y + z2.height / 2;
    f1.x = a.x;
    f1.y = a.y;
    (g as any).stepFlags(0.1);
    assert.equal(g.isRoundOver, false);
    assert.equal((g as any).roundWins.get("t0") ?? 0, 0);
    assert.equal((g as any).roundWins.get("t2") ?? 0, 0);

    // Carry it into team 0's own base → scores for team 0.
    const z0 = zoneOf(g, 0);
    a.x = z0.x + z0.width / 2;
    a.y = z0.y + z0.height / 2;
    f1.x = a.x;
    f1.y = a.y;
    (g as any).stepFlags(0.1);
    assert.equal((g as any).roundWins.get("t0"), 1);
  });

  it("needs flagsPerRound captures to win a round", () => {
    const g = makeCtf({ flagsPerRound: 2 });
    const a = tank(g, "a"); // team 0
    const f = flagOf(g, 1); // team 1's flag
    const z0 = zoneOf(g, 0);
    const capture = () => {
      a.x = f.x;
      a.y = f.y;
      (g as any).stepFlags(0.1); // pick up the (home) enemy flag
      a.x = z0.x + z0.width / 2;
      a.y = z0.y + z0.height / 2;
      f.x = a.x;
      f.y = a.y;
      (g as any).stepFlags(0.1); // deliver to own base
    };
    capture();
    assert.equal(g.isRoundOver, false); // 1 of 2
    assert.equal(a.captures, 1);
    capture();
    assert.equal(g.isRoundOver, true); // 2 of 2 → round won
    assert.equal((g as any).roundWins.get("t0"), 1);
  });
});

describe("team spawn zones", () => {
  const teamPlayers = [
    { id: "a", name: "A", color: "#ff0000", team: 0 },
    { id: "b", name: "B", color: "#ff0000", team: 0 },
    { id: "c", name: "C", color: "#0000ff", team: 1 },
    { id: "d", name: "D", color: "#0000ff", team: 1 },
  ];
  const inRect = (t: any, z: any): boolean =>
    t.x >= z.x && t.x <= z.x + z.width && t.y >= z.y && t.y <= z.y + z.height;

  it("spawns every tank inside its own team's zone (Team VS, default on)", () => {
    const g = makeGame({ cfg: { mode: "teams", teamCount: 2 }, players: teamPlayers });
    const zones = g.spawnZoneDTOs();
    assert.equal(zones.length, 2);
    for (const id of ["a", "b", "c", "d"]) {
      const t = tank(g, id);
      const z = zones.find((z) => z.team === t.team)!;
      assert.ok(inRect(t, z), `${id} should spawn in its team zone`);
    }
  });

  it("makes all zones the same size and places teams far apart", () => {
    const g = makeGame({ cfg: { mode: "teams", teamCount: 2 }, players: teamPlayers });
    const [z0, z1] = g.spawnZoneDTOs();
    assert.equal(z0.width, z1.width);
    assert.equal(z0.height, z1.height);
    // Zone centers should be most of the arena apart (opposite corners).
    const c0 = { x: z0.x + z0.width / 2, y: z0.y + z0.height / 2 };
    const c1 = { x: z1.x + z1.width / 2, y: z1.y + z1.height / 2 };
    const dist = Math.hypot(c1.x - c0.x, c1.y - c0.y);
    assert.ok(dist > 600, `zones should be far apart (got ${Math.round(dist)})`);
  });

  it("tints each zone with its team's color", () => {
    const g = makeGame({ cfg: { mode: "teams", teamCount: 2 }, players: teamPlayers });
    const zones = g.spawnZoneDTOs();
    assert.equal(zones.find((z) => z.team === 0)!.color, "#ff0000");
    assert.equal(zones.find((z) => z.team === 1)!.color, "#0000ff");
  });

  it("keeps spawns clear of walls even on a maze layout", () => {
    const g = makeGame({
      cfg: { mode: "teams", teamCount: 2 },
      players: teamPlayers,
      maze: new Maze(10, 8, "maze"),
    });
    for (const id of ["a", "b", "c", "d"]) {
      const t = tank(g, id);
      assert.equal((g as any).maze.hitsCircle(t.x, t.y, 11), false, `${id} clear of walls`);
    }
  });

  it("emits no zones when disabled or outside Team VS", () => {
    const off = makeGame({ cfg: { mode: "teams", teamSpawnZones: false }, players: teamPlayers });
    assert.deepEqual(off.spawnZoneDTOs(), []);
    const ffa = makeGame({ cfg: { mode: "ffa" }, players: teamPlayers });
    assert.deepEqual(ffa.spawnZoneDTOs(), []);
  });
});

describe("friendly fire", () => {
  const friendly = (g: Game, ownerId: string, targetId: string): boolean =>
    (g as any).isFriendly(ownerId, tank(g, targetId));

  it("off: a tank can't damage itself in any mode", () => {
    for (const mode of ["ffa", "teams", "lms"] as const) {
      const g = makeGame({
        cfg: { mode, friendlyFire: false },
        players: [
          { id: "a", name: "A", team: 0 },
          { id: "b", name: "B", team: 1 },
        ],
      });
      assert.equal(friendly(g, "a", "a"), true, `self protected in ${mode}`);
    }
  });

  it("off: teammates are protected but enemies are not (team mode)", () => {
    const g = makeGame({
      cfg: { mode: "teams", friendlyFire: false },
      players: [
        { id: "a", name: "A", team: 0 },
        { id: "b", name: "B", team: 0 },
        { id: "c", name: "C", team: 1 },
      ],
    });
    assert.equal(friendly(g, "a", "b"), true, "teammate protected");
    assert.equal(friendly(g, "a", "c"), false, "enemy hittable");
  });

  it("on: nobody is protected — self and teammates are fair game", () => {
    const g = makeGame({
      cfg: { mode: "teams", friendlyFire: true },
      players: [
        { id: "a", name: "A", team: 0 },
        { id: "b", name: "B", team: 0 },
        { id: "c", name: "C", team: 1 },
      ],
    });
    assert.equal(friendly(g, "a", "a"), false, "self hittable");
    assert.equal(friendly(g, "a", "b"), false, "teammate hittable");
    assert.equal(friendly(g, "a", "c"), false, "enemy hittable");
  });
});

describe("scoring / kills", () => {
  it("an enemy kill awards killPoints; a kill never leaves you below 1", () => {
    const g = makeGame({ cfg: { killPoints: 60 } });
    (g as any).kill(tank(g, "b"), "a");
    assert.equal(tank(g, "a").score, 60);
  });

  it("self-destruct applies the death penalty and emits a suicide event", () => {
    const g = makeGame({ cfg: { deathPenaltyPct: 25 } });
    const a = tank(g, "a");
    a.score = 100;
    (g as any).kill(a, "a");
    assert.equal(a.score, 75);
    const ev = (g as any).pendingEvents.at(-1);
    assert.equal(ev.type, 1); // suicide
    assert.equal(ev.streak, 0); // suicides never announce
  });

  it("kill streaks: first blood → savage (capped) with succession multiplier", () => {
    const g = makeGame({ cfg: { winScore: 100000 } }); // don't let FFA end mid-test
    const b = tank(g, "b");
    const tiers: number[] = [];
    const mults: number[] = [];
    for (let i = 0; i < 7; i++) {
      (g as any).kill(b, "a"); // elapsed stays 0 → all within the window
      const ev = (g as any).pendingEvents.at(-1);
      tiers.push(ev.streak);
      mults.push(ev.mult);
    }
    assert.deepEqual(tiers, [1, 2, 3, 4, 5, 5, 5]); // fb, double, triple, maniac, savage×3
    assert.deepEqual(mults, [0, 0, 0, 0, 0, 2, 3]); // 1st savage no mult, then ×2, ×3
    (g as any).elapsed = 100; // jump past the multikill window
    (g as any).kill(b, "a");
    assert.equal((g as any).pendingEvents.at(-1).streak, 0); // chain broken → lone kill, no banner
  });

  it("a player's kill streak resets when they die", () => {
    const g = makeGame({ cfg: { winScore: 100000 } });
    const a = tank(g, "a");
    const b = tank(g, "b");
    (g as any).kill(b, "a"); // a: first blood
    (g as any).kill(b, "a"); // a: double kill
    assert.equal((g as any).pendingEvents.at(-1).streak, 2);
    (g as any).kill(a, "b"); // a dies → a's streak is wiped
    (g as any).kill(b, "a"); // a kills again → fresh chain (count 1 → no banner)
    assert.equal((g as any).pendingEvents.at(-1).streak, 0);
  });

  it("team kills chain into a betrayal: 1st betrayal, 3rd traitor, 5th kinslayer", () => {
    const g = makeGame({
      cfg: { mode: "teams", teamKillPenalty: 10, winScore: 100000 },
      players: [
        { id: "a", name: "A", team: 0 },
        { id: "b", name: "B", team: 0 },
        { id: "c", name: "C", team: 1 },
      ],
    });
    const b = tank(g, "b");
    const tiers: number[] = [];
    const mults: number[] = [];
    for (let i = 0; i < 6; i++) {
      (g as any).kill(b, "a"); // a team-kills b (elapsed stays 0 → all in window)
      const ev = (g as any).pendingEvents.at(-1);
      tiers.push(ev.streak);
      mults.push(ev.mult);
    }
    // betrayal(6), —, traitor(7), —, kinslayer(8), kinslayer(8)×2
    assert.deepEqual(tiers, [6, 0, 7, 0, 8, 8]);
    assert.deepEqual(mults, [0, 0, 0, 0, 0, 2]);

    (g as any).elapsed = TEAMKILL_STREAK_WINDOW + 1; // chain expires
    (g as any).kill(b, "a");
    assert.equal((g as any).pendingEvents.at(-1).streak, 6); // back to a fresh betrayal
  });

  it("team-killing is penalized, not rewarded", () => {
    const g = makeGame({
      cfg: { mode: "teams", teamKillPenalty: 40 },
      players: [
        { id: "a", name: "A", team: 0 },
        { id: "b", name: "B", team: 0 },
      ],
    });
    const a = tank(g, "a");
    a.score = 100;
    (g as any).kill(tank(g, "b"), "a");
    assert.equal(a.score, 60);
  });
});

describe("rounds (best-of-N)", () => {
  it("ends a round on the score goal, banks cumulative score, and clinches the match", () => {
    const g = makeGame({ cfg: { mode: "ffa", rounds: 3, winScore: 60, killPoints: 60, lives: 0 } });
    (g as any).kill(tank(g, "b"), "a"); // A hits 60 -> round 1
    assert.equal(g.isRoundOver, true);
    assert.equal(g.isFinished, false);
    g.startNextRound(new Maze(10, 8, "open"));
    assert.equal(g.currentRound, 2);
    assert.equal(tank(g, "a").score, 0); // round score reset
    (g as any).kill(tank(g, "b"), "a"); // A 2-0 -> rival can't catch up -> clinch
    assert.equal(g.isFinished, true);
    assert.equal(g.getWinnerName(), "A");
    assert.equal(g.scores().find((s) => s.id === "a")!.score, 120); // cumulative
  });
});

describe("elimination ending (lives > 0)", () => {
  it("FFA ends when one player remains; infinite lives never trigger it", () => {
    const g = makeGame({
      cfg: { mode: "ffa", lives: 2, winScore: 100000, rounds: 1 },
      players: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
        { id: "c", name: "C" },
      ],
    });
    const elim = (id: string) => {
      const v = tank(g, id);
      while (!v.out) (g as any).kill(v, "a");
    };
    elim("b");
    assert.equal(g.isFinished, false);
    elim("c");
    assert.equal(g.isFinished, true);
    assert.equal(g.getWinnerName(), "A");

    const inf = makeGame({ cfg: { mode: "ffa", lives: 0, winScore: 100000, rounds: 1 } });
    for (let i = 0; i < 10; i++) (inf as any).kill(tank(inf, "b"), "a");
    assert.equal(inf.isFinished, false);
  });

  it("Team VS ends when one team is wiped", () => {
    const g = makeGame({
      cfg: { mode: "teams", lives: 1, winScore: 100000, rounds: 1 },
      players: [
        { id: "a", name: "A", team: 0 },
        { id: "b", name: "B", team: 1 },
        { id: "c", name: "C", team: 2 },
      ],
      teamNames: ["Red", "Blue", "Green"],
    });
    (g as any).kill(tank(g, "b"), "a");
    (g as any).kill(tank(g, "c"), "a");
    assert.equal(g.isFinished, true);
    assert.equal(g.getWinnerName(), "Red");
  });
});

describe("snapshot: livesLeft", () => {
  it("reports lives remaining (lives - deaths) for finite-lives modes", () => {
    const g = makeGame({ cfg: { mode: "lms", lives: 3, respawnSeconds: 1 } });
    assert.equal(scoredTank(g, "a").livesLeft, 3);
    const a = tank(g, "a");
    a.shieldTimer = 0;
    (g as any).kill(a, "b"); // one death
    assert.equal(scoredTank(g, "a").livesLeft, 2);
  });

  it("is 0 for infinite-lives modes (unused outside LMS)", () => {
    const g = makeGame({ cfg: { mode: "ffa", lives: 0 } });
    assert.equal(scoredTank(g, "a").livesLeft, 0);
  });
});

describe("spawn shields", () => {
  it("are granted on initial spawn, respawn, and at round start", () => {
    const g = makeGame({ adv: { fireCooldown: 0 }, cfg: { lives: 0, respawnSeconds: 1, rounds: 3 } });
    assert.equal(tank(g, "a").shieldTimer > 0, true); // initial
    const a = tank(g, "a");
    a.shieldTimer = 0;
    (g as any).kill(a, "b");
    for (let i = 0; i < 40 && !a.alive; i++) g.step(1 / 30); // wait out respawn
    assert.equal(a.alive, true);
    assert.ok(a.shieldTimer > 0, "respawn shield"); // respawn

    g.startNextRound(new Maze(10, 8, "open"));
    assert.ok(tank(g, "a").shieldTimer > 0, "round-start shield");
  });
});

describe("joystick movement", () => {
  it("drives + faces 360° toward aim, and fires along the heading", () => {
    const g = makeGame({ adv: { fireCooldown: 0 }, maze: new Maze(12, 9, "open"), players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.shieldTimer = 0;
    a.x = 400;
    a.y = 350;

    a.input = input({ joystick: true, forward: true, aim: 0 });
    const x0 = a.x;
    g.step(0.1);
    assert.ok(a.x > x0, "moved +x toward aim=0");
    assert.ok(Math.abs(a.bodyAngle) < 1e-6 && Math.abs(a.turretAngle) < 1e-6, "faces heading");

    a.input = input({ joystick: true, forward: false, fire: true, aim: 0 });
    a.fireCooldown = 0;
    bullets(g).length = 0;
    g.step(1 / 30);
    const b = bullets(g)[0];
    assert.ok(b && b.vx > 0 && Math.abs(b.vy) < 1e-6, "fires along the heading");
  });
});

describe("live config update", () => {
  it("applies new killPoints to the running match", () => {
    const g = makeGame({ cfg: { winScore: 100000, killPoints: 60 }, players: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] });
    tank(g, "b").shieldTimer = 0;
    (g as any).kill(tank(g, "b"), "a");
    assert.equal(tank(g, "a").score, 60);
    const next = structuredClone(DEFAULT_GAME_CONFIG);
    next.killPoints = 100;
    g.updateConfig(next);
    tank(g, "c").shieldTimer = 0;
    (g as any).kill(tank(g, "c"), "a");
    assert.equal(tank(g, "a").score, 160);
  });
});

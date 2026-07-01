import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_GAME_CONFIG,
  type AdvancedConfig,
  type GameConfig,
  type InputState,
} from "../src/shared/protocol.js";
import { Game } from "../src/server/game.js";
import { HAZARD_ZONE_FRACTION, TEAMKILL_STREAK_WINDOW, WALL_REGEN_SECONDS } from "../src/shared/constants.js";
import { Maze } from "../src/server/maze.js";

// Deterministic RNG for this file. The sim's spawn/hazard placement uses
// Math.random, and all tests here share one process, so an unseeded stream lets
// spawn-heavy tests shift downstream layout-dependent tests into flakiness.
// Seeding (mulberry32) makes every run identical. Restored after the file via
// the natural process exit; no test relies on true randomness.
let __rngState = 0x9e3779b1;
Math.random = () => {
  __rngState = (__rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(__rngState ^ (__rngState >>> 15), 1 | __rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

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
    a.shieldTimer = 0; // clear spawn shield so the pickup effect is isolated (stacking-agnostic)
    apply(g, a, "speed");
    assert.equal(a.boostTimer, 7);
    apply(g, a, "shield");
    assert.equal(a.shieldTimer, 9);
    apply(g, a, "scope");
    assert.equal(a.scopeTimer, 5);
    assert.equal(a.scopeShots, 2); // charges
  });
});

describe("power-ups: stacking", () => {
  it("weapon: a same-type pickup adds another grant of charges when stacking is on", () => {
    const g = makeGame({ cfg: { powerupCharges: 3, powerupStacking: true }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    apply(g, a, "sniper");
    assert.equal(a.weaponCharges, 3);
    apply(g, a, "sniper"); // same weapon again
    assert.equal(a.weapon, "sniper");
    assert.equal(a.weaponCharges, 6); // stacked another full grant
  });

  it("weapon: a different weapon replaces (never stacks) even with stacking on", () => {
    const g = makeGame({ cfg: { powerupCharges: 3, powerupStacking: true }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    apply(g, a, "sniper");
    apply(g, a, "laser"); // different weapon
    assert.equal(a.weapon, "laser");
    assert.equal(a.weaponCharges, 3); // fresh grant, not 6
  });

  it("weapon: a same-type pickup resets (no stack) when stacking is off", () => {
    const g = makeGame({ cfg: { powerupCharges: 3, powerupStacking: false }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    apply(g, a, "sniper");
    a.weaponCharges = 1; // pretend two were spent
    apply(g, a, "sniper");
    assert.equal(a.weaponCharges, 3); // reset to a grant, not added
  });

  it("buff: a same-type pickup adds duration when stacking is on", () => {
    const g = makeGame({ adv: { shieldSeconds: 9 }, cfg: { powerupStacking: true }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.shieldTimer = 0;
    apply(g, a, "shield");
    assert.equal(a.shieldTimer, 9);
    apply(g, a, "shield");
    assert.equal(a.shieldTimer, 18); // stacked duration
  });

  it("buff: a pickup resets duration (no stack) when stacking is off", () => {
    const g = makeGame({ adv: { shieldSeconds: 9 }, cfg: { powerupStacking: false }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.shieldTimer = 5;
    apply(g, a, "shield");
    assert.equal(a.shieldTimer, 9); // reset, not 14
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

// Park every tank out of the arena so it can't vacuum a crate that spawns on
// its own cell — isolates spawn behavior from pickup so these tests are
// deterministic regardless of the (unseeded) random spawn layout.
function parkTanks(g: Game): void {
  for (const t of (g as any).tanks.values()) {
    t.alive = false;
    t.respawnIn = 1e9;
  }
}

describe("power-ups: despawn scaling", () => {
  it("scales despawn ttl by map size (1x small, 2x normal, 3x large)", () => {
    const cases: Array<[number, number, number]> = [
      [7, 5, 1],
      [10, 7, 2],
      [14, 10, 3],
    ];
    for (const [cols, rows, mult] of cases) {
      const g = makeGame({
        cfg: { powerupEverySeconds: 0.01, powerupDespawnSeconds: 12 },
        maze: new Maze(cols, rows, "open"),
        players: [{ id: "a", name: "A" }],
      });
      parkTanks(g);
      g.step(0.02);
      const powerups = (g as any).powerups;
      assert.equal(powerups.length, 1);
      assert.equal(powerups[0].ttl, 12 * mult);
    }
  });
});

describe("power-ups: despawn scaling recomputes on round restart", () => {
  it("uses the new round's maze size, not the match's original one", () => {
    const g = makeGame({
      cfg: { powerupEverySeconds: 0.01, powerupDespawnSeconds: 12 },
      maze: new Maze(7, 5, "open"), // small -> 1x
      players: [{ id: "a", name: "A" }],
    });
    parkTanks(g);
    g.step(0.02);
    assert.equal((g as any).powerups[0].ttl, 12);

    g.startNextRound(new Maze(14, 10, "open")); // large -> 3x
    parkTanks(g); // startNextRound revives tanks — park again
    g.step(0.02);
    assert.equal((g as any).powerups[0].ttl, 36);
  });
});

describe("power-ups: spawn count per tick", () => {
  it("spawns powerupSpawnCount crates together each time the cadence ticks", () => {
    const g = makeGame({ cfg: { powerupEverySeconds: 1, powerupSpawnCount: 4 }, players: [{ id: "a", name: "A" }] });
    parkTanks(g);
    g.step(1);
    assert.equal((g as any).powerups.length, 4);
  });

  it("grows past the old hardcoded cap of 4 — bounded only by despawn timing and cell count", () => {
    const g = makeGame({
      cfg: { powerupEverySeconds: 1, powerupSpawnCount: 10, powerupDespawnSeconds: 60 },
      players: [{ id: "a", name: "A" }],
    });
    parkTanks(g);
    g.step(1);
    g.step(1);
    const powerups = (g as any).powerups;
    assert.ok(powerups.length > 4, `expected > 4 crates, got ${powerups.length}`); // past the old cap
    assert.ok(powerups.length <= 20); // two batches of 10, minus any cells reused across batches
    const positions = new Set(powerups.map((p: any) => `${p.x},${p.y}`));
    assert.equal(positions.size, powerups.length); // still one crate per cell
  });

  it("caps the population at the protocol ceiling (255) so the wire count can't overflow", () => {
    const g = makeGame({
      cfg: { powerupEverySeconds: 1, powerupSpawnCount: 20, powerupDespawnSeconds: 60 },
      maze: new Maze(20, 16, "open"), // 320 cells, so the 255 ceiling binds before cells run out
      players: [{ id: "a", name: "A" }],
    });
    parkTanks(g);
    for (let i = 0; i < 100; i++) g.step(1); // saturates well past 255 attempts
    assert.equal((g as any).powerups.length, 255);
  });

  it("spawns each crate in a batch on a distinct cell (no invisible stacking)", () => {
    const g = makeGame({
      cfg: { powerupEverySeconds: 1, powerupSpawnCount: 10 },
      maze: new Maze(5, 5, "open"), // 25 open cells, comfortably > batch size
      players: [{ id: "a", name: "A" }],
    });
    parkTanks(g);
    g.step(1);
    const powerups = (g as any).powerups;
    assert.equal(powerups.length, 10);
    const positions = new Set(powerups.map((p: any) => `${p.x},${p.y}`));
    assert.equal(positions.size, 10); // all distinct
  });
});

describe("power-ups: type pool", () => {
  it("spawns only from the configured type pool", () => {
    const g = makeGame({
      cfg: { powerupEverySeconds: 1, powerupSpawnCount: 6, powerupTypes: ["speed"] },
      players: [{ id: "a", name: "A" }],
    });
    parkTanks(g);
    g.step(1);
    const types = new Set((g as any).powerups.map((p: any) => p.type));
    assert.deepEqual(types, new Set(["speed"]));
  });

  it("spawns nothing when the type pool is empty", () => {
    const g = makeGame({ cfg: { powerupEverySeconds: 1, powerupSpawnCount: 4, powerupTypes: [] }, players: [{ id: "a", name: "A" }] });
    parkTanks(g);
    g.step(1);
    assert.equal((g as any).powerups.length, 0);
  });
});

describe("power-ups: one crate per cell", () => {
  it("replaces a crate already on a cell instead of stacking two in one spot", () => {
    const g = makeGame({
      cfg: { powerupEverySeconds: 1, powerupSpawnCount: 10, powerupDespawnSeconds: 60 },
      maze: new Maze(5, 5, "open"), // 25 cells; 10/tick over several ticks forces cross-batch cell reuse
      players: [{ id: "a", name: "A" }],
    });
    parkTanks(g);
    for (let i = 0; i < 5; i++) g.step(1); // 50 spawn attempts across 25 cells
    const powerups = (g as any).powerups;
    const positions = new Set(powerups.map((p: any) => `${p.x},${p.y}`));
    assert.equal(positions.size, powerups.length); // never two crates on one cell
    assert.ok(powerups.length <= 25, `expected <= 25 crates, got ${powerups.length}`);
  });
});

describe("rapid fire", () => {
  it("fires the first bullet immediately and queues the rest as one volley (one charge)", () => {
    const g = makeGame({ adv: { rapidFireCount: 5, rapidFireDelay: 0.15 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.turretAngle = 0;
    a.weapon = "rapidfire";
    a.weaponCharges = 1;
    fire(g, a);
    assert.equal(bullets(g).length, 1);
    assert.equal(a.rapidFireShotsLeft, 4);
    assert.equal(a.weaponCharges, 0); // consumed once, not per-bullet
  });

  it("fires the remaining queued shots on schedule, one per configured delay", () => {
    const g = makeGame({ adv: { rapidFireCount: 5, rapidFireDelay: 0.15 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.turretAngle = 0;
    a.weapon = "rapidfire";
    a.weaponCharges = 1;
    fire(g, a);
    for (let i = 0; i < 4; i++) {
      assert.equal(bullets(g).length, i + 1);
      g.step(0.15);
    }
    assert.equal(bullets(g).length, 5);
    assert.equal(a.rapidFireShotsLeft, 0);
  });

  it("blocks re-firing while a burst is in progress", () => {
    const g = makeGame({ adv: { rapidFireCount: 5, rapidFireDelay: 0.15 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.turretAngle = 0;
    a.weapon = "rapidfire";
    a.weaponCharges = 5;
    fire(g, a);
    assert.equal(bullets(g).length, 1);
    a.fireCooldown = 0; // bypass the normal cooldown gate to isolate the burst guard itself
    fire(g, a);
    assert.equal(bullets(g).length, 1); // second click ignored — still mid-burst
    assert.equal(a.weaponCharges, 4); // not consumed twice
  });

  it("a round restart mid-burst clears the queued shots (no phantom shots in the new round)", () => {
    const g = makeGame({ adv: { rapidFireCount: 5, rapidFireDelay: 0.15 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.turretAngle = 0;
    a.weapon = "rapidfire";
    a.weaponCharges = 1;
    fire(g, a);
    g.step(0.15); // 2nd shot fires; 3 more still queued
    assert.equal(a.rapidFireShotsLeft, 3);
    g.startNextRound(new Maze(10, 8, "open"));
    assert.equal(tank(g, "a").rapidFireShotsLeft, 0);
    assert.equal(bullets(g).length, 0); // startNextRound clears the bullet list too
    for (let i = 0; i < 5; i++) g.step(0.15);
    assert.equal(bullets(g).length, 0); // nothing leaked from the old burst
  });

  it("a burst interrupted by death fizzles out silently and isn't stuck afterward", () => {
    const g = makeGame({
      cfg: { mode: "ffa", lives: 1 },
      adv: { rapidFireCount: 5, rapidFireDelay: 0.15 },
      players: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
    });
    const a = tank(g, "a");
    a.turretAngle = 0;
    a.weapon = "rapidfire";
    a.weaponCharges = 1;
    fire(g, a);
    const countAtDeath = bullets(g).length;
    (g as any).kill(a, "b"); // a is eliminated (lives: 1); b and c stay alive, match continues
    assert.equal(a.out, true);
    for (let i = 0; i < 6; i++) g.step(0.15); // well past the burst's full duration
    // No scheduled shots fired from the corpse, so the bullet count can only fall
    // (existing rounds may hit a wall/tank), never rise past what existed at death.
    assert.ok(bullets(g).length <= countAtDeath, "no bullets fired from the corpse");
    assert.equal(a.rapidFireShotsLeft, 0); // not stuck — fire()'s guard isn't permanently locked
  });

  it("completes normally if the tank disconnects mid-burst while still alive", () => {
    const g = makeGame({ adv: { rapidFireCount: 5, rapidFireDelay: 0.15 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.turretAngle = 0;
    a.weapon = "rapidfire";
    a.weaponCharges = 1;
    fire(g, a);
    a.connected = false;
    for (let i = 0; i < 4; i++) g.step(0.15);
    assert.equal(bullets(g).length, 5);
    assert.equal(a.rapidFireShotsLeft, 0);
  });

  it("a weapon picked up mid-burst doesn't interrupt the original burst", () => {
    const g = makeGame({ adv: { rapidFireCount: 5, rapidFireDelay: 0.15 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.turretAngle = 0;
    a.weapon = "rapidfire";
    a.weaponCharges = 1;
    fire(g, a);
    g.step(0.15); // 2nd shot fires; 3 more still queued
    apply(g, a, "sniper"); // pick up a different weapon mid-burst
    assert.equal(a.weapon, "sniper");
    for (let i = 0; i < 3; i++) g.step(0.15);
    assert.equal(bullets(g).length, 5); // the original burst's remaining shots still completed
    assert.equal(a.rapidFireShotsLeft, 0);
    assert.equal(a.weapon, "sniper"); // tank keeps the newly picked-up weapon once the burst ends
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
    const g = makeCtf(); // flagStealMode "any" (default)
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

  it("steal mode 'team': only a teammate takes on touch; enemies must kill", () => {
    const g = makeGame({
      cfg: { mode: "ctf", maxFlags: 3, hp: 3, teamCount: 2, flagStealMode: "team" },
      players: [
        { id: "a", name: "A", team: 0 },
        { id: "mate", name: "Mate", team: 0 },
        { id: "enemy", name: "Enemy", team: 1 },
      ],
      maze: new Maze(10, 8, "open"),
    });
    const a = tank(g, "a"); // team 0 carrier of team 1's flag
    const flag = flagOf(g, 1);
    a.x = flag.x;
    a.y = flag.y;
    (g as any).stepFlags(0.1);
    assert.equal(flag.carrierId, "a");
    a.x = 400;
    a.y = 300;
    flag.x = a.x;
    flag.y = a.y;

    // Enemy touches the carrier → can't take it (must kill).
    flag.stealCooldown = 0;
    const enemy = tank(g, "enemy");
    enemy.x = a.x;
    enemy.y = a.y;
    (g as any).stepFlags(0.1);
    assert.equal(flag.carrierId, "a");

    // Teammate touches the carrier → relays it.
    flag.stealCooldown = 0;
    enemy.x = 50;
    enemy.y = 50; // move enemy away
    const mate = tank(g, "mate");
    mate.x = a.x;
    mate.y = a.y;
    (g as any).stepFlags(0.1);
    assert.equal(flag.carrierId, "mate");
  });

  it("with steal off, touching a carrier doesn't take the flag (kill to drop)", () => {
    const g = makeCtf({ flagStealMode: "off" });
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

  it("conquest: only flags PLANTED on your base score (×3 with own flag home)", () => {
    const g = makeCtf({ ctfScoreMode: "conquest", winScore: 50 });
    const a = tank(g, "a"); // team 0
    const enemyFlag = flagOf(g, 1);
    a.x = enemyFlag.x;
    a.y = enemyFlag.y;
    (g as any).stepFlags(0.1);
    assert.equal(enemyFlag.carrierId, "a"); // a carries team 1's flag

    a.score = 0;
    (g as any).stepConquest(1); // merely carrying scores nothing
    assert.equal(a.score, 0);

    // Bring it onto team 0's base → planted ("held").
    const base = zoneOf(g, 0);
    a.x = base.x + base.width / 2;
    a.y = base.y + base.height / 2;
    enemyFlag.x = a.x;
    enemyFlag.y = a.y;
    (g as any).stepFlags(0.1);
    assert.equal(enemyFlag.state, "held");
    assert.equal(enemyFlag.carrierId, null);

    a.score = 0;
    (g as any).stepConquest(1); // own flag home → ×3, 1 planted flag → 3/s
    assert.equal(Math.round(a.score), 3);

    flagOf(g, 0).state = "dropped"; // own flag no longer home → no multiplier
    a.score = 0;
    (g as any).stepConquest(1);
    assert.equal(Math.round(a.score), 1);

    flagOf(g, 0).state = "home"; // back to ×3; cross the points target
    a.score = 49;
    (g as any).stepConquest(1); // +3 → 52 ≥ 50
    assert.equal(g.isRoundOver, true);
    assert.equal((g as any).roundWins.get("t0"), 1);
  });

  it("conquest: a planted flag isn't captured and can be raided back", () => {
    const g = makeCtf({ ctfScoreMode: "conquest", winScore: 1000 });
    const a = tank(g, "a"); // team 0
    const b = tank(g, "b"); // team 1 (the flag's owner)
    const enemyFlag = flagOf(g, 1);
    a.x = enemyFlag.x;
    a.y = enemyFlag.y;
    (g as any).stepFlags(0.1);
    const base = zoneOf(g, 0);
    a.x = base.x + base.width / 2;
    a.y = base.y + base.height / 2;
    enemyFlag.x = a.x;
    enemyFlag.y = a.y;
    (g as any).stepFlags(0.1);
    assert.equal(enemyFlag.state, "held");
    assert.equal(g.isRoundOver, false); // planted, never "captured"

    // The owner raids the stack and carries it away.
    a.x = 50;
    a.y = 50; // captor steps off so its own team doesn't re-grab it
    enemyFlag.stealCooldown = 0;
    b.x = enemyFlag.x;
    b.y = enemyFlag.y;
    (g as any).stepFlags(0.1);
    assert.equal(enemyFlag.state, "carried");
    assert.equal(enemyFlag.carrierId, "b");
  });

  it("carry: a tank scores per enemy flag carried (×3 while also carrying its own)", () => {
    const g = makeCtf({ ctfScoreMode: "carry", winScore: 1000 });
    const a = tank(g, "a"); // team 0
    const enemyFlag = flagOf(g, 1);
    a.x = enemyFlag.x;
    a.y = enemyFlag.y;
    (g as any).stepFlags(0.1);
    assert.equal(enemyFlag.carrierId, "a"); // a carries team 1's enemy flag

    a.score = 0;
    (g as any).stepCarry(1); // 1 enemy flag, no own flag → 1/s
    assert.equal(Math.round(a.score), 1);

    // Grab a's own flag (from home) too → multiplier kicks in.
    const ownFlag = flagOf(g, 0);
    a.x = ownFlag.x;
    a.y = ownFlag.y;
    ownFlag.stealCooldown = 0;
    (g as any).stepFlags(0.1);
    assert.equal(ownFlag.carrierId, "a");
    assert.equal(ownFlag.state, "carried");

    a.score = 0;
    (g as any).stepCarry(1); // 1 enemy flag × own-flag bonus → 3/s
    assert.equal(Math.round(a.score), 3);
  });

  it("carry: the multiplier is per-tank — own-flag carrier outscores a 2-flag teammate", () => {
    const g = makeCtf({ ctfScoreMode: "carry", winScore: 1000, teamCount: 4 });
    const a = tank(g, "a"); // team 0
    const b = tank(g, "b"); // team 1 — repurposed as a's teammate via flag assignment
    // a carries two enemy flags (teams 1 and 2); teammate-style tank carries one
    // enemy flag plus team 0's own flag. Drive each tank onto the relevant flags.
    const f1 = flagOf(g, 1);
    const f2 = flagOf(g, 2);
    const f3 = flagOf(g, 3);
    const own = flagOf(g, 0);
    // a (team 0) grabs flags of teams 1 and 2.
    for (const f of [f1, f2]) {
      a.x = f.x; a.y = f.y; f.stealCooldown = 0;
      (g as any).stepFlags(0.1);
    }
    assert.equal(f1.carrierId, "a");
    assert.equal(f2.carrierId, "a");
    // b is on team 1 — make it a team-0 carrier holding team 3's flag + team 0's own flag.
    b.team = 0;
    for (const f of [f3, own]) {
      b.x = f.x; b.y = f.y; f.stealCooldown = 0;
      (g as any).stepFlags(0.1);
    }
    assert.equal(f3.carrierId, "b");
    assert.equal(own.carrierId, "b");

    a.score = 0;
    b.score = 0;
    (g as any).stepCarry(1);
    assert.equal(Math.round(a.score), 2); // 2 enemy flags, no own flag → 2/s
    assert.equal(Math.round(b.score), 3); // 1 enemy flag × own-flag bonus → 3/s
    assert.ok(b.score > a.score);
  });

  it("carry: flags never plant at a base and reaching winScore wins the round", () => {
    const g = makeCtf({ ctfScoreMode: "carry", winScore: 5 });
    const a = tank(g, "a"); // team 0
    const enemyFlag = flagOf(g, 1);
    a.x = enemyFlag.x;
    a.y = enemyFlag.y;
    (g as any).stepFlags(0.1);
    // Sit on a's own base — in carry mode nothing is planted/captured there.
    const base = zoneOf(g, 0);
    a.x = base.x + base.width / 2;
    a.y = base.y + base.height / 2;
    enemyFlag.x = a.x;
    enemyFlag.y = a.y;
    (g as any).stepFlags(0.1);
    assert.equal(enemyFlag.state, "carried");
    assert.equal(enemyFlag.carrierId, "a");

    a.score = 4;
    (g as any).stepCarry(1); // +1 → 5 ≥ winScore
    assert.equal(g.isRoundOver, true);
    assert.equal((g as any).roundWins.get("t0"), 1);
  });

  it("carry: flags from a multi-flag carrier scatter (no overlap, off walls, in bounds)", () => {
    const g = makeCtf({ ctfScoreMode: "carry", winScore: 1000, teamCount: 4 }, new Maze(14, 11, "maze"));
    const a = tank(g, "a"); // team 0
    const maze = (g as any).maze;
    // a grabs the three enemy flags (teams 1, 2, 3) at a central, open spot.
    for (const team of [1, 2, 3]) {
      const f = flagOf(g, team);
      a.x = maze.width / 2;
      a.y = maze.height / 2;
      f.x = a.x;
      f.y = a.y;
      f.stealCooldown = 0;
      (g as any).stepFlags(0.1);
      assert.equal(f.carrierId, "a");
    }
    (g as any).kill(a, "b"); // dies holding three flags → they scatter

    const dropped = [1, 2, 3].map((t) => flagOf(g, t));
    const R = 12; // POWERUP_RADIUS
    const minGap = R * 2.4;
    for (const f of dropped) {
      assert.equal(f.state, "dropped");
      assert.equal(f.carrierId, null);
      // Inside the map.
      assert.ok(f.x >= 0 && f.x <= maze.width && f.y >= 0 && f.y <= maze.height, "in bounds");
      // Not sitting on a wall.
      assert.equal(maze.hitsCircle(f.x, f.y, R), false, "off walls");
    }
    // No two dropped flags overlap.
    for (let i = 0; i < dropped.length; i++) {
      for (let j = i + 1; j < dropped.length; j++) {
        const d2 = (dropped[i].x - dropped[j].x) ** 2 + (dropped[i].y - dropped[j].y) ** 2;
        assert.ok(d2 >= minGap * minGap, "dropped flags are spaced apart");
      }
    }
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

  it("series length scales with team count (first to maxFlags)", () => {
    assert.equal(makeCtf({ teamCount: 2 }).roundCount, 5); // 2·(3−1)+1 = old best-of-5
    assert.equal(makeCtf({ teamCount: 4 }).roundCount, 9); // 4·(3−1)+1
    assert.equal(makeCtf({ teamCount: 4, maxFlags: 1 }).roundCount, 1);
  });

  it("4-team first-to-3 runs past round 5 and ends only when a team reaches 3", () => {
    const g = makeGame({
      cfg: { mode: "ctf", maxFlags: 3, hp: 3, teamCount: 4 },
      players: [
        { id: "a", name: "A", team: 0 },
        { id: "b", name: "B", team: 1 },
        { id: "c", name: "C", team: 2 },
        { id: "d", name: "D", team: 3 },
      ],
      maze: new Maze(14, 11, "maze"),
    });
    assert.equal(g.roundCount, 9);
    const win = (key: string) => {
      (g as any).endRound(key, key);
      if (!g.isFinished) {
        (g as any).roundOver = false;
        (g as any).round += 1;
      }
    };
    // Three teams each reach 2 wins over 6 rounds — well past the old cap of 5.
    for (const k of ["t0", "t1", "t2", "t0", "t1", "t2"]) win(k);
    assert.equal(g.isFinished, false); // pre-fix this wrongly ended at round 5
    win("t0"); // t0's third → first to 3 → match over
    assert.equal(g.isFinished, true);
    assert.equal((g as any).roundWins.get("t0"), 3);
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

describe("rounds (first-to-N)", () => {
  it("ends a round on the score goal, banks cumulative score, ends at first-to-X", () => {
    const g = makeGame({ cfg: { mode: "ffa", rounds: 3, winScore: 60, killPoints: 60, lives: 0 } });
    assert.equal(g.roundCount, 5); // 2 players, first to 3 ⇒ 2·2+1

    (g as any).kill(tank(g, "b"), "a"); // A hits 60 → A 1-0
    assert.equal(g.isRoundOver, true);
    assert.equal(g.isFinished, false);
    g.startNextRound(new Maze(10, 8, "open"));
    assert.equal(tank(g, "a").score, 0); // round score reset

    (g as any).kill(tank(g, "b"), "a"); // A 2-0 — NOT a clinch under first-to-3
    assert.equal(g.isFinished, false);
    g.startNextRound(new Maze(10, 8, "open"));

    (g as any).kill(tank(g, "b"), "a"); // A 3-0 → first to 3 → match over
    assert.equal(g.isFinished, true);
    assert.equal(g.getWinnerName(), "A");
    assert.equal(g.scores().find((s) => s.id === "a")!.score, 180); // cumulative (3×60)
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

describe("hazards", () => {
  it("hazardDensity=0 produces no zones", () => {
    const g = makeGame({ cfg: { hazardDensity: 0 }, players: [{ id: "a", name: "A" }] });
    assert.equal((g as any).hazards.length, 0);
    assert.deepEqual(g.hazardZoneDTOs(), []);
  });

  it("places the requested number of zones avoiding spawn zones", () => {
    const g = makeGame({
      cfg: { hazardDensity: 5, mode: "teams", teamSpawnZones: true, teamCount: 2 },
      players: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    });
    const zones = (g as any).hazards;
    assert.equal(zones.length, 5);
    const expectedSide = Math.round(((g as any).maze as Maze).cell * HAZARD_ZONE_FRACTION);
    const spawnZones = (g as any).spawnZones;
    for (const h of zones) {
      assert.equal(h.width, expectedSide);
      assert.equal(h.height, expectedSide);
      for (const sz of spawnZones) {
        const overlaps = h.x < sz.x + sz.width && h.x + h.width > sz.x && h.y < sz.y + sz.height && h.y + h.height > sz.y;
        assert.ok(!overlaps, "hazard zone overlaps a spawn zone");
      }
    }
  });

  it("uses only the configured hazard type pool", () => {
    const g = makeGame({ cfg: { hazardDensity: 6, hazardTypes: ["lava"] }, players: [{ id: "a", name: "A" }] });
    const zones = (g as any).hazards;
    assert.equal(zones.length, 6);
    assert.deepEqual(new Set(zones.map((h: any) => h.type)), new Set(["lava"]));
  });

  it("spawns no zones when all hazard types are disabled", () => {
    const g = makeGame({ cfg: { hazardDensity: 6, hazardTypes: [] }, players: [{ id: "a", name: "A" }] });
    assert.equal((g as any).hazards.length, 0);
  });

  it("lava damages an unshielded tank over time and kills at 0 hp", () => {
    const g = makeGame({ cfg: { hazardDensity: 1, hazardDamage: 10, hp: 1 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.shieldTimer = 0;
    // Force a lava zone onto the tank's position.
    (g as any).hazards = [{ x: a.x - 5, y: a.y - 5, width: 20, height: 20, type: "lava" }];
    g.step(0.1);
    assert.ok(a.hp < 1, "lava dealt damage");
    assert.ok(!a.alive, "tank died from lava");
  });

  it("shields block lava damage", () => {
    const g = makeGame({ cfg: { hazardDensity: 1, hazardDamage: 10, hp: 5 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.shieldTimer = 5;
    (g as any).hazards = [{ x: a.x - 5, y: a.y - 5, width: 20, height: 20, type: "lava" }];
    g.step(0.1);
    assert.equal(a.hp, 5, "shielded tank took no lava damage");
  });

  it("heal restores HP up to maxHp", () => {
    const g = makeGame({ cfg: { hazardDensity: 1, hazardHealRate: 5, hp: 3 }, players: [{ id: "a", name: "A" }] });
    const a = tank(g, "a");
    a.shieldTimer = 0;
    a.hp = 1;
    (g as any).hazards = [{ x: a.x - 5, y: a.y - 5, width: 20, height: 20, type: "heal" }];
    g.step(0.2);
    assert.ok(a.hp > 1, "heal restored HP");
    assert.ok(a.hp <= 3, "heal capped at maxHp");
  });

  it("mud slows the target velocity", () => {
    const g = makeGame({
      cfg: { hazardDensity: 0, hazardSlowMult: 0.5 },
      adv: { tankAccel: 10000 },
      players: [{ id: "a", name: "A" }],
    });
    const a = tank(g, "a");
    a.shieldTimer = 0;
    (g as any).hazards = [{ x: a.x - 5, y: a.y - 5, width: 20, height: 20, type: "mud" }];
    a.input = input({ forward: true, aim: 0 });
    g.step(0.5);
    // With slowMult 0.5, max velocity should be ~50 px/s instead of 100.
    assert.ok(Math.abs(a.vx) < 70, "mud slowed the tank");
    assert.ok(Math.abs(a.vx) > 20, "tank still moved");
  });

  it("ice preserves momentum when no input is held (slide)", () => {
    const g = makeGame({
      cfg: { hazardDensity: 0 },
      adv: { tankAccel: 10000, tankDecel: 10000 },
      players: [{ id: "a", name: "A" }],
    });
    const a = tank(g, "a");
    a.shieldTimer = 0;
    // Build up speed first.
    a.input = input({ forward: true, aim: 0 });
    g.step(0.5);
    const fastVx = a.vx;
    assert.ok(fastVx > 50, "tank got up to speed");
    // Place ice and release input — tank should keep sliding.
    (g as any).hazards = [{ x: a.x - 5, y: a.y - 5, width: 30, height: 30, type: "ice" }];
    a.input = input({ forward: false });
    g.step(0.1);
    assert.ok(a.vx > fastVx * 0.9, "ice preserved most of the momentum (no friction)");
  });
});

describe("destructible walls", () => {
  it("walls have Infinity HP when destructibleWalls is off", () => {
    const g = makeGame({ players: [{ id: "a", name: "A" }] });
    for (const w of (g as any).maze.walls) {
      assert.equal(w.hp, Infinity);
      assert.equal(w.maxHp, Infinity);
    }
  });

  it("internal walls get HP when destructibleWalls is on; borders stay indestructible", () => {
    const g = makeGame({
      cfg: { destructibleWalls: true },
      adv: { wallHp: 3 },
      maze: new Maze(10, 8, "cross"),
      players: [{ id: "a", name: "A" }],
    });
    const maze = (g as any).maze;
    let internal = 0;
    let border = 0;
    for (const w of maze.walls) {
      const onBorder = (w.x1 === 0 && w.x2 === 0) || (w.x1 === maze.width && w.x2 === maze.width) ||
        (w.y1 === 0 && w.y2 === 0) || (w.y1 === maze.height && w.y2 === maze.height);
      if (onBorder) {
        assert.equal(w.maxHp, Infinity, "border wall indestructible");
        border++;
      } else {
        assert.equal(w.hp, 3, "internal wall has HP");
        assert.equal(w.maxHp, 3);
        internal++;
      }
    }
    assert.ok(internal > 0, "there are internal walls");
    assert.ok(border > 0, "there are border walls");
  });

  it("bullets damage walls and destroyed walls no longer block movement", () => {
    const g = makeGame({
      cfg: { destructibleWalls: true },
      adv: { wallHp: 1, fireCooldown: 0, bulletBounces: 0 },
      maze: new Maze(10, 8, "cross"),
      players: [{ id: "a", name: "A" }],
    });
    const a = tank(g, "a");
    a.shieldTimer = 0;
    const maze = (g as any).maze;
    const internal = maze.walls.find((w: any) => w.maxHp !== Infinity);
    assert.ok(internal, "found an internal wall");
    a.x = internal.x1 - 20;
    a.y = internal.y1;
    a.bodyAngle = 0;
    a.turretAngle = 0;
    a.ammo = 5;
    a.input = input({ fire: true, aim: 0 });
    const hpBefore = internal.hp;
    g.step(1 / 30);
    g.step(1 / 30);
    g.step(1 / 30);
    assert.ok(internal.hp < hpBefore || internal.hp === 0, "wall was damaged by the bullet");
  });

  it("explosive rounds deal AoE damage to nearby walls", () => {
    const g = makeGame({
      cfg: { destructibleWalls: true },
      adv: { wallHp: 5, fireCooldown: 0 },
      maze: new Maze(10, 8, "cross"),
      players: [{ id: "a", name: "A" }],
    });
    const a = tank(g, "a");
    a.shieldTimer = 0;
    a.weapon = "explosive";
    a.weaponCharges = 5;
    a.ammo = 5;
    const maze = (g as any).maze;
    const internal = maze.walls.find((w: any) => w.maxHp !== Infinity);
    assert.ok(internal);
    a.x = internal.x1 - 15;
    a.y = internal.y1;
    a.input = input({ fire: true, aim: 0 });
    const hpBefore = internal.hp;
    g.step(1 / 30);
    g.step(1 / 30);
    g.step(1 / 30);
    assert.ok(internal.hp < hpBefore, "explosive round damaged the wall (AoE)");
  });

  it("snapshot includes wallHp only when destructibleWalls is on", () => {
    const g1 = makeGame({
      cfg: { destructibleWalls: false },
      players: [{ id: "a", name: "A" }],
    });
    assert.deepEqual(g1.snapshot(0).wallHp, []);

    const g2 = makeGame({
      cfg: { destructibleWalls: true },
      adv: { wallHp: 3 },
      maze: new Maze(10, 8, "cross"),
      players: [{ id: "a", name: "A" }],
    });
    assert.deepEqual(g2.snapshot(0).wallHp, []);
    const maze = (g2 as any).maze;
    const internal = maze.walls.find((w: any) => w.maxHp !== Infinity);
    maze.damageWall(internal, 1);
    const wallHp = g2.snapshot(0).wallHp;
    assert.equal(wallHp.length, 1);
    assert.equal(wallHp[0].hp, 2);
  });

  it("destroyed walls (hp 0) are reported in the snapshot", () => {
    const g = makeGame({
      cfg: { destructibleWalls: true },
      adv: { wallHp: 1 },
      maze: new Maze(10, 8, "cross"),
      players: [{ id: "a", name: "A" }],
    });
    const maze = (g as any).maze;
    const internal = maze.walls.find((w: any) => w.maxHp !== Infinity);
    maze.damageWall(internal, 1);
    assert.equal(internal.hp, 0, "wall is destroyed");
    const wallHp = g.snapshot(0).wallHp;
    const entry = wallHp.find((w) => maze.walls[w.index] === internal);
    assert.ok(entry, "destroyed wall is included so the client can hide it");
    assert.equal(entry!.hp, 0);
  });

  it("interior walls are per-cell, so one hit only breaks one cell", () => {
    const g = makeGame({
      cfg: { destructibleWalls: true },
      adv: { wallHp: 1 },
      maze: new Maze(10, 8, "cross"),
      players: [{ id: "a", name: "A" }],
    });
    const maze = (g as any).maze;
    // Every destructible wall spans a single cell edge (length == cell size).
    for (const w of maze.walls) {
      if (w.maxHp === Infinity) continue;
      const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
      assert.equal(len, maze.cell, "destructible wall is one cell long");
    }
    const internal = maze.walls.find((w: any) => w.maxHp !== Infinity);
    maze.damageWall(internal, 1);
    const destroyed = maze.walls.filter((w: any) => w.maxHp !== Infinity && w.hp <= 0);
    assert.equal(destroyed.length, 1, "only the hit cell broke");
  });

  it("damaged walls regenerate to full once clear, but not while blocked", () => {
    const g = makeGame({
      cfg: { destructibleWalls: true },
      adv: { wallHp: 2 },
      maze: new Maze(10, 8, "cross"),
      players: [{ id: "a", name: "A" }],
    });
    const a = tank(g, "a");
    const maze = (g as any).maze;
    const internal = maze.walls.find((w: any) => w.maxHp !== Infinity);
    maze.damageWall(internal, 2);
    assert.equal(internal.hp, 0);

    // A tank sitting on the wall keeps it from regrowing past the timer.
    a.x = (internal.x1 + internal.x2) / 2;
    a.y = (internal.y1 + internal.y2) / 2;
    maze.regenWalls(WALL_REGEN_SECONDS + 1, [{ x: a.x, y: a.y }], 14);
    assert.equal(internal.hp, 0, "blocked wall stays broken");

    // Once nothing overlaps it, the wall heals back to full.
    maze.regenWalls(0, [{ x: 99999, y: 99999 }], 14);
    assert.equal(internal.hp, internal.maxHp, "wall regrew to full");
  });
});

describe("tank collision", () => {
  it("overlapping tanks are pushed apart when tankCollision is true", () => {
    const g = makeGame({
      cfg: { tankCollision: true },
      players: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });
    const a = tank(g, "a");
    const b = tank(g, "b");
    const r = (g as any).adv.tankRadius;
    
    // Place them almost exactly on top of each other, away from walls
    a.x = 200;
    a.y = 200;
    b.x = 201;
    b.y = 200;
    
    (g as any).step(0.1);
    
    // They should be pushed apart to exactly 2 * tankRadius distance
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    assert.ok(dist >= 2 * r - 0.5, `tanks pushed apart: dist ${dist} >= ${2*r}`);
  });

  it("tanks are NOT pushed apart when tankCollision is false", () => {
    const g = makeGame({
      cfg: { tankCollision: false },
      players: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    });
    const a = tank(g, "a");
    const b = tank(g, "b");
    
    // Place them almost exactly on top of each other
    a.x = 200;
    a.y = 200;
    b.x = 201;
    b.y = 200;
    
    (g as any).step(0.1);
    
    // They should not have moved
    assert.equal(a.x, 200);
    assert.equal(b.x, 201);
  });
});

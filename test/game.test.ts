import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_GAME_CONFIG,
  type AdvancedConfig,
  type GameConfig,
  type InputState,
} from "../src/shared/protocol.js";
import { Game } from "../src/server/game.js";
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

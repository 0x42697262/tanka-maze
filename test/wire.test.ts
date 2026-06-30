import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  POWERUP_TYPES,
  WEAPON_POWERUPS,
  type InputState,
  type RosterEntry,
  type SnapshotDTO,
  type TankDTO,
} from "../src/shared/protocol.js";
import { decodeInput, decodeSnapshot, encodeInput, encodeSlimSnapshot, encodeSnapshot } from "../src/shared/wire.js";

const toAB = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

const baseInput: InputState = {
  forward: false,
  backward: false,
  turnLeft: false,
  turnRight: false,
  fire: false,
  aim: 0,
  eightDir: false,
  joystick: false,
};

function tank(over: Partial<TankDTO> = {}): TankDTO {
  return {
    index: 0,
    id: "a",
    name: "A",
    color: "#fff",
    x: 0,
    y: 0,
    bodyAngle: 0,
    turretAngle: 0,
    alive: true,
    score: 0,
    respawnIn: 0,
    hp: 1,
    maxHp: 1,
    ammo: 5,
    maxAmmo: 5,
    reloadIn: 0,
    weapon: null,
    weaponCharges: 0,
    livesLeft: 0,
    boosted: false,
    shielded: false,
    charging: false,
    scoped: false,
    team: 0,
    captures: 0,
    ...over,
  };
}

const roster = (): Map<number, RosterEntry> =>
  new Map([[0, { index: 0, id: "a", name: "A", color: "#fff", team: 0, maxHp: 1, maxAmmo: 5 }]]);

function emptySnap(over: Partial<SnapshotDTO> = {}): SnapshotDTO {
  return { t: 0, tanks: [], bullets: [], powerups: [], flags: [], blasts: [], beams: [], events: [], wallHp: [], ...over };
}

describe("wire: input", () => {
  it("round-trips every flag + the joystick bit", () => {
    const i: InputState = {
      forward: true,
      backward: false,
      turnLeft: true,
      turnRight: false,
      fire: true,
      aim: 1.23,
      eightDir: true,
      joystick: true,
    };
    const out = decodeInput(toAB(encodeInput(i)));
    assert.equal(out.forward, true);
    assert.equal(out.turnLeft, true);
    assert.equal(out.fire, true);
    assert.equal(out.eightDir, true);
    assert.equal(out.joystick, true);
    assert.ok(Math.abs(out.aim - 1.23) < 0.01);
  });

  it("wraps large aim angles into [-π, π] without saturating", () => {
    const out = decodeInput(toAB(encodeInput({ ...baseInput, aim: 50.3 })));
    let expected = 50.3 % (Math.PI * 2);
    if (expected > Math.PI) expected -= Math.PI * 2;
    assert.ok(Math.abs(out.aim - expected) < 0.01, `got ${out.aim}`);
  });
});

describe("wire: snapshot", () => {
  it("round-trips tank pose + status flags + lives", () => {
    const t = tank({ x: 123, y: 456, hp: 3, maxHp: 3, score: 60, scoped: true, boosted: true, livesLeft: 2, captures: 4 });
    const out = decodeSnapshot(toAB(encodeSnapshot(emptySnap({ tanks: [t] }))), roster());
    const o = out.tanks[0];
    assert.equal(Math.round(o.x), 123);
    assert.equal(Math.round(o.y), 456);
    assert.equal(o.score, 60);
    assert.equal(o.scoped, true);
    assert.equal(o.boosted, true);
    assert.equal(o.shielded, false);
    assert.equal(o.livesLeft, 2);
    assert.equal(o.captures, 4);
  });

  it("round-trips every weapon code (incl. null) — derived from the registry", () => {
    for (const w of [null, ...WEAPON_POWERUPS]) {
      const snap = emptySnap({ tanks: [tank({ weapon: w, weaponCharges: 2 })] });
      const out = decodeSnapshot(toAB(encodeSnapshot(snap)), roster());
      assert.equal(out.tanks[0].weapon, w, `weapon ${w}`);
    }
  });

  it("round-trips every power-up pickup type", () => {
    for (const type of POWERUP_TYPES) {
      const snap = emptySnap({ powerups: [{ id: 1, x: 10, y: 20, type }] });
      const out = decodeSnapshot(toAB(encodeSnapshot(snap)), new Map());
      assert.equal(out.powerups[0]?.type, type, `pickup ${type}`);
    }
  });

  it("carries kill events (with streak tier + multiplier)", () => {
    const snap = emptySnap({
      events: [{ type: 0, killer: 0, victim: 1, points: 60, streak: 5, mult: 3 }],
    });
    const out = decodeSnapshot(toAB(encodeSnapshot(snap)), roster());
    assert.equal(out.events.length, 1);
    assert.deepEqual(out.events[0], { type: 0, killer: 0, victim: 1, points: 60, streak: 5, mult: 3 });
  });

  it("round-trips CTF flags (team, state, position, carrier)", () => {
    const snap = emptySnap({
      flags: [
        { team: 0, x: 40, y: 50, state: "home", carrier: 255 },
        { team: 1, x: 700, y: 600, state: "carried", carrier: 3 },
      ],
    });
    const out = decodeSnapshot(toAB(encodeSnapshot(snap)), roster());
    assert.equal(out.flags.length, 2);
    assert.deepEqual(out.flags[0], { team: 0, x: 40, y: 50, state: "home", carrier: 255 });
    assert.equal(out.flags[1].state, "carried");
    assert.equal(out.flags[1].carrier, 3);
    assert.equal(Math.round(out.flags[1].x), 700);
  });

  it("truncates (not wraps) bullet counts past the 255-byte limit, so later fields don't desync", () => {
    const manyBullets = Array.from({ length: 260 }, (_, i) => ({
      id: i,
      x: 10,
      y: 20,
      ownerId: "a",
      kind: "normal" as const,
    }));
    const snap = emptySnap({
      bullets: manyBullets,
      powerups: [{ id: 1, x: 30, y: 40, type: "speed" as const }],
    });
    const out = decodeSnapshot(toAB(encodeSnapshot(snap)), roster());
    assert.equal(out.bullets.length, 255); // truncated, not silently byte-wrapped
    assert.equal(out.powerups.length, 1); // fields after bullets still decode correctly
    assert.equal(out.powerups[0].type, "speed");
  });

  it("slim snapshots update pose/status and inherit slow tank fields", () => {
    const prev = emptySnap({
      tanks: [
        tank({
          x: 100,
          y: 200,
          hp: 3,
          maxHp: 3,
          ammo: 4,
          score: 120,
          reloadIn: 1.2,
          weapon: "tracking",
          weaponCharges: 2,
          livesLeft: 1,
          captures: 5,
        }),
      ],
    });
    const slim = emptySnap({
      tanks: [
        tank({
          x: 140,
          y: 230,
          alive: false,
          boosted: true,
          shielded: true,
          respawnIn: 2.4,
        }),
      ],
      bullets: [{ id: 7, x: 11, y: 22, ownerId: "a", kind: "normal" }],
    });

    const out = decodeSnapshot(toAB(encodeSlimSnapshot(slim)), roster(), prev);
    const o = out.tanks[0];
    assert.equal(Math.round(o.x), 140);
    assert.equal(Math.round(o.y), 230);
    assert.equal(o.alive, false);
    assert.equal(o.boosted, true);
    assert.equal(o.shielded, true);
    assert.equal(o.score, 120);
    assert.equal(o.ammo, 4);
    assert.equal(o.weapon, "tracking");
    assert.equal(o.weaponCharges, 2);
    assert.equal(o.livesLeft, 1);
    assert.equal(o.captures, 5);
    assert.ok(Math.abs(o.respawnIn - 2.4) < 0.11);
    assert.equal(out.bullets[0]?.id, 7);
  });

  it("round-trips damaged walls (index + hp)", () => {
    const snap = emptySnap({
      wallHp: [
        { index: 3, hp: 2 },
        { index: 7, hp: 1 },
      ],
    });
    const out = decodeSnapshot(toAB(encodeSnapshot(snap)), roster());
    assert.equal(out.wallHp.length, 2);
    assert.deepEqual(out.wallHp[0], { index: 3, hp: 2 });
    assert.deepEqual(out.wallHp[1], { index: 7, hp: 1 });
  });
});

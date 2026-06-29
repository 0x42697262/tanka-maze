// Binary wire codec for the two high-frequency messages — client input and
// server snapshots. These dominate bandwidth, so they're packed into bytes
// instead of JSON. Everything else (lobby/config/welcome/…) stays JSON.
//
// Frame discrimination: text frames are JSON; binary frames are these. The
// first byte is a message tag.

import {
  POWERUP_TYPES,
  WEAPON_POWERUPS,
  type BulletKind,
  type FlagState,
  type InputState,
  type PowerupType,
  type RosterEntry,
  type SnapshotDTO,
  type TankDTO,
} from "./protocol.js";

export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;
export const MSG_SNAPSHOT_SLIM = 3;

// --- enum <-> code tables (derived from the power-up registry) -------------

// Active-weapon codes: 0 = none, then each weapon power-up in registry order.
const WEAPON_CODES: (PowerupType | null)[] = [null, ...WEAPON_POWERUPS];
const KIND_CODES: BulletKind[] = ["normal", "sniper", "explosive", "laser", "tracking"];
// Pickup codes: every power-up in registry order.
const PUP_CODES: PowerupType[] = POWERUP_TYPES;
// Flag-state codes.
const FLAG_STATES: FlagState[] = ["home", "carried", "dropped", "held"];
const flagStateCode = (s: FlagState): number => Math.max(0, FLAG_STATES.indexOf(s));

const weaponCode = (w: PowerupType | null): number => {
  const i = WEAPON_CODES.indexOf(w);
  return i < 0 ? 0 : i;
};
const kindCode = (k: BulletKind): number => Math.max(0, KIND_CODES.indexOf(k));
const pupCode = (p: PowerupType): number => Math.max(0, PUP_CODES.indexOf(p));

// --- quantization helpers --------------------------------------------------

const A = 32767 / Math.PI; // angle (radians) <-> int16
const TAU = Math.PI * 2;
// bodyAngle accumulates unbounded on the server, so wrap into [-π, π] before
// quantizing — otherwise large angles saturate the int16 and the body freezes.
const wrap = (rad: number): number => {
  let a = rad % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
};
const encAngle = (rad: number): number =>
  Math.max(-32767, Math.min(32767, Math.round(wrap(rad) * A)));
const decAngle = (v: number): number => v / A;
const u16 = (n: number): number => Math.max(0, Math.min(65535, Math.round(n)));
const ds = (sec: number): number => Math.max(0, Math.min(255, Math.round(sec * 10))); // deciseconds
const decDs = (v: number): number => v / 10;

// --- input (4 bytes) -------------------------------------------------------

export function encodeInput(i: InputState): Uint8Array {
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG_INPUT);
  let bits = 0;
  if (i.forward) bits |= 1;
  if (i.backward) bits |= 2;
  if (i.turnLeft) bits |= 4;
  if (i.turnRight) bits |= 8;
  if (i.fire) bits |= 16;
  if (i.eightDir) bits |= 32;
  if (i.joystick) bits |= 64;
  dv.setUint8(1, bits);
  dv.setInt16(2, encAngle(i.aim), true);
  return new Uint8Array(buf);
}

export function decodeInput(buf: ArrayBuffer): InputState {
  const dv = new DataView(buf);
  const bits = dv.getUint8(1);
  return {
    forward: (bits & 1) !== 0,
    backward: (bits & 2) !== 0,
    turnLeft: (bits & 4) !== 0,
    turnRight: (bits & 8) !== 0,
    fire: (bits & 16) !== 0,
    eightDir: (bits & 32) !== 0,
    joystick: (bits & 64) !== 0,
    aim: decAngle(dv.getInt16(2, true)),
  };
}

// --- snapshot --------------------------------------------------------------

const TANK_BYTES = 20;
const SLIM_TANK_BYTES = 11;

export function encodeSnapshot(s: SnapshotDTO): Uint8Array {
  const size =
    2 + // tag + tank count
    s.tanks.length * TANK_BYTES +
    1 +
    s.bullets.length * 8 +
    1 +
    s.powerups.length * 5 +
    1 +
    s.flags.length * 7 +
    1 +
    s.blasts.length * 4 +
    1 +
    s.beams.length * 8 +
    1 +
    s.events.length * 7 +
    2 +
    s.wallHp.length * 3; // u16 count, then u16 index + u8 hp per damaged wall
  const dv = new DataView(new ArrayBuffer(size));
  let o = 0;

  dv.setUint8(o++, MSG_SNAPSHOT);
  dv.setUint8(o++, s.tanks.length);
  for (const t of s.tanks) {
    dv.setUint8(o++, t.index);
    dv.setUint16(o, u16(t.x), true);
    o += 2;
    dv.setUint16(o, u16(t.y), true);
    o += 2;
    dv.setInt16(o, encAngle(t.bodyAngle), true);
    o += 2;
    dv.setInt16(o, encAngle(t.turretAngle), true);
    o += 2;
    let flags = 0;
    if (t.alive) flags |= 1;
    if (t.boosted) flags |= 2;
    if (t.shielded) flags |= 4;
    if (t.charging) flags |= 8;
    if (t.scoped) flags |= 16;
    dv.setUint8(o++, flags);
    dv.setUint8(o++, Math.min(255, t.hp));
    dv.setUint8(o++, Math.min(255, t.ammo));
    dv.setUint16(o, u16(t.score), true);
    o += 2;
    dv.setUint8(o++, ds(t.respawnIn));
    dv.setUint8(o++, ds(t.reloadIn));
    dv.setUint8(o++, weaponCode(t.weapon));
    dv.setUint8(o++, Math.min(255, t.weaponCharges));
    dv.setUint8(o++, Math.min(255, t.livesLeft));
    dv.setUint8(o++, Math.min(255, t.captures));
  }

  // Owner is sent as the tank's wire index (resolved back to color client-side).
  // 255 = unknown owner.
  const ownerIndex = new Map(s.tanks.map((t) => [t.id, t.index]));
  dv.setUint8(o++, s.bullets.length);
  for (const b of s.bullets) {
    dv.setUint16(o, b.id & 0xffff, true);
    o += 2;
    dv.setUint16(o, u16(b.x), true);
    o += 2;
    dv.setUint16(o, u16(b.y), true);
    o += 2;
    dv.setUint8(o++, kindCode(b.kind));
    dv.setUint8(o++, ownerIndex.get(b.ownerId) ?? 255);
  }

  dv.setUint8(o++, s.powerups.length);
  for (const p of s.powerups) {
    dv.setUint8(o++, pupCode(p.type));
    dv.setUint16(o, u16(p.x), true);
    o += 2;
    dv.setUint16(o, u16(p.y), true);
    o += 2;
  }

  dv.setUint8(o++, s.flags.length);
  for (const f of s.flags) {
    dv.setUint8(o++, f.team);
    dv.setUint8(o++, flagStateCode(f.state));
    dv.setUint16(o, u16(f.x), true);
    o += 2;
    dv.setUint16(o, u16(f.y), true);
    o += 2;
    dv.setUint8(o++, f.carrier & 0xff);
  }

  dv.setUint8(o++, s.blasts.length);
  for (const bl of s.blasts) {
    dv.setUint16(o, u16(bl.x), true);
    o += 2;
    dv.setUint16(o, u16(bl.y), true);
    o += 2;
  }

  dv.setUint8(o++, s.beams.length);
  for (const bm of s.beams) {
    dv.setUint16(o, u16(bm.x1), true);
    o += 2;
    dv.setUint16(o, u16(bm.y1), true);
    o += 2;
    dv.setUint16(o, u16(bm.x2), true);
    o += 2;
    dv.setUint16(o, u16(bm.y2), true);
    o += 2;
  }

  dv.setUint8(o++, s.events.length);
  for (const e of s.events) {
    dv.setUint8(o++, e.type);
    dv.setUint8(o++, e.killer);
    dv.setUint8(o++, e.victim);
    dv.setInt16(o, Math.max(-32767, Math.min(32767, e.points)), true);
    o += 2;
    dv.setUint8(o++, e.streak & 0xff);
    dv.setUint8(o++, Math.min(255, e.mult));
  }

  // Damaged walls (destructibleWalls only): index + current HP. The index is
  // u16 because per-cell destructible walls can exceed 255 on large maps.
  dv.setUint16(o, s.wallHp.length, true);
  o += 2;
  for (const w of s.wallHp) {
    dv.setUint16(o, w.index, true);
    o += 2;
    dv.setUint8(o++, Math.min(255, w.hp));
  }

  return new Uint8Array(dv.buffer);
}

/**
 * Smaller high-frequency snapshot. Tank stats that change slowly (score, ammo,
 * weapon charges, etc.) are refreshed by periodic full snapshots; this frame
 * keeps only pose + visual status for smooth interpolation between them.
 */
export function encodeSlimSnapshot(s: SnapshotDTO): Uint8Array {
  const size =
    2 +
    s.tanks.length * SLIM_TANK_BYTES +
    1 +
    s.bullets.length * 8 +
    1 +
    s.powerups.length * 5 +
    1 +
    s.flags.length * 7 +
    1 +
    s.blasts.length * 4 +
    1 +
    s.beams.length * 8 +
    1 +
    s.events.length * 7;
  const dv = new DataView(new ArrayBuffer(size));
  let o = 0;

  dv.setUint8(o++, MSG_SNAPSHOT_SLIM);
  dv.setUint8(o++, s.tanks.length);
  for (const t of s.tanks) {
    dv.setUint8(o++, t.index);
    dv.setUint16(o, u16(t.x), true);
    o += 2;
    dv.setUint16(o, u16(t.y), true);
    o += 2;
    dv.setInt16(o, encAngle(t.bodyAngle), true);
    o += 2;
    dv.setInt16(o, encAngle(t.turretAngle), true);
    o += 2;
    let flags = 0;
    if (t.alive) flags |= 1;
    if (t.boosted) flags |= 2;
    if (t.shielded) flags |= 4;
    if (t.charging) flags |= 8;
    if (t.scoped) flags |= 16;
    dv.setUint8(o++, flags);
    dv.setUint8(o++, ds(t.respawnIn));
  }

  o = encodeSnapshotTail(dv, o, s);
  return new Uint8Array(dv.buffer.slice(0, o));
}

function encodeSnapshotTail(dv: DataView, offset: number, s: SnapshotDTO): number {
  let o = offset;
  const ownerIndex = new Map(s.tanks.map((t) => [t.id, t.index]));
  dv.setUint8(o++, s.bullets.length);
  for (const b of s.bullets) {
    dv.setUint16(o, b.id & 0xffff, true);
    o += 2;
    dv.setUint16(o, u16(b.x), true);
    o += 2;
    dv.setUint16(o, u16(b.y), true);
    o += 2;
    dv.setUint8(o++, kindCode(b.kind));
    dv.setUint8(o++, ownerIndex.get(b.ownerId) ?? 255);
  }

  dv.setUint8(o++, s.powerups.length);
  for (const p of s.powerups) {
    dv.setUint8(o++, pupCode(p.type));
    dv.setUint16(o, u16(p.x), true);
    o += 2;
    dv.setUint16(o, u16(p.y), true);
    o += 2;
  }

  dv.setUint8(o++, s.flags.length);
  for (const f of s.flags) {
    dv.setUint8(o++, f.team);
    dv.setUint8(o++, flagStateCode(f.state));
    dv.setUint16(o, u16(f.x), true);
    o += 2;
    dv.setUint16(o, u16(f.y), true);
    o += 2;
    dv.setUint8(o++, f.carrier & 0xff);
  }

  dv.setUint8(o++, s.blasts.length);
  for (const bl of s.blasts) {
    dv.setUint16(o, u16(bl.x), true);
    o += 2;
    dv.setUint16(o, u16(bl.y), true);
    o += 2;
  }

  dv.setUint8(o++, s.beams.length);
  for (const bm of s.beams) {
    dv.setUint16(o, u16(bm.x1), true);
    o += 2;
    dv.setUint16(o, u16(bm.y1), true);
    o += 2;
    dv.setUint16(o, u16(bm.x2), true);
    o += 2;
    dv.setUint16(o, u16(bm.y2), true);
    o += 2;
  }

  dv.setUint8(o++, s.events.length);
  for (const e of s.events) {
    dv.setUint8(o++, e.type);
    dv.setUint8(o++, e.killer);
    dv.setUint8(o++, e.victim);
    dv.setInt16(o, Math.max(-32767, Math.min(32767, e.points)), true);
    o += 2;
    dv.setUint8(o++, e.streak & 0xff);
    dv.setUint8(o++, Math.min(255, e.mult));
  }
  return o;
}

/** Rebuild a full SnapshotDTO by joining the packed dynamic fields with the
 *  static roster info. Tanks with no roster entry are skipped. */
export function decodeSnapshot(buf: ArrayBuffer, roster: Map<number, RosterEntry>, previous?: SnapshotDTO | null): SnapshotDTO {
  const dv = new DataView(buf);
  const tag = dv.getUint8(0);
  if (tag === MSG_SNAPSHOT_SLIM) return decodeSlimSnapshot(dv, roster, previous ?? null);
  let o = 1; // skip tag

  const tanks: TankDTO[] = [];
  const tankCount = dv.getUint8(o++);
  for (let i = 0; i < tankCount; i++) {
    const index = dv.getUint8(o++);
    const x = dv.getUint16(o, true);
    o += 2;
    const y = dv.getUint16(o, true);
    o += 2;
    const bodyAngle = decAngle(dv.getInt16(o, true));
    o += 2;
    const turretAngle = decAngle(dv.getInt16(o, true));
    o += 2;
    const flags = dv.getUint8(o++);
    const hp = dv.getUint8(o++);
    const ammo = dv.getUint8(o++);
    const score = dv.getUint16(o, true);
    o += 2;
    const respawnIn = decDs(dv.getUint8(o++));
    const reloadIn = decDs(dv.getUint8(o++));
    const weapon = WEAPON_CODES[dv.getUint8(o++)] ?? null;
    const weaponCharges = dv.getUint8(o++);
    const livesLeft = dv.getUint8(o++);
    const captures = dv.getUint8(o++);
    const r = roster.get(index);
    tanks.push({
      index,
      id: r?.id ?? String(index),
      name: r?.name ?? "?",
      color: r?.color ?? "#888888",
      team: r?.team ?? -1,
      maxHp: r?.maxHp ?? hp,
      maxAmmo: r?.maxAmmo ?? ammo,
      x,
      y,
      bodyAngle,
      turretAngle,
      alive: (flags & 1) !== 0,
      boosted: (flags & 2) !== 0,
      shielded: (flags & 4) !== 0,
      charging: (flags & 8) !== 0,
      scoped: (flags & 16) !== 0,
      hp,
      ammo,
      score,
      respawnIn,
      reloadIn,
      weapon,
      weaponCharges,
      livesLeft,
      captures,
    });
  }

  const bullets = [];
  const bulletCount = dv.getUint8(o++);
  for (let i = 0; i < bulletCount; i++) {
    const id = dv.getUint16(o, true);
    o += 2;
    const x = dv.getUint16(o, true);
    o += 2;
    const y = dv.getUint16(o, true);
    o += 2;
    const kind = KIND_CODES[dv.getUint8(o++)] ?? "normal";
    const ownerIndex = dv.getUint8(o++);
    const ownerId = roster.get(ownerIndex)?.id ?? "";
    bullets.push({ id, x, y, ownerId, kind });
  }

  const powerups = [];
  const powerupCount = dv.getUint8(o++);
  for (let i = 0; i < powerupCount; i++) {
    const type = PUP_CODES[dv.getUint8(o++)] ?? "speed";
    const x = dv.getUint16(o, true);
    o += 2;
    const y = dv.getUint16(o, true);
    o += 2;
    powerups.push({ id: i, type, x, y });
  }

  const flags = [];
  const flagCount = dv.getUint8(o++);
  for (let i = 0; i < flagCount; i++) {
    const team = dv.getUint8(o++);
    const state = FLAG_STATES[dv.getUint8(o++)] ?? "home";
    const x = dv.getUint16(o, true);
    o += 2;
    const y = dv.getUint16(o, true);
    o += 2;
    const carrier = dv.getUint8(o++);
    flags.push({ team, state, x, y, carrier });
  }

  const blasts = [];
  const blastCount = dv.getUint8(o++);
  for (let i = 0; i < blastCount; i++) {
    const x = dv.getUint16(o, true);
    o += 2;
    const y = dv.getUint16(o, true);
    o += 2;
    blasts.push({ x, y });
  }

  const beams = [];
  const beamCount = dv.getUint8(o++);
  for (let i = 0; i < beamCount; i++) {
    const x1 = dv.getUint16(o, true);
    o += 2;
    const y1 = dv.getUint16(o, true);
    o += 2;
    const x2 = dv.getUint16(o, true);
    o += 2;
    const y2 = dv.getUint16(o, true);
    o += 2;
    beams.push({ x1, y1, x2, y2 });
  }

  const events = [];
  const eventCount = dv.getUint8(o++);
  for (let i = 0; i < eventCount; i++) {
    const type = dv.getUint8(o++);
    const killer = dv.getUint8(o++);
    const victim = dv.getUint8(o++);
    const points = dv.getInt16(o, true);
    o += 2;
    const streak = dv.getUint8(o++);
    const mult = dv.getUint8(o++);
    events.push({ type, killer, victim, points, streak, mult });
  }

  const wallHp: Array<{ index: number; hp: number }> = [];
  const wallHpCount = dv.getUint16(o, true);
  o += 2;
  for (let i = 0; i < wallHpCount; i++) {
    const index = dv.getUint16(o, true);
    o += 2;
    const hp = dv.getUint8(o++);
    wallHp.push({ index, hp });
  }

  return { t: 0, tanks, bullets, powerups, flags, blasts, beams, events, wallHp };
}

function decodeSlimSnapshot(
  dv: DataView,
  roster: Map<number, RosterEntry>,
  previous: SnapshotDTO | null
): SnapshotDTO {
  let o = 1;
  const previousTanks = new Map(previous?.tanks.map((t) => [t.index, t]) ?? []);

  const tanks: TankDTO[] = [];
  const tankCount = dv.getUint8(o++);
  for (let i = 0; i < tankCount; i++) {
    const index = dv.getUint8(o++);
    const x = dv.getUint16(o, true);
    o += 2;
    const y = dv.getUint16(o, true);
    o += 2;
    const bodyAngle = decAngle(dv.getInt16(o, true));
    o += 2;
    const turretAngle = decAngle(dv.getInt16(o, true));
    o += 2;
    const flags = dv.getUint8(o++);
    const respawnIn = decDs(dv.getUint8(o++));
    const r = roster.get(index);
    const prev = previousTanks.get(index);
    tanks.push({
      index,
      id: r?.id ?? prev?.id ?? String(index),
      name: r?.name ?? prev?.name ?? "?",
      color: r?.color ?? prev?.color ?? "#888888",
      team: r?.team ?? prev?.team ?? 0,
      maxHp: r?.maxHp ?? prev?.maxHp ?? 1,
      maxAmmo: r?.maxAmmo ?? prev?.maxAmmo ?? 0,
      x,
      y,
      bodyAngle,
      turretAngle,
      alive: (flags & 1) !== 0,
      boosted: (flags & 2) !== 0,
      shielded: (flags & 4) !== 0,
      charging: (flags & 8) !== 0,
      scoped: (flags & 16) !== 0,
      hp: prev?.hp ?? r?.maxHp ?? 1,
      ammo: prev?.ammo ?? r?.maxAmmo ?? 0,
      score: prev?.score ?? 0,
      respawnIn,
      reloadIn: prev?.reloadIn ?? 0,
      weapon: prev?.weapon ?? null,
      weaponCharges: prev?.weaponCharges ?? 0,
      livesLeft: prev?.livesLeft ?? 0,
      captures: prev?.captures ?? 0,
    });
  }

  return decodeSnapshotTail(dv, o, roster, tanks, previous);
}

function decodeSnapshotTail(
  dv: DataView,
  offset: number,
  roster: Map<number, RosterEntry>,
  tanks: TankDTO[],
  previous: SnapshotDTO | null
): SnapshotDTO {
  let o = offset;
  const bullets = [];
  const bulletCount = dv.getUint8(o++);
  for (let i = 0; i < bulletCount; i++) {
    const id = dv.getUint16(o, true);
    o += 2;
    const x = dv.getUint16(o, true);
    o += 2;
    const y = dv.getUint16(o, true);
    o += 2;
    const kind = KIND_CODES[dv.getUint8(o++)] ?? "normal";
    const ownerIndex = dv.getUint8(o++);
    const ownerId = roster.get(ownerIndex)?.id ?? "";
    bullets.push({ id, x, y, ownerId, kind });
  }

  const powerups = [];
  const powerupCount = dv.getUint8(o++);
  for (let i = 0; i < powerupCount; i++) {
    const type = PUP_CODES[dv.getUint8(o++)] ?? "speed";
    const x = dv.getUint16(o, true);
    o += 2;
    const y = dv.getUint16(o, true);
    o += 2;
    powerups.push({ id: i, type, x, y });
  }

  const flags = [];
  const flagCount = dv.getUint8(o++);
  for (let i = 0; i < flagCount; i++) {
    const team = dv.getUint8(o++);
    const state = FLAG_STATES[dv.getUint8(o++)] ?? "home";
    const x = dv.getUint16(o, true);
    o += 2;
    const y = dv.getUint16(o, true);
    o += 2;
    const carrier = dv.getUint8(o++);
    flags.push({ team, state, x, y, carrier });
  }

  const blasts = [];
  const blastCount = dv.getUint8(o++);
  for (let i = 0; i < blastCount; i++) {
    const x = dv.getUint16(o, true);
    o += 2;
    const y = dv.getUint16(o, true);
    o += 2;
    blasts.push({ x, y });
  }

  const beams = [];
  const beamCount = dv.getUint8(o++);
  for (let i = 0; i < beamCount; i++) {
    const x1 = dv.getUint16(o, true);
    o += 2;
    const y1 = dv.getUint16(o, true);
    o += 2;
    const x2 = dv.getUint16(o, true);
    o += 2;
    const y2 = dv.getUint16(o, true);
    o += 2;
    beams.push({ x1, y1, x2, y2 });
  }

  const events = [];
  const eventCount = dv.getUint8(o++);
  for (let i = 0; i < eventCount; i++) {
    const type = dv.getUint8(o++);
    const killer = dv.getUint8(o++);
    const victim = dv.getUint8(o++);
    const points = dv.getInt16(o, true);
    o += 2;
    const streak = dv.getUint8(o++);
    const mult = dv.getUint8(o++);
    events.push({ type, killer, victim, points, streak, mult });
  }

  // Slim snapshots don't carry wall HP; inherit it from the last full snapshot.
  const wallHp = previous?.wallHp ?? [];
  return { t: 0, tanks, bullets, powerups, flags, blasts, beams, events, wallHp };
}

/** Byte-equality check for snapshot change-gating. */
export function bytesEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Binary wire codec for the two high-frequency messages — client input and
// server snapshots. These dominate bandwidth, so they're packed into bytes
// instead of JSON. Everything else (lobby/config/welcome/…) stays JSON.
//
// Frame discrimination: text frames are JSON; binary frames are these. The
// first byte is a message tag.

import type {
  BulletKind,
  InputState,
  PowerupType,
  RosterEntry,
  SnapshotDTO,
  TankDTO,
} from "./protocol.js";

export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;

// --- enum <-> code tables --------------------------------------------------

const WEAPON_CODES: (PowerupType | null)[] = [
  null,
  "sniper",
  "explosive",
  "laser",
  "tracking",
  "multishot",
];
const KIND_CODES: BulletKind[] = ["normal", "sniper", "explosive", "laser", "tracking"];
const PUP_CODES: PowerupType[] = [
  "speed",
  "shield",
  "sniper",
  "explosive",
  "laser",
  "tracking",
  "multishot",
  "scope",
];

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

const TANK_BYTES = 18;

export function encodeSnapshot(s: SnapshotDTO): Uint8Array {
  const size =
    2 + // tag + tank count
    s.tanks.length * TANK_BYTES +
    1 +
    s.bullets.length * 7 +
    1 +
    s.powerups.length * 5 +
    1 +
    s.blasts.length * 4 +
    1 +
    s.beams.length * 8 +
    1 +
    s.events.length * 5;
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
  }

  dv.setUint8(o++, s.bullets.length);
  for (const b of s.bullets) {
    dv.setUint16(o, b.id & 0xffff, true);
    o += 2;
    dv.setUint16(o, u16(b.x), true);
    o += 2;
    dv.setUint16(o, u16(b.y), true);
    o += 2;
    dv.setUint8(o++, kindCode(b.kind));
  }

  dv.setUint8(o++, s.powerups.length);
  for (const p of s.powerups) {
    dv.setUint8(o++, pupCode(p.type));
    dv.setUint16(o, u16(p.x), true);
    o += 2;
    dv.setUint16(o, u16(p.y), true);
    o += 2;
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
  }

  return new Uint8Array(dv.buffer);
}

/** Rebuild a full SnapshotDTO by joining the packed dynamic fields with the
 *  static roster info. Tanks with no roster entry are skipped. */
export function decodeSnapshot(buf: ArrayBuffer, roster: Map<number, RosterEntry>): SnapshotDTO {
  const dv = new DataView(buf);
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
    const r = roster.get(index);
    tanks.push({
      index,
      id: r?.id ?? String(index),
      name: r?.name ?? "?",
      color: r?.color ?? "#888888",
      team: r?.team ?? 0,
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
    bullets.push({ id, x, y, ownerId: "", kind });
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
    events.push({ type, killer, victim, points });
  }

  return { t: 0, tanks, bullets, powerups, blasts, beams, events };
}

/** Byte-equality check for snapshot change-gating. */
export function bytesEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

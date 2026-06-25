import { BULLET_RADIUS, POWERUP_RADIUS, TANK_RADIUS } from "../shared/constants.js";
import {
  powerupDef,
  type BulletKind,
  type MazeDTO,
  type PowerupDTO,
  type SnapshotDTO,
  type TankDTO,
} from "../shared/protocol.js";

// Render this far in the past so we always have two snapshots to interpolate
// between. Must exceed the network send interval (≈66ms at 15 Hz) with margin.
const INTERP_DELAY = 140;

// Bullets are black; size varies a little by kind. Tracking rounds render as a
// triangle (drawn separately), the rest as filled circles.
const BULLET_COLOR = "#11100e";
const BULLET_STYLE: Record<BulletKind, { dr: number }> = {
  normal: { dr: 0 },
  sniper: { dr: 0 },
  explosive: { dr: 2 },
  laser: { dr: -1 },
  tracking: { dr: 1 },
};

interface Buffered {
  snap: SnapshotDTO;
  recvAt: number;
}

interface Explosion {
  x: number;
  y: number;
  color: string;
  start: number; // ms
}

const EXPLOSION_MS = 600;
const BEAM_MS = 170;

interface Beam {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  start: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private maze: MazeDTO | null = null;
  private buffer: Buffered[] = [];
  private explosions: Explosion[] = [];
  private beams: Beam[] = [];
  // Per-game visual sizes (from the lobby's advanced config).
  private tankR = TANK_RADIUS;
  private bulletR = BULLET_RADIUS;
  // Bullet-physics params for the local-only scope (aiming guide) simulation.
  private scope = {
    range: 1320,
    laserRange: 1320,
    bulletSpeed: 240,
    bounces: 3,
    multiCount: 3,
    multiSpread: 30,
  };
  // Last seen state per tank, to detect deaths and spawn explosions.
  private lastTankState = new Map<string, { x: number; y: number; alive: boolean; color: string }>();

  setParams(tankRadius: number, bulletRadius: number): void {
    this.tankR = tankRadius;
    this.bulletR = bulletRadius;
  }

  /** Bullet-physics params used to draw the local player's aiming guide. */
  setScope(p: {
    range: number;
    laserRange: number;
    bulletSpeed: number;
    bounces: number;
    multiCount: number;
    multiSpread: number;
  }): void {
    this.scope = { ...p };
  }

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
  }

  setMaze(maze: MazeDTO): void {
    this.maze = maze;
    this.canvas.width = maze.width;
    this.canvas.height = maze.height;
    this.buffer = [];
    this.explosions = [];
    this.beams = [];
    this.lastTankState.clear();
  }

  push(snap: SnapshotDTO, nowMs: number): void {
    this.detectDeaths(snap, nowMs);
    // Transient effects emitted by the server this tick.
    for (const b of snap.blasts) {
      this.explosions.push({ x: b.x, y: b.y, color: "#e6863f", start: nowMs });
    }
    for (const bm of snap.beams) {
      this.beams.push({ x1: bm.x1, y1: bm.y1, x2: bm.x2, y2: bm.y2, start: nowMs });
    }
    this.buffer.push({ snap, recvAt: nowMs });
    if (this.buffer.length > 30) this.buffer.shift();
  }

  /** Spawn an explosion wherever a tank went from alive to dead/gone. */
  private detectDeaths(snap: SnapshotDTO, nowMs: number): void {
    const seen = new Set<string>();
    for (const t of snap.tanks) {
      seen.add(t.id);
      const prev = this.lastTankState.get(t.id);
      if (prev && prev.alive && !t.alive) {
        this.explosions.push({ x: prev.x, y: prev.y, color: t.color, start: nowMs });
      }
      this.lastTankState.set(t.id, { x: t.x, y: t.y, alive: t.alive, color: t.color });
    }
    // A previously-alive tank that vanished (killed while disconnected) also pops.
    for (const [id, prev] of this.lastTankState) {
      if (!seen.has(id)) {
        if (prev.alive) this.explosions.push({ x: prev.x, y: prev.y, color: prev.color, start: nowMs });
        this.lastTankState.delete(id);
      }
    }
  }

  /** Most recent snapshot — used for authoritative HUD/score and local aim. */
  latest(): SnapshotDTO | null {
    return this.buffer.length ? this.buffer[this.buffer.length - 1].snap : null;
  }

  render(localId: string, nowMs: number): void {
    const { ctx, maze } = this;
    if (!maze) return;

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawMaze(maze);

    const interp = this.interpolated(nowMs);
    if (!interp) return;

    // Power-up pickups (stationary — drawn from the latest snapshot, no interp).
    this.drawPowerups(this.latest()?.powerups ?? [], nowMs);

    for (const b of interp.bullets) {
      const style = BULLET_STYLE[b.kind] ?? BULLET_STYLE.normal;
      const rad = Math.max(1, this.bulletR + style.dr);
      ctx.fillStyle = BULLET_COLOR;
      if (b.kind === "tracking") {
        // Triangle pointing in the travel direction.
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.dir ?? 0);
        const r = rad + 1.5;
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(-r * 0.8, r * 0.8);
        ctx.lineTo(-r * 0.8, -r * 0.8);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(b.x, b.y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Aiming guide (local player only) — drawn under the tanks would be hidden
    // by them, so draw it just before so the dotted line reads clearly.
    this.drawScope(interp);

    for (const t of interp.tanks) {
      this.drawTank(t, t.id === localId, nowMs);
    }

    this.drawBeams(nowMs);
    this.drawExplosions(nowMs);
  }

  /**
   * Line-of-sight scope: a dotted guide showing where a shot would travel from
   * a scoped tank, accounting for the tank's velocity (inherited by the round)
   * and wall bounces. Drawn for EVERY scoped tank — others can see who has it —
   * yet still computed purely client-side (the server only flags `scoped`), so
   * it adds no simulation cost.
   */
  private drawScope(interp: SnapshotDTO): void {
    if (!this.maze) return;
    const { ctx } = this;
    for (const t of interp.tanks) {
      if (!t.alive || !t.scoped) continue;
      const paths = this.scopePaths(t, this.tankVelocity(t.id));
      ctx.save();
      ctx.lineCap = "round";
      ctx.strokeStyle = t.color;
      ctx.fillStyle = t.color;
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([5, 7]);
      ctx.lineWidth = 2;
      for (const path of paths) {
        if (path.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
        ctx.stroke();
      }
      // Solid impact pip at the end of each guide.
      ctx.setLineDash([]);
      for (const path of paths) {
        const end = path[path.length - 1];
        if (!end) continue;
        ctx.beginPath();
        ctx.arc(end.x, end.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  /** One or more trajectory polylines for a tank's current weapon. */
  private scopePaths(me: TankDTO, vel: { x: number; y: number }): Array<{ x: number; y: number }[]> {
    const a = me.turretAngle;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const sc = this.scope;

    if (me.weapon === "laser") {
      // Hitscan beam: from the muzzle along the turret, reflecting, no momentum.
      const ox = me.x + ca * (this.tankR + 2);
      const oy = me.y + sa * (this.tankR + 2);
      return [this.walkPath(ox, oy, ca, sa, sc.laserRange, Infinity, false, false)];
    }

    const muzzle = this.tankR + this.bulletR + 2;
    const ox = me.x + ca * muzzle;
    const oy = me.y + sa * muzzle;

    if (me.weapon === "sniper") {
      // Flies straight & fast, no momentum, punches through walls.
      return [this.walkPath(ox, oy, ca, sa, sc.range, 0, false, true)];
    }

    const speed = sc.bulletSpeed;
    const stopOnWall = me.weapon === "explosive";
    const bounces = stopOnWall ? 0 : sc.bounces;

    if (me.weapon === "multishot") {
      const n = Math.max(1, Math.round(sc.multiCount));
      const fan = (sc.multiSpread * Math.PI) / 180;
      const step = n > 1 ? fan / (n - 1) : 0;
      const start = a - fan / 2;
      const paths: Array<{ x: number; y: number }[]> = [];
      for (let i = 0; i < n; i++) {
        const ang = n > 1 ? start + step * i : a;
        const mx = me.x + Math.cos(ang) * muzzle;
        const my = me.y + Math.sin(ang) * muzzle;
        paths.push(
          this.walkPath(mx, my, Math.cos(ang) * speed + vel.x, Math.sin(ang) * speed + vel.y, sc.range, bounces, false, false)
        );
      }
      return paths;
    }

    // normal / explosive / tracking: inherits the tank's velocity.
    return [this.walkPath(ox, oy, ca * speed + vel.x, sa * speed + vel.y, sc.range, bounces, stopOnWall, false)];
  }

  /**
   * March a virtual round through the maze, mirroring the server's stepBullets:
   * reflect off walls (axis-wise), optionally stop on the first wall (explosive)
   * or pass straight through (sniper). Returns polyline vertices (start, each
   * bounce, end).
   */
  private walkPath(
    ox: number,
    oy: number,
    vx: number,
    vy: number,
    range: number,
    maxBounces: number,
    stopOnWall: boolean,
    pierce: boolean
  ): Array<{ x: number; y: number }> {
    const pts = [{ x: ox, y: oy }];
    const maze = this.maze;
    if (!maze) return pts;
    const step = Math.max(2.5, this.bulletR * 0.8);
    let x = ox;
    let y = oy;
    let bounces = 0;
    let dist = 0;
    let guard = 0;
    while (dist < range && guard++ < 3000) {
      const sp = Math.hypot(vx, vy) || 1;
      const nx = x + (vx / sp) * step;
      const ny = y + (vy / sp) * step;
      if (nx < 0 || ny < 0 || nx > maze.width || ny > maze.height) {
        pts.push({ x: Math.max(0, Math.min(maze.width, nx)), y: Math.max(0, Math.min(maze.height, ny)) });
        return pts;
      }
      if (pierce) {
        x = nx;
        y = ny;
        dist += step;
        continue;
      }
      let bounced = false;
      if (this.hitsWall(nx, y)) {
        if (stopOnWall) {
          pts.push({ x, y });
          return pts;
        }
        vx = -vx;
        bounces++;
        bounced = true;
      } else {
        x = nx;
      }
      if (this.hitsWall(x, ny)) {
        if (stopOnWall) {
          pts.push({ x, y });
          return pts;
        }
        vy = -vy;
        bounces++;
        bounced = true;
      } else {
        y = ny;
      }
      if (bounced) {
        pts.push({ x, y });
        if (bounces > maxBounces) return pts;
      }
      dist += step;
    }
    pts.push({ x, y });
    return pts;
  }

  /** Same circle-vs-wall test the server uses, against the local maze segments. */
  private hitsWall(x: number, y: number): boolean {
    const maze = this.maze;
    if (!maze) return false;
    const reach = this.bulletR + maze.thickness / 2;
    const r2 = reach * reach;
    for (const w of maze.walls) {
      if (pointSegDist2(x, y, w.x1, w.y1, w.x2, w.y2) <= r2) return true;
    }
    return false;
  }

  /** Estimate a tank's current velocity (px/s) from the last two snapshots. */
  private tankVelocity(id: string): { x: number; y: number } {
    if (this.buffer.length < 2) return { x: 0, y: 0 };
    const b = this.buffer[this.buffer.length - 1];
    const a = this.buffer[this.buffer.length - 2];
    const tb = b.snap.tanks.find((t) => t.id === id);
    const ta = a.snap.tanks.find((t) => t.id === id);
    const dt = (b.recvAt - a.recvAt) / 1000;
    if (!ta || !tb || dt <= 0) return { x: 0, y: 0 };
    return { x: (tb.x - ta.x) / dt, y: (tb.y - ta.y) / dt };
  }

  private drawBeams(nowMs: number): void {
    const { ctx } = this;
    this.beams = this.beams.filter((b) => nowMs - b.start < BEAM_MS);
    ctx.lineCap = "round";
    for (const b of this.beams) {
      const alpha = 1 - (nowMs - b.start) / BEAM_MS;
      // Layered beam: violet glow → blue → white core.
      ctx.globalAlpha = alpha * 0.3;
      ctx.strokeStyle = "#9b3fd6";
      ctx.lineWidth = 8;
      this.strokeLine(b);
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = "#6aa6ff";
      ctx.lineWidth = 4;
      this.strokeLine(b);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.8;
      this.strokeLine(b);
    }
    ctx.globalAlpha = 1;
  }

  private strokeLine(b: Beam): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    ctx.lineTo(b.x2, b.y2);
    ctx.stroke();
  }

  private drawPowerups(powerups: PowerupDTO[], nowMs: number): void {
    const { ctx } = this;
    const bob = Math.sin(nowMs / 300) * 1.5;
    for (const p of powerups) {
      const def = powerupDef(p.type);
      const s = POWERUP_RADIUS;
      ctx.save();
      ctx.translate(p.x, p.y + bob);

      // Wooden crate body.
      ctx.fillStyle = "#c79a5b";
      ctx.fillRect(-s, -s, s * 2, s * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#6e4a1e";
      ctx.strokeRect(-s, -s, s * 2, s * 2);
      // Plank bracing.
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(110,74,30,0.7)";
      ctx.beginPath();
      ctx.moveTo(-s, -s);
      ctx.lineTo(s, s);
      ctx.moveTo(s, -s);
      ctx.lineTo(-s, s);
      ctx.stroke();

      // Power-up emblem.
      ctx.fillStyle = def.color;
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.strokeStyle = "rgba(27,22,16,0.85)";
      ctx.lineWidth = 3;
      ctx.strokeText(def.emblem, 0, 1);
      ctx.fillText(def.emblem, 0, 1);
      ctx.restore();
    }
    ctx.textBaseline = "alphabetic";
  }

  private drawExplosions(nowMs: number): void {
    const { ctx } = this;
    this.explosions = this.explosions.filter((e) => nowMs - e.start < EXPLOSION_MS);
    for (const e of this.explosions) {
      const age = (nowMs - e.start) / EXPLOSION_MS; // 0..1
      ctx.save();
      ctx.translate(e.x, e.y);

      // Bright flash core, fading.
      ctx.globalAlpha = (1 - age) * 0.9;
      ctx.beginPath();
      ctx.arc(0, 0, 6 + age * 16, 0, Math.PI * 2);
      ctx.fillStyle = age < 0.4 ? "#ffd24a" : "#e6863f";
      ctx.fill();

      // Expanding shock ring.
      ctx.globalAlpha = 1 - age;
      ctx.beginPath();
      ctx.arc(0, 0, 8 + age * 30, 0, Math.PI * 2);
      ctx.strokeStyle = "#b23b2e";
      ctx.lineWidth = 3 * (1 - age) + 0.5;
      ctx.stroke();

      // Sparks flung outward (deterministic by index, no RNG needed).
      ctx.globalAlpha = (1 - age) * 0.85;
      ctx.fillStyle = e.color;
      const sparks = 8;
      const dist = 6 + age * 34;
      for (let i = 0; i < sparks; i++) {
        const a = (i / sparks) * Math.PI * 2 + i;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * dist, Math.sin(a) * dist, 2.2 * (1 - age) + 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private drawMaze(maze: MazeDTO): void {
    const { ctx } = this;
    // Parchment arena floor.
    ctx.fillStyle = "#e7d9b8";
    ctx.fillRect(0, 0, maze.width, maze.height);

    // Inked wall lines.
    ctx.strokeStyle = "#352f25";
    ctx.lineWidth = maze.thickness;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (const w of maze.walls) {
      ctx.moveTo(w.x1, w.y1);
      ctx.lineTo(w.x2, w.y2);
    }
    ctx.stroke();
  }

  private drawTank(t: TankDTO, isLocal: boolean, nowMs: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.globalAlpha = t.alive ? 1 : 0.25;

    // Local-player highlight: a soft, semi-transparent glow ring under your
    // tank so you can find yourself at a glance.
    if (isLocal && t.alive) {
      ctx.beginPath();
      ctx.arc(0, 0, this.tankR + 9, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,252,240,0.3)";
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(47,42,34,0.7)";
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Body (oriented to movement direction).
    ctx.save();
    ctx.rotate(t.bodyAngle);
    const r = this.tankR;
    // Elongated hull: longer front-to-back (x) than it is wide (y).
    const halfLen = r * 1.3;
    const halfWid = r * 0.82;

    // Treads: dark bars down each side, running front-to-back, poking out a bit.
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    ctx.fillRect(-halfLen, -halfWid - 3, halfLen * 2, 4);
    ctx.fillRect(-halfLen, halfWid - 1, halfLen * 2, 4);

    // Hull: rounded rectangle chassis with an outline for definition.
    ctx.fillStyle = t.color;
    roundRect(ctx, -halfLen, -halfWid, halfLen * 2, halfWid * 2, 4);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.stroke();

    // Front plate: a brighter band on the leading (+x) edge marks the front,
    // with a thin dark lip at the very nose.
    ctx.fillStyle = shade(t.color, 80);
    roundRect(ctx, halfLen * 0.45, -halfWid * 0.82, halfLen * 0.55, halfWid * 1.64, 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(halfLen - 2, -halfWid * 0.82, 2, halfWid * 1.64);
    ctx.restore();

    // Turret + barrel (aim direction).
    ctx.save();
    ctx.rotate(t.turretAngle);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, -2.5, r + 8, 5);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = shade(t.color, -25);
    ctx.fill();
    ctx.restore();

    // Laser windup preview: a thin flickering beam along the aim.
    if (t.charging && t.alive) {
      ctx.save();
      ctx.rotate(t.turretAngle);
      ctx.globalAlpha = 0.4 + 0.35 * Math.abs(Math.sin(nowMs / 60));
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(r + 4, 0);
      ctx.lineTo(r + 54, 0);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Shield bubble.
    if (t.shielded && t.alive) {
      ctx.beginPath();
      ctx.arc(0, 0, r + 8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(79,214,160,0.18)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(79,214,160,${0.55 + 0.3 * Math.abs(Math.sin(nowMs / 200))})`;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.restore();

    // Health bar (only when HP > 1).
    if (t.alive && t.maxHp > 1) {
      const bw = this.tankR * 2;
      const bx = t.x - this.tankR;
      const by = t.y - this.tankR - 6;
      const frac = Math.max(0, Math.min(1, t.hp / t.maxHp));
      ctx.fillStyle = "rgba(47,42,34,0.35)";
      ctx.fillRect(bx, by, bw, 3);
      ctx.fillStyle = frac > 0.5 ? "#4d7a40" : frac > 0.25 ? "#e6863f" : "#b23b2e";
      ctx.fillRect(bx, by, bw * frac, 3);
    }

    // Name / respawn label (unrotated).
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    if (t.alive) {
      ctx.fillStyle = "rgba(13,17,23,0.9)";
      ctx.fillText(t.name, t.x, t.y - this.tankR - (t.maxHp > 1 ? 13 : 8));
    } else {
      ctx.fillStyle = "rgba(13,17,23,0.65)";
      ctx.fillText(`${Math.ceil(t.respawnIn)}`, t.x, t.y + 4);
    }
  }

  /** Linearly interpolate tank/bullet positions ~INTERP_DELAY ms in the past. */
  private interpolated(nowMs: number): SnapshotDTO | null {
    if (this.buffer.length === 0) return null;
    if (this.buffer.length === 1) return this.buffer[0].snap;

    const target = nowMs - INTERP_DELAY;
    let a = this.buffer[0];
    let b = this.buffer[this.buffer.length - 1];
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i].recvAt <= target && this.buffer[i + 1].recvAt >= target) {
        a = this.buffer[i];
        b = this.buffer[i + 1];
        break;
      }
    }
    const span = b.recvAt - a.recvAt;
    const f = span > 0 ? clamp01((target - a.recvAt) / span) : 1;

    const bById = new Map(a.snap.tanks.map((t) => [t.id, t]));
    const tanks: TankDTO[] = b.snap.tanks.map((tb) => {
      const ta = bById.get(tb.id);
      if (!ta) return tb;
      return {
        ...tb,
        x: lerp(ta.x, tb.x, f),
        y: lerp(ta.y, tb.y, f),
        bodyAngle: angleLerp(ta.bodyAngle, tb.bodyAngle, f),
        turretAngle: angleLerp(ta.turretAngle, tb.turretAngle, f),
      };
    });

    const aBullets = new Map(a.snap.bullets.map((bl) => [bl.id, bl]));
    const bullets = b.snap.bullets.map((bb) => {
      const ba = aBullets.get(bb.id);
      if (!ba) return bb;
      // Travel direction from the movement between the two samples (for tracking).
      const dir = bb.x !== ba.x || bb.y !== ba.y ? Math.atan2(bb.y - ba.y, bb.x - ba.x) : bb.dir;
      return { ...bb, x: lerp(ba.x, bb.x, f), y: lerp(ba.y, bb.y, f), dir };
    });

    return { t: target, tanks, bullets, powerups: [], blasts: [], beams: [], events: [] };
  }
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}
function angleLerp(a: number, b: number, f: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by). */
function pointSegDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = clampByte((n >> 16) + amt);
  const g = clampByte(((n >> 8) & 0xff) + amt);
  const b = clampByte((n & 0xff) + amt);
  return `rgb(${r},${g},${b})`;
}
function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

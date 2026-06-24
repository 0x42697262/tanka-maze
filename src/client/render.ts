import { BULLET_RADIUS, POWERUP_RADIUS, TANK_RADIUS } from "../shared/constants.js";
import type {
  BulletKind,
  MazeDTO,
  PowerupDTO,
  PowerupType,
  SnapshotDTO,
  TankDTO,
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

const POWERUP_STYLE: Record<PowerupType, { c: string; g: string }> = {
  speed: { c: "#e6c23f", g: "»" },
  shield: { c: "#4fd6a0", g: "◈" },
  sniper: { c: "#2fb8d6", g: "•" },
  explosive: { c: "#b23b2e", g: "✸" },
  laser: { c: "#9b3fd6", g: "≡" },
  tracking: { c: "#3f9b46", g: "◎" },
  multishot: { c: "#d6822f", g: "⋔" },
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
  // Last seen state per tank, to detect deaths and spawn explosions.
  private lastTankState = new Map<string, { x: number; y: number; alive: boolean; color: string }>();

  setParams(tankRadius: number, bulletRadius: number): void {
    this.tankR = tankRadius;
    this.bulletR = bulletRadius;
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

    for (const t of interp.tanks) {
      this.drawTank(t, t.id === localId, nowMs);
    }

    this.drawBeams(nowMs);
    this.drawExplosions(nowMs);
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
      const style = POWERUP_STYLE[p.type];
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
      ctx.fillStyle = style.c;
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.strokeStyle = "rgba(27,22,16,0.85)";
      ctx.lineWidth = 3;
      ctx.strokeText(style.g, 0, 1);
      ctx.fillText(style.g, 0, 1);
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

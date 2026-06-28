import { BULLET_RADIUS, FLASHLIGHT_DEGREES, POWERUP_RADIUS, TANK_RADIUS, VISION_RADIUS } from "../shared/constants.js";
import { effectiveVisionRadius } from "../shared/fog.js";
import {
  powerupDef,
  type BulletKind,
  type FogType,
  type FlagDTO,
  type HazardZoneDTO,
  type KillEvent,
  type MazeDTO,
  type PowerupDTO,
  type SnapshotDTO,
  type SpawnZoneDTO,
  type TankDTO,
} from "../shared/protocol.js";

// Render this far in the past so we always have two snapshots to interpolate
// between. Must exceed the network send interval (≈66ms at 15 Hz) with margin.
const INTERP_DELAY = 140;

// Bullets are rendered in the owning tank's color so shots are identifiable by
// shooter. Size varies a little by kind. Tracking rounds render as a triangle
// (drawn separately), the rest as filled circles.
const BULLET_COLOR = "#11100e";
/** A bullet takes the owning tank's color, falling back to the dark base. */
function bulletColor(tankColor: string | undefined): string {
  return tankColor ?? BULLET_COLOR;
}
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

interface FogPoint {
  x: number;
  y: number;
}

interface FogView {
  local: TankDTO;
  radius: number;
  type: FogType;
  beamRadians: number;
  haloRadius: number;
  beamBaseHalf: number;
  beamBaseCenter: FogPoint;
  polygon: FogPoint[];
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private maze: MazeDTO | null = null;
  private spawnZones: SpawnZoneDTO[] = [];
  private buffer: Buffered[] = [];
  private explosions: Explosion[] = [];
  private beams: Beam[] = [];
  // Per-game visual sizes (from the lobby's advanced config).
  private tankR = TANK_RADIUS;
  private bulletR = BULLET_RADIUS;
  // Bullet-physics params for the local-only scope (aiming guide). Each weapon's
  // guide reach + behavior is derived from these (real max travel = speed × life).
  private scope = {
    bulletSpeed: 240,
    bulletLifetime: 5,
    bulletBounces: 3,
    sniperSpeedMult: 5,
    sniperWallPierce: 10,
    trackingLifetime: 6,
    trackingBounces: 6,
    laserRange: 1320,
    explosionRadius: 56,
    multiCount: 3,
    multiSpread: 30,
  };
  // Last seen state per tank, to detect deaths and spawn explosions.
  private lastTankState = new Map<string, { x: number; y: number; alive: boolean; color: string }>();
  // Transient effects (explosions, beams, kill events) are applied on the same
  // ~INTERP_DELAY-behind clock as the interpolated world, so a hit/death shows
  // exactly when the (delayed) bullet reaches the tank — not when the snapshot
  // arrives. `consumedUntil` is the recvAt of the last snapshot whose effects
  // we've fired; `pendingEvents` queues kill-log events for the main loop.
  private consumedUntil = 0;
  private pendingEvents: KillEvent[] = [];
  private displayedSnap: SnapshotDTO | null = null;
  // Fog of war: when on, non-wall visuals are clipped to the local sight radius.
  // Enemy tanks also need line of sight unless scope grants x-ray. Client-side
  // only — the server still broadcasts all entities.
  private fogOfWar = false;
  private fogType: FogType = "full";
  private visionRadius = VISION_RADIUS;
  private flashlightDegrees = FLASHLIGHT_DEGREES;
  // Hazard zones: terrain tiles (lava/mud/ice/heal) drawn under the walls.
  private hazards: HazardZoneDTO[] = [];
  // Destructible walls: per-wall HP array (index matches MazeDTO.walls). Walls
  // at 0 HP are destroyed (skipped in draw + collision). Updated from snapshot
  // `wallHp` deltas. Empty when destructibleWalls is off.
  private wallHp: number[] = [];
  private wallMaxHp = Infinity;
  private destructibleWalls = false;

  setParams(tankRadius: number, bulletRadius: number): void {
    this.tankR = tankRadius;
    this.bulletR = bulletRadius;
  }

  /** Bullet-physics params used to draw the aiming guide. */
  setScope(p: {
    bulletSpeed: number;
    bulletLifetime: number;
    bulletBounces: number;
    sniperSpeedMult: number;
    sniperWallPierce: number;
    trackingLifetime: number;
    trackingBounces: number;
    laserRange: number;
    explosionRadius: number;
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

  /** Team VS designated spawn areas; empty in other modes / when disabled. */
  setSpawnZones(zones: SpawnZoneDTO[]): void {
    this.spawnZones = zones;
  }

  /** Configure fog of war for the current game. */
  setFog(fogOfWar: boolean, visionRadius: number, fogType: FogType, flashlightDegrees: number): void {
    this.fogOfWar = fogOfWar;
    this.fogType = fogType;
    this.visionRadius = visionRadius;
    this.flashlightDegrees = flashlightDegrees;
  }

  /** Hazard zones for the current game (lava/mud/ice/heal terrain tiles). */
  setHazards(zones: HazardZoneDTO[]): void {
    this.hazards = zones;
  }

  /** Configure destructible walls. Initializes the per-wall HP array from the
   *  maze if one is already set; otherwise stores the config for setMaze. */
  setDestructibleWalls(enabled: boolean, wallHp: number): void {
    const sameConfig = this.destructibleWalls === enabled && this.wallMaxHp === (enabled ? wallHp : Infinity);
    this.destructibleWalls = enabled;
    this.wallMaxHp = enabled ? wallHp : Infinity;
    if (enabled && this.maze && (!sameConfig || this.wallHp.length !== this.maze.walls.length)) {
      this.wallHp = new Array(this.maze.walls.length).fill(wallHp);
    } else if (!enabled) {
      this.wallHp = [];
    }
  }

  setMaze(maze: MazeDTO): void {
    this.maze = maze;
    this.canvas.width = maze.width;
    this.canvas.height = maze.height;
    this.buffer = [];
    this.explosions = [];
    this.beams = [];
    this.lastTankState.clear();
    this.consumedUntil = 0;
    this.pendingEvents = [];
    this.displayedSnap = null;
    // Initialize per-wall HP from the destructible-walls config.
    this.wallHp = this.destructibleWalls
      ? new Array(maze.walls.length).fill(this.wallMaxHp)
      : [];
  }

  /** Buffer a snapshot. Effects are NOT fired here — they're applied later, when
   *  the interpolation clock reaches this snapshot (see consumeEffects). */
  push(snap: SnapshotDTO, nowMs: number): void {
    this.buffer.push({ snap, recvAt: nowMs });
    if (this.buffer.length > 30) this.buffer.shift();
  }

  /**
   * Fire the transient effects (explosions, beams, deaths, kill events) of any
   * buffered snapshot the interpolation clock has now reached — i.e. delayed by
   * the same INTERP_DELAY as the rendered world — so they line up on screen.
   */
  private consumeEffects(target: number, nowMs: number): void {
    for (const { snap, recvAt } of this.buffer) {
      if (recvAt <= this.consumedUntil || recvAt > target) continue;
      this.detectDeaths(snap, nowMs);
      for (const b of snap.blasts) {
        this.explosions.push({ x: b.x, y: b.y, color: "#e6863f", start: nowMs });
      }
      for (const bm of snap.beams) {
        this.beams.push({ x1: bm.x1, y1: bm.y1, x2: bm.x2, y2: bm.y2, start: nowMs });
      }
      if (snap.events.length) this.pendingEvents.push(...snap.events);
      this.consumedUntil = recvAt;
    }
  }

  /** Drain kill-log events that have reached the interpolation clock. */
  takeEvents(): KillEvent[] {
    if (this.pendingEvents.length === 0) return [];
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }

  /** The interpolated snapshot drawn last frame (the on-screen world). */
  displayed(): SnapshotDTO | null {
    return this.displayedSnap;
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

    // Fire any effects the interpolation clock has now reached (delayed in lockstep
    // with the world below), then draw the world ~INTERP_DELAY in the past.
    this.consumeEffects(nowMs - INTERP_DELAY, nowMs);

    const interp = this.interpolated(nowMs);
    this.displayedSnap = interp;
    const localTank = interp?.tanks.find((t) => t.id === localId) ?? null;
    const fog = this.fogView(localTank);

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.applyWallHp();
    this.drawFloor(maze);
    this.drawVisionClipped(fog, () => this.drawMapFeatures(nowMs, fog));
    this.drawWalls(maze);
    if (!interp) {
      if (fog) this.drawFogOverlay(fog, maze);
      return;
    }

    // Power-up pickups (stationary — drawn from the latest snapshot, no interp).
    this.drawVisionClipped(fog, () => this.drawPowerups(this.latest()?.powerups ?? [], nowMs, fog));
    // CTF flags (carried ones ride the interpolated tanks; the rest sit still).
    this.drawVisionClipped(fog, () => this.drawFlags(interp, nowMs, fog));

    this.drawVisionClipped(fog, () => {
      const tankColors = new Map(interp.tanks.map((t) => [t.id, t.color]));
      for (const b of interp.bullets) {
        if (fog && !this.isPointVisible(b.x, b.y, fog)) continue;
        const style = BULLET_STYLE[b.kind] ?? BULLET_STYLE.normal;
        const rad = Math.max(1, this.bulletR + style.dr);
        ctx.fillStyle = bulletColor(tankColors.get(b.ownerId));
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
    });

    // Aiming guide (local player only) — drawn under the tanks would be hidden
    // by them, so draw it just before so the dotted line reads clearly.
    this.drawVisionClipped(fog, () => this.drawScope(interp, localId, fog));

    this.drawVisionClipped(fog, () => {
      for (const t of interp.tanks) {
        if (fog && t.id !== localId && !this.isVisible(t, fog)) {
          continue;
        }
        this.drawTank(t, t.id === localId, nowMs);
      }
    });

    this.drawVisionClipped(fog, () => this.drawBeams(nowMs, fog));
    this.drawVisionClipped(fog, () => this.drawExplosions(nowMs, fog));

    if (fog) {
      this.drawFogOverlay(fog, maze);
      // Flashlight fog points forward, but the player should never lose sight
      // of their own tank when rotating the turret away from the hull.
      this.drawTank(fog.local, true, nowMs);
      this.drawWalls(maze);
    }
  }

  private applyWallHp(): void {
    if (!this.destructibleWalls) return;
    const latest = this.latest();
    if (!latest) return;
    for (const w of latest.wallHp) {
      if (w.index < this.wallHp.length) this.wallHp[w.index] = w.hp;
    }
  }

  private fogView(local: TankDTO | null): FogView | null {
    if (!this.fogOfWar || !local || !this.maze) return null;
    const base = effectiveVisionRadius(this.visionRadius, this.maze.width, this.maze.height);
    const beamRadians = (Math.min(170, Math.max(20, this.flashlightDegrees)) * Math.PI) / 180;
    const mapReach = Math.hypot(this.maze.width, this.maze.height) * 1.5;
    const radius = this.fogType === "flashlight" ? mapReach : local.scoped ? base * 2 : base;
    const ux = Math.cos(local.turretAngle);
    const uy = Math.sin(local.turretAngle);
    const fog: FogView = {
      local,
      radius,
      type: this.fogType,
      beamRadians,
      haloRadius: this.tankR + 14,
      beamBaseHalf: Math.max(6, this.tankR * 0.9),
      beamBaseCenter: { x: local.x + ux * this.tankR * 0.35, y: local.y + uy * this.tankR * 0.35 },
      polygon: [],
    };
    fog.polygon = this.visibilityPolygon(fog);
    return fog;
  }

  private drawVisionClipped(fog: FogView | null, draw: () => void): void {
    if (!fog) {
      draw();
      return;
    }
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    this.addFogShape(fog, true);
    ctx.clip();
    draw();
    ctx.restore();
  }

  private addFogShape(fog: FogView, includeHalo: boolean): void {
    const { ctx } = this;
    if (fog.polygon.length > 0) {
      ctx.moveTo(fog.polygon[0].x, fog.polygon[0].y);
      for (let i = 1; i < fog.polygon.length; i++) ctx.lineTo(fog.polygon[i].x, fog.polygon[i].y);
      ctx.closePath();
    }
    if (includeHalo) {
      ctx.moveTo(fog.local.x + fog.haloRadius, fog.local.y);
      ctx.arc(fog.local.x, fog.local.y, fog.haloRadius, 0, Math.PI * 2);
    }
  }

  private drawFogOverlay(fog: FogView, maze: MazeDTO): void {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = "#12100e";
    ctx.beginPath();
    ctx.rect(0, 0, maze.width, maze.height);
    this.addFogShape(fog, false);
    ctx.fill("evenodd");
    ctx.restore();
  }

  /** Build the visible fog shape by casting rays until they hit a blocking wall. */
  private visibilityPolygon(fog: FogView): FogPoint[] {
    const full = fog.type === "full";
    const span = full ? Math.PI * 2 : fog.beamRadians;
    const start = full ? 0 : fog.local.turretAngle - span / 2;
    const samples = full ? 96 : Math.max(10, Math.ceil((span * 180) / Math.PI / 4));
    const angles: number[] = [];
    const addAngle = (angle: number) => {
      if (!full && Math.abs(angleDelta(angle, fog.local.turretAngle)) > span / 2 + 0.0001) return;
      angles.push(angle);
    };

    for (let i = 0; i < samples; i++) addAngle(start + (span * i) / samples);
    if (!full) addAngle(start + span);

    if (this.maze && !fog.local.scoped) {
      const origin = this.fogRayOrigin(fog);
      const r2 = fog.radius * fog.radius;
      const eps = 0.0008;
      for (let i = 0; i < this.maze.walls.length; i++) {
        if (!this.wallBlocksVision(i)) continue;
        const w = this.maze.walls[i];
        for (const p of [[w.x1, w.y1], [w.x2, w.y2]] as const) {
          const dx = p[0] - origin.x;
          const dy = p[1] - origin.y;
          if (dx * dx + dy * dy > r2) continue;
          const a = Math.atan2(dy, dx);
          addAngle(a - eps);
          addAngle(a);
          addAngle(a + eps);
        }
      }
    }

    const points = angles
      .map((angle) => ({ angle, order: full ? normalizeAngle(angle) : normalizeAngle(angle - start), point: this.castFogRay(fog, angle) }))
      .sort((a, b) => a.order - b.order)
      .map((hit) => hit.point);
    if (full) return points;
    return [this.flashlightBasePoint(fog, -1), ...points, this.flashlightBasePoint(fog, 1)];
  }

  private castFogRay(fog: FogView, angle: number): FogPoint {
    const origin = this.fogRayOrigin(fog);
    const ox = origin.x;
    const oy = origin.y;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let best = fog.radius;
    if (this.maze && !fog.local.scoped) {
      for (let i = 0; i < this.maze.walls.length; i++) {
        if (!this.wallBlocksVision(i)) continue;
        const w = this.maze.walls[i];
        const hit = raySegmentDistance(ox, oy, dx, dy, w.x1, w.y1, w.x2, w.y2);
        if (hit !== null && hit < best) best = hit;
      }
    }
    return { x: ox + dx * best, y: oy + dy * best };
  }

  private fogRayOrigin(fog: FogView): FogPoint {
    return fog.type === "flashlight" ? fog.beamBaseCenter : fog.local;
  }

  private flashlightBasePoint(fog: FogView, side: -1 | 1): FogPoint {
    const px = -Math.sin(fog.local.turretAngle);
    const py = Math.cos(fog.local.turretAngle);
    return {
      x: fog.beamBaseCenter.x + px * fog.beamBaseHalf * side,
      y: fog.beamBaseCenter.y + py * fog.beamBaseHalf * side,
    };
  }

  /**
   * Line-of-sight check for fog of war. An enemy is visible when it's within
   * the vision radius AND no wall segment blocks the ray from the local tank to
   * it. The scope power-up doubles the radius and skips the wall check (x-ray).
   */
  private isVisible(enemy: TankDTO, fog: FogView): boolean {
    if (!this.isPointVisible(enemy.x, enemy.y, fog)) return false;
    return true;
  }

  private isPointVisible(x: number, y: number, fog: FogView): boolean {
    const localDx = x - fog.local.x;
    const localDy = y - fog.local.y;
    if (localDx * localDx + localDy * localDy <= fog.haloRadius * fog.haloRadius) return true;
    const origin = this.fogRayOrigin(fog);
    const dx = x - origin.x;
    const dy = y - origin.y;
    if (dx * dx + dy * dy > fog.radius * fog.radius) return false;
    if (fog.type === "flashlight") {
      const d = angleDelta(Math.atan2(dy, dx), fog.local.turretAngle);
      if (Math.abs(d) > fog.beamRadians / 2) return false;
    }
    if (fog.local.scoped) return true; // x-ray — see through walls
    if (!this.maze) return true;
    // Cast a ray from the local tank to the enemy; if any wall segment
    // intersects it, the enemy is hidden.
    for (let i = 0; i < this.maze.walls.length; i++) {
      if (!this.wallBlocksVision(i)) continue;
      const w = this.maze.walls[i];
      if (segIntersect(origin.x, origin.y, x, y, w.x1, w.y1, w.x2, w.y2)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Line-of-sight scope: a dotted guide showing where a shot would travel from
   * a scoped tank, accounting for the tank's velocity (inherited by the round)
   * and wall bounces. Drawn for EVERY scoped tank — others can see who has it —
   * yet still computed purely client-side (the server only flags `scoped`), so
   * it adds no simulation cost.
   */
  private drawScope(interp: SnapshotDTO, localId: string, fog: FogView | null): void {
    if (!this.maze) return;
    const { ctx } = this;
    for (const t of interp.tanks) {
      if (!t.alive || !t.scoped) continue;
      if (fog && t.id !== localId && !this.isVisible(t, fog)) continue;
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
      // Explosive: show the blast radius at the detonation point.
      const end = paths[0]?.[paths[0].length - 1];
      if (t.weapon === "explosive" && end) {
        ctx.globalAlpha = 0.16;
        ctx.beginPath();
        ctx.arc(end.x, end.y, this.scope.explosionRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  /**
   * One or more trajectory polylines for a tank's current weapon — each sized to
   * that weapon's real reach: normal/multishot fly speed×lifetime and bounce;
   * the sniper flies fast & straight, punching through walls; explosive stops
   * where it detonates; tracking uses its longer lifetime; laser is hitscan.
   */
  private scopePaths(me: TankDTO, vel: { x: number; y: number }): Array<{ x: number; y: number }[]> {
    const a = me.turretAngle;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const sc = this.scope;
    // A round lives `lifetime` seconds, so it travels its real speed × lifetime.
    const reach = (vx: number, vy: number, lifetime: number) => Math.hypot(vx, vy) * lifetime;
    const muzzle = this.tankR + this.bulletR + 2;
    const ox = me.x + ca * muzzle;
    const oy = me.y + sa * muzzle;

    if (me.weapon === "laser") {
      // Hitscan beam: reflects, no momentum, from just outside the hull.
      const lx = me.x + ca * (this.tankR + 2);
      const ly = me.y + sa * (this.tankR + 2);
      return [this.walkPath(lx, ly, ca, sa, { range: sc.laserRange, bounces: Infinity })];
    }

    if (me.weapon === "sniper") {
      // Fast & straight, no momentum, punches through up to N walls.
      const speed = sc.bulletSpeed * sc.sniperSpeedMult;
      return [
        this.walkPath(ox, oy, ca, sa, {
          range: speed * sc.bulletLifetime,
          straight: true,
          pierce: sc.sniperWallPierce,
        }),
      ];
    }

    if (me.weapon === "multishot") {
      const n = Math.max(1, Math.round(sc.multiCount));
      const fan = (sc.multiSpread * Math.PI) / 180;
      const stepA = n > 1 ? fan / (n - 1) : 0;
      const start = a - fan / 2;
      const paths: Array<{ x: number; y: number }[]> = [];
      for (let i = 0; i < n; i++) {
        const ang = n > 1 ? start + stepA * i : a;
        const mx = me.x + Math.cos(ang) * muzzle;
        const my = me.y + Math.sin(ang) * muzzle;
        const pvx = Math.cos(ang) * sc.bulletSpeed + vel.x;
        const pvy = Math.sin(ang) * sc.bulletSpeed + vel.y;
        paths.push(
          this.walkPath(mx, my, pvx, pvy, { range: reach(pvx, pvy, sc.bulletLifetime), bounces: sc.bulletBounces })
        );
      }
      return paths;
    }

    // Velocity inherits the tank's momentum, so reach is the real fire speed ×
    // lifetime (not the base bullet speed) — otherwise the guide stops short of a
    // moving tank's shot and hides its later bounces.
    const vx = ca * sc.bulletSpeed + vel.x;
    const vy = sa * sc.bulletSpeed + vel.y;

    if (me.weapon === "explosive") {
      // Detonates at the first wall (or where its lifetime runs out).
      return [this.walkPath(ox, oy, vx, vy, { range: reach(vx, vy, sc.bulletLifetime), stopOnWall: true })];
    }

    if (me.weapon === "tracking") {
      return [this.walkPath(ox, oy, vx, vy, { range: reach(vx, vy, sc.trackingLifetime), bounces: sc.trackingBounces })];
    }

    // Plain cannon.
    return [this.walkPath(ox, oy, vx, vy, { range: reach(vx, vy, sc.bulletLifetime), bounces: sc.bulletBounces })];
  }

  /**
   * March a virtual round through the maze, mirroring the server's stepBullets.
   * `straight` (sniper) flies in a line, passing through up to `pierce` walls
   * before stopping; otherwise it reflects off walls up to `bounces` times, or
   * `stopOnWall` halts at the first wall (explosive). Returns polyline vertices.
   */
  private walkPath(
    ox: number,
    oy: number,
    vx: number,
    vy: number,
    opts: { range: number; bounces?: number; stopOnWall?: boolean; straight?: boolean; pierce?: number }
  ): Array<{ x: number; y: number }> {
    const { range, bounces: maxBounces = 0, stopOnWall = false, straight = false, pierce = 0 } = opts;
    const pts = [{ x: ox, y: oy }];
    const maze = this.maze;
    if (!maze) return pts;
    const step = Math.max(2.5, this.bulletR * 0.8);
    let x = ox;
    let y = oy;
    let bounces = 0;
    let pierced = 0;
    let dist = 0;
    let guard = 0;
    let wasInWall = false;
    while (dist < range && guard++ < 4000) {
      const sp = Math.hypot(vx, vy) || 1;
      const nx = x + (vx / sp) * step;
      const ny = y + (vy / sp) * step;
      if (nx < 0 || ny < 0 || nx > maze.width || ny > maze.height) {
        pts.push({ x: Math.max(0, Math.min(maze.width, nx)), y: Math.max(0, Math.min(maze.height, ny)) });
        return pts;
      }
      if (straight) {
        const inWall = this.hitsWall(nx, ny);
        if (inWall && !wasInWall) {
          if (pierced >= pierce) {
            pts.push({ x, y });
            return pts;
          }
          pierced++;
        }
        wasInWall = inWall;
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

  private drawBeams(nowMs: number, fog: FogView | null): void {
    const { ctx } = this;
    this.beams = this.beams.filter((b) => nowMs - b.start < BEAM_MS);
    ctx.lineCap = "round";
    for (const b of this.beams) {
      if (fog && !this.isPointVisible((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, fog)) continue;
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

  private drawPowerups(powerups: PowerupDTO[], nowMs: number, fog: FogView | null): void {
    const { ctx } = this;
    const bob = Math.sin(nowMs / 300) * 1.5;
    for (const p of powerups) {
      if (fog && !this.isPointVisible(p.x, p.y, fog)) continue;
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

  /** CTF flags: a pennant on a pole in the team's color. Dropped flags pulse.
   *  When one tank carries several flags, their pennants stack up a taller pole
   *  (lowest team index at the bottom) so every held flag stays visible. */
  private drawFlags(interp: SnapshotDTO, nowMs: number, fog: FogView | null): void {
    if (interp.flags.length === 0) return;
    const { ctx } = this;
    const teamColor = new Map(this.spawnZones.map((z) => [z.team, z.color]));
    // Stack order for carried flags: index within their carrier's held set.
    const stackIndex = new Map<FlagDTO, number>();
    const byCarrier = new Map<number, FlagDTO[]>();
    for (const fl of interp.flags) {
      if (fl.state !== "carried" || fl.carrier === 255) continue;
      const list = byCarrier.get(fl.carrier) ?? [];
      list.push(fl);
      byCarrier.set(fl.carrier, list);
    }
    for (const list of byCarrier.values()) {
      list.sort((a, b) => a.team - b.team);
      list.forEach((fl, i) => stackIndex.set(fl, i));
    }

    const PENNANT_GAP = 9; // vertical spacing between stacked pennants
    for (const fl of interp.flags) {
      if (fog && !this.isPointVisible(fl.x, fl.y, fog)) continue;
      const color = teamColor.get(fl.team) ?? "#888888";
      const bob = fl.state === "carried" ? 0 : Math.sin(nowMs / 300) * 1.5;
      const tier = stackIndex.get(fl) ?? 0;
      const peak = 18 + tier * PENNANT_GAP; // pole height for this pennant's tier
      ctx.save();
      ctx.translate(fl.x, fl.y + bob);
      ctx.globalAlpha = fl.state === "dropped" ? 0.55 + 0.25 * Math.abs(Math.sin(nowMs / 250)) : 1;
      // Pole (tall enough to reach this tier's pennant).
      ctx.strokeStyle = "#352f25";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 4);
      ctx.lineTo(0, -peak);
      ctx.stroke();
      // Pennant at this tier.
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -peak);
      ctx.lineTo(13, -peak + 4.5);
      ctx.lineTo(0, -peak + 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private drawExplosions(nowMs: number, fog: FogView | null): void {
    const { ctx } = this;
    this.explosions = this.explosions.filter((e) => nowMs - e.start < EXPLOSION_MS);
    for (const e of this.explosions) {
      if (fog && !this.isPointVisible(e.x, e.y, fog)) continue;
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

  private drawFloor(maze: MazeDTO): void {
    const { ctx } = this;
    // Parchment arena floor.
    ctx.fillStyle = "#e7d9b8";
    ctx.fillRect(0, 0, maze.width, maze.height);
  }

  private drawMapFeatures(nowMs: number, fog: FogView | null): void {
    const { ctx } = this;
    // Team spawn zones: a faint wash of each team's color, with a soft dashed
    // outline. Drawn under the walls so the arena structure reads on top.
    for (const z of this.spawnZones) {
      ctx.fillStyle = hexToRgba(z.color, 0.14);
      ctx.fillRect(z.x, z.y, z.width, z.height);
      ctx.save();
      ctx.strokeStyle = hexToRgba(z.color, 0.5);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.strokeRect(z.x + 1, z.y + 1, z.width - 2, z.height - 2);
      ctx.restore();
    }

    // Hazard zones: animated terrain tints, drawn under the walls.
    for (const h of this.hazards) {
      if (fog && !this.isRectVisible(h.x, h.y, h.width, h.height, fog)) continue;
      const pulse = 0.28 + 0.1 * Math.abs(Math.sin(nowMs / 400));
      let color = "#c24f2f"; // lava — red-orange
      if (h.type === "mud") color = "#6b4a2f";
      else if (h.type === "ice") color = "#5a8cb8";
      else if (h.type === "heal") color = "#3f9e4f";
      ctx.fillStyle = hexToRgba(color, pulse);
      ctx.fillRect(h.x, h.y, h.width, h.height);
      ctx.save();
      ctx.strokeStyle = hexToRgba(color, 0.75);
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(h.x + 1, h.y + 1, h.width - 2, h.height - 2);
      ctx.restore();
    }
  }

  private drawWalls(maze: MazeDTO): void {
    const { ctx } = this;
    // Inked wall lines. Destroyed walls (hp <= 0) are skipped; damaged walls
    // are drawn with reduced alpha to show they're weakening.
    ctx.strokeStyle = "#352f25";
    ctx.lineWidth = maze.thickness;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < maze.walls.length; i++) {
      if (this.destructibleWalls && this.wallHp[i] <= 0) continue; // destroyed
      const w = maze.walls[i];
      ctx.moveTo(w.x1, w.y1);
      ctx.lineTo(w.x2, w.y2);
    }
    ctx.stroke();
    // Damaged walls get a second, lighter pass to show cracking.
    if (this.destructibleWalls) {
      ctx.strokeStyle = "#a89878";
      ctx.lineWidth = maze.thickness * 0.5;
      ctx.beginPath();
      for (let i = 0; i < maze.walls.length; i++) {
        const hp = this.wallHp[i];
        if (hp <= 0 || hp >= this.wallMaxHp) continue; // destroyed or undamaged
        const w = maze.walls[i];
        ctx.moveTo(w.x1, w.y1);
        ctx.lineTo(w.x2, w.y2);
      }
      ctx.stroke();
    }
  }

  private wallBlocksVision(index: number): boolean {
    return !this.destructibleWalls || this.wallHp[index] > 0;
  }

  private isRectVisible(x: number, y: number, width: number, height: number, fog: FogView): boolean {
    const points = [
      [x + width / 2, y + height / 2],
      [x, y],
      [x + width, y],
      [x, y + height],
      [x + width, y + height],
    ] as const;
    return points.some(([px, py]) => this.isPointVisible(px, py, fog));
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
      // Normally above the tank; flip below when it'd clip off the canvas top.
      const above = t.y - this.tankR - (t.maxHp > 1 ? 13 : 8);
      const labelY = above < 10 ? t.y + this.tankR + 14 : above;
      ctx.fillText(t.name, t.x, labelY);
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

    // Flags move with their carrier, so interpolate them on the same clock.
    const aFlags = new Map(a.snap.flags.map((fl) => [fl.team, fl]));
    const flags = b.snap.flags.map((fb) => {
      const fa = aFlags.get(fb.team);
      if (!fa) return fb;
      return { ...fb, x: lerp(fa.x, fb.x, f), y: lerp(fa.y, fb.y, f) };
    });

    return { t: target, tanks, bullets, powerups: [], flags, blasts: [], beams: [], events: [], wallHp: [] };
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
function angleDelta(a: number, b: number): number {
  let d = ((a - b + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function normalizeAngle(a: number): number {
  const v = a % (Math.PI * 2);
  return v < 0 ? v + Math.PI * 2 : v;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Distance along a unit ray to its first intersection with a segment. */
function raySegmentDistance(
  ox: number,
  oy: number,
  rx: number,
  ry: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number | null {
  const sx = bx - ax;
  const sy = by - ay;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qx = ax - ox;
  const qy = ay - oy;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  return t >= 0 && u >= 0 && u <= 1 ? t : null;
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

/** True if segment A-B intersects segment C-D (used for fog-of-war raycasting). */
function segIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): boolean {
  const d1x = bx - ax, d1y = by - ay;
  const d2x = dx - cx, d2y = dy - cy;
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return false; // parallel or collinear
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / denom;
  const u = ((cx - ax) * d1y - (cy - ay) * d1x) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
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

/** "#rrggbb" + alpha → an rgba() string. */
function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${alpha})`;
}

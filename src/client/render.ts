import { BULLET_RADIUS, POWERUP_RADIUS, TANK_RADIUS, VISION_RADIUS } from "../shared/constants.js";
import { buildFogShape, effectiveVisionRadius, pointInFogShape, type FogShape, type FogWall } from "../shared/fog.js";
import { playSfx } from "./audio.js";
import { state } from "./state.js";
import {
  powerupDef,
  type FogVisionMode,
  type FlagDTO,
  type HazardZoneDTO,
  type KillEvent,
  type MazeDTO,
  type PowerupDTO,
  type PowerupType,
  type SnapshotDTO,
  type SpawnZoneDTO,
  type TankDTO,
} from "../shared/protocol.js";

// Render this far in the past so we always have two snapshots to interpolate
// between. Must exceed the network send interval (≈66ms at 15 Hz) with margin.
const INTERP_DELAY = 140;

// Rapid fire's shots come fast — play its "pew" a bit faster/shorter so a
// burst doesn't sound mushy at the configured fire rate.
const RAPIDFIRE_PEW_RATE = 1.4;

// Bullets are rendered in the owning tank's color so shots are identifiable by
// shooter. Size varies a little by kind. Tracking rounds render as a triangle
// (drawn separately), the rest as filled circles.
const BULLET_COLOR = "#11100e";
/** A bullet takes the owning tank's color, falling back to the dark base. */
function bulletColor(tankColor: string | undefined): string {
  return tankColor ?? BULLET_COLOR;
}
/** Radius adjustment for a bullet, composed from its effect flags (explosive
 *  reads biggest; homing slightly larger; plain/sniper unchanged). */
function bulletDr(b: { homing: boolean; explosive: boolean }): number {
  if (b.explosive) return 2;
  if (b.homing) return 1;
  return 0;
}

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

interface FogSource {
  x: number;
  y: number;
  haloRadius: number;
  shape: FogShape;
}

interface FogView {
  local: TankDTO;
  sources: FogSource[];
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private fogOverlay: HTMLCanvasElement | null = null;
  private fogOverlayCtx: CanvasRenderingContext2D | null = null;
  private maze: MazeDTO | null = null;
  private worldWidth = 0;
  private worldHeight = 0;
  private dpr = 1;
  // Upper bound on devicePixelRatio (render-quality setting). Lower = fewer
  // pixels to fill each frame = less CPU/GPU, at the cost of some sharpness.
  private maxDpr = Infinity;
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
  private lastTankState = new Map<string, { x: number; y: number; alive: boolean; hp: number; color: string; ammo: number; weaponChargeSum: number; hadRapid: boolean; reloadIn: number; boosted: boolean; shielded: boolean; scoped: boolean }>();
  private lastPowerups = new Map<number, PowerupDTO>();
  private brickPattern: CanvasPattern | null = null;
  private steelPattern: CanvasPattern | null = null;
  // Bullet ids seen last frame, to detect rapid-fire's scheduled shots — they
  // add a bullet without changing ammo/weaponCharges (only the initiating
  // click does), so the ammo/charge-delta check below can't see them.
  private lastBulletIds = new Set<number>();
  // Transient effects (explosions, beams, kill events) are applied on the same
  // ~INTERP_DELAY-behind clock as the interpolated world, so a hit/death shows
  // exactly when the (delayed) bullet reaches the tank — not when the snapshot
  // arrives. `consumedUntil` is the recvAt of the last snapshot whose effects
  // we've fired; `pendingEvents` queues kill-log events for the main loop.
  private consumedUntil = 0;
  private pendingEvents: KillEvent[] = [];
  private displayedSnap: SnapshotDTO | null = null;
  // Fog of war: when on, non-wall visuals are clipped to team reveal sources.
  // Enemy tanks also need line of sight unless scope grants x-ray. Client-side
  // only — the server still broadcasts all entities.
  private fogOfWar = false;
  private visionRadius = VISION_RADIUS;
  private fogBaseVision: FogVisionMode = "team";
  private fogFlagVision: FogVisionMode = "team";
  private fogHideCarriedFlag = true;
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
  setFog(
    fogOfWar: boolean,
    visionRadius: number,
    fogBaseVision: FogVisionMode,
    fogFlagVision: FogVisionMode,
    fogHideCarriedFlag: boolean
  ): void {
    this.fogOfWar = fogOfWar;
    this.visionRadius = visionRadius;
    this.fogBaseVision = fogBaseVision;
    this.fogFlagVision = fogFlagVision;
    this.fogHideCarriedFlag = fogHideCarriedFlag;
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
    this.resizeDrawingBuffer(maze.width, maze.height);
    this.buffer = [];
    this.explosions = [];
    this.beams = [];
    this.lastTankState.clear();
    this.lastPowerups.clear();
    this.lastBulletIds.clear();
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
      this.detectTransients(snap, nowMs);
      for (const b of snap.blasts) {
        this.explosions.push({ x: b.x, y: b.y, color: "#e6863f", start: nowMs });
        playSfx("explosion", 0.5);
      }
      for (const bm of snap.beams) {
        this.beams.push({ x1: bm.x1, y1: bm.y1, x2: bm.x2, y2: bm.y2, start: nowMs });
        playSfx("pew", 0.3);
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

  /** Spawn an explosion wherever a tank died, and play sounds for firing. */
  private detectTransients(snap: SnapshotDTO, nowMs: number): void {
    const seen = new Set<string>();
    // New bullets this frame, per owner — catches rapid-fire's scheduled
    // shots, which add a bullet without an ammo/weaponCharges change.
    const newBulletsByOwner = new Map<string, number>();
    for (const b of snap.bullets) {
      if (this.lastBulletIds.has(b.id)) continue;
      newBulletsByOwner.set(b.ownerId, (newBulletsByOwner.get(b.ownerId) ?? 0) + 1);
    }
    this.lastBulletIds = new Set(snap.bullets.map((b) => b.id));
    for (const t of snap.tanks) {
      seen.add(t.id);
      const prev = this.lastTankState.get(t.id);
      if (prev && prev.alive) {
        if (!t.alive) {
          this.explosions.push({ x: prev.x, y: prev.y, color: t.color, start: nowMs });
          playSfx("explosion", 0.5);
        } else {
          if (prev.hp !== undefined && t.hp < prev.hp) {
            playSfx("oof", 0.4);
          }
          
          // Play firing sound if ammo dropped, or if they reloaded and fired in the same snapshot
          const chargeSum = Object.values(t.weaponCharges).reduce((a, n) => a + (n ?? 0), 0);
          const firedNormal = t.ammo < prev.ammo || (prev.ammo === 0 && t.ammo > 0 && t.ammo < t.maxAmmo);
          const firedSpecial = !t.charging && chargeSum < prev.weaponChargeSum && prev.weaponChargeSum > 0;
          const isRapid = prev.hadRapid;
          const rapidFireRate = isRapid ? RAPIDFIRE_PEW_RATE : 1.0;

          if (firedNormal || firedSpecial) {
            playSfx("pew", 0.3, rapidFireRate);
            // A rapid-fire click can share a frame with its first scheduled
            // shot(s) when the delay is shorter than the snapshot interval; sound
            // those extras too. (Multishot fires one logical volley, so its extra
            // pellets are intentionally left as a single pew.)
            if (isRapid) {
              const extra = (newBulletsByOwner.get(t.id) ?? 0) - 1;
              for (let i = 0; i < extra; i++) playSfx("pew", 0.3, RAPIDFIRE_PEW_RATE);
            }
          } else {
            // A scheduled rapid-fire shot: a new bullet appeared for this tank
            // with no ammo/charge change to explain it (see newBulletsByOwner).
            const echoes = newBulletsByOwner.get(t.id) ?? 0;
            for (let i = 0; i < echoes; i++) playSfx("pew", 0.3, RAPIDFIRE_PEW_RATE);
          }
          
          if (prev.reloadIn === 0 && t.reloadIn > 0) {
            playSfx("reloading", 0.4);
          }
        }
      }
      this.lastTankState.set(t.id, {
        x: t.x, y: t.y, alive: t.alive, hp: t.hp, color: t.color,
        ammo: t.ammo,
        weaponChargeSum: Object.values(t.weaponCharges).reduce((a, n) => a + (n ?? 0), 0),
        hadRapid: (t.weaponCharges.rapidfire ?? 0) > 0,
        reloadIn: t.reloadIn, boosted: t.boosted, shielded: t.shielded, scoped: t.scoped
      });
    }
    // A previously-alive tank that vanished (killed while disconnected) also pops.
    for (const [id, prev] of this.lastTankState) {
      if (!seen.has(id)) {
        if (prev.alive) {
          this.explosions.push({ x: prev.x, y: prev.y, color: prev.color, start: nowMs });
          playSfx("explosion", 0.5);
        }
        this.lastTankState.delete(id);
      }
    }

    let playedPowerupSound = false;
    const currentPowerupIds = new Set(snap.powerups.map(p => p.id));
    for (const p of this.lastPowerups.values()) {
      if (!currentPowerupIds.has(p.id)) {
        // Powerup disappeared. Was it picked up by the local player?
        const me = snap.tanks.find(t => t.id === state.playerId);
        if (me && me.alive) {
          const dx = me.x - p.x;
          const dy = me.y - p.y;
          if (dx * dx + dy * dy <= 1600) { // 40 radius squared, for some interpolation margin
            playedPowerupSound = true;
          }
        }
      }
    }
    this.lastPowerups.clear();
    for (const p of snap.powerups) {
      this.lastPowerups.set(p.id, p);
    }
    if (playedPowerupSound) {
      playSfx("powerup", 0.6);
    }
  }

  /** Most recent snapshot — used for authoritative HUD/score and local aim. */
  latest(): SnapshotDTO | null {
    return this.buffer.length ? this.buffer[this.buffer.length - 1].snap : null;
  }

  render(localId: string, nowMs: number): void {
    const { ctx, maze } = this;
    if (!maze) return;
    if (this.dpr !== this.currentDpr()) this.resizeDrawingBuffer(this.worldWidth, this.worldHeight);

    // Fire any effects the interpolation clock has now reached (delayed in lockstep
    // with the world below), then draw the world ~INTERP_DELAY in the past.
    this.consumeEffects(nowMs - INTERP_DELAY, nowMs);

    const interp = this.interpolated(nowMs);
    this.displayedSnap = interp;
    const localTank = interp?.tanks.find((t) => t.id === localId) ?? null;
    const fog = this.fogView(localTank, interp?.tanks ?? []);

    ctx.clearRect(0, 0, maze.width, maze.height);
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
        // Radius derives from the composed effect flags (beta's axis model); the
        // fill honors the active visual theme, else the owner's tint.
        const rad = Math.max(1, this.bulletR + bulletDr(b));
        if (state.realisticEnabled) {
          ctx.fillStyle = "#3a3a2a"; // Dark olive tracer rounds
        } else if (state.modernEnabled) {
          ctx.fillStyle = "#00f8f8"; // Glowing cyan plasma bullets
        } else if (state.battleCityEnabled) {
          ctx.fillStyle = "#f8f8f8"; // High-visibility retro white bullets
        } else {
          ctx.fillStyle = bulletColor(tankColors.get(b.ownerId));
        }
        if (b.homing) {
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
      // Redraw the local tank and walls over the dark wash so they stay crisp.
      this.drawTank(fog.local, true, nowMs);
      this.drawWalls(maze);
      // Flags revealed by config show faintly over the fog (out-of-sight only).
      this.drawFlagMarkers(interp, nowMs, fog);
    }
  }

  private applyWallHp(): void {
    if (!this.destructibleWalls) return;
    const latest = this.latest();
    if (!latest) return;
    // The snapshot carries the authoritative set of below-full walls, so reset
    // everything to full first — this restores walls that have regrown.
    this.wallHp.fill(this.wallMaxHp);
    for (const w of latest.wallHp) {
      if (w.index < this.wallHp.length) this.wallHp[w.index] = w.hp;
    }
  }

  private fogView(local: TankDTO | null, tanks: TankDTO[]): FogView | null {
    if (!this.fogOfWar || !local || !this.maze) return null;
    const visionTanks = [
      local,
      ...(
        local.team >= 0
          ? tanks.filter((t) => t.id !== local.id && t.alive && t.team === local.team)
          : []
      ),
    ];
    const baseRadius = effectiveVisionRadius(this.visionRadius, this.maze.width, this.maze.height);
    const arena = { x: 0, y: 0, width: this.maze.width, height: this.maze.height };
    const walls = this.visionWalls();
    // Scope only benefits its own user: a teammate's scope must not extend or
    // x-ray the local player's fog, so honor `scoped` for the local tank only.
    const sources = visionTanks.map((t) => this.tankFogSource(t, baseRadius, t.id === local.id, arena, walls));
    for (const z of this.spawnZones) {
      if (!this.fogVisionIncludes(z.team, local.team, this.fogBaseVision)) continue;
      // Bases reveal exactly their own square zone, not a circle around it.
      sources.push(this.staticRectFogSource(z.x, z.y, z.width, z.height));
    }
    // Flags don't grant vision; instead they're drawn faintly over the fog
    // (gated by fogFlagVision) in drawFlagMarkers so you can spot them.
    return { local, sources };
  }

  private fogVisionIncludes(ownerTeam: number, localTeam: number, mode: FogVisionMode): boolean {
    if (mode === "all") return true;
    return mode === "team" && localTeam >= 0 && ownerTeam === localTeam;
  }

  private visionWalls(): readonly FogWall[] {
    if (!this.maze) return [];
    if (!this.destructibleWalls) return this.maze.walls;
    return this.maze.walls.filter((_, i) => this.wallHp[i] > 0);
  }

  private tankFogSource(
    tank: TankDTO,
    baseRadius: number,
    applyScope: boolean,
    arena: { x: number; y: number; width: number; height: number },
    walls: readonly FogWall[]
  ): FogSource {
    // Scope only benefits its own user: a teammate's scope must not extend or
    // x-ray the local player's fog, so honor `scoped` for the local tank only.
    const scoped = applyScope && tank.scoped;
    const radius = scoped ? baseRadius * 2 : baseRadius;
    return {
      x: tank.x,
      y: tank.y,
      haloRadius: this.tankR + 9,
      shape: buildFogShape({ x: tank.x, y: tank.y, radius, seesThroughWalls: scoped, arena, walls }),
    };
  }

  /** A reveal source shaped as an axis-aligned rectangle (its own square base zone). */
  private staticRectFogSource(x: number, y: number, width: number, height: number): FogSource {
    return {
      x: x + width / 2,
      y: y + height / 2,
      haloRadius: 0,
      shape: { kind: "rect", x, y, width, height },
    };
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

  private addFogShape(fog: FogView, includeHalo: boolean, ctx: CanvasRenderingContext2D = this.ctx): void {
    for (const source of fog.sources) {
      const shape = source.shape;
      if (shape.kind === "rect") {
        ctx.rect(shape.x, shape.y, shape.width, shape.height);
      } else if (shape.kind === "circle") {
        ctx.moveTo(shape.x + shape.radius, shape.y);
        ctx.arc(shape.x, shape.y, shape.radius, 0, Math.PI * 2);
      } else if (shape.points.length > 0) {
        ctx.moveTo(shape.points[0].x, shape.points[0].y);
        for (let i = 1; i < shape.points.length; i++) ctx.lineTo(shape.points[i].x, shape.points[i].y);
        ctx.closePath();
      }
      if (includeHalo && source.haloRadius > 0) {
        ctx.moveTo(source.x + source.haloRadius, source.y);
        ctx.arc(source.x, source.y, source.haloRadius, 0, Math.PI * 2);
      }
    }
  }

  private drawFogOverlay(fog: FogView, maze: MazeDTO): void {
    const { ctx } = this;
    const { canvas: overlay, ctx: overlayCtx } = this.fogOverlayTarget(maze.width, maze.height);
    overlayCtx.clearRect(0, 0, maze.width, maze.height);
    overlayCtx.globalCompositeOperation = "source-over";
    overlayCtx.fillStyle = "#12100e";
    overlayCtx.fillRect(0, 0, maze.width, maze.height);
    overlayCtx.globalCompositeOperation = "destination-out";
    overlayCtx.beginPath();
    this.addFogShape(fog, true, overlayCtx);
    overlayCtx.fill();
    overlayCtx.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.drawImage(overlay, 0, 0);
    ctx.restore();
  }

  private fogOverlayTarget(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    if (!this.fogOverlay) {
      this.fogOverlay = document.createElement("canvas");
      this.fogOverlayCtx = this.fogOverlay.getContext("2d");
      if (!this.fogOverlayCtx) throw new Error("2D canvas context unavailable");
    }
    if (this.fogOverlay.width !== width || this.fogOverlay.height !== height) {
      this.fogOverlay.width = width;
      this.fogOverlay.height = height;
    }
    return { canvas: this.fogOverlay, ctx: this.fogOverlayCtx! };
  }

  /**
   * Line-of-sight check for fog of war. An enemy is visible when any team reveal
   * source can see it; scoped tank sources skip the wall check (x-ray).
   */
  private isVisible(enemy: TankDTO, fog: FogView): boolean {
    if (fog.local.team >= 0 && enemy.team === fog.local.team) return true;
    if (!this.isPointVisible(enemy.x, enemy.y, fog)) return false;
    return true;
  }

  private isPointVisible(x: number, y: number, fog: FogView): boolean {
    return fog.sources.some((source) => this.isPointVisibleFromSource(x, y, source));
  }

  private isPointVisibleFromSource(x: number, y: number, fog: FogSource): boolean {
    const localDx = x - fog.x;
    const localDy = y - fog.y;
    if (localDx * localDx + localDy * localDy <= fog.haloRadius * fog.haloRadius) return true;
    return pointInFogShape(x, y, fog.shape);
  }

  /**
   * Backing-store pixels scale with DPR for sharp Retina rendering, but all draw
   * calls stay in maze/world coordinates through the canvas transform. Input code
   * reads the stored world size so mouse aiming is not multiplied by DPR.
   */
  public resizeDrawingBuffer(worldWidth: number, worldHeight: number): void {
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;
    this.dpr = this.currentDpr();
    this.canvas.width = Math.round(worldWidth * this.dpr);
    this.canvas.height = Math.round(worldHeight * this.dpr);
    this.canvas.dataset.worldWidth = String(worldWidth);
    this.canvas.dataset.worldHeight = String(worldHeight);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private currentDpr(): number {
    if (state.retroEnabled) return 0.25;
    return Math.max(1, Math.min(this.maxDpr, window.devicePixelRatio || 1));
  }

  /** Set the render-quality DPR cap and re-apply it to the current canvas. */
  setMaxDpr(maxDpr: number): void {
    this.maxDpr = maxDpr;
    if (this.maze) this.resizeDrawingBuffer(this.worldWidth, this.worldHeight);
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
      if ((t.weaponCharges.explosive ?? 0) > 0 && end) {
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
   * One or more trajectory polylines for a tank's current shot, composed from
   * whatever weapon effects it holds — mirrors the server's recipe: sniper is
   * fast/straight/piercing (only when not homing/explosive), explosive stops at
   * the first wall (unless homing suppresses it), tracking uses its longer
   * lifetime/bounces, multishot fans, laser is a hitscan beam.
   */
  private scopePaths(me: TankDTO, vel: { x: number; y: number }): Array<{ x: number; y: number }[]> {
    const a = me.turretAngle;
    const sc = this.scope;
    // A round lives `lifetime` seconds, so it travels its real speed × lifetime.
    const reach = (vx: number, vy: number, lifetime: number) => Math.hypot(vx, vy) * lifetime;
    const muzzle = this.tankR + this.bulletR + 2;
    const has = (w: PowerupType) => (me.weaponCharges[w] ?? 0) > 0;

    if (has("laser")) {
      // Beam carrier: a hitscan ray that reflects, from just outside the hull.
      // Honors the fan (multishot → several beams); ignores the projectile axes.
      const n = has("multishot") ? Math.max(1, Math.round(sc.multiCount)) : 1;
      const spread = has("multishot") ? (sc.multiSpread * Math.PI) / 180 : 0;
      const beams: Array<{ x: number; y: number }[]> = [];
      for (let i = 0; i < n; i++) {
        const ang = n > 1 ? a - spread / 2 + (spread / (n - 1)) * i : a;
        const bx = me.x + Math.cos(ang) * (this.tankR + 2);
        const by = me.y + Math.sin(ang) * (this.tankR + 2);
        beams.push(this.walkPath(bx, by, Math.cos(ang), Math.sin(ang), { range: sc.laserRange, bounces: Infinity }));
      }
      return beams;
    }

    const homing = has("tracking");
    const explosive = has("explosive");
    const sniper = has("sniper");
    const speed = sc.bulletSpeed * (sniper ? sc.sniperSpeedMult : 1);
    const life = homing ? sc.trackingLifetime : sc.bulletLifetime;
    const bounces = homing ? sc.trackingBounces : sc.bulletBounces;
    const pureSniper = sniper && !homing && !explosive;
    const stopOnWall = explosive && !homing;

    // Trajectory for one launch angle, composing the held per-bullet effects.
    const walkShot = (ang: number): { x: number; y: number }[] => {
      const mx = me.x + Math.cos(ang) * muzzle;
      const my = me.y + Math.sin(ang) * muzzle;
      if (pureSniper) {
        return this.walkPath(mx, my, Math.cos(ang), Math.sin(ang), {
          range: speed * life,
          straight: true,
          pierce: sc.sniperWallPierce,
        });
      }
      // Sniper ignores tank momentum; others inherit it.
      const pvx = Math.cos(ang) * speed + (sniper ? 0 : vel.x);
      const pvy = Math.sin(ang) * speed + (sniper ? 0 : vel.y);
      const range = reach(pvx, pvy, life);
      return stopOnWall
        ? this.walkPath(mx, my, pvx, pvy, { range, stopOnWall: true })
        : this.walkPath(mx, my, pvx, pvy, { range, bounces });
    };

    if (has("multishot")) {
      const n = Math.max(1, Math.round(sc.multiCount));
      const fan = (sc.multiSpread * Math.PI) / 180;
      const stepA = n > 1 ? fan / (n - 1) : 0;
      const start = a - fan / 2;
      const paths: Array<{ x: number; y: number }[]> = [];
      for (let i = 0; i < n; i++) paths.push(walkShot(n > 1 ? start + stepA * i : a));
      return paths;
    }
    return [walkShot(a)];
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
      
      if (state.battleCityEnabled) {
        // Battle City 8-bit retro powerup box (pulsing pixelated style)
        ctx.translate(p.x, p.y + (Math.floor(nowMs / 180) % 2) * 1.5);
        const flash = Math.floor(nowMs / 120) % 2 === 0;
        ctx.fillStyle = flash ? "#f8b800" : "#d80000";
        ctx.fillRect(-s, -s, s * 2, s * 2);
        
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.strokeRect(-s + 1, -s + 1, s * 2 - 2, s * 2 - 2);
        
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 16px 'VT323', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(def.emblem.substring(0, 1).toUpperCase(), 0, 0);
      } else if (state.modernEnabled) {
        // Modern 4K glowing holographic projection
        ctx.translate(p.x, p.y + bob * 2.0);
        
        // Ground shadow/ripple
        ctx.beginPath();
        ctx.arc(0, s * 1.2 - bob, s * 1.2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0, 248, 248, 0.12)";
        ctx.fill();
        
        // Hologram base ring
        ctx.strokeStyle = "rgba(0, 248, 248, 0.4)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, s * 1.1, s * 0.9, 0, Math.PI * 2);
        ctx.stroke();

        // Glowing core
        const grad = ctx.createRadialGradient(0, 0, 1, 0, 0, s * 1.3);
        grad.addColorStop(0, "rgba(0, 248, 248, 0.5)");
        grad.addColorStop(0.5, "rgba(0, 248, 248, 0.2)");
        grad.addColorStop(1, "rgba(0, 248, 248, 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, s * 1.3, 0, Math.PI * 2);
        ctx.fill();

        // Neon bounds ring
        ctx.strokeStyle = def.color;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = def.color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(0, 0, s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0; // reset

        // Float emblem
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 13px 'Orbitron', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(def.emblem, 0, 0);
      } else if (state.realisticEnabled) {
        // Realistic military supply crate (olive drab metal box with stenciling)
        ctx.translate(p.x, p.y + bob * 0.5);
        ctx.fillStyle = "#3e4830"; // Army olive drab
        ctx.fillRect(-s, -s, s * 2, s * 2);
        
        ctx.strokeStyle = "#252b1b"; // Dark metal borders
        ctx.lineWidth = 2;
        ctx.strokeRect(-s, -s, s * 2, s * 2);
        
        // Stencil warning stripes
        ctx.fillStyle = "#b8860b"; // Warning yellow-green
        ctx.fillRect(-s + 1, -s + 1, 4, 3);
        ctx.fillRect(s - 5, -s + 1, 4, 3);

        // Supply star emblem
        ctx.strokeStyle = "rgba(221, 232, 192, 0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        // Simple star outline
        ctx.arc(0, 0, s * 0.45, 0, Math.PI * 2);
        ctx.stroke();
        
        ctx.fillStyle = "rgba(221, 232, 192, 0.85)";
        ctx.font = "bold 11px 'Courier New', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(def.emblem, 0, 0.5);
      } else {
        // Default paper style crate
        ctx.translate(p.x, p.y + bob);
        ctx.fillStyle = "#c79a5b";
        ctx.fillRect(-s, -s, s * 2, s * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#6e4a1e";
        ctx.strokeRect(-s, -s, s * 2, s * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(110,74,30,0.7)";
        ctx.beginPath();
        ctx.moveTo(-s, -s);
        ctx.lineTo(s, s);
        ctx.moveTo(s, -s);
        ctx.lineTo(-s, s);
        ctx.stroke();

        ctx.fillStyle = def.color;
        ctx.font = "bold 14px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.strokeStyle = "rgba(27,22,16,0.85)";
        ctx.lineWidth = 3;
        ctx.strokeText(def.emblem, 0, 1);
        ctx.fillText(def.emblem, 0, 1);
      }
      ctx.restore();
    }
    ctx.textBaseline = "alphabetic";
  }

  /** CTF flags: a pennant on a pole in the team's color. Dropped flags pulse.
   *  When one tank carries several flags, their pennants stack up a taller pole
   *  (lowest team index at the bottom) so every held flag stays visible. */
  private drawFlags(interp: SnapshotDTO, nowMs: number, fog: FogView | null): void {
    if (interp.flags.length === 0) return;
    const teamColor = new Map(this.spawnZones.map((z) => [z.team, z.color]));
    const stackIndex = this.flagStackIndex(interp.flags);
    for (const fl of interp.flags) {
      if (fog && !this.isPointVisible(fl.x, fl.y, fog)) continue;
      this.drawFlag(fl, teamColor.get(fl.team) ?? "#888888", stackIndex.get(fl) ?? 0, nowMs, 1);
    }
  }

  /**
   * Flags don't grant vision. Instead, when fogFlagVision allows it, draw flags
   * that fall outside the team's sight faintly on top of the fog so players can
   * still spot them without revealing the surrounding maze.
   */
  private drawFlagMarkers(interp: SnapshotDTO, nowMs: number, fog: FogView): void {
    if (this.fogFlagVision === "off" || interp.flags.length === 0) return;
    const teamColor = new Map(this.spawnZones.map((z) => [z.team, z.color]));
    const stackIndex = this.flagStackIndex(interp.flags);
    for (const fl of interp.flags) {
      if (this.isPointVisible(fl.x, fl.y, fog)) continue; // already drawn crisply in sight
      // A carried flag must not be trackable across the fog (only via line of sight).
      if (this.fogHideCarriedFlag && fl.state === "carried") continue;
      if (!this.fogVisionIncludes(fl.team, fog.local.team, this.fogFlagVision)) continue;
      this.drawFlag(
        fl,
        teamColor.get(fl.team) ?? "#888888",
        stackIndex.get(fl) ?? 0,
        nowMs,
        0.75,
        "rgba(255,255,255,0.9)",
      );
    }
  }

  /** Stack order for carried flags: index within their carrier's held set. */
  private flagStackIndex(flags: FlagDTO[]): Map<FlagDTO, number> {
    const stackIndex = new Map<FlagDTO, number>();
    const byCarrier = new Map<number, FlagDTO[]>();
    for (const fl of flags) {
      if (fl.state !== "carried" || fl.carrier === 255) continue;
      const list = byCarrier.get(fl.carrier) ?? [];
      list.push(fl);
      byCarrier.set(fl.carrier, list);
    }
    for (const list of byCarrier.values()) {
      list.sort((a, b) => a.team - b.team);
      list.forEach((fl, i) => stackIndex.set(fl, i));
    }
    return stackIndex;
  }

  /** Draw a single CTF flag (pennant on a pole). `alpha` scales opacity so the
   *  same drawing serves both crisp in-sight flags and faint fog markers.
   *  `outline`, when set, draws a contrasting halo so the flag pops over fog. */
  private drawFlag(
    fl: FlagDTO,
    color: string,
    tier: number,
    nowMs: number,
    alpha: number,
    outline?: string,
  ): void {
    const { ctx } = this;
    const PENNANT_GAP = 9; // vertical spacing between stacked pennants
    const bob = fl.state === "carried" ? 0 : Math.sin(nowMs / 300) * 1.5;
    const peak = 18 + tier * PENNANT_GAP; // pole height for this pennant's tier
    ctx.save();
    ctx.translate(fl.x, fl.y + bob);
    ctx.lineJoin = "round";
    const pulse = fl.state === "dropped" ? 0.55 + 0.25 * Math.abs(Math.sin(nowMs / 250)) : 1;
    ctx.globalAlpha = pulse * alpha;
    const polePath = () => {
      ctx.beginPath();
      ctx.moveTo(0, 4);
      ctx.lineTo(0, -peak);
    };
    const pennantPath = () => {
      ctx.beginPath();
      ctx.moveTo(0, -peak);
      ctx.lineTo(13, -peak + 4.5);
      ctx.lineTo(0, -peak + 9);
      ctx.closePath();
    };
    // Contrasting outline drawn underneath so the flag stands out against fog.
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = 5;
      polePath();
      ctx.stroke();
      pennantPath();
      ctx.stroke();
    }
    // Pole (tall enough to reach this tier's pennant).
    ctx.strokeStyle = "#352f25";
    ctx.lineWidth = 2;
    polePath();
    ctx.stroke();
    // Pennant at this tier.
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    pennantPath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
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

  private initPatterns(): void {
    if (this.brickPattern && this.steelPattern) return;
    const { ctx } = this;
    
    // Create brick canvas (8x8 pixels)
    const bCanvas = document.createElement("canvas");
    bCanvas.width = 8;
    bCanvas.height = 8;
    const bCtx = bCanvas.getContext("2d")!;
    bCtx.fillStyle = "#a83800"; // Red-brown bricks
    bCtx.fillRect(0, 0, 8, 8);
    bCtx.fillStyle = "#f8b800"; // Retro yellowish-orange mortar
    bCtx.fillRect(0, 7, 8, 1);
    bCtx.fillRect(7, 0, 1, 8);
    bCtx.fillRect(3, 0, 1, 4);
    this.brickPattern = ctx.createPattern(bCanvas, "repeat");
    
    // Create steel canvas (16x16 pixels)
    const sCanvas = document.createElement("canvas");
    sCanvas.width = 16;
    sCanvas.height = 16;
    const sCtx = sCanvas.getContext("2d")!;
    sCtx.fillStyle = "#b8b8b8"; // Light grey steel blocks
    sCtx.fillRect(0, 0, 16, 16);
    sCtx.fillStyle = "#ffffff"; // Highlights
    sCtx.fillRect(0, 0, 16, 1);
    sCtx.fillRect(0, 0, 1, 16);
    sCtx.fillStyle = "#000000"; // Shadows
    sCtx.fillRect(0, 15, 16, 1);
    sCtx.fillRect(15, 0, 1, 16);
    sCtx.fillStyle = "#808080"; // Inset grey
    sCtx.fillRect(2, 2, 12, 12);
    sCtx.fillStyle = "#b8b8b8";
    sCtx.fillRect(4, 4, 8, 8);
    this.steelPattern = ctx.createPattern(sCanvas, "repeat");
  }

  private drawFloor(maze: MazeDTO): void {
    const { ctx } = this;
    if (state.realisticEnabled) {
      // Sandy terrain base
      ctx.fillStyle = "#8b7d5e";
      ctx.fillRect(0, 0, maze.width, maze.height);
      
      // Subtle terrain noise overlay with darker splotches
      ctx.save();
      ctx.globalAlpha = 0.06;
      const patchSize = 48;
      for (let x = 0; x < maze.width; x += patchSize) {
        for (let y = 0; y < maze.height; y += patchSize) {
          const v = ((x * 7 + y * 13) % 37) / 37;
          const shade = Math.floor(v * 40) - 20;
          const r = 139 + shade, g = 125 + shade, b = 94 + shade;
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x, y, patchSize, patchSize);
        }
      }
      ctx.restore();
      return;
    }

    if (state.modernEnabled) {
      ctx.fillStyle = "#090d16"; // Modern slate background
      ctx.fillRect(0, 0, maze.width, maze.height);
      
      // Draw glowing cybernetic floor grid
      ctx.save();
      ctx.strokeStyle = "rgba(0, 248, 248, 0.04)";
      ctx.lineWidth = 1;
      const gridSize = 64;
      ctx.beginPath();
      for (let x = 0; x < maze.width; x += gridSize) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, maze.height);
      }
      for (let y = 0; y < maze.height; y += gridSize) {
        ctx.moveTo(0, y);
        ctx.lineTo(maze.width, y);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (state.battleCityEnabled) {
      ctx.fillStyle = "#000000"; // Pitch black Battle City background
    } else {
      ctx.fillStyle = "#e7d9b8";
    }
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
    if (state.realisticEnabled) {
      // Concrete barrier walls with shadow depth effect
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      
      // Shadow pass underneath
      ctx.beginPath();
      for (let i = 0; i < maze.walls.length; i++) {
        if (this.destructibleWalls && this.wallHp[i] <= 0) continue;
        const w = maze.walls[i];
        ctx.moveTo(w.x1 + 2, w.y1 + 2);
        ctx.lineTo(w.x2 + 2, w.y2 + 2);
      }
      ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
      ctx.lineWidth = maze.thickness + 2;
      ctx.stroke();
      
      // Main concrete wall
      ctx.beginPath();
      for (let i = 0; i < maze.walls.length; i++) {
        if (this.destructibleWalls && this.wallHp[i] <= 0) continue;
        const w = maze.walls[i];
        ctx.moveTo(w.x1, w.y1);
        ctx.lineTo(w.x2, w.y2);
      }
      ctx.strokeStyle = "#5a5a50";
      ctx.lineWidth = maze.thickness;
      ctx.stroke();
      
      // Highlight edge on top
      ctx.strokeStyle = "rgba(180, 175, 160, 0.3)";
      ctx.lineWidth = 2;
      ctx.stroke();
      
      ctx.restore();
      return;
    }

    if (state.modernEnabled) {
      // Draw futuristic glowing neon borders!
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      
      // Pass 1: Soft outer neon bloom
      ctx.beginPath();
      for (let i = 0; i < maze.walls.length; i++) {
        if (this.destructibleWalls && this.wallHp[i] <= 0) continue;
        const w = maze.walls[i];
        ctx.moveTo(w.x1, w.y1);
        ctx.lineTo(w.x2, w.y2);
      }
      ctx.strokeStyle = "rgba(0, 248, 248, 0.15)";
      ctx.lineWidth = maze.thickness + 6;
      ctx.stroke();

      // Pass 2: Secondary core glow
      ctx.strokeStyle = "rgba(0, 248, 248, 0.4)";
      ctx.lineWidth = maze.thickness + 2;
      ctx.stroke();

      // Pass 3: Bright white center wire
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.restore();
      return;
    }

    if (state.battleCityEnabled) {
      this.initPatterns();
      for (let i = 0; i < maze.walls.length; i++) {
        if (this.destructibleWalls && this.wallHp[i] <= 0) continue;
        const w = maze.walls[i];
        
        // Boundaries are steel, interior walls are destructible bricks
        const isBorder = w.x1 === 0 || w.y1 === 0 || w.x2 === maze.width || w.y2 === maze.height;
        const isDestructible = this.destructibleWalls && !isBorder;
        
        ctx.fillStyle = (isDestructible ? this.brickPattern : this.steelPattern) || "#352f25";
        
        // Fill rectangles for clean alignment of repeating pixel patterns
        const thickness = maze.thickness;
        const x = Math.min(w.x1, w.x2) - thickness / 2;
        const y = Math.min(w.y1, w.y2) - thickness / 2;
        const width = Math.abs(w.x2 - w.x1) + thickness;
        const height = Math.abs(w.y2 - w.y1) + thickness;
        ctx.fillRect(x, y, width, height);
      }
      return;
    }

    // Default Tanka Maze wall drawing code:
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < maze.walls.length; i++) {
      if (this.destructibleWalls && this.wallHp[i] <= 0) continue; // destroyed
      const w = maze.walls[i];
      ctx.moveTo(w.x1, w.y1);
      ctx.lineTo(w.x2, w.y2);
    }
    ctx.strokeStyle = "rgba(228,214,176,0.5)";
    ctx.lineWidth = maze.thickness + 3;
    ctx.stroke();
    ctx.strokeStyle = "#352f25";
    ctx.lineWidth = maze.thickness;
    ctx.stroke();
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

    const r = this.tankR;

    if (state.realisticEnabled) {
      // Local-player subtle ground shadow marker
      if (isLocal && t.alive) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.rotate(t.bodyAngle);
      
      // Realistic military olive/tan colors
      let hullColor = "#4a5a3c"; // Enemy: olive drab
      let darkColor = "#3a4a2c";
      if (isLocal) {
        hullColor = "#5b6b32"; // Player: woodland green
        darkColor = "#4a5a28";
      } else if (t.team !== -1) {
        const localTeam = this.displayedSnap?.tanks.find(tk => tk.id === state.playerId)?.team;
        if (t.team === localTeam) {
          hullColor = "#6b7b42"; // Teammate: lighter green
          darkColor = "#5a6a38";
        }
      }

      // Resolve chassis style
      let style = state.realisticStyle;
      if (!isLocal) {
        const hash = t.id.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const styles = ["abrams", "leopard", "t90", "bradley"] as const;
        style = styles[hash % styles.length];
      }

      // Tracks/treads — all styles have them
      const trackW = style === "bradley" ? r * 0.3 : r * 0.38;
      const trackH = style === "leopard" ? r * 2.3 : r * 2.1;
      const trackOff = style === "bradley" ? r * 0.82 : r * 0.92;
      
      ctx.fillStyle = "#1a1a18";
      ctx.fillRect(-trackH/2, -trackOff - trackW/2, trackH, trackW);
      ctx.fillRect(-trackH/2, trackOff - trackW/2, trackH, trackW);
      // Track link detail — subtle horizontal ridges
      ctx.strokeStyle = "rgba(80, 75, 65, 0.5)";
      ctx.lineWidth = 0.8;
      for (let xo = -trackH/2 + 4; xo < trackH/2; xo += 5) {
        ctx.beginPath();
        ctx.moveTo(xo, -trackOff - trackW/2);
        ctx.lineTo(xo, -trackOff + trackW/2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(xo, trackOff - trackW/2);
        ctx.lineTo(xo, trackOff + trackW/2);
        ctx.stroke();
      }

      // Hull shapes per style
      if (style === "abrams") {
        // Angular front wedge hull — M1A2 style
        ctx.fillStyle = hullColor;
        ctx.beginPath();
        ctx.moveTo(-r * 0.85, -r * 0.8);
        ctx.lineTo(r * 0.5, -r * 0.8);
        ctx.lineTo(r * 0.95, -r * 0.4);
        ctx.lineTo(r * 0.95, r * 0.4);
        ctx.lineTo(r * 0.5, r * 0.8);
        ctx.lineTo(-r * 0.85, r * 0.8);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = darkColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // Engine deck hatches
        ctx.fillStyle = darkColor;
        ctx.fillRect(-r * 0.8, -r * 0.35, r * 0.5, r * 0.7);
        ctx.strokeStyle = "rgba(0,0,0,0.3)";
        ctx.strokeRect(-r * 0.8, -r * 0.35, r * 0.5, r * 0.7);
      } else if (style === "leopard") {
        // Smooth wedge hull — German precision
        ctx.fillStyle = hullColor;
        ctx.beginPath();
        ctx.moveTo(-r * 0.9, -r * 0.75);
        ctx.lineTo(r * 0.7, -r * 0.65);
        ctx.lineTo(r * 1.0, 0);
        ctx.lineTo(r * 0.7, r * 0.65);
        ctx.lineTo(-r * 0.9, r * 0.75);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = darkColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // Side skirts
        ctx.fillStyle = shade(hullColor, -12);
        ctx.fillRect(-r * 0.85, -r * 0.8, r * 1.5, r * 0.12);
        ctx.fillRect(-r * 0.85, r * 0.68, r * 1.5, r * 0.12);
      } else if (style === "t90") {
        // Rounded turret-forward hull — Russian school
        ctx.fillStyle = hullColor;
        ctx.beginPath();
        ctx.moveTo(-r * 0.85, -r * 0.78);
        ctx.lineTo(r * 0.6, -r * 0.78);
        ctx.quadraticCurveTo(r * 0.95, -r * 0.5, r * 0.95, 0);
        ctx.quadraticCurveTo(r * 0.95, r * 0.5, r * 0.6, r * 0.78);
        ctx.lineTo(-r * 0.85, r * 0.78);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = darkColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // ERA blocks (reactive armor)
        ctx.fillStyle = shade(hullColor, -18);
        for (let bx = -r*0.3; bx < r*0.6; bx += r*0.22) {
          ctx.fillRect(bx, -r*0.82, r*0.18, r*0.12);
          ctx.fillRect(bx, r*0.7, r*0.18, r*0.12);
        }
      } else {
        // Bradley IFV — boxy and compact
        ctx.fillStyle = hullColor;
        ctx.fillRect(-r * 0.8, -r * 0.7, r * 1.6, r * 1.4);
        ctx.strokeStyle = darkColor;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-r * 0.8, -r * 0.7, r * 1.6, r * 1.4);
        // Front vision block
        ctx.fillStyle = "rgba(120, 180, 120, 0.3)";
        ctx.fillRect(r * 0.4, -r * 0.15, r * 0.25, r * 0.3);
        ctx.strokeStyle = darkColor;
        ctx.strokeRect(r * 0.4, -r * 0.15, r * 0.25, r * 0.3);
      }

      ctx.restore(); // End body rotation

      // Turret + barrel
      ctx.save();
      ctx.rotate(t.turretAngle);
      
      if (style === "abrams") {
        // Long smoothbore barrel
        ctx.fillStyle = "#2a2a24";
        ctx.fillRect(r * 0.1, -2.5, r * 1.7, 5);
        ctx.fillStyle = "#1a1a18";
        ctx.fillRect(r * 1.7, -3.5, r * 0.15, 7); // muzzle brake
        // Flat angular turret
        ctx.fillStyle = shade(hullColor, 8);
        ctx.beginPath();
        ctx.moveTo(-r * 0.45, -r * 0.48);
        ctx.lineTo(r * 0.15, -r * 0.48);
        ctx.lineTo(r * 0.35, -r * 0.25);
        ctx.lineTo(r * 0.35, r * 0.25);
        ctx.lineTo(r * 0.15, r * 0.48);
        ctx.lineTo(-r * 0.45, r * 0.48);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = darkColor;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (style === "leopard") {
        // Barrel
        ctx.fillStyle = "#2a2a24";
        ctx.fillRect(r * 0.1, -2, r * 1.8, 4);
        // Wedge turret
        ctx.fillStyle = shade(hullColor, 8);
        ctx.beginPath();
        ctx.moveTo(-r * 0.5, -r * 0.4);
        ctx.lineTo(r * 0.3, -r * 0.38);
        ctx.lineTo(r * 0.45, 0);
        ctx.lineTo(r * 0.3, r * 0.38);
        ctx.lineTo(-r * 0.5, r * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = darkColor;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (style === "t90") {
        // Barrel
        ctx.fillStyle = "#2a2a24";
        ctx.fillRect(r * 0.05, -2.5, r * 1.6, 5);
        // Round cast turret
        ctx.fillStyle = shade(hullColor, 8);
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.52, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = darkColor;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        // Bradley autocannon (small caliber)
        ctx.fillStyle = "#2a2a24";
        ctx.fillRect(r * 0.1, -1.5, r * 1.5, 3);
        // Small turret box
        ctx.fillStyle = shade(hullColor, 8);
        ctx.fillRect(-r * 0.35, -r * 0.35, r * 0.7, r * 0.7);
        ctx.strokeStyle = darkColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(-r * 0.35, -r * 0.35, r * 0.7, r * 0.7);
      }
      
      ctx.restore();
      
      // Laser windup
      if (t.charging && t.alive) {
        ctx.save();
        ctx.rotate(t.turretAngle);
        ctx.globalAlpha = 0.4 + 0.3 * Math.sin(nowMs / 60);
        ctx.strokeStyle = "#ff4444";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(r + 4, 0);
        ctx.lineTo(r + 54, 0);
        ctx.stroke();
        ctx.restore();
      }

      // Shield — subtle green force field
      if (t.shielded && t.alive) {
        ctx.save();
        const pulse = 0.9 + 0.1 * Math.sin(nowMs / 120);
        ctx.strokeStyle = "rgba(100, 180, 80, 0.4)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.45 * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      
      ctx.restore();

      // Health bar
      if (t.alive && t.maxHp > 1) {
        const bw = r * 2;
        const bx = t.x - r;
        const by = t.y - r - 6;
        const frac = Math.max(0, Math.min(1, t.hp / t.maxHp));
        ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
        ctx.fillRect(bx, by, bw, 3);
        ctx.fillStyle = frac > 0.5 ? "#5a8a3a" : frac > 0.25 ? "#b8a030" : "#aa3030";
        ctx.fillRect(bx, by, bw * frac, 3);
      }

      // Name / respawn label
      ctx.font = "bold 11px 'Inter', sans-serif";
      ctx.textAlign = "center";
      if (t.alive) {
        ctx.fillStyle = isLocal ? "#c8d8a0" : "#a0a898";
        const above = t.y - r - (t.maxHp > 1 ? 13 : 8);
        const labelY = above < 10 ? t.y + r + 14 : above;
        ctx.fillText(t.name, t.x, labelY);
      } else {
        ctx.fillStyle = "#706858";
        ctx.fillText(`${Math.ceil(t.respawnIn)}`, t.x, t.y + 4);
      }
      return;
    }

    if (state.modernEnabled) {
      // High-tech glow under the local player
      if (isLocal && t.alive) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, r + 10, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0, 248, 248, 0.05)";
        ctx.fill();
        ctx.strokeStyle = "rgba(0, 248, 248, 0.25)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.rotate(t.bodyAngle);
      
      // Determine neon colors
      // Self/teammates = cyan (#00f8f8), enemies = hot pink/rose (#f43f5e)
      let neonColor = "#f43f5e";
      if (isLocal) {
        neonColor = "#00f8f8";
      } else if (t.team !== -1) {
        const localTeam = this.displayedSnap?.tanks.find(tk => tk.id === state.playerId)?.team;
        if (t.team === localTeam) {
          neonColor = "#00f8f8";
        }
      }

      // Resolve modern tank styles
      let style = state.modernStyle;
      if (!isLocal) {
        const hash = t.id.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const styles = ["railgun", "hover", "plasma", "siege"] as const;
        style = styles[hash % styles.length];
      }

      // Draw Chassis based on futuristic style
      if (style === "hover") {
        // Hover pods (no tracks)
        ctx.fillStyle = "#1e293b";
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        
        ctx.fillStyle = neonColor;
        ctx.beginPath();
        ctx.arc(-r * 0.5, -r * 0.5, r * 0.22, 0, Math.PI * 2);
        ctx.arc(-r * 0.5, r * 0.5, r * 0.22, 0, Math.PI * 2);
        ctx.arc(r * 0.5, 0, r * 0.22, 0, Math.PI * 2);
        ctx.fill();
      } else if (style === "plasma") {
        // Hexagonal energy chassis
        ctx.fillStyle = "#0f172a";
        ctx.beginPath();
        ctx.moveTo(-r, -r * 0.55);
        ctx.lineTo(-r * 0.5, -r);
        ctx.lineTo(r * 0.5, -r);
        ctx.lineTo(r, -r * 0.55);
        ctx.lineTo(r, r * 0.55);
        ctx.lineTo(r * 0.5, r);
        ctx.lineTo(-r * 0.5, r);
        ctx.lineTo(-r, r * 0.55);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = neonColor;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (style === "siege") {
        // Heavy armor plates
        ctx.fillStyle = "#020617";
        ctx.fillRect(-r * 1.1, -r * 0.9, r * 2.2, r * 1.8);
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
        ctx.strokeRect(-r * 1.1, -r * 0.9, r * 2.2, r * 1.8);
        
        // Front & back treads
        ctx.fillStyle = "#1e293b";
        ctx.fillRect(-r * 1.25, -r * 1.05, r * 0.7, r * 0.35);
        ctx.fillRect(-r * 1.25, r * 0.7, r * 0.7, r * 0.35);
        ctx.fillRect(r * 0.55, -r * 1.05, r * 0.7, r * 0.35);
        ctx.fillRect(r * 0.55, r * 0.7, r * 0.7, r * 0.35);
      } else {
        // Railgun: sleek carbon wing plates
        ctx.fillStyle = "#0f172a";
        ctx.beginPath();
        ctx.moveTo(-r * 1.1, -r * 0.8);
        ctx.lineTo(-r * 0.4, -r * 0.8);
        ctx.lineTo(r * 0.8, -r * 0.4);
        ctx.lineTo(r * 0.8, r * 0.4);
        ctx.lineTo(-r * 0.4, r * 0.8);
        ctx.lineTo(-r * 1.1, r * 0.8);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = "#000000";
        ctx.fillRect(-r * 0.95, -r * 0.95, r * 1.9, r * 0.22);
        ctx.fillRect(-r * 0.95, r * 0.73, r * 1.9, r * 0.22);
      }

      // Glowing power core
      const corePulse = 0.8 + 0.2 * Math.abs(Math.sin(nowMs / 180));
      const grad = ctx.createRadialGradient(0, 0, 1, 0, 0, r * 0.45);
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.3, neonColor);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.45 * corePulse, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.restore(); // End body rotation

      // Turret + barrel
      ctx.save();
      ctx.rotate(t.turretAngle);
      
      if (style === "hover") {
        // Dual energy rail capacitor barrel
        ctx.fillStyle = "#334155";
        ctx.fillRect(0, -4.5, r * 1.6, 3);
        ctx.fillRect(0, 1.5, r * 1.6, 3);
        ctx.fillStyle = neonColor;
        ctx.fillRect(r * 0.4, -1, r * 1.2, 2);
        
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = "#1e293b";
        ctx.fill();
        ctx.strokeStyle = neonColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (style === "plasma") {
        // Plasma condenser rings barrel
        ctx.fillStyle = "#334155";
        ctx.fillRect(0, -3.5, r * 1.5, 7);
        ctx.fillStyle = neonColor;
        ctx.fillRect(r * 0.4, -4.5, r * 0.15, 9);
        ctx.fillRect(r * 0.8, -4.5, r * 0.15, 9);
        ctx.fillRect(r * 1.2, -4.5, r * 0.15, 9);
        
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = "#0f172a";
        ctx.fill();
        ctx.strokeStyle = neonColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (style === "siege") {
        // Heavy artillery tube cannon
        ctx.fillStyle = "#1e293b";
        ctx.fillRect(0, -5, r * 1.9, 10);
        ctx.fillStyle = "#000000";
        ctx.fillRect(r * 1.9 - 2, -6, 4, 12);
        
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = "#020617";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        // Railgun barrel
        ctx.fillStyle = "#334155";
        ctx.fillRect(0, -3, r * 1.7, 6);
        ctx.fillStyle = neonColor;
        ctx.fillRect(r * 0.2, -1, r * 1.4, 2);
        
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = "#0f172a";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      
      ctx.restore();
      
      // Laser windup
      if (t.charging && t.alive) {
        ctx.save();
        ctx.rotate(t.turretAngle);
        ctx.globalAlpha = 0.6 + 0.35 * Math.abs(Math.sin(nowMs / 40));
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(r + 4, 0);
        ctx.lineTo(r + 54, 0);
        ctx.stroke();
        ctx.restore();
      }

      // Shield bubble
      if (t.shielded && t.alive) {
        ctx.save();
        const pulse = 0.9 + 0.1 * Math.sin(nowMs / 100);
        ctx.strokeStyle = neonColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.5 * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = hexToRgba(neonColor, 0.05);
        ctx.fill();
        ctx.restore();
      }
      
      ctx.restore();

      // Health bar
      if (t.alive && t.maxHp > 1) {
        const bw = r * 2;
        const bx = t.x - r;
        const by = t.y - r - 6;
        const frac = Math.max(0, Math.min(1, t.hp / t.maxHp));
        ctx.fillStyle = "rgba(15, 23, 42, 0.6)";
        ctx.fillRect(bx, by, bw, 3);
        ctx.fillStyle = frac > 0.5 ? "#10b981" : frac > 0.25 ? "#f59e0b" : "#ef4444";
        ctx.fillRect(bx, by, bw * frac, 3);
      }

      // Name / respawn label
      ctx.font = "bold 11px 'Outfit', sans-serif";
      ctx.textAlign = "center";
      if (t.alive) {
        ctx.fillStyle = isLocal ? "#00f8f8" : "#f1f5f9";
        const above = t.y - r - (t.maxHp > 1 ? 13 : 8);
        const labelY = above < 10 ? t.y + r + 14 : above;
        ctx.fillText(t.name, t.x, labelY);
      } else {
        ctx.fillStyle = "#64748b";
        ctx.fillText(`${Math.ceil(t.respawnIn)}`, t.x, t.y + 4);
      }
      return;
    }

    if (state.battleCityEnabled) {
      // Local-player highlight: thin cyan circular dash glow
      if (isLocal && t.alive) {
        ctx.beginPath();
        ctx.arc(0, 0, r + 9, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0, 248, 248, 0.08)";
        ctx.fill();
        ctx.setLineDash([3, 2]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(0, 248, 248, 0.4)";
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.save();
      ctx.rotate(t.bodyAngle);
      
      // Determine Battle City tank team colors
      let baseColor = "#b8b8b8"; // Enemy: light grey
      if (isLocal) {
        baseColor = "#f8b800"; // Local player: yellow
      } else if (t.team !== -1) {
        const localTeam = this.displayedSnap?.tanks.find(tk => tk.id === state.playerId)?.team;
        if (t.team === localTeam) {
          baseColor = "#00a800"; // Teammate: green
        }
      }

      // Resolve the style for this tank:
      // Local player uses their selected custom style. Others are assigned one based on their ID hash.
      let style = state.retroStyle;
      if (!isLocal) {
        const hash = t.id.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
        const styles = ["basic", "fast", "heavy", "armored"] as const;
        style = styles[hash % styles.length];
      }

      let treadW = r * 0.35;
      let treadH = r * 2.2;
      let treadOffsetX = r * 0.9;
      
      if (style === "fast") {
        treadW = r * 0.28;
        treadH = r * 2.4;
        treadOffsetX = r * 0.85;
      } else if (style === "heavy") {
        treadW = r * 0.45;
        treadH = r * 2.0;
        treadOffsetX = r * 1.0;
      }
      
      // Draw treads (black)
      ctx.fillStyle = "#000000";
      ctx.fillRect(-treadH/2, -treadOffsetX - treadW/2, treadH, treadW);
      ctx.fillRect(-treadH/2, treadOffsetX - treadW/2, treadH, treadW);
      
      // Tread animation teeth (white dashes)
      ctx.fillStyle = "#ffffff";
      const treadPulse = Math.floor(nowMs / 80) % 2;
      for (let xOffset = -treadH/2 + 2; xOffset < treadH/2; xOffset += 6) {
        const shiftedX = xOffset + (treadPulse * 3);
        if (shiftedX > -treadH/2 && shiftedX < treadH/2 - 2) {
          ctx.fillRect(shiftedX, -treadOffsetX - treadW/2 + 1, 2, treadW - 2);
          ctx.fillRect(shiftedX, treadOffsetX - treadW/2 + 1, 2, treadW - 2);
        }
      }
      
      // Main body chassis and outlines based on style
      if (style === "fast") {
        // Sleeker, narrower chassis
        ctx.fillStyle = baseColor;
        ctx.fillRect(-r * 1.0, -r * 0.7, r * 2.0, r * 1.4);
        ctx.fillStyle = "#000000";
        ctx.strokeRect(-r * 1.0, -r * 0.7, r * 2.0, r * 1.4);
        // Hatch (pointing arrow)
        ctx.fillStyle = shade(baseColor, -25);
        ctx.beginPath();
        ctx.moveTo(r * 0.2, 0);
        ctx.lineTo(-r * 0.3, -r * 0.3);
        ctx.lineTo(-r * 0.3, r * 0.3);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#000000";
        ctx.stroke();
      } else if (style === "heavy") {
        // Wide, blocky chassis
        ctx.fillStyle = baseColor;
        ctx.fillRect(-r * 0.85, -r * 1.0, r * 1.7, r * 2.0);
        ctx.fillStyle = "#000000";
        ctx.strokeRect(-r * 0.85, -r * 1.0, r * 1.7, r * 2.0);
        // Double round hatches
        ctx.fillStyle = shade(baseColor, -25);
        ctx.beginPath();
        ctx.arc(-r * 0.2, -r * 0.3, r * 0.3, 0, Math.PI * 2);
        ctx.arc(-r * 0.2, r * 0.3, r * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#000000";
        ctx.beginPath();
        ctx.arc(-r * 0.2, -r * 0.3, r * 0.3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(-r * 0.2, r * 0.3, r * 0.3, 0, Math.PI * 2);
        ctx.stroke();
      } else if (style === "armored") {
        // Standard body but with extra armor plating
        ctx.fillStyle = baseColor;
        ctx.fillRect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7);
        ctx.fillStyle = "#000000";
        ctx.strokeRect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7);
        // Side armor panels
        ctx.fillStyle = shade(baseColor, -15);
        ctx.fillRect(-r * 0.85, -r * 0.85, r * 1.7, r * 0.2);
        ctx.fillRect(-r * 0.85, r * 0.65, r * 1.7, r * 0.2);
        ctx.fillStyle = "#000000";
        ctx.strokeRect(-r * 0.85, -r * 0.85, r * 1.7, r * 0.2);
        ctx.strokeRect(-r * 0.85, r * 0.65, r * 1.7, r * 0.2);
        // Octagonal hatch
        ctx.fillStyle = shade(baseColor, -25);
        const sz = r * 0.35;
        ctx.beginPath();
        ctx.moveTo(-sz * 0.5, -sz);
        ctx.lineTo(sz * 0.5, -sz);
        ctx.lineTo(sz, -sz * 0.5);
        ctx.lineTo(sz, sz * 0.5);
        ctx.lineTo(sz * 0.5, sz);
        ctx.lineTo(-sz * 0.5, sz);
        ctx.lineTo(-sz, sz * 0.5);
        ctx.lineTo(-sz, -sz * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#000000";
        ctx.stroke();
      } else {
        // Basic: standard square body + center hatch
        ctx.fillStyle = baseColor;
        ctx.fillRect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7);
        ctx.fillStyle = "#000000";
        ctx.fillRect(-r * 0.85, -r * 0.85, r * 1.7, 2);
        ctx.fillRect(-r * 0.85, r * 0.85 - 2, r * 1.7, 2);
        ctx.fillRect(-r * 0.85, -r * 0.85, 2, r * 1.7);
        ctx.fillRect(r * 0.85 - 2, -r * 0.85, 2, r * 1.7);
        ctx.fillStyle = shade(baseColor, -25);
        ctx.fillRect(-r * 0.4, -r * 0.4, r * 0.8, r * 0.8);
        ctx.fillStyle = "#000000";
        ctx.strokeRect(-r * 0.4, -r * 0.4, r * 0.8, r * 0.8);
      }
      
      ctx.restore(); // End body rotation

      // Turret + barrel
      ctx.save();
      ctx.rotate(t.turretAngle);
      
      if (style === "heavy") {
        // Dual parallel barrels
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, -5.5, r * 1.4 + 1, 4);
        ctx.fillRect(0, 1.5, r * 1.4 + 1, 4);
        ctx.fillStyle = baseColor;
        ctx.fillRect(0, -4.5, r * 1.4, 2);
        ctx.fillRect(0, 2.5, r * 1.4, 2);
        
        // Rectangular turret box
        ctx.fillStyle = "#000000";
        ctx.fillRect(-r * 0.5 - 1, -r * 0.55 - 1, r * 1.0 + 2, r * 1.1 + 2);
        ctx.fillStyle = shade(baseColor, 20);
        ctx.fillRect(-r * 0.5, -r * 0.55, r * 1.0, r * 1.1);
      } else if (style === "fast") {
        // Long thin barrel
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, -2.5, r * 1.8 + 1, 5);
        ctx.fillStyle = baseColor;
        ctx.fillRect(0, -1, r * 1.8, 2);
        ctx.fillStyle = "#000000";
        ctx.fillRect(r * 1.8 - 2, -2.5, 2, 5);
        
        // Oval turret dome
        ctx.fillStyle = "#000000";
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.5 + 1, r * 0.4 + 1, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = shade(baseColor, 20);
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.5, r * 0.4, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (style === "armored") {
        // Fat barrel + reinforced muzzle break
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, -4.5, r * 1.4 + 1, 9);
        ctx.fillRect(r * 1.4 - 3, -6, 5, 12);
        ctx.fillStyle = baseColor;
        ctx.fillRect(0, -3, r * 1.4, 6);
        ctx.fillRect(r * 1.4 - 2, -4.5, 3, 9);
        
        // Octagonal turret dome
        ctx.fillStyle = "#000000";
        const tsz = r * 0.55;
        ctx.beginPath();
        ctx.moveTo(-tsz * 0.5 - 1, -tsz - 1);
        ctx.lineTo(tsz * 0.5 + 1, -tsz - 1);
        ctx.lineTo(tsz + 1, -tsz * 0.5 - 1);
        ctx.lineTo(tsz + 1, tsz * 0.5 + 1);
        ctx.lineTo(tsz * 0.5 + 1, tsz + 1);
        ctx.lineTo(-tsz * 0.5 - 1, tsz + 1);
        ctx.lineTo(-tsz - 1, tsz * 0.5 + 1);
        ctx.lineTo(-tsz - 1, -tsz * 0.5 - 1);
        ctx.closePath();
        ctx.fill();
        
        ctx.fillStyle = shade(baseColor, 20);
        ctx.beginPath();
        ctx.moveTo(-tsz * 0.5, -tsz);
        ctx.lineTo(tsz * 0.5, -tsz);
        ctx.lineTo(tsz, -tsz * 0.5);
        ctx.lineTo(tsz, tsz * 0.5);
        ctx.lineTo(tsz * 0.5, tsz);
        ctx.lineTo(-tsz * 0.5, tsz);
        ctx.lineTo(-tsz, tsz * 0.5);
        ctx.closePath();
        ctx.fill();
      } else {
        // Basic: standard single barrel & round turret dome
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, -3.5, r * 1.5 + 1, 7);
        ctx.fillStyle = baseColor;
        ctx.fillRect(0, -2, r * 1.5, 4);
        ctx.fillStyle = "#000000";
        ctx.fillRect(r * 1.5 - 2, -3.5, 2, 7);
        
        ctx.fillStyle = "#000000";
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.55 + 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = shade(baseColor, 20);
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
      
      ctx.restore();
      
      // Laser windup
      if (t.charging && t.alive) {
        ctx.save();
        ctx.rotate(t.turretAngle);
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(nowMs / 50);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(r + 4, 0);
        ctx.lineTo(r + 54, 0);
        ctx.stroke();
        ctx.restore();
      }

      // Shield bubble: cyan circle
      if (t.shielded && t.alive) {
        ctx.save();
        const pulse = 0.85 + 0.15 * Math.sin(nowMs / 80);
        ctx.strokeStyle = "#00f8f8";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.45 * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      
      ctx.restore();

      // Health bar
      if (t.alive && t.maxHp > 1) {
        const bw = r * 2;
        const bx = t.x - r;
        const by = t.y - r - 6;
        const frac = Math.max(0, Math.min(1, t.hp / t.maxHp));
        ctx.fillStyle = "rgba(255, 255, 255, 0.2)"; // Light backdrop
        ctx.fillRect(bx, by, bw, 3);
        ctx.fillStyle = frac > 0.5 ? "#00a800" : frac > 0.25 ? "#f8b800" : "#a83800";
        ctx.fillRect(bx, by, bw * frac, 3);
      }

      // Name / respawn label
      ctx.font = "bold 13px 'VT323', monospace";
      ctx.textAlign = "center";
      if (t.alive) {
        ctx.fillStyle = isLocal ? "#f8b800" : "#ffffff"; // Local is yellow, others white
        const above = t.y - r - (t.maxHp > 1 ? 13 : 8);
        const labelY = above < 10 ? t.y + r + 14 : above;
        ctx.fillText(t.name, t.x, labelY);
      } else {
        ctx.fillStyle = "#808080"; // Grey death timer
        ctx.fillText(`${Math.ceil(t.respawnIn)}`, t.x, t.y + 4);
      }
      return;
    }

    // Default Tanka Maze vector tank drawing code:
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

/** "#rrggbb" + alpha → an rgba() string. */
function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${alpha})`;
}

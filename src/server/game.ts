import {
  BULLET_LIFETIME,
  BULLET_MAX_BOUNCES,
  BULLET_RADIUS,
  BULLET_SPEED,
  EXPLOSION_RADIUS,
  FIRE_COOLDOWN,
  LASER_RANGE,
  MAX_AMMO,
  MAX_POWERUPS_ON_MAP,
  POWERUP_RADIUS,
  RELOAD_SECONDS,
  SNIPER_SPEED_MULT,
  SNIPER_WALL_PIERCE,
  SPEED_BOOST_MULT,
  SPEED_BOOST_SECONDS,
  TANK_COLORS,
  TANK_RADIUS,
  TANK_REVERSE_SPEED,
  TANK_SPEED,
  TANK_TURN_SPEED,
  TEAM_COLORS,
  TRACKING_TURN_RATE,
} from "../shared/constants.js";
import {
  POWERUP_TYPES,
  type BulletKind,
  type GameConfig,
  type InputState,
  type PowerupType,
  type ScoreDTO,
  type SnapshotDTO,
} from "../shared/protocol.js";
import { Maze } from "./maze.js";

interface Tank {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  /** Actual velocity (px/s) from last tick's movement, inherited by bullets. */
  vx: number;
  vy: number;
  bodyAngle: number;
  turretAngle: number;
  alive: boolean;
  /** False while the player's socket is gone. A disconnected tank lingers if
   *  alive, but is not respawned (and is hidden) once killed. */
  connected: boolean;
  /** Eliminated (ran out of lives) — stays out of the battlefield permanently. */
  out: boolean;
  hp: number;
  maxHp: number;
  ammo: number;
  reloadTimer: number;
  deaths: number;
  score: number;
  respawnIn: number;
  fireCooldown: number;
  input: InputState;
  /** Active offensive power-up (never "speed"), or null. */
  weapon: PowerupType | null;
  weaponCharges: number;
  /** Seconds of speed boost remaining. */
  boostTimer: number;
  team: number;
}

interface Bullet {
  id: number;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounces: number;
  life: number;
  kind: BulletKind;
  /** Walls this round can still punch through (sniper). */
  wallPierce: number;
  /** Passes through tanks, damaging each once (sniper). */
  pierceTanks: boolean;
  /** Whether the round was inside a wall last step (wall-cross detection). */
  wasInWall: boolean;
  /** Tanks already damaged by a piercing round. */
  hitIds: Set<string>;
}

interface Powerup {
  id: number;
  type: PowerupType;
  x: number;
  y: number;
  ttl: number; // seconds until it despawns
}

/**
 * Server-authoritative tank battle. Behaviour is driven by the lobby's
 * GameConfig (mode, tank speed, HP, lives, scoring, etc.). Players submit input
 * intents; the game advances on a fixed timestep and emits snapshots.
 */
export class Game {
  readonly maze: Maze;
  private cfg: GameConfig;
  private tanks = new Map<string, Tank>();
  private bullets: Bullet[] = [];
  private nextBulletId = 1;
  private spawns: Array<{ x: number; y: number }>;
  private finished = false;
  private winnerName = "";
  private colorIndex = 0;
  private spawnIndex = 0;
  private everMultiple = false;
  private forwardSpeed: number;
  private reverseSpeed: number;
  private powerups: Powerup[] = [];
  private nextPowerupId = 1;
  private powerupTimer: number;
  // Transient effects emitted during the last step (sent once, then cleared).
  private pendingBlasts: Array<{ x: number; y: number }> = [];
  private pendingBeams: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

  constructor(
    maze: Maze,
    players: Array<{ id: string; name: string; color?: string; team?: number }>,
    config: GameConfig
  ) {
    this.maze = maze;
    this.cfg = config;
    this.forwardSpeed = (TANK_SPEED * config.tankSpeedPct) / 100;
    this.reverseSpeed = (TANK_REVERSE_SPEED * config.tankSpeedPct) / 100;
    this.powerupTimer = config.powerupEverySeconds;
    this.spawns = shuffle(maze.openCellCenters());

    // Initial players take sequential spawn points around the arena.
    for (const p of players) this.addPlayer(p, false);
  }

  addPlayer(
    p: { id: string; name: string; color?: string; team?: number },
    farSpawn = true
  ): void {
    if (this.tanks.has(p.id)) return;
    const team = p.team ?? 0;
    // In Team VS, teammates share a team color so sides read at a glance.
    const color =
      this.cfg.mode === "teams"
        ? TEAM_COLORS[team % TEAM_COLORS.length]
        : p.color ?? TANK_COLORS[this.colorIndex++ % TANK_COLORS.length];
    const spawn = farSpawn
      ? this.pickSpawn(p.id)
      : this.spawns[this.spawnIndex++ % this.spawns.length];
    this.tanks.set(p.id, {
      id: p.id,
      name: p.name,
      color,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      bodyAngle: 0,
      turretAngle: 0,
      alive: true,
      connected: true,
      out: false,
      hp: this.cfg.hp,
      maxHp: this.cfg.hp,
      ammo: MAX_AMMO,
      reloadTimer: 0,
      deaths: 0,
      score: 0,
      respawnIn: 0,
      fireCooldown: 0,
      input: {
        forward: false,
        backward: false,
        turnLeft: false,
        turnRight: false,
        fire: false,
        aim: 0,
      },
      weapon: null,
      weaponCharges: 0,
      boostTimer: 0,
      team,
    });
    if (this.tanks.size > 1) this.everMultiple = true;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  setInput(playerId: string, input: InputState): void {
    const tank = this.tanks.get(playerId);
    if (tank) tank.input = input;
  }

  /** Reconnect: a tank that died (but isn't eliminated) is brought back. */
  setConnected(playerId: string, connected: boolean): void {
    const tank = this.tanks.get(playerId);
    if (!tank) return;
    tank.connected = connected;
    if (connected && !tank.alive && !tank.out) this.respawn(tank);
  }

  removePlayer(playerId: string): void {
    this.tanks.delete(playerId);
    this.bullets = this.bullets.filter((b) => b.ownerId !== playerId);
    this.checkLmsWin();
  }

  /** Advance the simulation by `dt` seconds. */
  step(dt: number): void {
    if (this.finished) return;

    // Transient effects only live for the snapshot taken right after this step.
    this.pendingBlasts = [];
    this.pendingBeams = [];

    this.stepPowerups(dt);

    for (const tank of this.tanks.values()) {
      tank.fireCooldown = Math.max(0, tank.fireCooldown - dt);
      if (tank.boostTimer > 0) tank.boostTimer = Math.max(0, tank.boostTimer - dt);
      if (tank.reloadTimer > 0) {
        tank.reloadTimer -= dt;
        if (tank.reloadTimer <= 0) {
          tank.reloadTimer = 0;
          tank.ammo = MAX_AMMO; // instant full reload
        }
      }

      if (!tank.alive) {
        // Disconnected or eliminated tanks stay gone; others respawn on a timer.
        if (!tank.connected || tank.out) continue;
        tank.respawnIn = Math.max(0, tank.respawnIn - dt);
        if (tank.respawnIn === 0) this.respawn(tank);
        continue;
      }

      tank.turretAngle = tank.input.aim;

      // Steer: A/D rotate the tank's heading (bodyAngle).
      let turn = 0;
      if (tank.input.turnLeft) turn -= 1;
      if (tank.input.turnRight) turn += 1;
      if (turn !== 0) tank.bodyAngle += turn * TANK_TURN_SPEED * dt;

      // Drive: W/S move forward/backward along the heading.
      const oldX = tank.x;
      const oldY = tank.y;
      let drive = 0;
      if (tank.input.forward) drive += 1;
      if (tank.input.backward) drive -= 1;
      if (drive !== 0) {
        const base = drive > 0 ? this.forwardSpeed : this.reverseSpeed;
        const speed = tank.boostTimer > 0 ? base * SPEED_BOOST_MULT : base;
        const step = drive * speed * dt;
        const dx = Math.cos(tank.bodyAngle) * step;
        const dy = Math.sin(tank.bodyAngle) * step;
        const nx = tank.x + dx;
        if (!this.circleHitsWall(nx, tank.y, TANK_RADIUS)) tank.x = nx;
        const ny = tank.y + dy;
        if (!this.circleHitsWall(tank.x, ny, TANK_RADIUS)) tank.y = ny;
      }
      tank.vx = dt > 0 ? (tank.x - oldX) / dt : 0;
      tank.vy = dt > 0 ? (tank.y - oldY) / dt : 0;

      if (tank.input.fire && tank.fireCooldown === 0) this.fire(tank);
    }

    this.stepBullets(dt);
  }

  private fire(tank: Tank): void {
    const weapon = tank.weapon && tank.weapon !== "speed" ? tank.weapon : null;
    const usingWeapon = weapon !== null;

    // Power-up shots don't draw from the magazine — only normal shots do.
    if (!usingWeapon) {
      if (tank.reloadTimer > 0) return; // mid-reload
      if (tank.ammo <= 0) {
        tank.reloadTimer = RELOAD_SECONDS;
        return;
      }
    }
    tank.fireCooldown = FIRE_COOLDOWN;
    const a = tank.turretAngle;

    if (weapon === "laser") {
      this.fireLaser(tank, a);
    } else {
      const kind: BulletKind = weapon ?? "normal";
      const speed = kind === "sniper" ? BULLET_SPEED * SNIPER_SPEED_MULT : BULLET_SPEED;
      const muzzle = TANK_RADIUS + BULLET_RADIUS + 2;
      // Sniper flies straight & fast (no momentum drift); others inherit it.
      const inheritVx = kind === "sniper" ? 0 : tank.vx;
      const inheritVy = kind === "sniper" ? 0 : tank.vy;
      this.bullets.push({
        id: this.nextBulletId++,
        ownerId: tank.id,
        x: tank.x + Math.cos(a) * muzzle,
        y: tank.y + Math.sin(a) * muzzle,
        vx: Math.cos(a) * speed + inheritVx,
        vy: Math.sin(a) * speed + inheritVy,
        bounces: 0,
        life: BULLET_LIFETIME,
        kind,
        wallPierce: kind === "sniper" ? SNIPER_WALL_PIERCE : 0,
        pierceTanks: kind === "sniper",
        wasInWall: false,
        hitIds: new Set(),
      });
    }

    if (usingWeapon) {
      tank.weaponCharges -= 1;
      if (tank.weaponCharges <= 0) tank.weapon = null;
    } else {
      tank.ammo -= 1;
      if (tank.ammo <= 0) tank.reloadTimer = RELOAD_SECONDS; // forced reload
    }
  }

  /** Hitscan laser: instant straight beam, ignores walls, hits all in range. */
  private fireLaser(tank: Tank, angle: number): void {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const x1 = tank.x + dx * (TANK_RADIUS + 2);
    const y1 = tank.y + dy * (TANK_RADIUS + 2);
    const x2 = tank.x + dx * LASER_RANGE;
    const y2 = tank.y + dy * LASER_RANGE;
    this.pendingBeams.push({ x1, y1, x2, y2 });

    for (const t of this.tanks.values()) {
      if (!t.alive || t.id === tank.id) continue;
      if (this.isFriendly(tank.id, t)) continue;
      // Distance from the tank center to the beam segment.
      const proj = ((t.x - x1) * dx + (t.y - y1) * dy);
      if (proj < 0 || proj > LASER_RANGE) continue;
      const cx = x1 + dx * proj;
      const cy = y1 + dy * proj;
      const d2 = (t.x - cx) ** 2 + (t.y - cy) ** 2;
      if (d2 <= TANK_RADIUS * TANK_RADIUS) {
        t.hp -= 1;
        if (t.hp <= 0) this.kill(t, tank.id);
      }
    }
  }

  /** True if owner and tank are on the same team (Team VS friendly fire off). */
  private isFriendly(ownerId: string, tank: Tank): boolean {
    if (this.cfg.mode !== "teams") return false;
    const o = this.tanks.get(ownerId);
    return !!o && o.id !== tank.id && o.team === tank.team;
  }

  private stepBullets(dt: number): void {
    const survivors: Bullet[] = [];
    for (const b of this.bullets) {
      b.life -= dt;
      if (b.life <= 0) continue;

      if (b.kind === "tracking") this.steerHoming(b, dt);

      const speed = Math.hypot(b.vx, b.vy);
      const steps = Math.max(1, Math.ceil((speed * dt) / (BULLET_RADIUS * 0.9)));
      const sdt = dt / steps;
      let dead = false;

      for (let s = 0; s < steps && !dead; s++) {
        if (b.pierceTanks) {
          // Sniper: fly straight, punch through walls (limited), pierce tanks.
          b.x += b.vx * sdt;
          b.y += b.vy * sdt;
          if (b.x < 0 || b.y < 0 || b.x > this.maze.width || b.y > this.maze.height) {
            dead = true;
          } else {
            const inWall = this.circleHitsWall(b.x, b.y, BULLET_RADIUS);
            if (inWall && !b.wasInWall) {
              // Entered a fresh wall: spend a penetration charge or die.
              if (b.wallPierce > 0) b.wallPierce -= 1;
              else dead = true;
            }
            b.wasInWall = inWall;
          }
        } else {
          const nx = b.x + b.vx * sdt;
          if (this.circleHitsWall(nx, b.y, BULLET_RADIUS)) {
            if (b.kind === "explosive") {
              this.explode(b.x, b.y, b.ownerId);
              dead = true;
            } else {
              b.vx = -b.vx;
              if (++b.bounces > BULLET_MAX_BOUNCES) dead = true;
            }
          } else {
            b.x = nx;
          }
          if (!dead) {
            const ny = b.y + b.vy * sdt;
            if (this.circleHitsWall(b.x, ny, BULLET_RADIUS)) {
              if (b.kind === "explosive") {
                this.explode(b.x, b.y, b.ownerId);
                dead = true;
              } else {
                b.vy = -b.vy;
                if (++b.bounces > BULLET_MAX_BOUNCES) dead = true;
              }
            } else {
              b.y = ny;
            }
          }
        }

        if (!dead && this.checkBulletHit(b)) dead = true;
      }

      if (!dead) survivors.push(b);
    }
    this.bullets = survivors;
  }

  /** Steer a homing round toward the nearest tank (prefers an enemy). */
  private steerHoming(b: Bullet, dt: number): void {
    const target = this.nearestTarget(b.x, b.y, b.ownerId);
    if (!target) return;
    const speed = Math.hypot(b.vx, b.vy) || BULLET_SPEED;
    const cur = Math.atan2(b.vy, b.vx);
    const want = Math.atan2(target.y - b.y, target.x - b.x);
    let diff = ((want - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (diff < -Math.PI) diff += Math.PI * 2;
    const max = TRACKING_TURN_RATE * dt;
    const turn = Math.max(-max, Math.min(max, diff));
    const a = cur + turn;
    b.vx = Math.cos(a) * speed;
    b.vy = Math.sin(a) * speed;
  }

  /** Nearest valid enemy; if none, the nearest tank at all (even the owner). */
  private nearestTarget(x: number, y: number, ownerId: string): Tank | null {
    let bestEnemy: Tank | null = null;
    let bestEnemyD = Infinity;
    let bestAny: Tank | null = null;
    let bestAnyD = Infinity;
    const owner = this.tanks.get(ownerId);
    for (const t of this.tanks.values()) {
      if (!t.alive) continue;
      const d = (t.x - x) ** 2 + (t.y - y) ** 2;
      if (d < bestAnyD) {
        bestAnyD = d;
        bestAny = t;
      }
      const enemy = t.id !== ownerId && !(owner && this.cfg.mode === "teams" && owner.team === t.team);
      if (enemy && d < bestEnemyD) {
        bestEnemyD = d;
        bestEnemy = t;
      }
    }
    return bestEnemy ?? bestAny;
  }

  /** Area damage from an explosive round; emits a blast for clients to render. */
  private explode(x: number, y: number, ownerId: string): void {
    this.pendingBlasts.push({ x, y });
    const r2 = EXPLOSION_RADIUS * EXPLOSION_RADIUS;
    for (const tank of this.tanks.values()) {
      if (!tank.alive) continue;
      if (this.isFriendly(ownerId, tank)) continue;
      const dx = tank.x - x;
      const dy = tank.y - y;
      if (dx * dx + dy * dy <= r2) {
        tank.hp -= 1;
        if (tank.hp <= 0) this.kill(tank, ownerId);
      }
    }
  }

  /** Returns true if the bullet struck a tank (and should be consumed). */
  private checkBulletHit(b: Bullet): boolean {
    const rr = TANK_RADIUS + BULLET_RADIUS;
    for (const tank of this.tanks.values()) {
      if (!tank.alive) continue;
      if (tank.id === b.ownerId && b.bounces === 0) continue; // no point-blank self-hit
      if (this.isFriendly(b.ownerId, tank)) continue; // friendly fire off
      if (b.pierceTanks && b.hitIds.has(tank.id)) continue; // already pierced this one
      const dx = tank.x - b.x;
      const dy = tank.y - b.y;
      if (dx * dx + dy * dy > rr * rr) continue;

      if (b.kind === "explosive") {
        this.explode(b.x, b.y, b.ownerId);
        return true;
      }
      tank.hp -= 1;
      if (tank.hp <= 0) this.kill(tank, b.ownerId);
      if (b.pierceTanks) {
        b.hitIds.add(tank.id);
        continue; // a piercing round keeps going
      }
      return true; // normal round is consumed
    }
    return false;
  }

  // --- Power-ups ---------------------------------------------------------

  private stepPowerups(dt: number): void {
    if (!this.cfg.powerups) return;

    // Despawn timed-out pickups.
    for (const p of this.powerups) p.ttl -= dt;
    this.powerups = this.powerups.filter((p) => p.ttl > 0);

    // Spawn on cadence.
    this.powerupTimer -= dt;
    if (this.powerupTimer <= 0) {
      this.powerupTimer = this.cfg.powerupEverySeconds;
      if (this.powerups.length < MAX_POWERUPS_ON_MAP && this.spawns.length > 0) {
        const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
        const cell = this.spawns[Math.floor(Math.random() * this.spawns.length)];
        this.powerups.push({
          id: this.nextPowerupId++,
          type,
          x: cell.x,
          y: cell.y,
          ttl: this.cfg.powerupDespawnSeconds,
        });
      }
    }

    // Pickups.
    const reach = TANK_RADIUS + POWERUP_RADIUS;
    const reach2 = reach * reach;
    for (const tank of this.tanks.values()) {
      if (!tank.alive) continue;
      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const p = this.powerups[i];
        const dx = tank.x - p.x;
        const dy = tank.y - p.y;
        if (dx * dx + dy * dy <= reach2) {
          this.applyPowerup(tank, p.type);
          this.powerups.splice(i, 1);
        }
      }
    }
  }

  private applyPowerup(tank: Tank, type: PowerupType): void {
    if (type === "speed") {
      tank.boostTimer = SPEED_BOOST_SECONDS;
    } else {
      tank.weapon = type;
      tank.weaponCharges = this.cfg.powerupCharges;
    }
  }

  private kill(victim: Tank, killerId: string): void {
    victim.alive = false;
    victim.deaths += 1;

    // Death penalty: lose a configurable fraction of points (integer, ≥ 0).
    const loss = Math.floor((victim.score * this.cfg.deathPenaltyPct) / 100);
    victim.score = Math.max(0, victim.score - loss);

    // Eliminated if lives are limited and exhausted; otherwise respawns.
    if (this.cfg.lives > 0 && victim.deaths >= this.cfg.lives) {
      victim.out = true;
    } else {
      victim.respawnIn = this.cfg.respawnSeconds;
    }

    const killer = this.tanks.get(killerId);
    if (killer && killer.id !== victim.id) {
      killer.score += this.cfg.killPoints;
      if (killer.score < 1) killer.score = 1; // a kill always leaves you ≥ 1
      if (this.cfg.mode === "ffa" && killer.score >= this.cfg.winScore) {
        this.finished = true;
        this.winnerName = killer.name;
      }
    }
    this.checkLmsWin();
    this.checkTeamWin();
  }

  /** Last Man Standing: the game ends when one (or zero) players remain in. */
  private checkLmsWin(): void {
    if (this.finished || this.cfg.mode !== "lms" || !this.everMultiple) return;
    const standing = [...this.tanks.values()].filter((t) => !t.out);
    if (standing.length <= 1) {
      this.finished = true;
      this.winnerName = standing[0]?.name ?? "";
    }
  }

  /** Team VS: a team wins when the sum of its members' points hits winScore. */
  private checkTeamWin(): void {
    if (this.finished || this.cfg.mode !== "teams") return;
    const totals = new Map<number, number>();
    for (const t of this.tanks.values()) {
      totals.set(t.team, (totals.get(t.team) ?? 0) + t.score);
    }
    for (const [team, total] of totals) {
      if (total >= this.cfg.winScore) {
        this.finished = true;
        this.winnerName = `Team ${team + 1}`;
        return;
      }
    }
  }

  private respawn(tank: Tank): void {
    const spot = this.pickSpawn(tank.id);
    tank.x = spot.x;
    tank.y = spot.y;
    tank.vx = 0;
    tank.vy = 0;
    tank.alive = true;
    tank.hp = tank.maxHp;
    tank.ammo = MAX_AMMO;
    tank.reloadTimer = 0;
    tank.respawnIn = 0;
    tank.fireCooldown = 0;
    // Power-ups are lost on death.
    tank.weapon = null;
    tank.weaponCharges = 0;
    tank.boostTimer = 0;
  }

  /**
   * Pick a randomized spawn point. With no other living tanks around, any open
   * cell is fair game; otherwise we randomly choose from the farther half of
   * cells so respawns are varied but never right on top of an opponent.
   */
  private pickSpawn(excludeId?: string): { x: number; y: number } {
    const living = [...this.tanks.values()].filter((t) => t.alive && t.id !== excludeId);
    if (living.length === 0) {
      return this.spawns[Math.floor(Math.random() * this.spawns.length)];
    }
    const scored = this.spawns
      .map((s) => {
        let nearest = Infinity;
        for (const t of living) {
          const d = (t.x - s.x) ** 2 + (t.y - s.y) ** 2;
          if (d < nearest) nearest = d;
        }
        return { s, nearest };
      })
      .sort((a, b) => b.nearest - a.nearest);
    const pool = Math.max(1, Math.floor(scored.length / 2));
    return scored[Math.floor(Math.random() * pool)].s;
  }

  private circleHitsWall(x: number, y: number, r: number): boolean {
    return this.maze.hitsCircle(x, y, r);
  }

  snapshot(now: number): SnapshotDTO {
    return {
      t: now,
      // Hidden: dead tanks whose player is gone (disconnected) or eliminated.
      tanks: [...this.tanks.values()]
        .filter((t) => t.alive || (t.connected && !t.out))
        .map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color,
          x: round(t.x),
          y: round(t.y),
          bodyAngle: round(t.bodyAngle, 3),
          turretAngle: round(t.turretAngle, 3),
          alive: t.alive,
          score: t.score,
          respawnIn: round(t.respawnIn, 2),
          hp: t.hp,
          maxHp: t.maxHp,
          ammo: t.ammo,
          maxAmmo: MAX_AMMO,
          reloadIn: round(t.reloadTimer, 2),
          weapon: t.weapon,
          weaponCharges: t.weaponCharges,
          boosted: t.boostTimer > 0,
          team: t.team,
        })),
      bullets: this.bullets.map((b) => ({
        id: b.id,
        x: round(b.x),
        y: round(b.y),
        ownerId: b.ownerId,
        kind: b.kind,
      })),
      powerups: this.powerups.map((p) => ({
        id: p.id,
        type: p.type,
        x: round(p.x),
        y: round(p.y),
      })),
      blasts: this.pendingBlasts.map((b) => ({ x: round(b.x), y: round(b.y) })),
      beams: this.pendingBeams.map((b) => ({
        x1: round(b.x1),
        y1: round(b.y1),
        x2: round(b.x2),
        y2: round(b.y2),
      })),
    };
  }

  scores(): ScoreDTO[] {
    return [...this.tanks.values()]
      .map((t) => ({ id: t.id, name: t.name, color: t.color, score: t.score }))
      .sort((a, b) => b.score - a.score);
  }

  getWinnerName(): string {
    return this.winnerName;
  }
}

function round(v: number, decimals = 1): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

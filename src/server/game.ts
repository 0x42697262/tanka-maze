import {
  BULLET_LIFETIME,
  BULLET_MAX_BOUNCES,
  BULLET_RADIUS,
  BULLET_SPEED,
  FIRE_COOLDOWN,
  MAX_AMMO,
  RELOAD_SECONDS,
  TANK_COLORS,
  TANK_RADIUS,
  TANK_REVERSE_SPEED,
  TANK_SPEED,
  TANK_TURN_SPEED,
} from "../shared/constants.js";
import type { GameConfig, InputState, ScoreDTO, SnapshotDTO } from "../shared/protocol.js";
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

  constructor(
    maze: Maze,
    players: Array<{ id: string; name: string; color?: string }>,
    config: GameConfig
  ) {
    this.maze = maze;
    this.cfg = config;
    this.forwardSpeed = (TANK_SPEED * config.tankSpeedPct) / 100;
    this.reverseSpeed = (TANK_REVERSE_SPEED * config.tankSpeedPct) / 100;
    this.spawns = shuffle(maze.openCellCenters());

    // Initial players take sequential spawn points around the arena.
    for (const p of players) this.addPlayer(p, false);
  }

  addPlayer(p: { id: string; name: string; color?: string }, farSpawn = true): void {
    if (this.tanks.has(p.id)) return;
    const color = p.color ?? TANK_COLORS[this.colorIndex++ % TANK_COLORS.length];
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

    for (const tank of this.tanks.values()) {
      tank.fireCooldown = Math.max(0, tank.fireCooldown - dt);
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
        const speed = drive > 0 ? this.forwardSpeed : this.reverseSpeed;
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
    if (tank.reloadTimer > 0) return; // mid-reload
    if (tank.ammo <= 0) {
      tank.reloadTimer = RELOAD_SECONDS;
      return;
    }
    tank.fireCooldown = FIRE_COOLDOWN;
    const a = tank.turretAngle;
    const muzzle = TANK_RADIUS + BULLET_RADIUS + 2;
    // Inherit the tank's momentum (faster forward, slower reversing, drifts when
    // moving while aiming elsewhere).
    this.bullets.push({
      id: this.nextBulletId++,
      ownerId: tank.id,
      x: tank.x + Math.cos(a) * muzzle,
      y: tank.y + Math.sin(a) * muzzle,
      vx: Math.cos(a) * BULLET_SPEED + tank.vx,
      vy: Math.sin(a) * BULLET_SPEED + tank.vy,
      bounces: 0,
      life: BULLET_LIFETIME,
    });
    tank.ammo -= 1;
    if (tank.ammo <= 0) tank.reloadTimer = RELOAD_SECONDS; // forced reload
  }

  private stepBullets(dt: number): void {
    const survivors: Bullet[] = [];
    for (const b of this.bullets) {
      b.life -= dt;
      if (b.life <= 0) continue;

      const speed = Math.hypot(b.vx, b.vy);
      const steps = Math.max(1, Math.ceil((speed * dt) / (BULLET_RADIUS * 0.9)));
      const sdt = dt / steps;
      let dead = false;

      for (let s = 0; s < steps && !dead; s++) {
        const nx = b.x + b.vx * sdt;
        if (this.circleHitsWall(nx, b.y, BULLET_RADIUS)) {
          b.vx = -b.vx;
          if (++b.bounces > BULLET_MAX_BOUNCES) dead = true;
        } else {
          b.x = nx;
        }
        const ny = b.y + b.vy * sdt;
        if (this.circleHitsWall(b.x, ny, BULLET_RADIUS)) {
          b.vy = -b.vy;
          if (++b.bounces > BULLET_MAX_BOUNCES) dead = true;
        } else {
          b.y = ny;
        }

        if (this.checkBulletHit(b)) dead = true;
      }

      if (!dead) survivors.push(b);
    }
    this.bullets = survivors;
  }

  /** Returns true if the bullet struck a tank (and should be consumed). */
  private checkBulletHit(b: Bullet): boolean {
    for (const tank of this.tanks.values()) {
      if (!tank.alive) continue;
      // Can't hit your own tank until the shot has bounced at least once.
      if (tank.id === b.ownerId && b.bounces === 0) continue;
      const dx = tank.x - b.x;
      const dy = tank.y - b.y;
      const rr = TANK_RADIUS + BULLET_RADIUS;
      if (dx * dx + dy * dy <= rr * rr) {
        tank.hp -= 1;
        if (tank.hp <= 0) this.kill(tank, b.ownerId);
        return true; // bullet is consumed whether or not it was lethal
      }
    }
    return false;
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
        })),
      bullets: this.bullets.map((b) => ({
        id: b.id,
        x: round(b.x),
        y: round(b.y),
        ownerId: b.ownerId,
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

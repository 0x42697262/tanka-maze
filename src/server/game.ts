import {
  BULLET_LIFETIME,
  BULLET_MAX_BOUNCES,
  BULLET_RADIUS,
  BULLET_SPEED,
  FIRE_COOLDOWN,
  KILL_POINTS,
  MAX_BULLETS_PER_TANK,
  RESPAWN_TIME,
  TANK_COLORS,
  TANK_RADIUS,
  TANK_REVERSE_SPEED,
  TANK_SPEED,
  TANK_TURN_SPEED,
} from "../shared/constants.js";
import type { InputState, ScoreDTO, SnapshotDTO } from "../shared/protocol.js";
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
 * Server-authoritative tank battle inside a maze. Players submit input intents;
 * the game advances on a fixed timestep and produces snapshots to broadcast.
 */
export class Game {
  readonly maze: Maze;
  private tanks = new Map<string, Tank>();
  private bullets: Bullet[] = [];
  private nextBulletId = 1;
  private spawns: Array<{ x: number; y: number }>;
  private winScore: number;
  private finished = false;
  private winnerName = "";
  private colorIndex = 0;
  private spawnIndex = 0;

  constructor(
    maze: Maze,
    players: Array<{ id: string; name: string; color?: string }>,
    winScore: number
  ) {
    this.maze = maze;
    this.winScore = winScore;
    this.spawns = shuffle(maze.openCellCenters());

    // Initial players take sequential spawn points around the arena.
    for (const p of players) this.addPlayer(p, false);
  }

  /**
   * Add a tank to the game. Initial players spawn sequentially; late joiners
   * (`farSpawn`) drop in at the open cell farthest from everyone else.
   */
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
  }

  get isFinished(): boolean {
    return this.finished;
  }

  setInput(playerId: string, input: InputState): void {
    const tank = this.tanks.get(playerId);
    if (tank) tank.input = input;
  }

  /**
   * Mark a player's connection state. On reconnect, a tank that died while away
   * is respawned so the player re-enters the battle; an alive tank is left in
   * place to resume.
   */
  setConnected(playerId: string, connected: boolean): void {
    const tank = this.tanks.get(playerId);
    if (!tank) return;
    tank.connected = connected;
    if (connected && !tank.alive) this.respawn(tank);
  }

  removePlayer(playerId: string): void {
    this.tanks.delete(playerId);
    this.bullets = this.bullets.filter((b) => b.ownerId !== playerId);
  }

  /** Advance the simulation by `dt` seconds. */
  step(dt: number): void {
    if (this.finished) return;

    for (const tank of this.tanks.values()) {
      tank.fireCooldown = Math.max(0, tank.fireCooldown - dt);

      if (!tank.alive) {
        // A disconnected player's tank stays dead (gone from the battlefield)
        // rather than respawning — it only comes back if they reconnect.
        if (!tank.connected) continue;
        tank.respawnIn = Math.max(0, tank.respawnIn - dt);
        if (tank.respawnIn === 0) this.respawn(tank);
        continue;
      }

      tank.turretAngle = tank.input.aim;

      // Steer: A/D rotate the tank's heading (bodyAngle).
      let turn = 0;
      if (tank.input.turnLeft) turn -= 1;
      if (tank.input.turnRight) turn += 1;
      if (turn !== 0) {
        tank.bodyAngle += turn * TANK_TURN_SPEED * dt;
      }

      // Drive: W/S move forward/backward along the heading.
      const oldX = tank.x;
      const oldY = tank.y;
      let drive = 0;
      if (tank.input.forward) drive += 1;
      if (tank.input.backward) drive -= 1;
      if (drive !== 0) {
        const speed = drive > 0 ? TANK_SPEED : TANK_REVERSE_SPEED;
        const step = drive * speed * dt;
        const dx = Math.cos(tank.bodyAngle) * step;
        const dy = Math.sin(tank.bodyAngle) * step;
        // Resolve each axis independently so tanks slide along walls.
        const nx = tank.x + dx;
        if (!this.circleHitsWall(nx, tank.y, TANK_RADIUS)) tank.x = nx;
        const ny = tank.y + dy;
        if (!this.circleHitsWall(tank.x, ny, TANK_RADIUS)) tank.y = ny;
      }
      // Actual velocity (respects wall-sliding) — bullets inherit this.
      tank.vx = dt > 0 ? (tank.x - oldX) / dt : 0;
      tank.vy = dt > 0 ? (tank.y - oldY) / dt : 0;

      if (tank.input.fire && tank.fireCooldown === 0) {
        this.fire(tank);
      }
    }

    this.stepBullets(dt);
  }

  private fire(tank: Tank): void {
    const owned = this.bullets.filter((b) => b.ownerId === tank.id).length;
    if (owned >= MAX_BULLETS_PER_TANK) return;
    tank.fireCooldown = FIRE_COOLDOWN;
    const a = tank.turretAngle;
    const muzzle = TANK_RADIUS + BULLET_RADIUS + 2;
    // Inherit the tank's momentum: muzzle velocity along the aim, plus the
    // tank's own velocity. Driving forward speeds the shot up, reversing slows
    // it, and moving while aiming elsewhere makes the shot drift sideways.
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
  }

  private stepBullets(dt: number): void {
    const survivors: Bullet[] = [];
    for (const b of this.bullets) {
      b.life -= dt;
      if (b.life <= 0) continue;

      // Sub-step to avoid tunneling through thin walls at high speed.
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
      // A bullet can't hit its owner until it has bounced once (no self-snipe
      // at point blank, but ricochets are fair game).
      if (tank.id === b.ownerId && b.bounces === 0) continue;
      const dx = tank.x - b.x;
      const dy = tank.y - b.y;
      const rr = TANK_RADIUS + BULLET_RADIUS;
      if (dx * dx + dy * dy <= rr * rr) {
        this.kill(tank, b.ownerId);
        return true;
      }
    }
    return false;
  }

  private kill(victim: Tank, killerId: string): void {
    victim.alive = false;
    victim.respawnIn = RESPAWN_TIME;
    // Dying costs a third of your points (integer math, never below 0).
    victim.score = Math.max(0, victim.score - Math.floor(victim.score / 3));
    const killer = this.tanks.get(killerId);
    if (killer && killer.id !== victim.id) {
      killer.score += KILL_POINTS;
      if (killer.score < 1) killer.score = 1; // a kill always leaves you ≥ 1
      if (killer.score >= this.winScore) {
        this.finished = true;
        this.winnerName = killer.name;
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
      // A disconnected player's dead tank is omitted — it's gone from the
      // battlefield until they reconnect (alive tanks always show).
      tanks: [...this.tanks.values()]
        .filter((t) => t.alive || t.connected)
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

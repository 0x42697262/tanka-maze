import {
  MAX_POWERUPS_ON_MAP,
  POWERUP_RADIUS,
  FLAG_STEAL_COOLDOWN,
  HAZARD_DAMAGE,
  HAZARD_HEAL_RATE,
  HAZARD_SLOW_MULT,
  HAZARD_ZONE_FRACTION,
  KILL_STREAK_WINDOW,
  SPAWN_SHIELD_SECONDS,
  SPAWN_ZONE_CELLS,
  TANK_COLORS,
  TEAMKILL_STREAK_WINDOW,
  TANK_REVERSE_SPEED,
  TANK_SPEED,
  TRACKING_REPATH,
  WALL_DAMAGE,
  WALL_EXPLOSION_DAMAGE,
} from "../shared/constants.js";
import {
  POWERUP_TYPES,
  powerupDef,
  WEAPON_POWERUPS,
  type AdvancedConfig,
  type BulletKind,
  type GameConfig,
  type HazardType,
  type HazardZoneDTO,
  type InputState,
  type KillEvent,
  type PowerupType,
  type RosterEntry,
  type RoundStanding,
  type ScoreDTO,
  type SnapshotDTO,
  type SpawnZoneDTO,
  type FlagDTO,
  type FlagState,
} from "../shared/protocol.js";
import { Maze } from "./maze.js";

/** A terrain hazard zone that affects tanks standing inside it each tick. */
interface HazardZone {
  x: number;
  y: number;
  width: number;
  height: number;
  type: HazardType;
}

 /** A team's flag in Capture the Flag. Home position is its base (spawn-zone) center. */
interface Flag {
  team: number;
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  state: FlagState;
  carrierId: string | null;
  /** Team whose base this flag is placed at while "held" (conquest), else -1. */
  heldTeam: number;
  /** Seconds before this flag can change hands again (anti ping-pong). */
  stealCooldown: number;
}

/** A team's designated spawn area: a cell-aligned rectangle and its cell centers. */
interface SpawnZone {
  team: number;
  x: number;
  y: number;
  width: number;
  height: number;
  cells: Array<{ x: number; y: number }>;
}

/** CTF points scoring (conquest/carry): the bonus multiplier applied while your
 *  own flag is also secured — at home (conquest) or carried (carry). */
const OWN_FLAG_MULT = 3;

/** 4-neighbour offsets (up, right, down, left) for homing-round pathfinding. */
const HOMING_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Composable "apply" command per buff power-up. Weapons share one generic path
 * (set the active weapon + charges); buffs each set their own timers/charges
 * here, so adding a buff is a single entry alongside its registry definition.
 */
type BuffCommand = (tank: Tank, adv: AdvancedConfig, cfg: GameConfig) => void;
const BUFF_COMMANDS: Partial<Record<PowerupType, BuffCommand>> = {
  speed: (t, adv) => {
    t.boostTimer = adv.speedBoostSeconds;
  },
  shield: (t, adv) => {
    t.shieldTimer = adv.shieldSeconds;
  },
  scope: (t, adv, cfg) => {
    // Aiming guide: layers on any weapon, consumed one charge per shot, capped
    // by scopeSeconds so it doesn't linger forever if unused.
    t.scopeTimer = adv.scopeSeconds;
    t.scopeShots = cfg.powerupCharges;
  },
};

interface Tank {
  id: string;
  index: number; // compact per-game id for binary snapshots
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
  score: number; // points this round (reset each round)
  totalScore: number; // cumulative points across all rounds (final scoreboard)
  respawnIn: number;
  fireCooldown: number;
  input: InputState;
  /** Active offensive power-up (never "speed"), or null. */
  weapon: PowerupType | null;
  weaponCharges: number;
  /** Seconds of speed boost remaining. */
  boostTimer: number;
  /** Seconds of shield (invulnerability) remaining. */
  shieldTimer: number;
  /** Seconds of line-of-sight scope (aiming guide) remaining (time cap). */
  scopeTimer: number;
  /** Scoped shots remaining — the guide is consumed one charge per shot. */
  scopeShots: number;
  /** Seconds left on a laser windup (0 = not charging). */
  laserCharge: number;
  team: number;
  /** Flags this tank has personally captured (Capture the Flag scoreboard stat). */
  captures: number;
}

interface Bullet {
  id: number;
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounces: number;
  /** Wall bounces this round survives before dying. */
  maxBounces: number;
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
  /** Homing: seconds until the next path recompute. */
  repathIn: number;
  /** Homing: current world point to steer toward (a path waypoint or target). */
  waypoint: { x: number; y: number } | null;
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
  maze: Maze; // swapped each round (a fresh maze per round)
  private cfg: GameConfig;
  private adv: AdvancedConfig;
  private tanks = new Map<string, Tank>();
  private bullets: Bullet[] = [];
  private nextBulletId = 1;
  private nextIndex = 0;
  private spawns: Array<{ x: number; y: number }>;
  // Team VS / CTF: per-team designated spawn areas (empty when disabled).
  private spawnZones: SpawnZone[] = [];
  // Capture the Flag: one flag per team (empty in other modes).
  private flags: Flag[] = [];
  // Hazard zones: terrain tiles (lava/mud/ice/heal) placed on the map.
  private hazards: HazardZone[] = [];
  private finished = false; // the whole match is decided
  private winnerName = ""; // match champion (set once finished)
  // Round series state.
  private round = 1;
  private roundOver = false; // current round decided; match continues
  private roundWinnerName = ""; // who took the round just ended
  private roundWins = new Map<string, number>(); // competitor key -> rounds won
  private teamRoundCaptures = new Map<number, number>(); // CTF: team -> captures this round
  private colorIndex = 0;
  private spawnIndex = 0;
  private everMultiple = false;
  private teamNames: string[] = [];
  private forwardSpeed: number;
  private reverseSpeed: number;
  private powerups: Powerup[] = [];
  private nextPowerupId = 1;
  private powerupTimer: number;
  // Transient effects emitted during the last step (sent once, then cleared).
  private pendingBlasts: Array<{ x: number; y: number }> = [];
  private pendingBeams: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  private pendingEvents: KillEvent[] = [];
  // Kill-streak announcements (server-authoritative so every client agrees).
  private elapsed = 0; // seconds since match start (advances each step)
  private enemyStreak = new Map<number, { count: number; last: number }>();
  private teamKillStreak = new Map<number, { count: number; last: number }>();
  private firstBloodDone = false;
  // Reused BFS scratch for homing-round pathfinding (stamped by generation so
  // it never needs clearing). Sized to the maze grid on first use.
  private pathSeen: Int32Array = new Int32Array(0);
  private pathFrom: Int32Array = new Int32Array(0);
  private pathGen = 0;

  constructor(
    maze: Maze,
    players: Array<{ id: string; name: string; color?: string; team?: number }>,
    config: GameConfig,
    teamNames: string[] = []
  ) {
    this.maze = maze;
    this.cfg = config;
    this.adv = config.adv;
    this.teamNames = teamNames;
    this.forwardSpeed = (TANK_SPEED * config.tankSpeedPct) / 100;
    this.reverseSpeed = (TANK_REVERSE_SPEED * config.tankSpeedPct) / 100;
    this.powerupTimer = config.powerupEverySeconds;
    this.spawns = shuffle(maze.openCellCenters());
    this.buildSpawnZones(players.map((p) => p.team ?? 0));
    this.maze.clearZones(this.spawnZones); // bases are open rooms (no inner walls)
    this.buildHazardZones();
    if (this.cfg.destructibleWalls) this.maze.setWallHp(this.adv.wallHp);
    this.buildFlags();

    // Initial players take sequential spawn points around the arena.
    for (const p of players) this.addPlayer(p, false);
  }

  addPlayer(
    p: { id: string; name: string; color?: string; team?: number },
    farSpawn = true
  ): void {
    if (this.tanks.has(p.id)) return;
    const team = p.team ?? 0;
    // Color is supplied by the lobby (team color in Team VS), else palette.
    const color = p.color ?? TANK_COLORS[this.colorIndex++ % TANK_COLORS.length];
    const spawn = this.zonesActive
      ? this.pickSpawn(p.id, team)
      : farSpawn
        ? this.pickSpawn(p.id)
        : this.spawns[this.spawnIndex++ % this.spawns.length];
    this.tanks.set(p.id, {
      id: p.id,
      index: this.nextIndex++,
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
      ammo: this.adv.maxAmmo,
      reloadTimer: 0,
      deaths: 0,
      score: 0,
      totalScore: 0,
      respawnIn: 0,
      fireCooldown: 0,
      input: {
        forward: false,
        backward: false,
        turnLeft: false,
        turnRight: false,
        fire: false,
        aim: 0,
        eightDir: false,
        joystick: false,
      },
      weapon: null,
      weaponCharges: 0,
      boostTimer: 0,
      shieldTimer: SPAWN_SHIELD_SECONDS, // spawn protection
      scopeTimer: 0,
      scopeShots: 0,
      laserCharge: 0,
      team,
      captures: 0,
    });
    if (this.tanks.size > 1) this.everMultiple = true;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Current round is decided but the match isn't (intermission pending). */
  get isRoundOver(): boolean {
    return this.roundOver && !this.finished;
  }

  get currentRound(): number {
    return this.round;
  }

  /** Round wins needed to take the match (CTF: maxFlags; else the rounds setting). */
  private get roundsToWin(): number {
    return Math.max(1, this.ctf ? this.cfg.maxFlags : this.cfg.rounds);
  }

  /** Number of independent sides: teams in team modes, players otherwise. */
  private get competitorCount(): number {
    return this.cfg.mode === "teams" || this.ctf ? Math.max(2, this.cfg.teamCount) : Math.max(2, this.tanks.size);
  }

  /** Team identity exposed to clients; -1 means this match has no teams. */
  private dtoTeam(t: Tank): number {
    return this.cfg.mode === "teams" || this.ctf ? t.team : -1;
  }

  /**
   * Worst-case rounds in a "first to roundsToWin" series for any number of sides:
   * every side reaching roundsToWin-1 before one more round forces a winner, i.e.
   * sides·(roundsToWin−1)+1. (2 sides first-to-3 ⇒ 5; 4 sides ⇒ 9.) The match
   * actually ends the moment a side reaches roundsToWin.
   */
  get roundCount(): number {
    return Math.max(1, this.competitorCount * (this.roundsToWin - 1) + 1);
  }

  /** Alias used internally for the match-over check. */
  private get totalRounds(): number {
    return this.roundCount;
  }

  /** Name of whoever took the round that just ended. */
  getRoundWinnerName(): string {
    return this.roundWinnerName;
  }

  /**
   * Apply a live config change to the running match. Tuning that's read each
   * tick (scoring, power-ups, bullet/advanced values) takes effect immediately;
   * cached derived values (movement speeds, round count) are recomputed here.
   * Structural changes (mode, map, team count, HP) only fully apply on a
   * restart — the new maze/teams are rebuilt then.
   */
  updateConfig(config: GameConfig): void {
    this.cfg = config;
    this.adv = config.adv;
    this.forwardSpeed = (TANK_SPEED * config.tankSpeedPct) / 100;
    this.reverseSpeed = (TANK_REVERSE_SPEED * config.tankSpeedPct) / 100;
    // Series length (roundCount) is derived from config on read, so nothing to
    // cache here — it tracks the new rounds-to-win / team count immediately.
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
    this.checkElimination();
  }

  /** Advance the simulation by `dt` seconds. */
  step(dt: number): void {
    if (this.finished) return; // frozen only once the whole match is decided
    this.elapsed += dt; // drives kill-streak timing

    // Transient effects only live for the snapshot taken right after this step.
    this.pendingBlasts = [];
    this.pendingBeams = [];
    this.pendingEvents = [];

    this.stepPowerups(dt);

    for (const tank of this.tanks.values()) {
      tank.fireCooldown = Math.max(0, tank.fireCooldown - dt);
      if (tank.boostTimer > 0) tank.boostTimer = Math.max(0, tank.boostTimer - dt);
      if (tank.shieldTimer > 0) tank.shieldTimer = Math.max(0, tank.shieldTimer - dt);
      if (tank.scopeTimer > 0) tank.scopeTimer = Math.max(0, tank.scopeTimer - dt);
      // Laser windup: fire the beam once the charge completes.
      if (tank.laserCharge > 0) {
        tank.laserCharge -= dt;
        if (tank.laserCharge <= 0) {
          tank.laserCharge = 0;
          if (tank.alive && !this.roundOver) this.fireLaser(tank, tank.turretAngle);
        }
      }
      if (tank.reloadTimer > 0) {
        tank.reloadTimer -= dt;
        if (tank.reloadTimer <= 0) {
          tank.reloadTimer = 0;
          tank.ammo = this.adv.maxAmmo; // instant full reload
        }
      }

      if (!tank.alive) {
        // Disconnected or eliminated tanks stay gone; others respawn on a timer.
        if (!tank.connected || tank.out) continue;
        tank.respawnIn = Math.max(0, tank.respawnIn - dt);
        if (tank.respawnIn === 0) this.respawn(tank);
        continue;
      }

      // Between rounds the world keeps animating (bullets fly, blasts settle)
      // but every player is locked out of all control until the next round.
      if (this.roundOver) {
        tank.vx = 0;
        tank.vy = 0;
        continue;
      }

      // Locked during the laser windup: no movement, no aim change, no firing.
      // The turret stays at the angle captured when the laser was triggered.
      if (tank.laserCharge > 0) {
        tank.vx = 0;
        tank.vy = 0;
        continue;
      }

      tank.turretAngle = tank.input.aim;

      const boost = tank.boostTimer > 0 ? this.adv.speedBoostMult : 1;

      // --- compute target velocity from input (per control scheme) ---
      // Velocity is authoritative state that eases toward this target each
      // tick (momentum), instead of being derived from an instant position
      // teleport. Bullets inherit the tank's actual current velocity, so a
      // ramping tank's shots ramp along with it.
      let tx = 0; // target velocity x (px/s)
      let ty = 0; // target velocity y (px/s)
      let moving = false; // any movement key held (governs accel vs decel rate)

      if (tank.input.joystick) {
        // Mobile joystick: face and drive the full 360° toward the aim angle.
        // The turret already tracks `aim` (set above), so heading == aim == shot.
        tank.bodyAngle = tank.input.aim;
        if (tank.input.forward) {
          tx = Math.cos(tank.input.aim) * this.forwardSpeed * boost;
          ty = Math.sin(tank.input.aim) * this.forwardSpeed * boost;
          moving = true;
        }
      } else if (tank.input.eightDir) {
        // 8-directional world movement (MMORPG-style): WASD = up/left/down/right,
        // the body faces the direction of travel. Turret still tracks the cursor.
        let mx = 0;
        let my = 0;
        if (tank.input.forward) my -= 1; // W
        if (tank.input.backward) my += 1; // S
        if (tank.input.turnLeft) mx -= 1; // A
        if (tank.input.turnRight) mx += 1; // D
        if (mx !== 0 || my !== 0) {
          const len = Math.hypot(mx, my);
          tx = (mx / len) * this.forwardSpeed * boost;
          ty = (my / len) * this.forwardSpeed * boost;
          moving = true;
        }
      } else {
        // Tank-relative: A/D rotate the heading, W/S drive along it.
        let turn = 0;
        if (tank.input.turnLeft) turn -= 1;
        if (tank.input.turnRight) turn += 1;
        if (turn !== 0) tank.bodyAngle += turn * this.adv.tankTurnSpeed * dt;

        let drive = 0;
        if (tank.input.forward) drive += 1;
        if (tank.input.backward) drive -= 1;
        if (drive !== 0) {
          const base = drive > 0 ? this.forwardSpeed : this.reverseSpeed;
          tx = Math.cos(tank.bodyAngle) * drive * base * boost;
          ty = Math.sin(tank.bodyAngle) * drive * base * boost;
          moving = true;
        }
      }

      // --- terrain hazard effects on movement ---
      // Mud scales the target velocity (tank drives slower); ice removes
      // friction so the tank slides with no decel when no key is held. Lava
      // and heal are damage/restore effects handled in stepHazards (below).
      const hazard = this.hazardAt(tank.x, tank.y);
      const slowMult = hazard === "mud" ? this.cfg.hazardSlowMult : 1;
      tx *= slowMult;
      ty *= slowMult;
      const onIce = hazard === "ice";

      // --- ease current velocity toward the target (momentum) ---
      // Vector easing: clamp the magnitude of the delta to the per-tick rate,
      // so a diagonal reaches max speed at the same rate as a cardinal move.
      // Decel is higher than accel for snappy brakes vs wind-up. On ice with no
      // input, skip the ease entirely — velocity persists (no friction = slide).
      if (onIce && !moving) {
        // no friction — keep sliding
      } else {
        const rate = (moving ? this.adv.tankAccel : this.adv.tankDecel) * dt;
        const dxv = tx - tank.vx;
        const dyv = ty - tank.vy;
        const dlen = Math.hypot(dxv, dyv);
        if (dlen <= rate || dlen === 0) {
          tank.vx = tx;
          tank.vy = ty;
        } else {
          const k = rate / dlen;
          tank.vx += dxv * k;
          tank.vy += dyv * k;
        }
      }

      // --- move by velocity, axis-separated (slide along walls) ---
      // Zeroing the blocked component preserves slide along the wall and stops
      // the tank from "pushing" into it every tick (which would waste accel
      // and feel sticky).
      const nx = tank.x + tank.vx * dt;
      if (!this.circleHitsWall(nx, tank.y, this.adv.tankRadius)) tank.x = nx;
      else tank.vx = 0;
      const ny = tank.y + tank.vy * dt;
      if (!this.circleHitsWall(tank.x, ny, this.adv.tankRadius)) tank.y = ny;
      else tank.vy = 0;

      // --- body facing follows velocity (8-dir only, for smooth rotation) ---
      // Joystick sets bodyAngle = aim above (instant). Tank-relative derives
      // heading from A/D. Only 8-dir benefits from velocity-based facing, so
      // the body eases through diagonals as momentum ramps. Guard so a tank
      // at rest keeps its last facing.
      if (tank.input.eightDir) {
        const speed = Math.hypot(tank.vx, tank.vy);
        if (speed > 1) tank.bodyAngle = Math.atan2(tank.vy, tank.vx);
      }

      if (tank.input.fire && tank.fireCooldown === 0) this.fire(tank);
    }

    this.stepBullets(dt);
    this.stepFlags(dt);
    this.stepConquest(dt);
    this.stepCarry(dt);
    this.stepHazards(dt);
  }

  private fire(tank: Tank): void {
    if (tank.laserCharge > 0) return; // can't fire while a laser is winding up
    const weapon = tank.weapon && WEAPON_POWERUPS.includes(tank.weapon) ? tank.weapon : null;
    const usingWeapon = weapon !== null;

    // Power-up shots don't draw from the magazine — only normal shots do.
    if (!usingWeapon) {
      if (tank.reloadTimer > 0) return; // mid-reload
      if (tank.ammo <= 0) {
        tank.reloadTimer = this.adv.reloadSeconds;
        return;
      }
    }
    tank.fireCooldown = this.adv.fireCooldown;
    // A committed shot consumes one scope charge (the aiming guide).
    if (tank.scopeShots > 0) tank.scopeShots -= 1;
    const a = tank.turretAngle;

    if (weapon === "laser") {
      // Begin the windup; the beam fires after this.adv.laserDelay (see step()).
      tank.laserCharge = this.adv.laserDelay;
      tank.weaponCharges -= 1;
      if (tank.weaponCharges <= 0) tank.weapon = null;
      return;
    }

    if (weapon === "multishot") {
      // Shotgun: release N ordinary pellets fanned across multishotSpread.
      const n = Math.max(1, Math.round(this.adv.multishotCount));
      const fan = (this.adv.multishotSpread * Math.PI) / 180;
      const step = n > 1 ? fan / (n - 1) : 0;
      const start = a - fan / 2;
      const muzzle = this.adv.tankRadius + this.adv.bulletRadius + 2;
      for (let i = 0; i < n; i++) {
        const ang = n > 1 ? start + step * i : a;
        this.bullets.push({
          id: this.nextBulletId++,
          ownerId: tank.id,
          x: tank.x + Math.cos(ang) * muzzle,
          y: tank.y + Math.sin(ang) * muzzle,
          vx: Math.cos(ang) * this.adv.bulletSpeed + tank.vx,
          vy: Math.sin(ang) * this.adv.bulletSpeed + tank.vy,
          bounces: 0,
          maxBounces: this.adv.bulletBounces,
          life: this.adv.bulletLifetime,
          kind: "normal",
          wallPierce: 0,
          pierceTanks: false,
          wasInWall: false,
          hitIds: new Set(),
          repathIn: 0,
          waypoint: null,
        });
      }
      tank.weaponCharges -= 1;
      if (tank.weaponCharges <= 0) tank.weapon = null;
      return;
    }

    {
      // Only sniper / explosive / tracking reach here (laser & buffs handled above).
      const kind: BulletKind = (weapon ?? "normal") as BulletKind;
      const speed = kind === "sniper" ? this.adv.bulletSpeed * this.adv.sniperSpeedMult : this.adv.bulletSpeed;
      const muzzle = this.adv.tankRadius + this.adv.bulletRadius + 2;
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
        // Tracking rounds carry their own bounce budget; others use the default.
        maxBounces: kind === "tracking" ? this.adv.trackingBounces : this.adv.bulletBounces,
        // Tracking rounds live longer (their effective range); others use the default.
        life: kind === "tracking" ? this.adv.trackingLifetime : this.adv.bulletLifetime,
        kind,
        // Walls a sniper round may pass through before stopping.
        wallPierce: kind === "sniper" ? this.adv.sniperWallPierce : 0,
        pierceTanks: kind === "sniper",
        wasInWall: false,
        hitIds: new Set(),
        repathIn: 0,
        waypoint: null,
      });
    }

    if (usingWeapon) {
      tank.weaponCharges -= 1;
      if (tank.weaponCharges <= 0) tank.weapon = null;
    } else {
      tank.ammo -= 1;
      if (tank.ammo <= 0) tank.reloadTimer = this.adv.reloadSeconds; // forced reload
    }
  }

  /**
   * Hitscan laser: an instant beam that reflects off walls, accumulating up to
   * this.adv.laserRange total length, damaging each tank it crosses (once).
   */
  private fireLaser(tank: Tank, angle: number): void {
    const STEP = 3;
    let dx = Math.cos(angle);
    let dy = Math.sin(angle);
    let x = tank.x + dx * (this.adv.tankRadius + 2);
    let y = tank.y + dy * (this.adv.tankRadius + 2);
    let remaining = this.adv.laserRange;
    const pts: Array<{ x: number; y: number }> = [{ x, y }];
    const hit = new Set<string>();
    let guard = 0;
    let bounces = 0;

    while (remaining > 0 && guard++ < 4000) {
      const nx = x + dx * STEP;
      if (this.circleHitsWall(nx, y, this.adv.bulletRadius)) {
        dx = -dx;
        bounces += 1;
        pts.push({ x, y });
      } else {
        x = nx;
      }
      const ny = y + dy * STEP;
      if (this.circleHitsWall(x, ny, this.adv.bulletRadius)) {
        dy = -dy;
        bounces += 1;
        pts.push({ x, y });
      } else {
        y = ny;
      }
      remaining -= STEP;
      if (x < 0 || y < 0 || x > this.maze.width || y > this.maze.height) break;

      for (const t of this.tanks.values()) {
        if (!t.alive || t.shieldTimer > 0 || hit.has(t.id)) continue;
        // Your own ricochet can come back and hit you (after at least one bounce).
        if (t.id === tank.id && bounces === 0) continue;
        if (this.isFriendly(tank.id, t)) continue; // teammates only when FF is on
        if ((t.x - x) ** 2 + (t.y - y) ** 2 <= this.adv.tankRadius * this.adv.tankRadius) {
          hit.add(t.id);
          t.hp -= 1;
          if (t.hp <= 0) this.kill(t, tank.id);
        }
      }
    }
    pts.push({ x, y });

    // Emit each leg of the reflected path for the client to draw.
    for (let i = 0; i < pts.length - 1; i++) {
      this.pendingBeams.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y });
    }
  }

  /**
   * True if `ownerId` is barred from damaging `tank` by the friendly-fire rule.
   * FF on  → nobody is protected (you can hurt yourself and teammates).
   * FF off → you can't hurt yourself (any mode) or your teammates (Team VS / CTF).
   */
  private isFriendly(ownerId: string, tank: Tank): boolean {
    if (this.cfg.friendlyFire) return false;
    if (ownerId === tank.id) return true; // can't self-damage when FF is off
    if (this.cfg.mode !== "teams" && !this.ctf) return false;
    const o = this.tanks.get(ownerId);
    return !!o && o.team === tank.team;
  }

  private stepBullets(dt: number): void {
    const survivors: Bullet[] = [];
    for (const b of this.bullets) {
      b.life -= dt;
      if (b.life <= 0) {
        // An explosive round detonates wherever it expires, not just on a wall.
        if (b.kind === "explosive") this.explode(b.x, b.y, b.ownerId);
        continue;
      }

      if (b.kind === "tracking") this.steerHoming(b, dt);

      const speed = Math.hypot(b.vx, b.vy);
      const steps = Math.max(1, Math.ceil((speed * dt) / (this.adv.bulletRadius * 0.9)));
      const sdt = dt / steps;
      let dead = false;

      for (let s = 0; s < steps && !dead; s++) {
        if (b.pierceTanks) {
          // Sniper: flies straight through tanks; punches through up to
          // `wallPierce` walls (-1 = unlimited), then stops. Also dies off-map.
          b.x += b.vx * sdt;
          b.y += b.vy * sdt;
          if (b.x < 0 || b.y < 0 || b.x > this.maze.width || b.y > this.maze.height) {
            dead = true;
          } else {
            const inWall = this.circleHitsWall(b.x, b.y, this.adv.bulletRadius);
            if (inWall && !b.wasInWall) {
              // Destructible walls: damage on pierce before checking wallPierce.
              if (this.cfg.destructibleWalls) {
                const w = this.maze.hitWall(b.x, b.y, this.adv.bulletRadius);
                if (w) this.maze.damageWall(w, WALL_DAMAGE);
              }
              if (b.wallPierce <= 0) dead = true;
              else b.wallPierce -= 1;
            }
            b.wasInWall = inWall;
          }
        } else {
          const nx = b.x + b.vx * sdt;
          if (this.circleHitsWall(nx, b.y, this.adv.bulletRadius)) {
            if (b.kind === "explosive") {
              this.explode(b.x, b.y, b.ownerId);
              dead = true;
            } else {
              // Destructible walls: damage on bounce.
              if (this.cfg.destructibleWalls) {
                const w = this.maze.hitWall(nx, b.y, this.adv.bulletRadius);
                if (w) this.maze.damageWall(w, WALL_DAMAGE);
              }
              b.vx = -b.vx;
              if (++b.bounces > b.maxBounces) dead = true;
            }
          } else {
            b.x = nx;
          }
          if (!dead) {
            const ny = b.y + b.vy * sdt;
            if (this.circleHitsWall(b.x, ny, this.adv.bulletRadius)) {
              if (b.kind === "explosive") {
                this.explode(b.x, b.y, b.ownerId);
                dead = true;
              } else {
                if (this.cfg.destructibleWalls) {
                  const w = this.maze.hitWall(b.x, ny, this.adv.bulletRadius);
                  if (w) this.maze.damageWall(w, WALL_DAMAGE);
                }
                b.vy = -b.vy;
                if (++b.bounces > b.maxBounces) dead = true;
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

  /**
   * Steer a homing round toward the nearest tank (prefers an enemy; otherwise
   * the closest tank, even the owner). Rather than aiming straight at the target
   * — which makes the round ram walls and die — it follows the maze: a periodic
   * grid BFS picks the next cell toward the target, and the round curves to it.
   */
  private steerHoming(b: Bullet, dt: number): void {
    b.repathIn -= dt;
    if (b.repathIn <= 0 || !b.waypoint) {
      const target = this.nearestTarget(b.x, b.y, b.ownerId);
      if (!target) {
        b.waypoint = null;
        return;
      }
      b.waypoint = this.nextHopToward(b.x, b.y, target.x, target.y) ?? { x: target.x, y: target.y };
      b.repathIn = TRACKING_REPATH;
    }
    const wp = b.waypoint;
    if (!wp) return;

    const speed = Math.hypot(b.vx, b.vy) || this.adv.bulletSpeed;
    const cur = Math.atan2(b.vy, b.vx);
    const want = Math.atan2(wp.y - b.y, wp.x - b.x);
    let diff = ((want - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (diff < -Math.PI) diff += Math.PI * 2;
    const max = this.adv.trackingTurnRate * dt;
    const turn = Math.max(-max, Math.min(max, diff));
    const a = cur + turn;
    b.vx = Math.cos(a) * speed;
    b.vy = Math.sin(a) * speed;

    // Recompute promptly once the current waypoint is reached.
    const reach = this.maze.cell * 0.35;
    if ((wp.x - b.x) ** 2 + (wp.y - b.y) ** 2 < reach * reach) b.repathIn = 0;
  }

  /**
   * Next world point a homing round should steer toward to reach (tx, ty)
   * through the maze. A breadth-first search rooted at the goal cell labels each
   * cell with the neighbor one step closer to the goal, so the start cell's
   * label is the first hop. Returns the target itself when already in its cell
   * or on the final hop (for an accurate strike), or null if unreachable.
   */
  private nextHopToward(fx: number, fy: number, tx: number, ty: number): { x: number; y: number } | null {
    const m = this.maze;
    const start = m.cellAt(fx, fy);
    const goal = m.cellAt(tx, ty);
    if (start.cx === goal.cx && start.cy === goal.cy) return { x: tx, y: ty };

    const cols = m.cols;
    const rows = m.rows;
    const n = cols * rows;
    if (this.pathSeen.length !== n) {
      this.pathSeen = new Int32Array(n);
      this.pathFrom = new Int32Array(n);
    }
    const seen = this.pathSeen;
    const from = this.pathFrom;
    const gen = ++this.pathGen;

    const startIdx = start.cy * cols + start.cx;
    const goalIdx = goal.cy * cols + goal.cx;
    const queue: number[] = [goalIdx];
    seen[goalIdx] = gen;
    from[goalIdx] = -1;

    let head = 0;
    let reached = false;
    while (head < queue.length && !reached) {
      const cur = queue[head++];
      const cx = cur % cols;
      const cy = (cur - cx) / cols;
      for (const [dx, dy] of HOMING_DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (seen[ni] === gen) continue;
        if (!m.passable(cx, cy, nx, ny)) continue;
        seen[ni] = gen;
        from[ni] = cur; // cur is one step closer to the goal
        if (ni === startIdx) {
          reached = true;
          break;
        }
        queue.push(ni);
      }
    }

    if (seen[startIdx] !== gen) return null; // disconnected (shouldn't happen)
    const hop = from[startIdx];
    if (hop < 0) return { x: tx, y: ty };
    const hx = hop % cols;
    const hy = (hop - hx) / cols;
    if (hx === goal.cx && hy === goal.cy) return { x: tx, y: ty }; // final hop: aim true
    return m.cellCenter(hx, hy);
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
      const teammate = !!owner && (this.cfg.mode === "teams" || this.ctf) && owner.team === t.team;
      const enemy = t.id !== ownerId && !teammate;
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
    // Destructible walls: AoE damage to nearby walls.
    if (this.cfg.destructibleWalls) {
      this.maze.damageWallsInRadius(x, y, this.adv.explosionRadius, WALL_EXPLOSION_DAMAGE);
    }
    if (this.roundOver) return; // between rounds: blast shows, but no damage
    const r2 = this.adv.explosionRadius * this.adv.explosionRadius;
    for (const tank of this.tanks.values()) {
      if (!tank.alive || tank.shieldTimer > 0) continue;
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
    if (this.roundOver) return false; // between rounds: rounds fly through players
    const rr = this.adv.tankRadius + this.adv.bulletRadius;
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
      // Shield blocks the hit (no damage); the round is still stopped/passes.
      if (tank.shieldTimer > 0) {
        if (b.pierceTanks) {
          b.hitIds.add(tank.id);
          continue;
        }
        return true; // normal round absorbed by the shield
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
    const reach = this.adv.tankRadius + POWERUP_RADIUS;
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
    if (powerupDef(type).kind === "weapon") {
      // Every weapon pickup grants the same configurable number of shots.
      tank.weapon = type;
      tank.weaponCharges = this.cfg.powerupCharges;
      return;
    }
    // Buffs run their own composable command (timers/charges).
    BUFF_COMMANDS[type]?.(tank, this.adv, this.cfg);
  }

  private kill(victim: Tank, killerId: string): void {
    victim.alive = false;
    victim.deaths += 1;
    // Dying resets your own streaks (kill chain and betrayal chain alike).
    this.enemyStreak.delete(victim.index);
    this.teamKillStreak.delete(victim.index);

    // CTF: a carried flag drops where the carrier fell, free to be picked up again.
    if (this.ctf) this.dropFlagOf(victim.id);

    // Death penalty: lose a configurable fraction of points (integer, ≥ 0).
    // CTF has no point scoring (the match is decided by flag captures).
    const loss = this.ctf ? 0 : Math.floor((victim.score * this.cfg.deathPenaltyPct) / 100);
    victim.score = Math.max(0, victim.score - loss);

    // Eliminated if lives are limited and exhausted; otherwise respawns. In CTF
    // each death in the round stacks an extra respawn delay, so repeated dying is
    // increasingly costly (the first death uses the normal respawn time).
    if (this.cfg.lives > 0 && victim.deaths >= this.cfg.lives) {
      victim.out = true;
    } else {
      const extra = this.ctf ? this.cfg.ctfRespawnBonus * Math.max(0, victim.deaths - 1) : 0;
      victim.respawnIn = this.cfg.respawnSeconds + extra;
    }

    const killer = this.tanks.get(killerId);
    if (killer && killer.id !== victim.id) {
      const teamKill = (this.cfg.mode === "teams" || this.ctf) && killer.team === victim.team;
      if (teamKill) {
        // Team-killing is penalized, not rewarded (no points in CTF).
        const before = killer.score;
        if (!this.ctf) killer.score = Math.max(0, killer.score - this.cfg.teamKillPenalty);
        const a = this.killStreakTier(killer.index, true);
        this.pendingEvents.push({
          type: 2,
          killer: killer.index,
          victim: victim.index,
          points: killer.score - before,
          streak: a.tier,
          mult: a.mult,
        });
      } else {
        if (!this.ctf) {
          killer.score += this.cfg.killPoints;
          if (killer.score < 1) killer.score = 1; // a kill always leaves you ≥ 1
        }
        const a = this.killStreakTier(killer.index, false);
        this.pendingEvents.push({
          type: 0,
          killer: killer.index,
          victim: victim.index,
          points: this.ctf ? 0 : this.cfg.killPoints,
          streak: a.tier,
          mult: a.mult,
        });
        if (this.cfg.mode === "ffa" && killer.score >= this.cfg.winScore) {
          this.endRound(killer.id, killer.name);
        }
      }
    } else {
      // Self-destruct / environment (e.g. own ricochet) — no announcement.
      this.pendingEvents.push({ type: 1, killer: 255, victim: victim.index, points: -loss, streak: 0, mult: 0 });
    }
    this.checkElimination();
    this.checkTeamWin();
  }

  /**
   * Kill-streak announcement for a kill by `killerIndex` (see KillEvent.streak /
   * .mult). Enemy kills chain into multikills within KILL_STREAK_WINDOW (first of
   * the round is First Blood); team kills chain into a betrayal within
   * TEAMKILL_STREAK_WINDOW (1st betrayal, 3rd traitor, 5th+ kinslayer). The top
   * tier (savage / kinslayer) carries a succession multiplier: 0 for the first,
   * then 2, 3, … for each consecutive one. `tier` 0 = no banner.
   */
  private killStreakTier(killerIndex: number, isTeamKill: boolean): { tier: number; mult: number } {
    // Repeats of the top tier (count 5 = the 1st, no mult; 6 = ×2; 7 = ×3; …).
    const topMult = (count: number) => (count >= 6 ? count - 4 : 0);
    if (isTeamKill) {
      const prev = this.teamKillStreak.get(killerIndex);
      const count = prev && this.elapsed - prev.last <= TEAMKILL_STREAK_WINDOW ? prev.count + 1 : 1;
      this.teamKillStreak.set(killerIndex, { count, last: this.elapsed });
      if (count >= 5) return { tier: 8, mult: topMult(count) }; // kinslayer (most impactful)
      if (count === 3) return { tier: 7, mult: 0 }; // traitor
      if (count === 1) return { tier: 6, mult: 0 }; // betrayal
      return { tier: 0, mult: 0 }; // 2nd / 4th — building toward the next
    }
    const prev = this.enemyStreak.get(killerIndex);
    const count = prev && this.elapsed - prev.last <= KILL_STREAK_WINDOW ? prev.count + 1 : 1;
    this.enemyStreak.set(killerIndex, { count, last: this.elapsed });
    if (!this.firstBloodDone) {
      this.firstBloodDone = true;
      return { tier: 1, mult: 0 }; // first blood
    }
    if (count >= 5) return { tier: 5, mult: topMult(count) }; // savage (caps the tier, multiplies)
    return { tier: count >= 2 ? count : 0, mult: 0 }; // double/triple/maniac, or lone kill
  }

  /**
   * Elimination ending: the match ends once only one side is left standing.
   * Always active in Last Man Standing; in FFA and Team VS it applies whenever
   * lives are limited (so players can actually be eliminated). With infinite
   * lives nobody is ever `out`, so this never triggers in FFA/Teams.
   */
  private checkElimination(): void {
    if (this.finished || this.roundOver || !this.everMultiple) return;
    if (this.ctf) return; // CTF rounds end on a capture, never on elimination
    if (this.cfg.mode !== "lms" && this.cfg.lives <= 0) return;

    if (this.cfg.mode === "teams") {
      const liveTeams = new Set<number>();
      for (const t of this.tanks.values()) if (!t.out) liveTeams.add(t.team);
      if (liveTeams.size <= 1) {
        const [team] = liveTeams;
        if (team === undefined) this.endRound(null, "");
        else this.endRound(`t${team}`, this.teamNames[team] ?? `Team ${team + 1}`);
      }
      return;
    }

    // FFA / LMS: one (or zero) players remain in.
    const standing = [...this.tanks.values()].filter((t) => !t.out);
    if (standing.length <= 1) {
      const w = standing[0];
      this.endRound(w?.id ?? null, w?.name ?? "");
    }
  }

  /** Team VS: a team wins when the sum of its members' points hits winScore. */
  private checkTeamWin(): void {
    if (this.finished || this.roundOver || this.cfg.mode !== "teams") return;
    const totals = new Map<number, number>();
    for (const t of this.tanks.values()) {
      totals.set(t.team, (totals.get(t.team) ?? 0) + t.score);
    }
    for (const [team, total] of totals) {
      if (total >= this.cfg.winScore) {
        this.endRound(`t${team}`, this.teamNames[team] ?? `Team ${team + 1}`);
        return;
      }
    }
  }

  /**
   * Close out the current round: bank this round's scores, credit the winner,
   * and decide whether the match is over (last round played, or the leader has
   * clinched more wins than any rival could still reach). When the match isn't
   * over yet, the lobby runs an intermission and calls `startNextRound`.
   */
  private endRound(winnerKey: string | null, roundWinnerName: string): void {
    if (this.finished || this.roundOver) return;

    // Bank each tank's round score into its cumulative total.
    for (const t of this.tanks.values()) t.totalScore += t.score;

    if (winnerKey) this.roundWins.set(winnerKey, (this.roundWins.get(winnerKey) ?? 0) + 1);
    this.roundWinnerName = roundWinnerName;
    this.roundOver = true;

    // Every mode is "first to roundsToWin round wins" for any number of sides:
    // end the instant a side reaches the target. roundCount is the pigeonhole cap
    // (reaching it guarantees a winner) and a safety net against endless draws.
    const best = Math.max(0, ...this.roundWins.values());
    const matchOver = best >= this.roundsToWin || this.round >= this.totalRounds;

    if (matchOver) {
      this.finished = true;
      this.winnerName = this.roundStandings()[0]?.name ?? roundWinnerName;
    }
  }

  /**
   * Reset the arena for the next round on a fresh maze: every tank back to a
   * full, alive start at a new spawn, round score cleared (cumulative kept),
   * bullets/power-ups/effects wiped. Round-win tallies persist.
   */
  startNextRound(maze: Maze): void {
    this.maze = maze;
    this.spawns = shuffle(maze.openCellCenters());
    this.spawnIndex = 0;
    this.buildSpawnZones([...this.tanks.values()].map((t) => t.team));
    this.maze.clearZones(this.spawnZones); // bases are open rooms (no inner walls)
    this.buildHazardZones();
    if (this.cfg.destructibleWalls) this.maze.setWallHp(this.adv.wallHp);
    this.buildFlags();
    this.teamRoundCaptures.clear();
    // Fresh fight, fresh streaks (a new First Blood is up for grabs).
    this.enemyStreak.clear();
    this.teamKillStreak.clear();
    this.firstBloodDone = false;
    this.round += 1;
    this.roundOver = false;
    this.roundWinnerName = "";
    this.bullets = [];
    this.powerups = [];
    this.pendingBlasts = [];
    this.pendingBeams = [];
    this.pendingEvents = [];
    this.powerupTimer = this.cfg.powerupEverySeconds;
    // Grid size can change with a new random maze — drop the BFS scratch.
    this.pathSeen = new Int32Array(0);
    this.pathFrom = new Int32Array(0);

    let i = 0;
    for (const t of this.tanks.values()) {
      const spot = this.zonesActive ? this.pickSpawn(t.id, t.team) : this.spawns[i++ % this.spawns.length];
      t.x = spot.x;
      t.y = spot.y;
      t.vx = 0;
      t.vy = 0;
      t.bodyAngle = 0;
      t.turretAngle = 0;
      t.alive = true;
      t.out = false;
      t.hp = t.maxHp;
      t.ammo = this.adv.maxAmmo;
      t.reloadTimer = 0;
      t.respawnIn = 0;
      t.fireCooldown = 0;
      t.deaths = 0;
      t.score = 0;
      t.weapon = null;
      t.weaponCharges = 0;
      t.boostTimer = 0;
      t.shieldTimer = SPAWN_SHIELD_SECONDS; // spawn protection at round start
      t.scopeTimer = 0;
      t.scopeShots = 0;
      t.laserCharge = 0;
    }
  }

  /**
   * Series standings: per team in Team VS, per player otherwise. Sorted by round
   * wins, then cumulative score as a tiebreak.
   */
  roundStandings(): RoundStanding[] {
    type Row = RoundStanding & { score: number };
    const rows: Row[] = [];
    if (this.cfg.mode === "teams" || this.ctf) {
      for (let team = 0; team < this.cfg.teamCount; team++) {
        const members = [...this.tanks.values()].filter((t) => t.team === team);
        rows.push({
          key: `t${team}`,
          name: this.teamNames[team] ?? `Team ${team + 1}`,
          color: members[0]?.color ?? this.teamColorFallback(team),
          wins: this.roundWins.get(`t${team}`) ?? 0,
          score: members.reduce((s, t) => s + t.totalScore, 0),
        });
      }
    } else {
      for (const t of this.tanks.values()) {
        rows.push({
          key: t.id,
          name: t.name,
          color: t.color,
          wins: this.roundWins.get(t.id) ?? 0,
          score: t.totalScore,
        });
      }
    }
    rows.sort((a, b) => b.wins - a.wins || b.score - a.score);
    return rows.map(({ key, name, color, wins }) => ({ key, name, color, wins }));
  }

  private teamColorFallback(team: number): string {
    return TANK_COLORS[team % TANK_COLORS.length];
  }

  private respawn(tank: Tank): void {
    const spot = this.pickSpawn(tank.id, tank.team);
    tank.x = spot.x;
    tank.y = spot.y;
    tank.vx = 0;
    tank.vy = 0;
    tank.alive = true;
    tank.hp = tank.maxHp;
    tank.ammo = this.adv.maxAmmo;
    tank.reloadTimer = 0;
    tank.respawnIn = 0;
    tank.fireCooldown = 0;
    // Power-ups are lost on death.
    tank.weapon = null;
    tank.weaponCharges = 0;
    tank.boostTimer = 0;
    tank.shieldTimer = SPAWN_SHIELD_SECONDS; // spawn protection on respawn
    tank.scopeTimer = 0;
    tank.scopeShots = 0;
    tank.laserCharge = 0;
  }

  /** True when team spawn zones are active for this match (Team VS option, or CTF bases). */
  private get zonesActive(): boolean {
    if (this.spawnZones.length === 0) return false;
    return this.ctf || (this.cfg.mode === "teams" && this.cfg.teamSpawnZones);
  }

  /** Candidate spawn cells: a team's zone when zones are active, else the whole arena. */
  private spawnCandidates(team?: number): Array<{ x: number; y: number }> {
    if (team != null) {
      const zone = this.spawnZones.find((z) => z.team === team);
      if (zone && zone.cells.length > 0) return zone.cells;
    }
    return this.spawns;
  }

  /**
   * Compute each team's designated spawn area: a square block of cells anchored
   * in a corner, ordered so teams sit as far apart as possible. The block is
   * SPAWN_ZONE_CELLS per side (clamped so corner blocks can't overlap on a small
   * grid), matching the maze's base blocks so the carved routes meet them.
   * Cell-aligned, so a tank dropped at any cell center always clears the walls.
   * No-op unless Team VS spawn zones are enabled.
   */
  private buildSpawnZones(_teams: number[]): void {
    this.spawnZones = [];
    // Team VS uses zones when enabled; CTF always uses them (they're the bases).
    const wantZones =
      this.cfg.mode === "ctf" || (this.cfg.mode === "teams" && this.cfg.teamSpawnZones);
    if (!wantZones) return;

    const { cols, rows, cell } = this.maze;
    // Same block size the maze routed its base paths to (kept in the corner).
    const side = Math.max(1, Math.min(SPAWN_ZONE_CELLS, Math.floor(cols / 2), Math.floor(rows / 2)));
    // Corner anchors (top-left cell of each block), ordered for max separation:
    // diagonal first (TL, BR), then the other diagonal (TR, BL).
    const corners = [
      { cx: 0, cy: 0 },
      { cx: cols - side, cy: rows - side },
      { cx: cols - side, cy: 0 },
      { cx: 0, cy: rows - side },
    ];
    for (let team = 0; team < this.cfg.teamCount; team++) {
      const { cx, cy } = corners[team % corners.length];
      const cells: Array<{ x: number; y: number }> = [];
      for (let dy = 0; dy < side; dy++) {
        for (let dx = 0; dx < side; dx++) {
          cells.push({ x: (cx + dx + 0.5) * cell, y: (cy + dy + 0.5) * cell });
        }
      }
      this.spawnZones.push({
        team,
        x: cx * cell,
        y: cy * cell,
        width: side * cell,
        height: side * cell,
        cells,
      });
    }
  }

  /**
   * Place up to `hazardDensity` small hazard patches on random open cells,
   * avoiding spawn zones. Patches are randomly offset inside their chosen cell
   * so they don't form a predictable grid.
   * Called on construction and on each new round (the maze changes).
   */
  private buildHazardZones(): void {
    this.hazards = [];
    const density = this.cfg.hazardDensity;
    if (density <= 0) return;
    const { cols, rows, cell } = this.maze;
    const sidePx = Math.max(1, Math.round(cell * HAZARD_ZONE_FRACTION));
    const types = this.cfg.hazardTypes;
    if (types.length === 0) return;
    // Candidate cells: avoid the arena border and spawn zones.
    const candidates: Array<{ cx: number; cy: number }> = [];
    for (let cy = 1; cy < rows - 1; cy++) {
      for (let cx = 1; cx < cols - 1; cx++) {
        const zx = cx * cell;
        const zy = cy * cell;
        // Skip if overlapping any spawn zone.
        const overlaps = this.spawnZones.some(
          (sz) => zx < sz.x + sz.width && zx + cell > sz.x && zy < sz.y + sz.height && zy + cell > sz.y
        );
        if (!overlaps) candidates.push({ cx, cy });
      }
    }
    const chosen = shuffle(candidates).slice(0, density);
    for (const { cx, cy } of chosen) {
      const jitterX = Math.random() * Math.max(0, cell - sidePx);
      const jitterY = Math.random() * Math.max(0, cell - sidePx);
      this.hazards.push({
        x: cx * cell + jitterX,
        y: cy * cell + jitterY,
        width: sidePx,
        height: sidePx,
        type: types[Math.floor(Math.random() * types.length)],
      });
    }
  }

  /** The hazard type at a world point, or null if none. */
  private hazardAt(x: number, y: number): HazardType | null {
    for (const h of this.hazards) {
      if (x >= h.x && x < h.x + h.width && y >= h.y && y < h.y + h.height) return h.type;
    }
    return null;
  }

  /** Per-tick hazard effects: lava damages, heal restores HP. (Mud/ice are
   *  applied in the movement block via hazardAt.) Shields block lava. */
  private stepHazards(dt: number): void {
    if (this.hazards.length === 0 || this.roundOver) return;
    for (const t of this.tanks.values()) {
      if (!t.alive || t.shieldTimer > 0) continue;
      const h = this.hazardAt(t.x, t.y);
      if (h === "lava") {
        t.hp -= this.cfg.hazardDamage * dt;
        if (t.hp <= 0) this.kill(t, t.id); // lava is environmental (self-kill)
      } else if (h === "heal") {
        t.hp = Math.min(t.maxHp, t.hp + this.cfg.hazardHealRate * dt);
      }
    }
  }

  hazardZoneDTOs(): HazardZoneDTO[] {
    return this.hazards.map((h) => ({ x: h.x, y: h.y, width: h.width, height: h.height, type: h.type }));
  }

  /** True when this is a Capture the Flag match. */
  private get ctf(): boolean {
    return this.cfg.mode === "ctf";
  }

  /** Place one flag at each team's base (spawn-zone) center. CTF only. */
  private buildFlags(): void {
    this.flags = [];
    if (!this.ctf) return;
    for (const z of this.spawnZones) {
      // The base is an open room (no inner walls), so the flag sits at its exact
      // centre — a tank can drive right onto it.
      const hx = z.x + z.width / 2;
      const hy = z.y + z.height / 2;
      this.flags.push({ team: z.team, homeX: hx, homeY: hy, x: hx, y: hy, state: "home", carrierId: null, heldTeam: -1, stealCooldown: 0 });
    }
  }

  /**
   * Capture the Flag step. A flag rides its carrier. flagStealMode decides who
   * can take it by touch: "any" (enemies steal, teammates relay), "team" (only
   * teammates relay — enemies must kill the carrier), or "off" (kill to drop).
   * An idle enemy flag is picked up on contact. A dropped own flag is either
   * carried back by your team (flagTeamCarry, default) or instantly teleported
   * home on touch. Bringing your own flag back into your base returns it home. An
   * enemy flag brought into your base is captured ("deliver") or planted on the
   * base to score over time ("conquest"); a planted flag can be reclaimed/raided.
   */
  private stepFlags(dt: number): void {
    if (!this.ctf || this.roundOver) return;
    const pickupR = this.adv.tankRadius + POWERUP_RADIUS;
    const pickupR2 = pickupR * pickupR;
    const stealMode = this.cfg.flagStealMode; // "any" | "team" | "off"
    // "carry" scoring: flags live on tanks and only drop on a kill — they're never
    // returned/planted at a base, and your own flag is grabbable so you can hoard it.
    const carry = this.cfg.ctfScoreMode === "carry";
    const teamCarry = this.cfg.flagTeamCarry || carry;

    for (const flag of this.flags) {
      if (flag.stealCooldown > 0) flag.stealCooldown = Math.max(0, flag.stealCooldown - dt);

      // Carried flag: ride the carrier, or drop if the carrier is gone/dead.
      if (flag.state === "carried") {
        const carrier = flag.carrierId ? this.tanks.get(flag.carrierId) : undefined;
        if (!carrier || !carrier.alive) {
          flag.state = "dropped";
          flag.carrierId = null;
        } else {
          // Take on contact: anyone (any), only the carrier's teammates (team),
          // or no one — kill required (off).
          if (stealMode !== "off" && flag.stealCooldown === 0) {
            for (const t of this.tanks.values()) {
              if (!t.alive || t.id === carrier.id) continue;
              if (stealMode === "team" && t.team !== carrier.team) continue; // enemies must kill
              if ((t.x - carrier.x) ** 2 + (t.y - carrier.y) ** 2 > pickupR2) continue;
              flag.carrierId = t.id;
              flag.stealCooldown = FLAG_STEAL_COOLDOWN;
              break;
            }
          }
          const holder = flag.carrierId ? this.tanks.get(flag.carrierId) : null;
          if (holder) {
            flag.x = holder.x;
            flag.y = holder.y;
          }
          continue;
        }
      }

      // Idle flag (home, dropped, or held at a base): first tank to touch it acts.
      for (const t of this.tanks.values()) {
        if (!t.alive) continue;
        if ((t.x - flag.x) ** 2 + (t.y - flag.y) ** 2 > pickupR2) continue;
        // A flag placed at a base (conquest) is taken by anyone not on the holding
        // team — the owner reclaiming it, or a rival raiding the stack.
        if (flag.state === "held") {
          if (t.team === flag.heldTeam) continue;
          flag.state = "carried";
          flag.carrierId = t.id;
          flag.heldTeam = -1;
          flag.x = t.x;
          flag.y = t.y;
          flag.stealCooldown = FLAG_STEAL_COOLDOWN;
          break;
        }
        if (t.team === flag.team) {
          // In carry mode you can pick up your own flag (even at home) to hoard it
          // for the multiplier; otherwise only a dropped own flag can be recovered.
          if (flag.state === "dropped" || (carry && flag.state === "home")) {
            if (teamCarry) {
              // Recover the flag by carrying it (it returns home from your base).
              flag.state = "carried";
              flag.carrierId = t.id;
              flag.x = t.x;
              flag.y = t.y;
              flag.stealCooldown = FLAG_STEAL_COOLDOWN;
            } else {
              // Legacy: touching your dropped flag teleports it home instantly.
              flag.state = "home";
              flag.x = flag.homeX;
              flag.y = flag.homeY;
              flag.carrierId = null;
            }
            break;
          }
          continue; // own flag sitting at home — nothing to do
        }
        flag.state = "carried";
        flag.carrierId = t.id;
        flag.x = t.x;
        flag.y = t.y;
        flag.stealCooldown = FLAG_STEAL_COOLDOWN;
        break;
      }
    }

    // At a base: a team's own flag carried back simply returns home (deliver/
    // conquest). In "deliver", an enemy flag brought into your base captures it; in
    // "conquest" the enemy flag is planted/stacked at the base, where it scores.
    // "carry" has no base interaction at all — flags only ride tanks and drop on death.
    if (carry) return;
    const deliver = this.cfg.ctfScoreMode === "deliver";
    for (const base of this.spawnZones) {
      for (const flag of this.flags) {
        if (flag.state !== "carried" || !flag.carrierId) continue;
        const carrier = this.tanks.get(flag.carrierId);
        if (!carrier || carrier.team !== base.team) continue; // only the base's team acts here
        if (!this.inRect(carrier.x, carrier.y, base)) continue;
        if (flag.team === base.team) {
          // Own flag brought home → returns to base, ready to grab again.
          this.sendFlagHome(flag);
        } else if (deliver) {
          if (this.captureFlag(carrier, flag)) return; // round ended
        } else {
          this.placeFlagAtBase(flag, base); // conquest: drop it on the stack
        }
      }
    }
  }

  /** Conquest: plant a carried enemy flag on the captor's base, where it scores
   *  until reclaimed/raided. Stacks beside the home flag so multiples stay clear. */
  private placeFlagAtBase(flag: Flag, base: SpawnZone): void {
    const cx = base.x + base.width / 2;
    const cy = base.y + base.height / 2;
    const already = this.flags.filter((f) => f.state === "held" && f.heldTeam === base.team).length;
    const spacing = this.adv.tankRadius * 2.4;
    const col = already % 3;
    flag.state = "held";
    flag.heldTeam = base.team;
    flag.carrierId = null;
    flag.x = cx + (col - 1) * spacing; // a short row offset below the home flag
    flag.y = cy + spacing * (1 + Math.floor(already / 3));
    flag.stealCooldown = FLAG_STEAL_COOLDOWN;
  }

  /**
   * Conquest scoring: each second a team earns 1 point per ENEMY flag planted on
   * its base ("held"), tripled while its own flag sits safe at home. Its own flag
   * is never a point — it's only the ×3 multiplier. Carrying a flag scores
   * nothing; it must be delivered to the base. Points accrue into the team's tanks
   * (so the leaderboard sums them); the first team to winScore takes the round.
   */
  private stepConquest(dt: number): void {
    if (!this.ctf || this.cfg.ctfScoreMode !== "conquest" || this.roundOver) return;
    const ownHome = new Map<number, boolean>();
    for (const f of this.flags) ownHome.set(f.team, f.state === "home");
    const held = new Map<number, number>(); // team -> enemy flags planted on its base
    for (const f of this.flags) {
      if (f.state === "held" && f.heldTeam >= 0) held.set(f.heldTeam, (held.get(f.heldTeam) ?? 0) + 1);
    }
    for (let team = 0; team < this.cfg.teamCount; team++) {
      const flags = held.get(team) ?? 0;
      if (flags === 0) continue;
      const gain = flags * (ownHome.get(team) ? OWN_FLAG_MULT : 1) * dt;
      const members = [...this.tanks.values()].filter((t) => t.team === team);
      if (members.length === 0) continue;
      const share = gain / members.length; // split so the team total = Σ members
      for (const m of members) m.score += share;
    }
    this.checkConquestWin();
  }

  /**
   * Carry scoring: each second a tank earns 1 point per ENEMY flag it personally
   * carries, multiplied (×OWN_FLAG_MULT) while it also carries its own team's flag.
   * The multiplier is per-tank, so of two teammates each holding two flags, the one
   * also carrying its own flag outscores the one holding two enemy flags. Points
   * accrue into the tank (the leaderboard sums them per team); the first team to
   * reach winScore points takes the round.
   */
  private stepCarry(dt: number): void {
    if (!this.ctf || this.cfg.ctfScoreMode !== "carry" || this.roundOver) return;
    const enemyFlags = new Map<string, number>(); // carrierId -> enemy flags carried
    const hasOwnFlag = new Set<string>(); // carriers also carrying their own flag
    for (const f of this.flags) {
      if (f.state !== "carried" || !f.carrierId) continue;
      const carrier = this.tanks.get(f.carrierId);
      if (!carrier || !carrier.alive) continue;
      if (f.team === carrier.team) hasOwnFlag.add(carrier.id);
      else enemyFlags.set(carrier.id, (enemyFlags.get(carrier.id) ?? 0) + 1);
    }
    for (const [id, flags] of enemyFlags) {
      const tank = this.tanks.get(id);
      if (!tank) continue;
      tank.score += flags * (hasOwnFlag.has(id) ? OWN_FLAG_MULT : 1) * dt;
    }
    this.checkConquestWin();
  }

  /** Conquest: the first team whose total points reach winScore wins the round. */
  private checkConquestWin(): void {
    if (this.finished || this.roundOver) return;
    const totals = new Map<number, number>();
    for (const t of this.tanks.values()) totals.set(t.team, (totals.get(t.team) ?? 0) + t.score);
    for (const [team, total] of totals) {
      if (total >= this.cfg.winScore) {
        this.endRound(`t${team}`, this.teamNames[team] ?? `Team ${team + 1}`);
        return;
      }
    }
  }

  /** Send a flag back to its home base. */
  private sendFlagHome(flag: Flag): void {
    flag.state = "home";
    flag.x = flag.homeX;
    flag.y = flag.homeY;
    flag.carrierId = null;
    flag.heldTeam = -1;
    flag.stealCooldown = 0;
  }

  /**
   * Credit a capture to the carrier's team and send the taken flag home. Ends the
   * round once the team reaches the configured captures-per-round. Returns true if
   * the round ended.
   */
  private captureFlag(carrier: Tank, flag: Flag): boolean {
    carrier.captures += 1;
    const team = carrier.team;
    const total = (this.teamRoundCaptures.get(team) ?? 0) + 1;
    this.teamRoundCaptures.set(team, total);
    this.sendFlagHome(flag); // captured flag returns so it can be contested again
    if (total >= Math.max(1, this.cfg.flagsPerRound)) {
      this.endRound(`t${team}`, this.teamNames[team] ?? `Team ${team + 1}`);
      return true;
    }
    return false;
  }

  /**
   * Carried flags drop where their carrier fell (called from kill). When a tank
   * was holding several, they scatter to distinct spots around the drop point so
   * they never stack on top of each other (which would make them un-pickable one
   * at a time). Spots are kept off walls and inside the map; a flag may land on
   * the far side of a wall (walls don't block the scatter), just never on one.
   */
  private dropFlagOf(tankId: string): void {
    const dropped = this.flags.filter((f) => f.carrierId === tankId);
    if (dropped.length === 0) return;
    const cx = dropped[0].x; // a carried flag rides the carrier, so this is where it fell
    const cy = dropped[0].y;
    const placed: Array<{ x: number; y: number }> = [];
    for (const flag of dropped) {
      const spot = dropped.length === 1 ? { x: cx, y: cy } : this.scatterFlagSpot(cx, cy, placed);
      flag.state = "dropped";
      flag.carrierId = null;
      flag.x = spot.x;
      flag.y = spot.y;
      placed.push(spot);
    }
  }

  /**
   * Pick a drop spot in a ring around (cx,cy) that is off walls, inside the map,
   * and at least a flag's clearance from spots already chosen in this drop. Walls
   * don't block the search (a flag may land beyond a wall), but a wall cell itself
   * is avoided. Falls back to the last non-overlapping candidate (else the clamped
   * centre) if no perfect spot turns up within the attempt budget.
   */
  private scatterFlagSpot(cx: number, cy: number, taken: Array<{ x: number; y: number }>): { x: number; y: number } {
    const r = POWERUP_RADIUS;
    const minGap = r * 2.4; // spacing so dropped flags don't overlap when picked up
    const minGap2 = minGap * minGap;
    const margin = r + 1; // keep the whole flag inside the map
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const cxIn = clamp(cx, margin, this.maze.width - margin);
    const cyIn = clamp(cy, margin, this.maze.height - margin);
    let fallback = { x: cxIn, y: cyIn };
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = minGap + Math.random() * minGap * 3; // a small scatter ring
      const x = clamp(cx + Math.cos(ang) * dist, margin, this.maze.width - margin);
      const y = clamp(cy + Math.sin(ang) * dist, margin, this.maze.height - margin);
      if (!taken.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 >= minGap2)) continue;
      fallback = { x, y }; // a non-overlapping spot, kept even if it sits on a wall
      if (!this.circleHitsWall(x, y, r)) return { x, y };
    }
    return fallback;
  }

  private inRect(x: number, y: number, r: { x: number; y: number; width: number; height: number }): boolean {
    return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  }

  /** Flags for the snapshot (CTF only; empty otherwise). */
  flagDTOs(): FlagDTO[] {
    return this.flags.map((f) => {
      const carrier = f.carrierId ? this.tanks.get(f.carrierId) : undefined;
      return {
        team: f.team,
        x: round(f.x),
        y: round(f.y),
        state: f.state,
        carrier: carrier ? carrier.index : 255,
      };
    });
  }

  /** Spawn areas for the client to render (team color resolved from live tanks). */
  spawnZoneDTOs(): SpawnZoneDTO[] {
    return this.spawnZones.map((z) => {
      const member = [...this.tanks.values()].find((t) => t.team === z.team);
      return {
        team: z.team,
        x: z.x,
        y: z.y,
        width: z.width,
        height: z.height,
        color: member?.color ?? this.teamColorFallback(z.team),
      };
    });
  }

  /**
   * Pick a randomized spawn point. With no other living tanks around, any open
   * cell is fair game; otherwise we randomly choose from the farther half of
   * cells so respawns are varied but never right on top of an opponent. When a
   * team is given and spawn zones are active, candidates are limited to that
   * team's zone.
   */
  private pickSpawn(excludeId?: string, team?: number): { x: number; y: number } {
    const candidates = this.spawnCandidates(team);
    const living = [...this.tanks.values()].filter((t) => t.alive && t.id !== excludeId);
    if (living.length === 0) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
    const scored = candidates
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
          index: t.index,
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
          maxAmmo: this.adv.maxAmmo,
          reloadIn: round(t.reloadTimer, 2),
          weapon: t.weapon,
          weaponCharges: t.weaponCharges,
          livesLeft: this.cfg.lives > 0 ? Math.max(0, this.cfg.lives - t.deaths) : 0,
          boosted: t.boostTimer > 0,
          shielded: t.shieldTimer > 0,
          charging: t.laserCharge > 0,
          scoped: t.scopeTimer > 0 && t.scopeShots > 0,
          team: this.dtoTeam(t),
          captures: t.captures,
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
      flags: this.flagDTOs(),
      blasts: this.pendingBlasts.map((b) => ({ x: round(b.x), y: round(b.y) })),
      beams: this.pendingBeams.map((b) => ({
        x1: round(b.x1),
        y1: round(b.y1),
        x2: round(b.x2),
        y2: round(b.y2),
      })),
      events: this.pendingEvents.slice(),
      wallHp: this.cfg.destructibleWalls ? this.maze.damagedWalls() : [],
    };
  }

  /** True if a blast or beam was produced this tick (force a broadcast so the
   *  transient effect isn't lost on a skipped network tick). */
  hasEffects(): boolean {
    return (
      this.pendingBlasts.length > 0 ||
      this.pendingBeams.length > 0 ||
      this.pendingEvents.length > 0
    );
  }

  /** Static per-player info clients need to decode binary snapshots. */
  roster(): RosterEntry[] {
    return [...this.tanks.values()].map((t) => ({
      index: t.index,
      id: t.id,
      name: t.name,
      color: t.color,
      team: this.dtoTeam(t),
      maxHp: t.maxHp,
      maxAmmo: this.adv.maxAmmo,
    }));
  }

  scores(): ScoreDTO[] {
    // Cumulative points across the whole match (the final round was banked at
    // round end). For a single-round match this equals the round score.
    return [...this.tanks.values()]
      .map((t) => ({ id: t.id, name: t.name, color: t.color, score: t.totalScore }))
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

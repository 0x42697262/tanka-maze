// Shared tuning constants. The server is authoritative; the client uses these
// purely for rendering scale and prediction-free interpolation.

export const TICK_RATE = 30; // server simulation ticks per second (physics)
export const TICK_MS = 1000 / TICK_RATE;
// Snapshots are broadcast every Nth sim tick (network rate = TICK_RATE / N).
// The client interpolates, so a lower send rate saves bandwidth invisibly.
export const SNAPSHOT_EVERY_TICKS = 2; // 30 Hz sim -> 15 Hz network
// Large rooms have quadratic snapshot fanout: each larger snapshot is sent to
// every player. Keep default 8-player feel unchanged, then trade network tick
// rate for scalability; client interpolation already renders between snapshots.
export function snapshotEveryTicksForPlayers(players: number): number {
  if (players <= 8) return SNAPSHOT_EVERY_TICKS;
  if (players <= 16) return 3; // 10 Hz
  if (players <= 32) return 4; // 7.5 Hz
  return 6; // 5 Hz for future larger rooms
}

// The arena is an open, limited field divided into a grid of cells. Walls are
// thin line segments placed on the edges between cells; most are removed so the
// space plays open (an arena with cover) rather than a tight corridor maze.
export const MAZE_COLS = 10;
export const MAZE_ROWS = 7;
export const CELL = 88; // pixel size of one arena cell
export const WALL_THICKNESS = 6; // rendered/collision thickness of a wall line
/**
 * Fraction of dead ends left intact when braiding (the rest get an extra
 * opening to form loops). The maze keeps full, even coverage either way; this
 * just controls how loopy vs. winding it feels. 0 = remove every dead end.
 */
export const WALL_KEEP_DEADEND_RATIO = 0.1;
/**
 * Fraction of dead ends a true (CTF) maze keeps when braiding them open. The
 * rest each get one extra opening so they connect through (often forming loops),
 * leaving a less stubby, more flowing maze. Some dead ends also stay because
 * opening them would create a 2×2 open area, which braiding never does.
 */
export const CTF_DEADEND_KEEP = 0.12;

export const TANK_RADIUS = 11;
export const TANK_SPEED = 100; // px / second (forward, at 100% speed)
export const TANK_REVERSE_SPEED = 60; // px / second (backward, at 100% speed)
export const TANK_TURN_SPEED = 4.3; // radians / second (steering rate)
// Momentum: velocity eases toward the input-derived target each tick instead
// of teleporting to it. Accel applies while a movement key is held; decel
// (higher, for snappy brakes vs wind-up) applies while idle. Both are host-
// tunable live (AdvancedConfig.tankAccel / tankDecel).
export const TANK_ACCEL = 600; // px/s² while input active (reaches 100 px/s in ~0.17s)
export const TANK_DECEL = 1200; // px/s² while no input (stops in ~0.08s)

// Ammunition: a magazine of MAX_AMMO rounds. Emptying it forces a reload that
// takes RELOAD_SECONDS, then instantly refills the whole magazine.
export const MAX_AMMO = 5;
export const RELOAD_SECONDS = 3;
export const FIRE_COOLDOWN = 1.0; // min seconds between individual shots
export const RESPAWN_TIME = 3; // default respawn delay (seconds)

export const BULLET_RADIUS = 4;
export const BULLET_SPEED = 240; // px / second
export const BULLET_MAX_BOUNCES = 3;
export const BULLET_LIFETIME = 5; // seconds

// Power-ups
export const POWERUP_RADIUS = 12;
// Hard ceiling on concurrent crates. Not a gameplay cap (hosts tune spawn count
// / despawn freely) but a protocol-safety limit: the binary snapshot encodes the
// crate-list length in a single byte, so the population must never exceed 255 or
// the count wraps and the stream desyncs. 255 is far above any playable density.
export const MAX_POWERUPS_ON_MAP = 255;
export const SPEED_BOOST_MULT = 1.6;
export const SPEED_BOOST_SECONDS = 6;
export const SHIELD_SECONDS = 6; // invulnerability duration from a shield pickup
export const LASER_DELAY = 1; // windup (seconds) before a laser actually fires
export const SNIPER_SPEED_MULT = 5; // very fast round
export const SNIPER_WALL_PIERCE = 10; // walls a sniper round punches through
export const EXPLOSION_RADIUS = 56; // area-damage radius for explosive rounds
export const TRACKING_TURN_RATE = 4.5; // radians/sec a homing round can turn
export const TRACKING_LIFETIME = 6; // seconds a tracking round lives (its range)
export const TRACKING_BOUNCES = 6; // wall bounces a tracking round survives
export const MULTISHOT_COUNT = 5; // pellets released by a multishot pickup
export const MULTISHOT_SPREAD_DEG = 30; // total fan angle (degrees) of a multishot
export const RAPIDFIRE_COUNT = 5; // bullets fired per rapid-fire burst
export const RAPIDFIRE_DELAY = 0.15; // seconds between each burst shot
// Safety bound on bullets emitted by one trigger pull when effects combine
// (e.g. multishot fan × rapid-fire burst) so extreme configs can't flood the
// arena / overrun the 255 wire cap. Rapid-fire burst length is clamped to keep
// fanCount × burst under this.
export const MAX_VOLLEY_BULLETS = 60;
export const TRACKING_REPATH = 0.12; // seconds between homing-round path recomputes
export const SCOPE_SECONDS = 10; // duration of the line-of-sight scope buff

// Rounds: a match is "first to N round wins" for any number of sides (the
// worst-case length is sides·(N−1)+1 rounds).
export const ROUNDS_DEFAULT = 3;
export const ROUND_INTERMISSION_SECONDS = 5; // break between rounds
export const SPAWN_SHIELD_SECONDS = 2; // spawn protection whenever a tank (re)spawns
// CTF: grace after a flag changes hands before it can be taken again, so two
// adjacent tanks don't ping-pong the flag every tick.
export const FLAG_STEAL_COOLDOWN = 0.6;
// Kill-streak announcements: max seconds between a killer's kills to chain a
// multikill, and the (2×) window over which team kills chain into a betrayal.
export const KILL_STREAK_WINDOW = 15;
export const TEAMKILL_STREAK_WINDOW = KILL_STREAK_WINDOW * 2;

// Side (in cells) of each team's square spawn base (Team VS zones / CTF bases).
// A wider base also gives a CTF corner enough exits for multiple base routes.
export const SPAWN_ZONE_CELLS = 2;
// Laser is a hitscan beam: range ≈ one small map (7 cells), so on big maps it
// can't reach all the way across.
export const LASER_RANGE = 15 * CELL;

// Fog of war: non-wall visuals are clipped to the local/team sight area.
// Scope doubles tank vision radius and grants x-ray through walls. Host-tunable live.
// The default clears a normal map's corner-to-corner diagonal (~1074px) with margin, so
// from anywhere on the map the whole map is in sight and only walls cast fog — no patchy
// distance fog at far corners. Because effectiveVisionRadius and the map diagonal both
// scale with √area, that comfortable coverage holds on every map size. Hosts who want
// distance-limited fog can lower "Vision px".
export const VISION_RADIUS = 1300; // px base sight radius (covers a normal map with margin)

// Hazard zones: small terrain patches that affect tanks inside them each tick.
// Lava deals damage; mud slows; ice removes friction (slide); heal restores HP.
export const HAZARD_ZONE_FRACTION = 0.60; // side length as a fraction of one cell
export const HAZARD_DAMAGE = 2; // lava damage per second
export const HAZARD_SLOW_MULT = 0.5; // mud speed multiplier
export const HAZARD_HEAL_RATE = 1; // heal HP per second

// Destructible walls: internal walls have HP and can be breached by bullets.
// Border walls are always indestructible. Explosive rounds deal AoE wall damage.
export const WALL_HP = 3; // hits to destroy an internal wall
export const WALL_DAMAGE = 1; // HP removed per bullet bounce
export const WALL_EXPLOSION_DAMAGE = 2; // HP removed by explosive AoE per wall
// A broken (or damaged) wall heals back to full this many seconds after its last
// hit, but only once no tank is standing on it (so it can't trap anyone).
export const WALL_REGEN_SECONDS = 10;

export const TEAM_COLORS = ["#3f8ce6", "#e6453f", "#46c24f", "#e6c23f"]; // blue, red, green, yellow

export const DEFAULT_MAX_PLAYERS = 8;

// Scoring (integer points only).
export const KILL_POINTS = 60; // points gained per kill
export const DEFAULT_WIN_SCORE = 300; // points to win (≈ 5 kills)
export const MIN_WIN_SCORE = 60;
export const MAX_WIN_SCORE = 6000;

/** How long a disconnected player's slot (and in-game tank/score) is held open
 *  for them to reconnect before they're removed for good. */
export const RECONNECT_GRACE_MS = 45_000;

export const TANK_COLORS = [
  "#e6453f", // red
  "#3f8ce6", // blue
  "#46c24f", // green
  "#e6c23f", // yellow
  "#b04fe6", // purple
  "#e6863f", // orange
  "#3fd9e6", // cyan
  "#e63f9e", // pink
];

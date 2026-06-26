// Shared tuning constants. The server is authoritative; the client uses these
// purely for rendering scale and prediction-free interpolation.

export const TICK_RATE = 30; // server simulation ticks per second (physics)
export const TICK_MS = 1000 / TICK_RATE;
// Snapshots are broadcast every Nth sim tick (network rate = TICK_RATE / N).
// The client interpolates, so a lower send rate saves bandwidth invisibly.
export const SNAPSHOT_EVERY_TICKS = 2; // 30 Hz sim -> 15 Hz network

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

export const TANK_RADIUS = 11;
export const TANK_SPEED = 100; // px / second (forward, at 100% speed)
export const TANK_REVERSE_SPEED = 60; // px / second (backward, at 100% speed)
export const TANK_TURN_SPEED = 4.3; // radians / second (steering rate)

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
export const MAX_POWERUPS_ON_MAP = 4;
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
export const MULTISHOT_COUNT = 3; // pellets released by a multishot pickup
export const MULTISHOT_SPREAD_DEG = 30; // total fan angle (degrees) of a multishot
export const TRACKING_REPATH = 0.12; // seconds between homing-round path recomputes
export const SCOPE_SECONDS = 10; // duration of the line-of-sight scope buff

// Rounds: a match is best-of-N; the side with the most round wins takes it.
export const ROUNDS_DEFAULT = 3;
export const ROUND_INTERMISSION_SECONDS = 5; // break between rounds
export const SPAWN_SHIELD_SECONDS = 2; // spawn protection whenever a tank (re)spawns
// CTF: grace after a flag changes hands before it can be taken again, so two
// adjacent tanks don't ping-pong the flag every tick.
export const FLAG_STEAL_COOLDOWN = 0.6;
// Laser is a hitscan beam: range ≈ one small map (7 cells), so on big maps it
// can't reach all the way across.
export const LASER_RANGE = 15 * CELL;

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

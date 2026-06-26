import {
  CELL,
  MAZE_COLS,
  MAZE_ROWS,
  WALL_KEEP_DEADEND_RATIO,
  WALL_THICKNESS,
} from "../shared/constants.js";
import type { MapSize, MazeDTO, WallDTO, WallStyle } from "../shared/protocol.js";

/**
 * Maze dimensions for the chosen map size. Normal is MAZE_COLS × MAZE_ROWS;
 * small ≈ half the area, large ≈ double, random anywhere in between. The aspect
 * ratio is preserved (area scales by `s`, so each side by `√s`).
 */
export function mazeDimensions(size: MapSize): { cols: number; rows: number } {
  let areaScale: number;
  switch (size) {
    case "small":
      areaScale = 0.5;
      break;
    case "large":
      areaScale = 2.0;
      break;
    case "normal":
      areaScale = 1.0;
      break;
    default:
      areaScale = 0.5 + Math.random() * 1.5; // random: [0.5, 2.0]
  }
  const linear = Math.sqrt(areaScale);
  return {
    cols: Math.max(4, Math.round(MAZE_COLS * linear)),
    rows: Math.max(3, Math.round(MAZE_ROWS * linear)),
  };
}

/**
 * Base-to-base routes a CTF maze should guarantee, scaled by map area: at least
 * 2 on small and normal maps, 3 on a large map. Random maps land wherever their
 * rolled area falls. (Bases are multi-cell blocks, so a corner has enough exits.)
 */
export function ctfPathCount(cols: number, rows: number): number {
  const ratio = (cols * rows) / (MAZE_COLS * MAZE_ROWS);
  return ratio < 1.5 ? 2 : 3;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 4-neighbour offsets (up, right, down, left) used throughout generation. */
const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/**
 * The mutable wall grid that generation commands read and write.
 *
 *  - vWalls[x][y]: vertical wall on the left edge of cell column x, row y.
 *      x in [0, cols] (0 and cols are the border), y in [0, rows).
 *  - hWalls[x][y]: horizontal wall on the top edge of cell x, row y.
 *      x in [0, cols), y in [0, rows] (0 and rows are the border).
 *
 * It owns only the primitives commands share (passability, wall removal, cell
 * openings). The higher-level algorithms live in the commands themselves, so a
 * new generation step is a new command rather than another method here.
 */
export class MazeGrid {
  // Grids start fully walled; the border edges are never removed.
  vWalls: boolean[][];
  hWalls: boolean[][];

  constructor(
    readonly cols: number,
    readonly rows: number,
    // Side (in cells) of each diagonal base block; the route guarantee connects
    // these whole corner blocks (see Maze.baseSize).
    readonly baseSize: number = 1
  ) {
    this.vWalls = makeGrid(cols + 1, rows, true);
    this.hWalls = makeGrid(cols, rows + 1, true);
  }

  /**
   * Whether you can pass between two orthogonally-adjacent cells (no wall on
   * their shared edge). Returns false for non-adjacent or out-of-range cells.
   */
  passable(ax: number, ay: number, bx: number, by: number): boolean {
    if (ax === bx && Math.abs(ay - by) === 1) {
      return !this.hWalls[ax][Math.max(ay, by)]; // shared horizontal edge
    }
    if (ay === by && Math.abs(ax - bx) === 1) {
      return !this.vWalls[Math.max(ax, bx)][ay]; // shared vertical edge
    }
    return false;
  }

  /** Knock down the wall on the shared edge of two adjacent cells. */
  removeWallBetween(cx: number, cy: number, nx: number, ny: number): void {
    if (nx === cx + 1) this.vWalls[cx + 1][cy] = false;
    else if (nx === cx - 1) this.vWalls[cx][cy] = false;
    else if (ny === cy + 1) this.hWalls[cx][cy + 1] = false;
    else if (ny === cy - 1) this.hWalls[cx][cy] = false;
  }

  /** Number of open sides (0-4) a cell currently has. */
  cellOpenings(x: number, y: number): number {
    let walls = 0;
    if (this.vWalls[x][y]) walls++;
    if (this.vWalls[x + 1][y]) walls++;
    if (this.hWalls[x][y]) walls++;
    if (this.hWalls[x][y + 1]) walls++;
    return 4 - walls;
  }

  /** Removers for each *internal* (non-border) wall currently around a cell. */
  internalWallsOf(x: number, y: number): Array<() => void> {
    const ops: Array<() => void> = [];
    if (x > 0 && this.vWalls[x][y]) ops.push(() => (this.vWalls[x][y] = false));
    if (x < this.cols - 1 && this.vWalls[x + 1][y]) ops.push(() => (this.vWalls[x + 1][y] = false));
    if (y > 0 && this.hWalls[x][y]) ops.push(() => (this.hWalls[x][y] = false));
    if (y < this.rows - 1 && this.hWalls[x][y + 1]) ops.push(() => (this.hWalls[x][y + 1] = false));
    return ops;
  }

  /** Remove every internal wall, leaving only the outer border. */
  clearInternalWalls(): void {
    for (let x = 1; x < this.cols; x++) {
      for (let y = 0; y < this.rows; y++) this.vWalls[x][y] = false;
    }
    for (let x = 0; x < this.cols; x++) {
      for (let y = 1; y < this.rows; y++) this.hWalls[x][y] = false;
    }
  }
}

/**
 * One step of maze generation (Command pattern). Each command mutates the shared
 * grid in place; a Maze is built by running an ordered pipeline of them. Adding
 * or reordering a generation behaviour is a matter of adding a command and
 * slotting it into `buildPipeline` — no other code changes.
 */
export interface MazeCommand {
  run(g: MazeGrid): void;
}

/** Randomized DFS that removes walls between visited cells (perfect maze). */
export class CarveCommand implements MazeCommand {
  run(g: MazeGrid): void {
    const { cols, rows } = g;
    const visited = makeGrid(cols, rows, false);
    const stack: Array<[number, number]> = [];
    const sx = Math.floor(Math.random() * cols);
    const sy = Math.floor(Math.random() * rows);
    visited[sx][sy] = true;
    stack.push([sx, sy]);

    while (stack.length > 0) {
      const [cx, cy] = stack[stack.length - 1];
      const neighbors: Array<[number, number]> = [];
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !visited[nx][ny]) {
          neighbors.push([nx, ny]);
        }
      }
      if (neighbors.length === 0) {
        stack.pop();
        continue;
      }
      const [nx, ny] = neighbors[Math.floor(Math.random() * neighbors.length)];
      g.removeWallBetween(cx, cy, nx, ny);
      visited[nx][ny] = true;
      stack.push([nx, ny]);
    }
  }
}

/**
 * Braid the perfect maze: every cell with a single opening (a dead end) gets
 * one extra opening. This adds loops and removes trap corridors while keeping
 * the perfect maze's dense, even wall coverage across the whole arena — so no
 * region is left empty. A small fraction of dead ends are left intact for
 * variety.
 */
export class BraidCommand implements MazeCommand {
  run(g: MazeGrid): void {
    for (let x = 0; x < g.cols; x++) {
      for (let y = 0; y < g.rows; y++) {
        if (g.cellOpenings(x, y) <= 1 && Math.random() > WALL_KEEP_DEADEND_RATIO) {
          const removable = g.internalWallsOf(x, y);
          if (removable.length > 0) {
            removable[Math.floor(Math.random() * removable.length)]();
          }
        }
      }
    }
  }
}

/**
 * Guarantee every cell borders at least one wall, so no spot on the field is
 * left fully exposed. A cell with all four sides open gets one wall restored,
 * preferring a wall whose neighbor stays connected (no new dead end).
 */
export class EnsureCoverageCommand implements MazeCommand {
  run(g: MazeGrid): void {
    for (let x = 0; x < g.cols; x++) {
      for (let y = 0; y < g.rows; y++) {
        if (g.cellOpenings(x, y) < 4) continue;
        const candidates: Array<{ add: () => void; safe: boolean }> = [];
        if (x > 0)
          candidates.push({ add: () => (g.vWalls[x][y] = true), safe: g.cellOpenings(x - 1, y) >= 3 });
        if (x < g.cols - 1)
          candidates.push({ add: () => (g.vWalls[x + 1][y] = true), safe: g.cellOpenings(x + 1, y) >= 3 });
        if (y > 0)
          candidates.push({ add: () => (g.hWalls[x][y] = true), safe: g.cellOpenings(x, y - 1) >= 3 });
        if (y < g.rows - 1)
          candidates.push({ add: () => (g.hWalls[x][y + 1] = true), safe: g.cellOpenings(x, y + 1) >= 3 });
        const pick = candidates.find((c) => c.safe) ?? candidates[0];
        pick?.add();
      }
    }
  }
}

/**
 * Guarantee the whole arena is reachable: flood-fill from a corner and, if any
 * cell is unreachable, knock down a wall bridging it to the reached region,
 * then repeat. Connected layouts (open/cross/box/…) leave it untouched; it only
 * repairs the rare disconnected pocket a randomized carve+coverage can leave.
 */
export class EnsureConnectedCommand implements MazeCommand {
  run(g: MazeGrid): void {
    const total = g.cols * g.rows;
    for (let guard = 0; guard < total; guard++) {
      const reached = new Uint8Array(total);
      const stack = [0];
      reached[0] = 1;
      let count = 1;
      while (stack.length) {
        const cur = stack.pop() as number;
        const cx = cur % g.cols;
        const cy = (cur - cx) / g.cols;
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
          const ni = ny * g.cols + nx;
          if (!reached[ni] && g.passable(cx, cy, nx, ny)) {
            reached[ni] = 1;
            count++;
            stack.push(ni);
          }
        }
      }
      if (count === total) return;
      // Open one wall from the reached region to an unreached neighbour.
      let opened = false;
      for (let i = 0; i < total && !opened; i++) {
        if (!reached[i]) continue;
        const cx = i % g.cols;
        const cy = (i - cx) / g.cols;
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
          if (!reached[ny * g.cols + nx] && !g.passable(cx, cy, nx, ny)) {
            g.removeWallBetween(cx, cy, nx, ny);
            opened = true;
            break;
          }
        }
      }
      if (!opened) return; // nothing to open (shouldn't happen) — avoid looping
    }
  }
}

/**
 * Guarantee at least `minPaths` edge-disjoint routes between the two diagonal
 * base blocks, so no single corridor can be the sole link between them.
 *
 * Solved as a *min-cost* max-flow between a super-source wired to every cell of
 * the top-left base block and a super-sink wired from the bottom-right block.
 * Each grid adjacency is a unit-capacity edge whose cost is 0 if it's already an
 * open passage and 1 if it's a wall (so using it would cost one carve). Pushing
 * `minPaths` units of cheapest flow makes the routes thread through the existing
 * maze corridors and only break the few walls they truly need — the first route
 * reuses the existing maze for free, so the maze keeps its winding character
 * instead of a plain BFS bulldozing whole border corridors open. The walls that
 * end up carrying net flow are carved.
 *
 * Routing to the whole corner block (rather than the single corner cell) is what
 * lets a corner support three routes: a lone corner cell has only two exits, but
 * a 2×2 block has four.
 */
export class EnsureCornerPathsCommand implements MazeCommand {
  constructor(private readonly minPaths: number) {}

  run(g: MazeGrid): void {
    const minPaths = this.minPaths;
    if (minPaths < 2 || g.cols < 2 || g.rows < 2) return;
    const N = g.cols * g.rows;
    const S = N; // super-source
    const T = N + 1; // super-sink
    const V = N + 2;
    const side = Math.max(1, Math.min(g.baseSize, Math.floor(g.cols / 2), Math.floor(g.rows / 2)));

    // Adjacency-list residual network. Arcs come in (real, residual) pairs so
    // the reverse of arc a is a ^ 1. Each grid edge is added as two opposing
    // unit-capacity arcs (the undirected-edge model for edge-disjoint flow).
    const head = new Int32Array(V).fill(-1);
    const to: number[] = [];
    const nxt: number[] = [];
    const cap: number[] = [];
    const cost: number[] = [];
    const addArc = (u: number, v: number, ca: number, co: number) => {
      to.push(v);
      cap.push(ca);
      cost.push(co);
      nxt.push(head[u]);
      head[u] = to.length - 1;
    };
    const addEdge = (u: number, v: number, ca: number, co: number): number => {
      const id = to.length;
      addArc(u, v, ca, co); // real arc
      addArc(v, u, 0, -co); // residual
      return id;
    };
    // Carvable walls cost 1, existing passages cost 0.
    const edges: Array<{ x: number; y: number; nx: number; ny: number; a1: number; a2: number }> = [];
    for (let y = 0; y < g.rows; y++) {
      for (let x = 0; x < g.cols; x++) {
        const u = y * g.cols + x;
        for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= g.cols || ny >= g.rows) continue;
          const v = ny * g.cols + nx;
          const co = g.passable(x, y, nx, ny) ? 0 : 1;
          const a1 = addEdge(u, v, 1, co);
          const a2 = addEdge(v, u, 1, co);
          edges.push({ x, y, nx, ny, a1, a2 });
        }
      }
    }
    // Wire the super-source/sink to each cell of the corner blocks (cost 0). The
    // capacity is generous; the grid edges are the real bottleneck.
    for (let dy = 0; dy < side; dy++) {
      for (let dx = 0; dx < side; dx++) {
        addEdge(S, dy * g.cols + dx, minPaths, 0);
        addEdge((g.rows - 1 - dy) * g.cols + (g.cols - 1 - dx), T, minPaths, 0);
      }
    }

    // Successive shortest (cheapest) augmenting paths via SPFA (Bellman–Ford
    // queue handles the negative residual-arc costs). Unit grid caps ⇒ routes
    // stay edge-disjoint.
    for (let f = 0; f < minPaths; f++) {
      const dist = new Float64Array(V).fill(Infinity);
      const inQueue = new Uint8Array(V);
      const prevArc = new Int32Array(V).fill(-1);
      dist[S] = 0;
      const q = [S];
      inQueue[S] = 1;
      while (q.length) {
        const u = q.shift() as number;
        inQueue[u] = 0;
        for (let a = head[u]; a !== -1; a = nxt[a]) {
          if (cap[a] <= 0) continue;
          const v = to[a];
          const nd = dist[u] + cost[a];
          if (nd < dist[v]) {
            dist[v] = nd;
            prevArc[v] = a;
            if (!inQueue[v]) {
              inQueue[v] = 1;
              q.push(v);
            }
          }
        }
      }
      if (!Number.isFinite(dist[T])) break; // no more edge-disjoint routes
      for (let v = T; v !== S; ) {
        const a = prevArc[v];
        cap[a] -= 1;
        cap[a ^ 1] += 1;
        v = to[a ^ 1];
      }
    }

    // Carve every wall carrying net flow: exactly one of its two real arcs spent
    // its unit of capacity (both spent ⇒ the routes cancelled ⇒ nothing to do).
    for (const e of edges) {
      const used1 = cap[e.a1] === 0;
      const used2 = cap[e.a2] === 0;
      if (used1 !== used2 && !g.passable(e.x, e.y, e.nx, e.ny)) {
        g.removeWallBetween(e.x, e.y, e.nx, e.ny);
      }
    }
  }
}

/**
 * Drop only wall segments that touch nothing else — a one-cell dash whose both
 * lattice endpoints are free (no border, no perpendicular wall). These are the
 * "broken walls that aren't connected at all"; coherent internal wall runs
 * (which legitimately float a maze's structure inward) are left intact, so this
 * never thins a maze out the way removing whole detached branches would.
 */
export class PruneIsolatedWallsCommand implements MazeCommand {
  run(g: MazeGrid): void {
    const { cols, rows } = g;
    // Walls incident to lattice vertex (x, y): up/down verticals, left/right
    // horizontals. A vertex with exactly one is the loose tip of a dash.
    const degree = (x: number, y: number): number => {
      let d = 0;
      if (y > 0 && g.vWalls[x][y - 1]) d++;
      if (y < rows && g.vWalls[x][y]) d++;
      if (x > 0 && g.hWalls[x - 1][y]) d++;
      if (x < cols && g.hWalls[x][y]) d++;
      return d;
    };
    // Internal verticals: endpoints (x, y) and (x, y + 1).
    for (let x = 1; x < cols; x++)
      for (let y = 0; y < rows; y++)
        if (g.vWalls[x][y] && degree(x, y) === 1 && degree(x, y + 1) === 1) g.vWalls[x][y] = false;
    // Internal horizontals: endpoints (x, y) and (x + 1, y).
    for (let x = 0; x < cols; x++)
      for (let y = 1; y < rows; y++)
        if (g.hWalls[x][y] && degree(x, y) === 1 && degree(x + 1, y) === 1) g.hWalls[x][y] = false;
  }
}

// --- Fixed, hand-designed layouts (start from an open field) ---------------
// vWalls[x][y] = vertical edge at pixel x*cell, spanning cell row y.
// hWalls[x][y] = horizontal edge at pixel y*cell, spanning cell column x.

/** A plus through the centre, arms stopping short of the border so tanks can
 *  circle around the ends. */
export class CrossCommand implements MazeCommand {
  run(g: MazeGrid): void {
    const xc = Math.floor(g.cols / 2);
    const yc = Math.floor(g.rows / 2);
    const vy0 = Math.max(1, Math.round(g.rows * 0.2));
    const vy1 = Math.min(g.rows - 1, Math.round(g.rows * 0.8));
    for (let y = vy0; y < vy1; y++) g.vWalls[xc][y] = true;
    const hx0 = Math.max(1, Math.round(g.cols * 0.2));
    const hx1 = Math.min(g.cols - 1, Math.round(g.cols * 0.8));
    for (let x = hx0; x < hx1; x++) g.hWalls[x][yc] = true;
  }
}

/** An L: a vertical arm meeting a horizontal arm at the centre corner. */
export class LCommand implements MazeCommand {
  run(g: MazeGrid): void {
    const xc = Math.floor(g.cols / 2);
    const yc = Math.floor(g.rows / 2);
    // Arms stop a cell short of the border so the L floats near the centre.
    const vEnd = Math.min(g.rows - 1, yc + Math.max(2, Math.round(g.rows * 0.45)));
    for (let y = yc; y < vEnd; y++) g.vWalls[xc][y] = true;
    const hEnd = Math.min(g.cols - 1, xc + Math.max(2, Math.round(g.cols * 0.45)));
    for (let x = xc; x < hEnd; x++) g.hWalls[x][yc] = true;
  }
}

/** Vertical bars with a single doorway each, staggered top/bottom to force a
 *  snaking route across the arena. */
export class TunnelsCommand implements MazeCommand {
  run(g: MazeGrid): void {
    const bars = [Math.round(g.cols / 3), Math.round((g.cols * 2) / 3)];
    bars.forEach((bx, i) => {
      if (bx <= 0 || bx >= g.cols) return;
      const gap = i % 2 === 0 ? g.rows - 1 : 0; // alternate the open end
      for (let y = 0; y < g.rows; y++) {
        if (y !== gap) g.vWalls[bx][y] = true;
      }
    });
  }
}

/** An inner rectangular room with a doorway centred on each side. */
export class BoxCommand implements MazeCommand {
  run(g: MazeGrid): void {
    const x0 = Math.max(1, Math.round(g.cols * 0.25));
    const x1 = Math.min(g.cols - 1, Math.round(g.cols * 0.75));
    const y0 = Math.max(1, Math.round(g.rows * 0.25));
    const y1 = Math.min(g.rows - 1, Math.round(g.rows * 0.75));
    const mx = Math.floor((x0 + x1) / 2);
    const my = Math.floor((y0 + y1) / 2);
    for (let x = x0; x < x1; x++) {
      if (x !== mx) {
        g.hWalls[x][y0] = true;
        g.hWalls[x][y1] = true;
      }
    }
    for (let y = y0; y < y1; y++) {
      if (y !== my) {
        g.vWalls[x0][y] = true;
        g.vWalls[x1][y] = true;
      }
    }
  }
}

/** A regular field of short pillar dashes (Snake-style obstacles). */
export class DotsCommand implements MazeCommand {
  run(g: MazeGrid): void {
    for (let x = 1; x < g.cols - 1; x += 2) {
      for (let y = 1; y < g.rows - 1; y += 2) {
        g.hWalls[x][y] = true; // a one-cell horizontal dash
      }
    }
  }
}

/** Sprinkle a handful of internal walls as light cover. */
export class ScatterCommand implements MazeCommand {
  run(g: MazeGrid): void {
    const p = 0.07;
    for (let x = 1; x < g.cols; x++) {
      for (let y = 0; y < g.rows; y++) {
        if (Math.random() < p) g.vWalls[x][y] = true;
      }
    }
    for (let x = 0; x < g.cols; x++) {
      for (let y = 1; y < g.rows; y++) {
        if (Math.random() < p) g.hWalls[x][y] = true;
      }
    }
  }
}

/** Clear the field down to its border (the base for the fixed layouts). */
export class ClearInternalCommand implements MazeCommand {
  run(g: MazeGrid): void {
    g.clearInternalWalls();
  }
}

/**
 * Assemble the ordered generation pipeline for a layout. The arena always ends
 * connected (no walled-off pockets) and, when asked, carries the guaranteed
 * base routes. CTF (`perfectMaze`) keeps the carved single-path maze — dead
 * ends and all — instead of braiding it open, and tidies any stray dash; other
 * modes braid the carved maze into an open arena with scattered cover.
 */
export function buildPipeline(
  wallStyle: WallStyle,
  minCornerPaths: number,
  perfectMaze: boolean
): MazeCommand[] {
  const cmds: MazeCommand[] = [];
  switch (wallStyle) {
    case "open":
      cmds.push(new ClearInternalCommand());
      break;
    case "sparse":
      cmds.push(new ClearInternalCommand(), new ScatterCommand());
      break;
    case "cross":
      cmds.push(new ClearInternalCommand(), new CrossCommand());
      break;
    case "lshape":
      cmds.push(new ClearInternalCommand(), new LCommand());
      break;
    case "tunnels":
      cmds.push(new ClearInternalCommand(), new TunnelsCommand());
      break;
    case "box":
      cmds.push(new ClearInternalCommand(), new BoxCommand());
      break;
    case "dots":
      cmds.push(new ClearInternalCommand(), new DotsCommand());
      break;
    default: // "maze"
      cmds.push(new CarveCommand());
      if (!perfectMaze) cmds.push(new BraidCommand(), new EnsureCoverageCommand());
  }
  cmds.push(new EnsureConnectedCommand()); // no tank ever spawns in a walled-off pocket
  if (minCornerPaths >= 2) cmds.push(new EnsureCornerPathsCommand(minCornerPaths));
  // A true maze keeps every wall joined to its neighbours; drop any loose dash a
  // carved route may have stranded (only the carved style — fixed layouts float
  // walls by design).
  if (perfectMaze && wallStyle === "maze") cmds.push(new PruneIsolatedWallsCommand());
  return cmds;
}

/**
 * An arena bounded by a border, with thin internal walls. The wall layout is
 * produced by a pipeline of generation commands (see `buildPipeline`): the
 * default "maze" style carves a randomized maze, while CTF keeps it as a true
 * single-path maze with guaranteed base routes and other styles lay down fixed
 * cover. Walls are exposed as thin line segments for rendering and collision.
 */
export class Maze {
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly cell: number;
  readonly thickness: number;
  readonly walls: Segment[];
  /**
   * Side (in cells) of each diagonal base block the route guarantee connects —
   * clamped so two blocks can't overlap on a small grid. The bases stay in the
   * corners; a multi-cell block gives a corner enough exits for several routes.
   */
  readonly baseSize: number;

  private grid: MazeGrid;

  constructor(
    cols: number,
    rows: number,
    wallStyle: WallStyle = "maze",
    cellSize: number = CELL,
    thickness: number = WALL_THICKNESS,
    // Minimum edge-disjoint routes to guarantee between the diagonal bases (CTF
    // bases). 1 = leave the layout as generated; 2+ = ensure that many routes.
    minCornerPaths: number = 1,
    // True for CTF: carve a true single-path maze (dead ends kept, every wall
    // joined to its neighbours) instead of the open arena other modes use.
    perfectMaze: boolean = false,
    // Side (in cells) of each diagonal base block the route guarantee connects.
    baseSize: number = 1
  ) {
    this.cols = cols;
    this.rows = rows;
    this.cell = cellSize;
    this.thickness = thickness;
    this.width = cols * cellSize;
    this.height = rows * cellSize;
    // Clamp so the two corner blocks can never overlap on a small grid.
    this.baseSize = Math.max(1, Math.min(baseSize, Math.floor(cols / 2), Math.floor(rows / 2)));

    this.grid = new MazeGrid(cols, rows, this.baseSize);
    for (const cmd of buildPipeline(wallStyle, minCornerPaths, perfectMaze)) {
      cmd.run(this.grid);
    }
    this.walls = this.buildSegments();
  }

  /** World point → grid cell indices (clamped to the arena). */
  cellAt(px: number, py: number): { cx: number; cy: number } {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(px / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(py / this.cell)));
    return { cx, cy };
  }

  /** Center world point of a cell. */
  cellCenter(cx: number, cy: number): { x: number; y: number } {
    return { x: (cx + 0.5) * this.cell, y: (cy + 0.5) * this.cell };
  }

  /**
   * Whether you can pass between two orthogonally-adjacent cells (no wall on
   * their shared edge). Returns false for non-adjacent or out-of-range cells.
   */
  passable(ax: number, ay: number, bx: number, by: number): boolean {
    return this.grid.passable(ax, ay, bx, by);
  }

  /** Collect standing walls into merged collinear line segments. */
  private buildSegments(): Segment[] {
    const segs: Segment[] = [];
    const { vWalls, hWalls } = this.grid;

    // Vertical walls: merge consecutive present cells down each column.
    for (let x = 0; x <= this.cols; x++) {
      let runStart = -1;
      for (let y = 0; y <= this.rows; y++) {
        const present = y < this.rows && vWalls[x][y];
        if (present && runStart === -1) runStart = y;
        if (!present && runStart !== -1) {
          segs.push({ x1: x * this.cell, y1: runStart * this.cell, x2: x * this.cell, y2: y * this.cell });
          runStart = -1;
        }
      }
    }

    // Horizontal walls: merge consecutive present cells across each row.
    for (let y = 0; y <= this.rows; y++) {
      let runStart = -1;
      for (let x = 0; x <= this.cols; x++) {
        const present = x < this.cols && hWalls[x][y];
        if (present && runStart === -1) runStart = x;
        if (!present && runStart !== -1) {
          segs.push({ x1: runStart * this.cell, y1: y * this.cell, x2: x * this.cell, y2: y * this.cell });
          runStart = -1;
        }
      }
    }

    return segs;
  }

  /** Pixel-space center of every cell — used as spawn points. */
  openCellCenters(): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        out.push({ x: (x + 0.5) * this.cell, y: (y + 0.5) * this.cell });
      }
    }
    return out;
  }

  /** True if a circle at (x, y) with radius r overlaps any wall line. */
  hitsCircle(x: number, y: number, r: number): boolean {
    const reach = r + this.thickness / 2;
    const reach2 = reach * reach;
    for (const w of this.walls) {
      if (pointSegDist2(x, y, w.x1, w.y1, w.x2, w.y2) <= reach2) return true;
    }
    return false;
  }

  toDTO(): MazeDTO {
    return {
      width: this.width,
      height: this.height,
      thickness: this.thickness,
      walls: this.walls.map((w): WallDTO => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })),
    };
  }
}

function makeGrid<T>(w: number, h: number, fill: T): T[][] {
  return Array.from({ length: w }, () => new Array<T>(h).fill(fill));
}

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by). */
function pointSegDist2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

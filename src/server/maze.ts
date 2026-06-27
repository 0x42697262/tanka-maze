import {
  CELL,
  CTF_DEADEND_KEEP,
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

/**
 * Side (in cells) of the open room carved at the map centre for CTF: a single
 * cell on a small map, 3×3 on normal and large maps. Random maps scale by area.
 * Takes the *base* (pre-density) dimensions, like ctfPathCount.
 */
export function ctfCenterRoom(cols: number, rows: number): number {
  const ratio = (cols * rows) / (MAZE_COLS * MAZE_ROWS);
  return ratio < 0.75 ? 1 : 3;
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

  /**
   * Number of walls meeting at a lattice vertex (border walls included). An
   * interior vertex with 0 means the four cells around it form a 2×2 open area;
   * keeping every interior vertex ≥1 is exactly "no 2×2 empty area".
   */
  wallDegree(vx: number, vy: number): number {
    let d = 0;
    if (vy > 0 && this.vWalls[vx][vy - 1]) d++;
    if (vy < this.rows && this.vWalls[vx][vy]) d++;
    if (vx > 0 && this.hWalls[vx - 1][vy]) d++;
    if (vx < this.cols && this.hWalls[vx][vy]) d++;
    return d;
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

/** Cells of a `side`×`side` block anchored at top-left cell (cx0, cy0). */
function blockCells(g: MazeGrid, cx0: number, cy0: number, side: number): number[] {
  const out: number[] = [];
  for (let dy = 0; dy < side; dy++)
    for (let dx = 0; dx < side; dx++) out.push((cy0 + dy) * g.cols + (cx0 + dx));
  return out;
}

/** Top-left cell of base corner `idx`, in the spawn-zone order: 0 TL, 1 BR, 2 TR, 3 BL. */
function cornerAnchor(g: MazeGrid, idx: number, side: number): [number, number] {
  switch (idx % 4) {
    case 1:
      return [g.cols - side, g.rows - side];
    case 2:
      return [g.cols - side, 0];
    case 3:
      return [0, g.rows - side];
    default:
      return [0, 0];
  }
}

/** Top-left cell of the centred `side`×`side` block. */
function centerAnchor(g: MazeGrid, side: number): [number, number] {
  return [Math.floor((g.cols - side) / 2), Math.floor((g.rows - side) / 2)];
}

/** Clamp a block side so two opposite blocks can't overlap on a small grid. */
function clampSide(g: MazeGrid, side: number): number {
  return Math.max(1, Math.min(side, Math.floor(g.cols / 2), Math.floor(g.rows / 2)));
}

/**
 * Min-cost max-flow carving: push `minPaths` units of cheapest flow from the
 * `sources` cells to the `sinks` cells, where crossing an existing passage costs
 * 0 and carving a wall costs 1. The routes thread through existing corridors and
 * break only the few walls they must, so the maze keeps its winding character.
 * Walls that carry net flow are carved and recorded in `onRoute` (so a later 2×2
 * fill won't wall a route off). Super-source/sink model the cell sets as a unit.
 */
function routeMinCost(
  g: MazeGrid,
  sources: number[],
  sinks: number[],
  minPaths: number,
  onRoute: Set<number>
): void {
  const N = g.cols * g.rows;
  const S = N;
  const T = N + 1;
  const V = N + 2;
  // Arcs come in (real, residual) pairs so the reverse of arc a is a ^ 1.
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
  const edges: Array<{ x: number; y: number; nx: number; ny: number; a1: number; a2: number }> = [];
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      const u = y * g.cols + x;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= g.cols || ny >= g.rows) continue;
        const v = ny * g.cols + nx;
        const co = g.passable(x, y, nx, ny) ? 0 : 1; // open passages free, walls cost a carve
        const a1 = addEdge(u, v, 1, co);
        const a2 = addEdge(v, u, 1, co);
        edges.push({ x, y, nx, ny, a1, a2 });
      }
    }
  }
  for (const c of sources) addEdge(S, c, minPaths, 0);
  for (const c of sinks) addEdge(c, T, minPaths, 0);

  // Successive cheapest augmenting paths via SPFA (handles negative residuals).
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

  for (const e of edges) {
    const used1 = cap[e.a1] === 0;
    const used2 = cap[e.a2] === 0;
    if (used1 !== used2) {
      const a = e.y * g.cols + e.x;
      const b = e.ny * g.cols + e.nx;
      onRoute.add(a < b ? a * N + b : b * N + a);
      if (!g.passable(e.x, e.y, e.nx, e.ny)) g.removeWallBetween(e.x, e.y, e.nx, e.ny);
    }
  }
}

/**
 * Fill any 2×2 open area carving may have opened: restore one of the block's
 * interior walls, preferring a wall no route uses (so guaranteed routes survive)
 * and that doesn't strand a dead end. Restoring one edge of the block's loop
 * keeps every cell connected.
 */
function fill2x2Areas(g: MazeGrid, onRoute: Set<number>): void {
  const N = g.cols * g.rows;
  const key = (a: number, b: number) => (a < b ? a * N + b : b * N + a);
  let guard = N;
  let changed = true;
  while (changed && guard-- > 0) {
    changed = false;
    for (let x = 0; x + 1 < g.cols; x++) {
      for (let y = 0; y + 1 < g.rows; y++) {
        if (g.vWalls[x + 1][y] || g.vWalls[x + 1][y + 1] || g.hWalls[x][y + 1] || g.hWalls[x + 1][y + 1]) {
          continue;
        }
        const opts = [
          { set: () => (g.vWalls[x + 1][y] = true), c1: [x, y], c2: [x + 1, y] },
          { set: () => (g.vWalls[x + 1][y + 1] = true), c1: [x, y + 1], c2: [x + 1, y + 1] },
          { set: () => (g.hWalls[x][y + 1] = true), c1: [x, y], c2: [x, y + 1] },
          { set: () => (g.hWalls[x + 1][y + 1] = true), c1: [x + 1, y], c2: [x + 1, y + 1] },
        ] as const;
        const k = (o: (typeof opts)[number]) => key(o.c1[1] * g.cols + o.c1[0], o.c2[1] * g.cols + o.c2[0]);
        const offRoute = opts.filter((o) => !onRoute.has(k(o)));
        const cands = offRoute.length ? offRoute : opts;
        const pick =
          cands.find((o) => g.cellOpenings(o.c1[0], o.c1[1]) >= 3 && g.cellOpenings(o.c2[0], o.c2[1]) >= 3) ??
          cands[0];
        pick.set();
        changed = true;
      }
    }
  }
}

/** Edge-disjoint routes between two cell sets (unit-capacity max flow, capped). */
function countRoutes(g: MazeGrid, sources: number[], sinks: number[], limit: number): number {
  const N = g.cols * g.rows;
  const S = N;
  const T = N + 1;
  const V = N + 2;
  const cap = new Map<number, number>();
  const add = (u: number, v: number, c: number) => cap.set(u * V + v, (cap.get(u * V + v) ?? 0) + c);
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      const u = y * g.cols + x;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= g.cols || ny >= g.rows || !g.passable(x, y, nx, ny)) continue;
        const v = ny * g.cols + nx;
        add(u, v, 1);
        add(v, u, 1);
      }
    }
  }
  for (const c of sources) add(S, c, limit);
  for (const c of sinks) add(c, T, limit);
  const srcSet = new Set(sources);
  const sinkSet = new Set(sinks);
  const neighbors = (u: number): number[] => {
    if (u === S) return sources;
    if (u === T) return [];
    const ux = u % g.cols;
    const uy = (u - ux) / g.cols;
    const out: number[] = [];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = ux + dx;
      const ny = uy + dy;
      if (nx >= 0 && ny >= 0 && nx < g.cols && ny < g.rows) out.push(ny * g.cols + nx);
    }
    if (srcSet.has(u)) out.push(S);
    if (sinkSet.has(u)) out.push(T);
    return out;
  };
  let flow = 0;
  while (flow < limit) {
    const prev = new Int32Array(V).fill(-1);
    prev[S] = S;
    const q = [S];
    for (let h = 0; h < q.length && prev[T] === -1; h++) {
      const u = q[h];
      for (const v of neighbors(u)) {
        if (prev[v] !== -1 || (cap.get(u * V + v) ?? 0) <= 0) continue;
        prev[v] = u;
        q.push(v);
      }
    }
    if (prev[T] === -1) break;
    for (let v = T; v !== S; v = prev[v]) {
      const u = prev[v];
      cap.set(u * V + v, (cap.get(u * V + v) as number) - 1);
      cap.set(v * V + u, (cap.get(v * V + u) ?? 0) + 1);
    }
    flow++;
  }
  return flow;
}

/** Fewest routes any of the `baseCorners` base blocks has to the centre block. */
export function minSpokeRoutes(g: MazeGrid, baseCorners: number, centerSide: number, limit: number): number {
  const bside = clampSide(g, g.baseSize);
  const cside = clampSide(g, Math.max(1, centerSide));
  const [ccx, ccy] = centerAnchor(g, cside);
  const center = blockCells(g, ccx, ccy, cside);
  let min = Infinity;
  for (let i = 0; i < baseCorners; i++) {
    const [cx, cy] = cornerAnchor(g, i, bside);
    min = Math.min(min, countRoutes(g, blockCells(g, cx, cy, bside), center, limit));
  }
  return min === Infinity ? limit : min;
}

/**
 * Corner-to-corner route guarantee (used by the non-CTF wall styles): ensure
 * `minPaths` edge-disjoint routes between the two diagonal corner blocks.
 */
export class EnsureCornerPathsCommand implements MazeCommand {
  // `fill2x2` fills any 2×2 the routing opens (a true maze wants none); the
  // open-arena styles leave it off so their layout is untouched.
  constructor(private readonly minPaths: number, private readonly fill2x2 = false) {}

  run(g: MazeGrid): void {
    if (this.minPaths < 2 || g.cols < 2 || g.rows < 2) return;
    const side = clampSide(g, g.baseSize);
    const onRoute = new Set<number>();
    routeMinCost(
      g,
      blockCells(g, 0, 0, side),
      blockCells(g, g.cols - side, g.rows - side, side),
      this.minPaths,
      onRoute
    );
    if (this.fill2x2) fill2x2Areas(g, onRoute);
  }
}

/**
 * CTF hub-and-spoke routing: guarantee `minPaths` edge-disjoint routes from each
 * base corner block to the central block, so every base truly connects to the
 * centre (rather than the bases being wired to each other). Routes may also link
 * bases directly — that's fine. Each base is routed independently (spokes may
 * share corridors), the cheapest-flow carve keeps the maze winding, and any 2×2
 * opened along the way is filled.
 */
export class CenterSpokesCommand implements MazeCommand {
  constructor(
    private readonly minPaths: number,
    private readonly baseCorners: number,
    private readonly centerSide: number
  ) {}

  run(g: MazeGrid): void {
    if (this.minPaths < 1 || g.cols < 2 || g.rows < 2) return;
    const bside = clampSide(g, g.baseSize);
    const cside = clampSide(g, Math.max(1, this.centerSide));
    const [ccx, ccy] = centerAnchor(g, cside);
    const center = blockCells(g, ccx, ccy, cside);
    const onRoute = new Set<number>();
    for (let i = 0; i < this.baseCorners; i++) {
      const [cx, cy] = cornerAnchor(g, i, bside);
      routeMinCost(g, blockCells(g, cx, cy, bside), center, this.minPaths, onRoute);
    }
    fill2x2Areas(g, onRoute);
  }
}

/**
 * Geometry of the central boxed room: a side×side block walled on its perimeter
 * with a doorway centred on each side. `walls` are the perimeter wall keys to
 * protect (doorways excluded); `inside` tests interior cells. Returns null when
 * there's nothing to box (a 1×1 small-map centre, or no room for an outer ring).
 */
function centerBox(
  g: MazeGrid,
  side: number
): {
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
  mx: number;
  my: number;
  inside: (x: number, y: number) => boolean;
  walls: Set<string>;
} | null {
  if (side < 2) return null;
  const cs = Math.min(side, g.cols - 2, g.rows - 2);
  if (cs < 2) return null;
  const cx0 = Math.floor((g.cols - cs) / 2);
  const cy0 = Math.floor((g.rows - cs) / 2);
  const cx1 = cx0 + cs;
  const cy1 = cy0 + cs;
  const mx = cx0 + (cs >> 1);
  const my = cy0 + (cs >> 1);
  const walls = new Set<string>();
  for (let y = cy0; y < cy1; y++) {
    if (y !== my) {
      walls.add(`v${cx0},${y}`);
      walls.add(`v${cx1},${y}`);
    }
  }
  for (let x = cx0; x < cx1; x++) {
    if (x !== mx) {
      walls.add(`h${x},${cy0}`);
      walls.add(`h${x},${cy1}`);
    }
  }
  const inside = (x: number, y: number) => x >= cx0 && x < cx1 && y >= cy0 && y < cy1;
  return { cx0, cy0, cx1, cy1, mx, my, inside, walls };
}

/**
 * Reconnect any cell cut off (e.g. by walling the centre box): open a wall to
 * bridge the gap, preferring a non-protected wall and only falling back to a
 * protected one (an extra box doorway) when it's the sole bridge. Guarantees
 * every cell stays reachable.
 */
function repairConnectivity(g: MazeGrid, protectedWalls: Set<string>): void {
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
    let fallback: (() => void) | null = null;
    let opened = false;
    for (let i = 0; i < total && !opened; i++) {
      if (!reached[i]) continue;
      const cx = i % g.cols;
      const cy = (i - cx) / g.cols;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
        if (reached[ny * g.cols + nx] || g.passable(cx, cy, nx, ny)) continue;
        let key: string;
        let open: () => void;
        if (nx === cx + 1) {
          key = `v${cx + 1},${cy}`;
          open = () => (g.vWalls[cx + 1][cy] = false);
        } else if (nx === cx - 1) {
          key = `v${cx},${cy}`;
          open = () => (g.vWalls[cx][cy] = false);
        } else if (ny === cy + 1) {
          key = `h${cx},${cy + 1}`;
          open = () => (g.hWalls[cx][cy + 1] = false);
        } else {
          key = `h${cx},${cy}`;
          open = () => (g.hWalls[cx][cy] = false);
        }
        if (protectedWalls.has(key)) {
          fallback ??= open;
          continue;
        }
        open();
        opened = true;
        break;
      }
    }
    if (!opened) {
      if (fallback) fallback();
      else return;
    }
  }
}

/**
 * Turn the map centre into a contained room: clear its interior, wall the whole
 * perimeter, then open a doorway centred on each side — so the centre reads as a
 * boxed structure with a few entrances instead of a wide-open blob. Runs after
 * routing/braid; any cell the box cut off is reconnected (preferring non-box
 * walls). No room for a 1×1 (small-map) centre.
 */
export class CenterRoomCommand implements MazeCommand {
  constructor(private readonly side: number) {}

  run(g: MazeGrid): void {
    const b = centerBox(g, this.side);
    if (!b) return;
    // Open the interior.
    for (let x = b.cx0 + 1; x < b.cx1; x++)
      for (let y = b.cy0; y < b.cy1; y++) g.vWalls[x][y] = false;
    for (let x = b.cx0; x < b.cx1; x++)
      for (let y = b.cy0 + 1; y < b.cy1; y++) g.hWalls[x][y] = false;
    // Wall the perimeter, leaving a doorway centred on each side.
    for (let y = b.cy0; y < b.cy1; y++) {
      g.vWalls[b.cx0][y] = y !== b.my;
      g.vWalls[b.cx1][y] = y !== b.my;
    }
    for (let x = b.cx0; x < b.cx1; x++) {
      g.hWalls[x][b.cy0] = x !== b.mx;
      g.hWalls[x][b.cy1] = x !== b.mx;
    }
    repairConnectivity(g, b.walls);
  }
}

/**
 * Stop adjacent corner bases (4-team) from being joined by a straight border
 * run: drop a short wall "tooth" inward from the middle of each map edge, so the
 * top/bottom/left/right border corridors can't be travelled corner-to-corner in
 * a straight line. Teeth (and the centre box) are protected while connectivity
 * is repaired, so they stay up without sealing anything off.
 */
export class EdgeBarriersCommand implements MazeCommand {
  constructor(private readonly baseCorners: number, private readonly centerSide: number) {}

  run(g: MazeGrid): void {
    if (this.baseCorners < 4) return; // only matters when all four corners are bases
    const depth = Math.max(1, Math.min(clampSide(g, g.baseSize) + 1, g.rows, g.cols));
    const midC = Math.floor(g.cols / 2);
    const midR = Math.floor(g.rows / 2);
    const protectedWalls = new Set<string>();
    const box = centerBox(g, this.centerSide);
    if (box) for (const w of box.walls) protectedWalls.add(w);
    for (let y = 0; y < depth; y++) {
      g.vWalls[midC][y] = true; // top
      protectedWalls.add(`v${midC},${y}`);
      g.vWalls[midC][g.rows - 1 - y] = true; // bottom
      protectedWalls.add(`v${midC},${g.rows - 1 - y}`);
    }
    for (let x = 0; x < depth; x++) {
      g.hWalls[x][midR] = true; // left
      protectedWalls.add(`h${x},${midR}`);
      g.hWalls[g.cols - 1 - x][midR] = true; // right
      protectedWalls.add(`h${g.cols - 1 - x},${midR}`);
    }
    repairConnectivity(g, protectedWalls);
  }
}

/**
 * Braid a true maze: give most dead ends one extra opening so they connect
 * through (often looping back), leaving a flowing maze instead of a thicket of
 * stubs. A wall is only removed when both its lattice endpoints keep a wall
 * afterwards, so braiding never opens a 2×2 area; a fraction of dead ends (and
 * any whose every opening would make a 2×2) are kept for character. Only opens
 * walls, so the arena stays connected.
 */
export class BraidDeadEndsCommand implements MazeCommand {
  // `centerSide` (when set) protects the central box: its perimeter walls are
  // never braided away and its open interior is left alone.
  constructor(private readonly keepRatio: number, private readonly centerSide = 0) {}

  run(g: MazeGrid): void {
    const { cols, rows } = g;
    const box = centerBox(g, this.centerSide);
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        if (box && box.inside(x, y)) continue; // leave the centre room as built
        if (g.cellOpenings(x, y) > 1) continue; // not a dead end
        if (Math.random() < this.keepRatio) continue; // keep some dead ends
        const cands: Array<{ remove: () => void; key: string; ax: number; ay: number; bx: number; by: number }> = [];
        if (x > 0 && g.vWalls[x][y])
          cands.push({ remove: () => (g.vWalls[x][y] = false), key: `v${x},${y}`, ax: x, ay: y, bx: x, by: y + 1 });
        if (x < cols - 1 && g.vWalls[x + 1][y])
          cands.push({ remove: () => (g.vWalls[x + 1][y] = false), key: `v${x + 1},${y}`, ax: x + 1, ay: y, bx: x + 1, by: y + 1 });
        if (y > 0 && g.hWalls[x][y])
          cands.push({ remove: () => (g.hWalls[x][y] = false), key: `h${x},${y}`, ax: x, ay: y, bx: x + 1, by: y });
        if (y < rows - 1 && g.hWalls[x][y + 1])
          cands.push({ remove: () => (g.hWalls[x][y + 1] = false), key: `h${x},${y + 1}`, ax: x, ay: y + 1, bx: x + 1, by: y + 1 });
        // Keep ≥1 wall at each endpoint (degree ≥2 before ⇒ ≥1 after): no 2×2.
        // Never tear down a box-perimeter wall.
        const safe = cands.filter(
          (c) =>
            g.wallDegree(c.ax, c.ay) >= 2 &&
            g.wallDegree(c.bx, c.by) >= 2 &&
            !(box && box.walls.has(c.key))
        );
        if (safe.length) safe[Math.floor(Math.random() * safe.length)].remove();
      }
    }
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
 * connected (no walled-off pockets) and, when asked, carries the guaranteed base
 * routes. CTF (`perfectMaze`) carves a true maze, wires each base to the central
 * hub (spoke routes), fills any 2×2 the routing opened, then braids most dead
 * ends into flowing loops (never opening a 2×2); other modes braid the carved
 * maze into an open arena with scattered cover.
 */
export function buildPipeline(
  wallStyle: WallStyle,
  minCornerPaths: number,
  perfectMaze: boolean,
  baseCorners = 2,
  centerRoom = 0
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
  if (perfectMaze && wallStyle === "maze") {
    // CTF: spoke each base to the centre, box the centre into a contained room,
    // then braid most dead ends into flowing loops (the box stays intact).
    cmds.push(new CenterSpokesCommand(minCornerPaths, baseCorners, centerRoom));
    cmds.push(new CenterRoomCommand(centerRoom));
    cmds.push(new BraidDeadEndsCommand(CTF_DEADEND_KEEP, centerRoom));
    cmds.push(new EdgeBarriersCommand(baseCorners, centerRoom));
  } else if (minCornerPaths >= 2) {
    cmds.push(new EnsureCornerPathsCommand(minCornerPaths));
  }
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
  walls: Segment[];
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
    baseSize: number = 1,
    // CTF: how many corner bases to wire to the centre (2 or 4 teams).
    baseCorners: number = 2,
    // CTF: side (in cells) of the central open room / spoke hub (0 = none).
    centerRoom: number = 0
  ) {
    this.cols = cols;
    this.rows = rows;
    this.cell = cellSize;
    this.thickness = thickness;
    this.width = cols * cellSize;
    this.height = rows * cellSize;
    // Clamp so the two corner blocks can never overlap on a small grid.
    this.baseSize = Math.max(1, Math.min(baseSize, Math.floor(cols / 2), Math.floor(rows / 2)));

    // Generate the layout. Every base must reach the boxed centre; the centre's
    // connectivity repair normally guarantees that, but carving is randomized, so
    // regenerate on the rare layout where a base can't (e.g. all its doorways got
    // walled off).
    const ctf = perfectMaze && wallStyle === "maze";
    const pipeline = () => buildPipeline(wallStyle, minCornerPaths, perfectMaze, baseCorners, centerRoom);
    let grid = new MazeGrid(cols, rows, this.baseSize);
    for (const cmd of pipeline()) cmd.run(grid);
    for (
      let attempt = 0;
      ctf && minSpokeRoutes(grid, baseCorners, centerRoom, 1) < 1 && attempt < 20;
      attempt++
    ) {
      grid = new MazeGrid(cols, rows, this.baseSize);
      for (const cmd of pipeline()) cmd.run(grid);
    }
    this.grid = grid;
    this.walls = this.buildSegments();
  }

  /**
   * Open up the given cell-rectangles (the spawn bases) so no wall sits inside
   * them — clearing the interior walls between their cells — then rebuild the
   * wall segments. Perimeter walls are kept; only walls are removed, so the
   * arena stays fully connected.
   */
  clearZones(rects: Array<{ x: number; y: number; width: number; height: number }>): void {
    for (const r of rects) {
      const cx0 = Math.round(r.x / this.cell);
      const cy0 = Math.round(r.y / this.cell);
      const cx1 = cx0 + Math.round(r.width / this.cell);
      const cy1 = cy0 + Math.round(r.height / this.cell);
      for (let x = cx0 + 1; x < cx1; x++)
        for (let y = cy0; y < cy1; y++) this.grid.vWalls[x][y] = false;
      for (let x = cx0; x < cx1; x++)
        for (let y = cy0 + 1; y < cy1; y++) this.grid.hWalls[x][y] = false;
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

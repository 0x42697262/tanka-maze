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

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * An open arena bounded by a border, with randomized thin internal walls.
 *
 * A perfect maze is first carved with a randomized depth-first search (so the
 * arena is always fully connected), then a fraction of the internal walls are
 * knocked down so the result plays as an open field with scattered cover rather
 * than a one-tank-wide corridor maze. Walls are exposed as thin line segments.
 */
export class Maze {
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly cell: number;
  readonly thickness: number;
  readonly walls: Segment[];

  // vWalls[x][y]: vertical wall on the left edge of cell column x, row y.
  //   x in [0, cols] (0 and cols are the border), y in [0, rows).
  // hWalls[x][y]: horizontal wall on the top edge of cell x, row y.
  //   x in [0, cols), y in [0, rows] (0 and rows are the border).
  private vWalls: boolean[][];
  private hWalls: boolean[][];

  constructor(
    cols: number,
    rows: number,
    wallStyle: WallStyle = "maze",
    cellSize: number = CELL,
    thickness: number = WALL_THICKNESS
  ) {
    this.cols = cols;
    this.rows = rows;
    this.cell = cellSize;
    this.thickness = thickness;
    this.width = cols * cellSize;
    this.height = rows * cellSize;

    // Grids start fully walled; the border edges are never removed.
    this.vWalls = makeGrid(cols + 1, rows, true);
    this.hWalls = makeGrid(cols, rows + 1, true);

    switch (wallStyle) {
      case "open":
        this.clearInternalWalls(); // bordered empty field (Nokia-snake style)
        break;
      case "sparse":
        this.clearInternalWalls();
        this.scatterWalls(); // a few scattered obstacles
        break;
      case "cross":
        this.clearInternalWalls();
        this.crossWalls();
        break;
      case "lshape":
        this.clearInternalWalls();
        this.lWalls();
        break;
      case "tunnels":
        this.clearInternalWalls();
        this.tunnelWalls();
        break;
      case "box":
        this.clearInternalWalls();
        this.boxWalls();
        break;
      case "dots":
        this.clearInternalWalls();
        this.dotWalls();
        break;
      default: // "maze"
        this.carve();
        this.braid();
        this.ensureCoverage();
    }
    this.ensureConnected(); // no tank can ever spawn in a walled-off pocket
    this.walls = this.buildSegments();
  }

  /**
   * Guarantee the whole arena is reachable: flood-fill from a corner and, if any
   * cell is unreachable, knock down a wall bridging it to the reached region,
   * then repeat. Connected layouts (open/cross/box/…) leave it untouched; it only
   * repairs the rare disconnected pocket a randomized carve+coverage can leave.
   */
  private ensureConnected(): void {
    const total = this.cols * this.rows;
    const dirs = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const;
    for (let guard = 0; guard < total; guard++) {
      const reached = new Uint8Array(total);
      const stack = [0];
      reached[0] = 1;
      let count = 1;
      while (stack.length) {
        const cur = stack.pop() as number;
        const cx = cur % this.cols;
        const cy = (cur - cx) / this.cols;
        for (const [dx, dy] of dirs) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
          const ni = ny * this.cols + nx;
          if (!reached[ni] && this.passable(cx, cy, nx, ny)) {
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
        const cx = i % this.cols;
        const cy = (i - cx) / this.cols;
        for (const [dx, dy] of dirs) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
          if (!reached[ny * this.cols + nx] && !this.passable(cx, cy, nx, ny)) {
            this.removeWallBetween(cx, cy, nx, ny);
            opened = true;
            break;
          }
        }
      }
      if (!opened) return; // nothing to open (shouldn't happen) — avoid looping
    }
  }

  // --- Fixed, hand-designed layouts (start from an open field) -------------
  // vWalls[x][y] = vertical edge at pixel x*cell, spanning cell row y.
  // hWalls[x][y] = horizontal edge at pixel y*cell, spanning cell column x.

  /** A plus through the centre, arms stopping short of the border so tanks can
   *  circle around the ends. */
  private crossWalls(): void {
    const xc = Math.floor(this.cols / 2);
    const yc = Math.floor(this.rows / 2);
    const vy0 = Math.max(1, Math.round(this.rows * 0.2));
    const vy1 = Math.min(this.rows - 1, Math.round(this.rows * 0.8));
    for (let y = vy0; y < vy1; y++) this.vWalls[xc][y] = true;
    const hx0 = Math.max(1, Math.round(this.cols * 0.2));
    const hx1 = Math.min(this.cols - 1, Math.round(this.cols * 0.8));
    for (let x = hx0; x < hx1; x++) this.hWalls[x][yc] = true;
  }

  /** An L: a vertical arm meeting a horizontal arm at the centre corner. */
  private lWalls(): void {
    const xc = Math.floor(this.cols / 2);
    const yc = Math.floor(this.rows / 2);
    // Arms stop a cell short of the border so the L floats near the centre.
    const vEnd = Math.min(this.rows - 1, yc + Math.max(2, Math.round(this.rows * 0.45)));
    for (let y = yc; y < vEnd; y++) this.vWalls[xc][y] = true;
    const hEnd = Math.min(this.cols - 1, xc + Math.max(2, Math.round(this.cols * 0.45)));
    for (let x = xc; x < hEnd; x++) this.hWalls[x][yc] = true;
  }

  /** Vertical bars with a single doorway each, staggered top/bottom to force a
   *  snaking route across the arena. */
  private tunnelWalls(): void {
    const bars = [Math.round(this.cols / 3), Math.round((this.cols * 2) / 3)];
    bars.forEach((bx, i) => {
      if (bx <= 0 || bx >= this.cols) return;
      const gap = i % 2 === 0 ? this.rows - 1 : 0; // alternate the open end
      for (let y = 0; y < this.rows; y++) {
        if (y !== gap) this.vWalls[bx][y] = true;
      }
    });
  }

  /** An inner rectangular room with a doorway centred on each side. */
  private boxWalls(): void {
    const x0 = Math.max(1, Math.round(this.cols * 0.25));
    const x1 = Math.min(this.cols - 1, Math.round(this.cols * 0.75));
    const y0 = Math.max(1, Math.round(this.rows * 0.25));
    const y1 = Math.min(this.rows - 1, Math.round(this.rows * 0.75));
    const mx = Math.floor((x0 + x1) / 2);
    const my = Math.floor((y0 + y1) / 2);
    for (let x = x0; x < x1; x++) {
      if (x !== mx) {
        this.hWalls[x][y0] = true;
        this.hWalls[x][y1] = true;
      }
    }
    for (let y = y0; y < y1; y++) {
      if (y !== my) {
        this.vWalls[x0][y] = true;
        this.vWalls[x1][y] = true;
      }
    }
  }

  /** A regular field of short pillar dashes (Snake-style obstacles). */
  private dotWalls(): void {
    for (let x = 1; x < this.cols - 1; x += 2) {
      for (let y = 1; y < this.rows - 1; y += 2) {
        this.hWalls[x][y] = true; // a one-cell horizontal dash
      }
    }
  }

  /** Remove every internal wall, leaving only the outer border. */
  private clearInternalWalls(): void {
    for (let x = 1; x < this.cols; x++) {
      for (let y = 0; y < this.rows; y++) this.vWalls[x][y] = false;
    }
    for (let x = 0; x < this.cols; x++) {
      for (let y = 1; y < this.rows; y++) this.hWalls[x][y] = false;
    }
  }

  /** Sprinkle a handful of internal walls as light cover. */
  private scatterWalls(): void {
    const p = 0.07;
    for (let x = 1; x < this.cols; x++) {
      for (let y = 0; y < this.rows; y++) {
        if (Math.random() < p) this.vWalls[x][y] = true;
      }
    }
    for (let x = 0; x < this.cols; x++) {
      for (let y = 1; y < this.rows; y++) {
        if (Math.random() < p) this.hWalls[x][y] = true;
      }
    }
  }

  /** Randomized DFS that removes walls between visited cells (perfect maze). */
  private carve(): void {
    const visited = makeGrid(this.cols, this.rows, false);
    const stack: Array<[number, number]> = [];
    const sx = Math.floor(Math.random() * this.cols);
    const sy = Math.floor(Math.random() * this.rows);
    visited[sx][sy] = true;
    stack.push([sx, sy]);

    while (stack.length > 0) {
      const [cx, cy] = stack[stack.length - 1];
      const neighbors: Array<[number, number]> = [];
      for (const [dx, dy] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < this.cols && ny >= 0 && ny < this.rows && !visited[nx][ny]) {
          neighbors.push([nx, ny]);
        }
      }
      if (neighbors.length === 0) {
        stack.pop();
        continue;
      }
      const [nx, ny] = neighbors[Math.floor(Math.random() * neighbors.length)];
      this.removeWallBetween(cx, cy, nx, ny);
      visited[nx][ny] = true;
      stack.push([nx, ny]);
    }
  }

  /**
   * Braid the perfect maze: every cell with a single opening (a dead end) gets
   * one extra opening. This adds loops and removes trap corridors while keeping
   * the perfect maze's dense, even wall coverage across the whole arena — so no
   * region is left empty. A small fraction of dead ends are left intact for
   * variety.
   */
  private braid(): void {
    for (let x = 0; x < this.cols; x++) {
      for (let y = 0; y < this.rows; y++) {
        if (this.cellOpenings(x, y) <= 1 && Math.random() > WALL_KEEP_DEADEND_RATIO) {
          const removable = this.internalWallsOf(x, y);
          if (removable.length > 0) {
            removable[Math.floor(Math.random() * removable.length)]();
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
  private ensureCoverage(): void {
    for (let x = 0; x < this.cols; x++) {
      for (let y = 0; y < this.rows; y++) {
        if (this.cellOpenings(x, y) < 4) continue;
        const candidates: Array<{ add: () => void; safe: boolean }> = [];
        if (x > 0)
          candidates.push({ add: () => (this.vWalls[x][y] = true), safe: this.cellOpenings(x - 1, y) >= 3 });
        if (x < this.cols - 1)
          candidates.push({ add: () => (this.vWalls[x + 1][y] = true), safe: this.cellOpenings(x + 1, y) >= 3 });
        if (y > 0)
          candidates.push({ add: () => (this.hWalls[x][y] = true), safe: this.cellOpenings(x, y - 1) >= 3 });
        if (y < this.rows - 1)
          candidates.push({ add: () => (this.hWalls[x][y + 1] = true), safe: this.cellOpenings(x, y + 1) >= 3 });
        const pick = candidates.find((c) => c.safe) ?? candidates[0];
        pick?.add();
      }
    }
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
    if (ax === bx && Math.abs(ay - by) === 1) {
      return !this.hWalls[ax][Math.max(ay, by)]; // shared horizontal edge
    }
    if (ay === by && Math.abs(ax - bx) === 1) {
      return !this.vWalls[Math.max(ax, bx)][ay]; // shared vertical edge
    }
    return false;
  }

  /** Number of open sides (0-4) a cell currently has. */
  private cellOpenings(x: number, y: number): number {
    let walls = 0;
    if (this.vWalls[x][y]) walls++;
    if (this.vWalls[x + 1][y]) walls++;
    if (this.hWalls[x][y]) walls++;
    if (this.hWalls[x][y + 1]) walls++;
    return 4 - walls;
  }

  /** Removers for each *internal* (non-border) wall currently around a cell. */
  private internalWallsOf(x: number, y: number): Array<() => void> {
    const ops: Array<() => void> = [];
    if (x > 0 && this.vWalls[x][y]) ops.push(() => (this.vWalls[x][y] = false));
    if (x < this.cols - 1 && this.vWalls[x + 1][y]) ops.push(() => (this.vWalls[x + 1][y] = false));
    if (y > 0 && this.hWalls[x][y]) ops.push(() => (this.hWalls[x][y] = false));
    if (y < this.rows - 1 && this.hWalls[x][y + 1]) ops.push(() => (this.hWalls[x][y + 1] = false));
    return ops;
  }

  private removeWallBetween(cx: number, cy: number, nx: number, ny: number): void {
    if (nx === cx + 1) this.vWalls[cx + 1][cy] = false;
    else if (nx === cx - 1) this.vWalls[cx][cy] = false;
    else if (ny === cy + 1) this.hWalls[cx][cy + 1] = false;
    else if (ny === cy - 1) this.hWalls[cx][cy] = false;
  }

  /** Collect standing walls into merged collinear line segments. */
  private buildSegments(): Segment[] {
    const segs: Segment[] = [];

    // Vertical walls: merge consecutive present cells down each column.
    for (let x = 0; x <= this.cols; x++) {
      let runStart = -1;
      for (let y = 0; y <= this.rows; y++) {
        const present = y < this.rows && this.vWalls[x][y];
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
        const present = x < this.cols && this.hWalls[x][y];
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

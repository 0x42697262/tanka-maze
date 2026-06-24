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
  readonly thickness = WALL_THICKNESS;
  readonly walls: Segment[];

  // vWalls[x][y]: vertical wall on the left edge of cell column x, row y.
  //   x in [0, cols] (0 and cols are the border), y in [0, rows).
  // hWalls[x][y]: horizontal wall on the top edge of cell x, row y.
  //   x in [0, cols), y in [0, rows] (0 and rows are the border).
  private vWalls: boolean[][];
  private hWalls: boolean[][];

  constructor(cols: number, rows: number, wallStyle: WallStyle = "maze") {
    this.cols = cols;
    this.rows = rows;
    this.width = cols * CELL;
    this.height = rows * CELL;

    // Grids start fully walled; the border edges are never removed.
    this.vWalls = makeGrid(cols + 1, rows, true);
    this.hWalls = makeGrid(cols, rows + 1, true);

    if (wallStyle === "open") {
      this.clearInternalWalls(); // bordered empty field (Nokia-snake style)
    } else if (wallStyle === "sparse") {
      this.clearInternalWalls();
      this.scatterWalls(); // a few scattered obstacles
    } else {
      this.carve();
      this.braid();
      this.ensureCoverage();
    }
    this.walls = this.buildSegments();
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
          segs.push({ x1: x * CELL, y1: runStart * CELL, x2: x * CELL, y2: y * CELL });
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
          segs.push({ x1: runStart * CELL, y1: y * CELL, x2: x * CELL, y2: y * CELL });
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
        out.push({ x: (x + 0.5) * CELL, y: (y + 0.5) * CELL });
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

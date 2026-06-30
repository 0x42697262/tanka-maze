import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WALL_STYLES } from "../src/shared/protocol.js";
import {
  Maze,
  mazeDimensions,
  ctfPathCount,
  ctfCenterRoom,
  powerupDespawnMultiplier,
} from "../src/server/maze.js";

/** Flood-fill the cell grid via `passable`; true if every cell is reachable. */
function fullyConnected(m: Maze): boolean {
  const seen = new Set([0]);
  const queue = [0];
  for (let h = 0; h < queue.length; h++) {
    const cur = queue[h];
    const cx = cur % m.cols;
    const cy = (cur - cx) / m.cols;
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= m.cols || ny >= m.rows) continue;
      if (!m.passable(cx, cy, nx, ny)) continue;
      const ni = ny * m.cols + nx;
      if (!seen.has(ni)) {
        seen.add(ni);
        queue.push(ni);
      }
    }
  }
  return seen.size === m.cols * m.rows;
}

const SIZES: Array<[number, number]> = [
  [10, 7],
  [6, 5],
  [14, 11],
  [20, 14],
];

/** Max edge-disjoint corner-to-corner routes, via unit-capacity max flow
 *  (Menger's theorem). Capped at `limit` augmenting paths. */
function cornerEdgeDisjointPaths(m: Maze, limit = 2): number {
  const N = m.cols * m.rows;
  const cap = new Map<number, number>();
  const add = (u: number, v: number) => cap.set(u * N + v, (cap.get(u * N + v) ?? 0) + 1);
  for (let y = 0; y < m.rows; y++) {
    for (let x = 0; x < m.cols; x++) {
      const u = y * m.cols + x;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= m.cols || ny >= m.rows || !m.passable(x, y, nx, ny)) continue;
        const v = ny * m.cols + nx;
        add(u, v);
        add(v, u);
      }
    }
  }
  const T = N - 1;
  let flow = 0;
  while (flow < limit) {
    const prev = new Int32Array(N).fill(-1);
    prev[0] = 0;
    const q = [0];
    for (let h = 0; h < q.length && prev[T] === -1; h++) {
      const u = q[h];
      const ux = u % m.cols;
      const uy = (u - ux) / m.cols;
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        const nx = ux + dx;
        const ny = uy + dy;
        if (nx < 0 || ny < 0 || nx >= m.cols || ny >= m.rows) continue;
        const v = ny * m.cols + nx;
        if (prev[v] !== -1 || (cap.get(u * N + v) ?? 0) <= 0) continue;
        prev[v] = u;
        q.push(v);
      }
    }
    if (prev[T] === -1) break;
    for (let v = T; v !== 0; v = prev[v]) {
      const u = prev[v];
      cap.set(u * N + v, (cap.get(u * N + v) as number) - 1);
      cap.set(v * N + u, (cap.get(v * N + u) ?? 0) + 1);
    }
    flow++;
  }
  return flow;
}

/** Cells of a side×side block anchored at top-left cell (cx0, cy0). */
function blockCells(m: Maze, cx0: number, cy0: number, side: number): number[] {
  const out: number[] = [];
  for (let dy = 0; dy < side; dy++)
    for (let dx = 0; dx < side; dx++) out.push((cy0 + dy) * m.cols + (cx0 + dx));
  return out;
}
/** Corner base block (0 TL, 1 BR, 2 TR, 3 BL), matching the spawn-zone order. */
function cornerCells(m: Maze, idx: number, side: number): number[] {
  const a: Record<number, [number, number]> = {
    0: [0, 0],
    1: [m.cols - side, m.rows - side],
    2: [m.cols - side, 0],
    3: [0, m.rows - side],
  };
  const [cx, cy] = a[idx % 4];
  return blockCells(m, cx, cy, side);
}
/** Centred side×side block. */
function centerCells(m: Maze, side: number): number[] {
  return blockCells(m, Math.floor((m.cols - side) / 2), Math.floor((m.rows - side) / 2), side);
}

/** Max edge-disjoint routes between two cell sets, via unit-capacity max flow. */
function routesBetween(m: Maze, sources: number[], sinks: number[], limit = 4): number {
  const N = m.cols * m.rows;
  const S = N;
  const T = N + 1;
  const V = N + 2;
  const cap = new Map<number, number>();
  const add = (u: number, v: number, c: number) => cap.set(u * V + v, (cap.get(u * V + v) ?? 0) + c);
  for (let y = 0; y < m.rows; y++) {
    for (let x = 0; x < m.cols; x++) {
      const u = y * m.cols + x;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= m.cols || ny >= m.rows || !m.passable(x, y, nx, ny)) continue;
        const v = ny * m.cols + nx;
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
    const ux = u % m.cols;
    const uy = (u - ux) / m.cols;
    const out: number[] = [];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = ux + dx;
      const ny = uy + dy;
      if (nx >= 0 && ny >= 0 && nx < m.cols && ny < m.rows) out.push(ny * m.cols + nx);
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

/**
 * Decompose the merged wall segments into unit lattice edges and the wall-degree
 * of each lattice vertex (border edges included). Used to reason about wall
 * connectivity and density independently of how segments were merged.
 */
function wallLattice(m: Maze): {
  edges: Array<[number, number]>;
  degree: Int32Array;
  vid: (vx: number, vy: number) => number;
} {
  const { cols, rows, cell } = m;
  const vid = (vx: number, vy: number) => vy * (cols + 1) + vx;
  const degree = new Int32Array((cols + 1) * (rows + 1));
  const edges: Array<[number, number]> = [];
  const addEdge = (a: number, b: number) => {
    edges.push([a, b]);
    degree[a]++;
    degree[b]++;
  };
  for (const w of m.walls) {
    const x1 = Math.round(w.x1 / cell);
    const y1 = Math.round(w.y1 / cell);
    const x2 = Math.round(w.x2 / cell);
    const y2 = Math.round(w.y2 / cell);
    if (x1 === x2) {
      for (let y = Math.min(y1, y2); y < Math.max(y1, y2); y++) addEdge(vid(x1, y), vid(x1, y + 1));
    } else {
      for (let x = Math.min(x1, x2); x < Math.max(x1, x2); x++) addEdge(vid(x, y1), vid(x + 1, y1));
    }
  }
  return { edges, degree, vid };
}

/** Count 2×2 blocks of cells with no walls between any of them (open rooms). */
function open2x2Count(m: Maze): number {
  let n = 0;
  for (let x = 0; x + 1 < m.cols; x++) {
    for (let y = 0; y + 1 < m.rows; y++) {
      if (
        m.passable(x, y, x + 1, y) &&
        m.passable(x, y, x, y + 1) &&
        m.passable(x + 1, y, x + 1, y + 1) &&
        m.passable(x, y + 1, x + 1, y + 1)
      ) {
        n++;
      }
    }
  }
  return n;
}

/** Cells with one or zero open sides — dead ends. */
function deadEndCount(m: Maze): number {
  let n = 0;
  for (let x = 0; x < m.cols; x++) {
    for (let y = 0; y < m.rows; y++) {
      let deg = 0;
      if (x > 0 && m.passable(x, y, x - 1, y)) deg++;
      if (x < m.cols - 1 && m.passable(x, y, x + 1, y)) deg++;
      if (y > 0 && m.passable(x, y, x, y - 1)) deg++;
      if (y < m.rows - 1 && m.passable(x, y, x, y + 1)) deg++;
      if (deg <= 1) n++;
    }
  }
  return n;
}

/** Internal (non-border) wall length in cell units — a density measure. */
function internalWallUnits(m: Maze): number {
  const { edges, vid } = wallLattice(m);
  const { cols, rows } = m;
  const border = new Set<number>();
  for (let x = 0; x <= cols; x++) {
    border.add(vid(x, 0));
    border.add(vid(x, rows));
  }
  for (let y = 0; y <= rows; y++) {
    border.add(vid(0, y));
    border.add(vid(cols, y));
  }
  let units = 0;
  for (const [a, b] of edges) if (!border.has(a) || !border.has(b)) units++;
  return units;
}

describe("maze: CTF true maze", () => {
  it("scales base-to-base routes with map area (small/normal/large)", () => {
    assert.equal(ctfPathCount(7, 5), 2); // ~small (min 2)
    assert.equal(ctfPathCount(10, 7), 2); // normal
    assert.equal(ctfPathCount(14, 10), 3); // ~large
  });

  it("is connected, spawn-safe, and never leaves a 2x2 open area", () => {
    for (const [cols, rows] of SIZES) {
      for (const paths of [1, 2, 3]) {
        const m = new Maze(cols, rows, "maze", undefined, undefined, paths, true);
        assert.ok(fullyConnected(m), `${cols}x${rows} p${paths}: not connected`);
        assert.equal(open2x2Count(m), 0, `${cols}x${rows} p${paths}: has a 2x2 open area`);
        for (const c of m.openCellCenters()) {
          assert.ok(!m.hitsCircle(c.x, c.y, 11), `${cols}x${rows} p${paths}: spawn clips a wall`);
        }
      }
    }
  });

  it("braids most dead ends away (a flowing maze, not a thicket of stubs)", () => {
    // Braiding opens the bulk of dead ends; only a few remain (kept for character
    // or because opening them would make a 2x2). The un-braided true maze leaves
    // roughly 10% of cells as dead ends, so well under 6% confirms braiding ran.
    for (const [cols, rows] of [[14, 11], [20, 14]] as const) {
      const paths = ctfPathCount(cols, rows);
      let total = 0;
      const N = 6;
      for (let k = 0; k < N; k++) {
        total += deadEndCount(new Maze(cols, rows, "maze", undefined, undefined, paths, true));
      }
      assert.ok(total / N < cols * rows * 0.06, `${cols}x${rows}: ${total / N} dead ends still`);
    }
  });

  it("stays a dense maze after carving extra routes (not an open field)", () => {
    // A perfect maze holds (cols-1)(rows-1) internal wall units; carving the few
    // extra routes a map's area calls for removes only a handful, so the bulk of
    // the maze must remain (the old prune bug gutted it down toward an open
    // field). Path counts mirror ctfPathCount so combos are realistic.
    for (const [cols, rows] of [[10, 7], [14, 11], [20, 14], [14, 10]] as const) {
      const paths = ctfPathCount(cols, rows);
      const full = (cols - 1) * (rows - 1);
      // Sample a few times so a single lucky carve can't mask a regression.
      let min = Infinity;
      for (let k = 0; k < 8; k++) {
        const m = new Maze(cols, rows, "maze", undefined, undefined, paths, true);
        min = Math.min(min, internalWallUnits(m));
      }
      assert.ok(
        min >= full * 0.5,
        `${cols}x${rows} p${paths}: as few as ${min}/${full} wall units left`
      );
    }
  });

  it("wires every base to the boxed centre and stays connected (2 and 4 teams)", () => {
    for (const [cols, rows, paths, teams] of [[14, 11, 2, 2], [20, 14, 3, 4]] as const) {
      const m = new Maze(cols, rows, "maze", undefined, undefined, paths, true, 2, teams, 3);
      const ctr = centerCells(m, 3);
      for (let i = 0; i < teams; i++) {
        assert.ok(routesBetween(m, cornerCells(m, i, 2), ctr) >= 1, `base ${i} can't reach centre`);
      }
      assert.ok(fullyConnected(m), `${cols}x${rows}: not connected`);
    }
  });

  it("stays connected for a small 4-team map (1x1 centre)", () => {
    for (let k = 0; k < 10; k++) {
      const m = new Maze(9, 7, "maze", undefined, undefined, 2, true, 2, 4, 1);
      assert.ok(fullyConnected(m), "small 4-team maze not connected");
    }
  });

  it("breaks straight border corridors between adjacent corner bases (4 teams)", () => {
    for (let k = 0; k < 15; k++) {
      const m = new Maze(13, 9, "maze", undefined, undefined, 2, true, 2, 4, 3);
      const rowOpen = (y: number) => {
        for (let x = 0; x + 1 < m.cols; x++) if (!m.passable(x, y, x + 1, y)) return false;
        return true;
      };
      const colOpen = (x: number) => {
        for (let y = 0; y + 1 < m.rows; y++) if (!m.passable(x, y, x, y + 1)) return false;
        return true;
      };
      assert.ok(!rowOpen(0), "top border is a straight corridor");
      assert.ok(!rowOpen(m.rows - 1), "bottom border is a straight corridor");
      assert.ok(!colOpen(0), "left border is a straight corridor");
      assert.ok(!colOpen(m.cols - 1), "right border is a straight corridor");
      assert.ok(fullyConnected(m), "not connected");
    }
  });
});

describe("maze: power-up despawn scaling", () => {
  it("powerupDespawnMultiplier scales: 1x small, 2x normal, 3x large", () => {
    assert.equal(powerupDespawnMultiplier(7, 5), 1); // small
    assert.equal(powerupDespawnMultiplier(10, 7), 2); // normal
    assert.equal(powerupDespawnMultiplier(14, 10), 3); // large
  });
});

describe("maze: CTF centre room", () => {
  it("ctfCenterRoom scales: 1 small, 3 normal, 3 large", () => {
    assert.equal(ctfCenterRoom(7, 5), 1); // small
    assert.equal(ctfCenterRoom(10, 7), 3); // normal
    assert.equal(ctfCenterRoom(14, 10), 3); // large
  });

  it("boxes the centre into an open room with a doorway on each side", () => {
    for (const [cols, rows] of [[13, 9], [18, 13]] as const) {
      const m = new Maze(cols, rows, "maze", undefined, undefined, 2, true, 2, 4, 3);
      const cs = Math.min(3, cols - 2, rows - 2);
      const cx0 = Math.floor((cols - cs) / 2);
      const cy0 = Math.floor((rows - cs) / 2);
      const cx1 = cx0 + cs;
      const cy1 = cy0 + cs;
      // Interior fully open.
      for (let x = cx0; x < cx1; x++) {
        for (let y = cy0; y < cy1; y++) {
          if (x + 1 < cx1) assert.ok(m.passable(x, y, x + 1, y), "interior wall");
          if (y + 1 < cy1) assert.ok(m.passable(x, y, x, y + 1), "interior wall");
        }
      }
      // Perimeter mostly walled with just a few doorways (boxed, not wide open).
      let walls = 0;
      let holes = 0;
      for (let y = cy0; y < cy1; y++) for (const px of [cx0, cx1]) (m.passable(px - 1, y, px, y) ? holes++ : walls++);
      for (let x = cx0; x < cx1; x++) for (const py of [cy0, cy1]) (m.passable(x, py - 1, x, py) ? holes++ : walls++);
      assert.ok(walls >= 6, `${cols}x${rows}: centre not boxed (${walls}/12 perimeter walls)`);
      assert.ok(holes >= 2 && holes <= 6, `${cols}x${rows}: centre holes out of range (${holes})`);
      assert.ok(fullyConnected(m), `${cols}x${rows}: not connected`);
    }
  });
});

describe("maze: corner paths (CTF)", () => {
  it("guarantees two edge-disjoint corner routes when asked (every wall style)", () => {
    for (const style of WALL_STYLES) {
      for (const [cols, rows] of [[10, 7], [14, 11], [20, 14]] as const) {
        const m = new Maze(cols, rows, style, undefined, undefined, 2);
        assert.ok(
          cornerEdgeDisjointPaths(m, 2) >= 2,
          `${style} ${cols}x${rows}: fewer than 2 corner routes`
        );
        assert.ok(fullyConnected(m), `${style} ${cols}x${rows}: not connected`);
      }
    }
  });

  it("default (1 path) leaves the layout untouched but still connected", () => {
    const m = new Maze(14, 11, "maze");
    assert.ok(fullyConnected(m));
  });

  it("keeps spawn cells wall-clear after carving the second route", () => {
    const m = new Maze(14, 11, "maze", undefined, undefined, 2);
    for (const c of m.openCellCenters()) {
      assert.ok(!m.hitsCircle(c.x, c.y, 11), "carved maze spawn clips a wall");
    }
  });
});

describe("maze: dimensions", () => {
  it("scales area by map size, preserving a sane minimum", () => {
    const small = mazeDimensions("small");
    const large = mazeDimensions("large");
    assert.ok(small.cols >= 4 && small.rows >= 3);
    assert.ok(large.cols > small.cols);
  });
});

describe("maze: every wall style", () => {
  for (const style of WALL_STYLES) {
    it(`${style} is fully connected + spawn-safe at all sizes`, () => {
      for (const [cols, rows] of SIZES) {
        const m = new Maze(cols, rows, style);
        assert.ok(fullyConnected(m), `${style} ${cols}x${rows} not connected`);
        for (const c of m.openCellCenters()) {
          assert.ok(!m.hitsCircle(c.x, c.y, 11), `${style} spawn clips a wall`);
        }
      }
    });
  }

  it("open style has only the 4 border walls", () => {
    assert.equal(new Maze(10, 7, "open").walls.length, 4);
  });

  it("fixed layouts (cross/box/dots) add internal walls", () => {
    for (const style of ["cross", "box", "dots"] as const) {
      assert.ok(new Maze(10, 7, style).walls.length > 4, `${style} has no internal walls`);
    }
  });
});

describe("maze: passable", () => {
  it("an open arena lets adjacent cells through, border blocks the edge", () => {
    const m = new Maze(8, 6, "open");
    assert.equal(m.passable(2, 2, 3, 2), true); // interior neighbours
    assert.equal(m.passable(0, 0, 0, 1), true);
    // Non-adjacent / diagonal is never passable.
    assert.equal(m.passable(0, 0, 2, 0), false);
    assert.equal(m.passable(0, 0, 1, 1), false);
  });
});

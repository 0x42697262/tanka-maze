import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WALL_STYLES } from "../src/shared/protocol.js";
import { Maze, mazeDimensions, ctfPathCount, ctfCenterRoom } from "../src/server/maze.js";

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

/**
 * Max edge-disjoint routes between the two diagonal corner *blocks* (mirroring
 * the maze's super-source/sink routing), via unit-capacity max flow. The blocks
 * are baseSize×baseSize cells anchored in the top-left and bottom-right corners.
 */
function blockEdgeDisjointPaths(m: Maze, limit = 4): number {
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
  const side = m.baseSize;
  for (let dy = 0; dy < side; dy++) {
    for (let dx = 0; dx < side; dx++) {
      add(S, dy * m.cols + dx, limit);
      add((m.rows - 1 - dy) * m.cols + (m.cols - 1 - dx), T, limit);
    }
  }
  const neighbors = (u: number): number[] => {
    if (u === S || u === T) {
      const out: number[] = [];
      for (let dy = 0; dy < side; dy++)
        for (let dx = 0; dx < side; dx++)
          out.push(u === S ? dy * m.cols + dx : (m.rows - 1 - dy) * m.cols + (m.cols - 1 - dx));
      return out;
    }
    const ux = u % m.cols;
    const uy = (u - ux) / m.cols;
    const out: number[] = [];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = ux + dx;
      const ny = uy + dy;
      if (nx >= 0 && ny >= 0 && nx < m.cols && ny < m.rows) out.push(ny * m.cols + nx);
    }
    out.push(S, T);
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

  it("delivers the requested base routes from corner blocks (2x2 stays in corner)", () => {
    const m2 = new Maze(14, 11, "maze", undefined, undefined, 2, true, 2);
    assert.equal(m2.baseSize, 2);
    assert.ok(blockEdgeDisjointPaths(m2) >= 2, "fewer than 2 base routes");

    // A 2x2 corner block has four exits, so three routes fit without insetting.
    const m3 = new Maze(20, 14, "maze", undefined, undefined, 3, true, 2);
    assert.equal(m3.baseSize, 2);
    assert.ok(blockEdgeDisjointPaths(m3) >= 3, "fewer than 3 base routes");
  });
});

describe("maze: CTF centre room + corner barriers", () => {
  it("ctfCenterRoom scales: 2 small, 2 normal, 3 large", () => {
    assert.equal(ctfCenterRoom(7, 5), 2); // small
    assert.equal(ctfCenterRoom(10, 7), 2); // normal
    assert.equal(ctfCenterRoom(14, 10), 3); // large
  });

  it("clearCenter opens a side×side room and stays connected", () => {
    for (const [cols, rows, s] of [[13, 9, 2], [18, 13, 3]] as const) {
      const m = new Maze(cols, rows, "maze", undefined, undefined, 2, true, 2);
      m.clearCenter(s);
      const cx0 = Math.floor((cols - s) / 2);
      const cy0 = Math.floor((rows - s) / 2);
      for (let x = cx0; x < cx0 + s; x++) {
        for (let y = cy0; y < cy0 + s; y++) {
          if (x + 1 < cx0 + s) assert.ok(m.passable(x, y, x + 1, y), "centre wall present");
          if (y + 1 < cy0 + s) assert.ok(m.passable(x, y, x, y + 1), "centre wall present");
        }
      }
      assert.ok(fullyConnected(m), `${cols}x${rows}: not connected after centre room`);
    }
  });

  it("addCornerBarriers blocks straight edge runs while staying connected", () => {
    for (let k = 0; k < 25; k++) {
      const m = new Maze(13, 9, "maze", undefined, undefined, 2, true, 2);
      m.addCornerBarriers(2);
      assert.ok(fullyConnected(m), "not connected after barriers");
      // No straight run hugging the top edge (row 0) or the left edge (col 0).
      let topOpen = true;
      for (let x = 0; x + 1 < m.cols; x++) if (!m.passable(x, 0, x + 1, 0)) topOpen = false;
      assert.ok(!topOpen, "top edge fully open between bases");
      let leftOpen = true;
      for (let y = 0; y + 1 < m.rows; y++) if (!m.passable(0, y, 0, y + 1)) leftOpen = false;
      assert.ok(!leftOpen, "left edge fully open between bases");
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

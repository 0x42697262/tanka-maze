import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WALL_STYLES } from "../src/shared/protocol.js";
import { Maze, mazeDimensions } from "../src/server/maze.js";

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

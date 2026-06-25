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

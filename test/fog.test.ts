import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CELL, MAZE_COLS, MAZE_ROWS, VISION_RADIUS } from "../src/shared/constants.js";
import { buildFogShape, effectiveVisionRadius, pointInFogShape, type FogWall } from "../src/shared/fog.js";
import { DEFAULT_GAME_CONFIG } from "../src/shared/protocol.js";

describe("fog of war", () => {
  it("defaults to the shared radius with team-owned objective vision", () => {
    assert.equal(DEFAULT_GAME_CONFIG.visionRadius, VISION_RADIUS);
    assert.equal(DEFAULT_GAME_CONFIG.fogBaseVision, "team");
    assert.equal(DEFAULT_GAME_CONFIG.fogFlagVision, "team");
    assert.equal(DEFAULT_GAME_CONFIG.fogHideCarriedFlag, false);
  });

  it("keeps the configured radius on a normal map", () => {
    const w = MAZE_COLS * CELL;
    const h = MAZE_ROWS * CELL;
    assert.equal(effectiveVisionRadius(100, w, h), 100);
  });

  it("scales vision by map area", () => {
    const w = MAZE_COLS * CELL;
    const h = MAZE_ROWS * CELL;
    assert.equal(effectiveVisionRadius(100, w * 2, h * 2), 200);
    assert.equal(effectiveVisionRadius(100, w / 2, h / 2), 50);
  });

  it("uses an exact full-map rectangle when x-ray vision covers every corner", () => {
    const arena = { x: 0, y: 0, width: 100, height: 80 };
    const shape = buildFogShape({ x: 12, y: 20, radius: 200, seesThroughWalls: true, arena, walls: [] });
    assert.equal(shape.kind, "rect");
    for (const [x, y] of [[0, 0], [100, 0], [100, 80], [0, 80]] as const) {
      assert.equal(pointInFogShape(x, y, shape), true);
    }
  });

  it("uses a true circle for radius-limited x-ray vision", () => {
    const arena = { x: 0, y: 0, width: 100, height: 80 };
    const shape = buildFogShape({ x: 50, y: 40, radius: 20, seesThroughWalls: true, arena, walls: [] });
    assert.equal(shape.kind, "circle");
    assert.equal(pointInFogShape(70, 40, shape), true);
    assert.equal(pointInFogShape(71, 40, shape), false);
  });

  it("blocks vision behind walls while keeping unobstructed corners visible", () => {
    const arena = { x: 0, y: 0, width: 100, height: 100 };
    const walls: FogWall[] = [{ x1: 50, y1: 0, x2: 50, y2: 80 }];
    const shape = buildFogShape({ x: 25, y: 50, radius: 200, seesThroughWalls: false, arena, walls });
    assert.equal(shape.kind, "polygon");
    assert.equal(pointInFogShape(75, 50, shape), false);
    assert.equal(pointInFogShape(0, 0, shape), true);
    assert.equal(pointInFogShape(25, 90, shape), true);
  });

  it("treats merged wall junctions as visibility corners", () => {
    const arena = { x: 0, y: 0, width: 880, height: 616 };
    const walls: FogWall[] = [
      { x1: 352, y1: 88, x2: 352, y2: 352 },
      { x1: 264, y1: 176, x2: 528, y2: 176 },
    ];
    const shape = buildFogShape({ x: 341.72, y: 341.16, radius: 1300, seesThroughWalls: false, arena, walls });
    assert.equal(pointInFogShape(350.34, 229.89, shape), true);
    assert.equal(pointInFogShape(360, 229.89, shape), false);
  });

  it("does not let destroyed walls block fog when omitted from the active wall list", () => {
    const arena = { x: 0, y: 0, width: 100, height: 100 };
    const blocked = buildFogShape({
      x: 25,
      y: 50,
      radius: 200,
      seesThroughWalls: false,
      arena,
      walls: [{ x1: 50, y1: 0, x2: 50, y2: 80 }],
    });
    const unblocked = buildFogShape({ x: 25, y: 50, radius: 200, seesThroughWalls: false, arena, walls: [] });
    assert.equal(pointInFogShape(75, 50, blocked), false);
    assert.equal(pointInFogShape(75, 50, unblocked), true);
  });
});

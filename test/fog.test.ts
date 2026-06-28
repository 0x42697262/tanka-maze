import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CELL, FLASHLIGHT_DEGREES, MAZE_COLS, MAZE_ROWS, VISION_RADIUS } from "../src/shared/constants.js";
import { effectiveVisionRadius } from "../src/shared/fog.js";
import { DEFAULT_GAME_CONFIG } from "../src/shared/protocol.js";

describe("fog of war", () => {
  it("defaults to the shared full-area vision radius", () => {
    assert.equal(DEFAULT_GAME_CONFIG.visionRadius, VISION_RADIUS);
    assert.equal(DEFAULT_GAME_CONFIG.fogType, "full");
    assert.equal(DEFAULT_GAME_CONFIG.flashlightDegrees, FLASHLIGHT_DEGREES);
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
});

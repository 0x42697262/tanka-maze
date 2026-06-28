import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_ADVANCED,
  POWERUP_DEFS,
  POWERUP_TYPES,
  powerupDef,
  WEAPON_POWERUPS,
} from "../src/shared/protocol.js";

// AdvancedConfig fields that have hand-written (non-power-up) editor inputs.
const STATIC_ADV_KEYS = [
  "tankRadius",
  "tankTurnSpeed",
  "tankAccel",
  "tankDecel",
  "fireCooldown",
  "maxAmmo",
  "reloadSeconds",
  "bulletSpeed",
  "bulletRadius",
  "bulletBounces",
  "bulletLifetime",
  "cellSize",
  "wallThickness",
  "wallHp",
];

describe("power-up registry", () => {
  it("derives POWERUP_TYPES in registry order", () => {
    assert.deepEqual(POWERUP_TYPES, POWERUP_DEFS.map((d) => d.id));
  });

  it("WEAPON_POWERUPS = weapon-kind defs only, in order", () => {
    assert.deepEqual(
      WEAPON_POWERUPS,
      POWERUP_DEFS.filter((d) => d.kind === "weapon").map((d) => d.id)
    );
  });

  it("powerupDef looks up by id", () => {
    assert.equal(powerupDef("scope").kind, "buff");
    assert.equal(powerupDef("scope").emblem, "ⓘ");
    assert.equal(powerupDef("multishot").kind, "weapon");
  });

  it("every config field maps to a real AdvancedConfig key", () => {
    const advKeys = new Set(Object.keys(DEFAULT_ADVANCED));
    for (const def of POWERUP_DEFS) {
      for (const f of def.config) {
        assert.ok(advKeys.has(f.key), `${def.id}.${String(f.key)} missing from AdvancedConfig`);
        assert.ok(f.min <= f.max, `${def.id}.${String(f.key)} bad range`);
      }
    }
  });

  it("no duplicate config keys across the registry", () => {
    const keys = POWERUP_DEFS.flatMap((d) => d.config.map((f) => f.key));
    assert.equal(keys.length, new Set(keys).size);
  });

  it("INVARIANT: every AdvancedConfig field has an editor input (static or registry)", () => {
    // Guards the gatherAdvanced() crash where a field has no `adv-<key>` input.
    const covered = new Set<string>([
      ...STATIC_ADV_KEYS,
      ...POWERUP_DEFS.flatMap((d) => d.config.map((f) => String(f.key))),
    ]);
    const missing = Object.keys(DEFAULT_ADVANCED).filter((k) => !covered.has(k));
    assert.deepEqual(missing, [], `uncovered adv fields: ${missing.join(", ")}`);
  });
});

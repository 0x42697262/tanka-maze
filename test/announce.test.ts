import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { KillEvent } from "../src/shared/protocol.js";
import {
  evaluateKill,
  resetStreaks,
  MULTIKILL_WINDOW,
  TEAMKILL_WINDOW,
} from "../src/client/announce.js";

const kill = (killer: number, victim = 9): KillEvent => ({ type: 0, killer, victim, points: 0 });
const suicide = (victim: number): KillEvent => ({ type: 1, killer: 255, victim, points: 0 });
const teamKill = (killer: number, victim = 9): KillEvent => ({ type: 2, killer, victim, points: 0 });
const label = (a: { label: string } | null) => a?.label ?? null;

describe("announce: kill-streak logic", () => {
  beforeEach(() => resetStreaks());

  it("ignores suicides", () => {
    assert.equal(evaluateKill(suicide(0), 1000), null);
  });

  it("the first enemy kill of the match is First Blood", () => {
    assert.equal(label(evaluateKill(kill(0), 0)), "FIRST BLOOD");
  });

  it("chains multikills within the window, escalating the tier", () => {
    evaluateKill(kill(0), 0); // First Blood (also streak 1)
    assert.equal(label(evaluateKill(kill(0), 1000)), "DOUBLE KILL");
    assert.equal(label(evaluateKill(kill(0), 2000)), "TRIPLE KILL");
    assert.equal(label(evaluateKill(kill(0), 3000)), "MANIAC");
    assert.equal(label(evaluateKill(kill(0), 4000)), "SAVAGE");
    assert.equal(label(evaluateKill(kill(0), 5000)), "SAVAGE"); // stays Savage at 6+
  });

  it("a kill after the window breaks the chain (single kill = no announcement)", () => {
    evaluateKill(kill(0), 0); // First Blood
    evaluateKill(kill(0), 1000); // Double
    const a = evaluateKill(kill(0), 1000 + MULTIKILL_WINDOW + 1); // gap too long
    assert.equal(a, null); // streak reset to 1 → nothing
  });

  it("tracks each killer's streak independently", () => {
    assert.equal(label(evaluateKill(kill(0), 0)), "FIRST BLOOD");
    // A different killer's first kill isn't a multikill (and First Blood is spent).
    assert.equal(evaluateKill(kill(1), 500), null);
    assert.equal(label(evaluateKill(kill(1), 1500)), "DOUBLE KILL");
  });

  it("team kills flash DENIED, throttled to once per (2×) window", () => {
    assert.equal(label(evaluateKill(teamKill(0), 0)), "DENIED");
    assert.equal(evaluateKill(teamKill(0), 1000), null); // within 2× window → suppressed
    assert.equal(label(evaluateKill(teamKill(0), TEAMKILL_WINDOW)), "DENIED"); // window elapsed
  });

  it("uses a 2× longer window for team kills than enemy multikills", () => {
    assert.equal(TEAMKILL_WINDOW, MULTIKILL_WINDOW * 2);
  });
});

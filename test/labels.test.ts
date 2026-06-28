import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_GAME_CONFIG, type LobbyDTO } from "../src/shared/protocol.js";
import {
  buildConfigDetailsHtml,
  configSummary,
  modeLabel,
  standingHtml,
} from "../src/client/labels.js";

function lobby(over: Partial<LobbyDTO> = {}): LobbyDTO {
  return {
    id: "L",
    name: "Test",
    hostId: "a",
    maxPlayers: 8,
    inGame: false,
    config: structuredClone(DEFAULT_GAME_CONFIG),
    players: [],
    teamNames: [],
    teamColors: [],
    ...over,
  };
}

describe("labels", () => {
  it("modeLabel maps each mode", () => {
    assert.equal(modeLabel("ffa"), "Free-for-all");
    assert.equal(modeLabel("lms"), "Last Man Standing");
    assert.equal(modeLabel("teams"), "Team VS");
  });

  it("configSummary reflects mode, rounds, and power-ups", () => {
    const c = structuredClone(DEFAULT_GAME_CONFIG);
    c.rounds = 3;
    c.powerups = true;
    const s = configSummary(c);
    assert.match(s, /Free-for-all/);
    assert.match(s, /first to 3 rounds/);
    assert.match(s, /power-ups/);
  });

  it("standingHtml escapes names and shows win pips", () => {
    const html = standingHtml([{ key: "a", name: "<b>x</b>", color: "#fff", wins: 2 }]);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(html, /●●/);
  });
});

describe("buildConfigDetailsHtml", () => {
  it("includes mode/match rows and is generated from the power-up registry", () => {
    const html = buildConfigDetailsHtml(lobby());
    assert.match(html, /Mode/);
    assert.match(html, /Free-for-all/);
    assert.match(html, /Max players/);
    // Registry-driven rows: a new power-up's tuning shows up automatically.
    assert.match(html, /Pellets/); // multishot
    assert.match(html, /Scope s/); // scope
  });

  it("shows friendly fire in every mode, team-only rows only in Team VS", () => {
    const ffa = buildConfigDetailsHtml(lobby());
    // Friendly fire governs self-damage in all modes, so it's always shown.
    assert.match(ffa, /Friendly fire/);
    assert.doesNotMatch(ffa, /Team-kill penalty/);
    const teamCfg = structuredClone(DEFAULT_GAME_CONFIG);
    teamCfg.mode = "teams";
    const teams = buildConfigDetailsHtml(lobby({ config: teamCfg }));
    assert.match(teams, /Friendly fire/);
    assert.match(teams, /Team-kill penalty/);
  });
});

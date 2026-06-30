# AGENTS.md

Reference for AI coding agents working on **tanka-maze**. Read this before editing
the codebase. The README is user-facing; this file is the engineering reference.

> If anything here conflicts with the code, the code wins. Fix the code and
> update this file in the same change.

---

## 1. Project overview

Real-time multiplayer tank battle. TypeScript + WebSockets. A 30 Hz
server-authoritative fixed-timestep simulation owns all movement, bullet
physics, collisions, and scoring. Clients send `input` intents and render
~140 ms in the past from binary snapshots broadcast at 15 Hz. **Nothing is
persisted** — the server exists only for lobby management and live session
syncing. No database, no files, no accounts. Reconnect within a 45 s grace
window rebinds a socket to the same session.

Three tiers: `src/shared/` (wire protocol + tuning, used by both sides),
`src/server/` (Node WebSocket hub + authoritative sim), `src/client/` (Vite +
canvas browser client, no framework).

---

## 2. Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Server (`tsx watch`, :8080) + Vite client (:5173) concurrently. |
| `npm run build` | `vite build` (client → `dist/client`) then `tsc -p tsconfig.server.json` (server → `dist/`). |
| `npm start` | `node dist/server/index.js` — serves client + WebSocket on one port (default :8080, `PORT=` to change). |
| `npm run typecheck` | `tsc --noEmit && tsc -p tsconfig.server.json --noEmit`. **Runs both tsconfigs.** |
| `npm test` | `node --import tsx --test test/*.test.ts` — Node built-in runner. |
| `npm run test:watch` | Same, watch mode. |

**Gotcha:** `test/*.test.ts` is in **neither** tsconfig `include`, so
`npm run typecheck` does **not** type-check tests. Run `npm test` to validate
test files. Tests are transpiled only by `tsx` at run time.

**Before you finish any task:** run `npm run typecheck` and `npm test`. Both
must pass. No linter/formatter is configured — `typecheck` + `test` are the
gate.

---

## 3. Code layout

```
src/shared/       wire protocol + tuning (used by both sides; no DOM, no Node APIs)
  constants.ts        all tuning constants (TICK_RATE, TANK_RADIUS, ...) — leaf module
  protocol.ts         DTOs, GameConfig, ClientMessage/ServerMessage unions, POWERUP_DEFS
  wire.ts             binary codec for the 2 high-frequency frames (input, snapshot)
src/server/       Node WebSocket server (authoritative)
  index.ts            HTTP + WS hub, session/reconnect, sanitize* validators, static serve
  lobby.ts            Lobby class + Client interface; owns the setInterval game loop
  game.ts             Game class — the simulation (tanks, bullets, powerups, flags, scoring)
  maze.ts             maze generation pipeline (Command pattern) + collision geometry
src/client/       Vite + canvas browser client (no framework)
  index.html          DOM scaffold: 3 screens + overlays; boot loads ./main.ts
  main.ts             entry: wires net handlers, rAF loop, DOM events
  net.ts              WebSocket wrapper w/ auto-reconnect (1500 ms, infinite)
  state.ts            shared singletons (net, canvas, renderer) + mutable AppState
  input.ts            keyboard + mouse + touch joystick → InputState
  render.ts           canvas renderer + ~140 ms interpolation buffer + effects
  lifecycle.ts        start/end game, pause, round banner, fitCanvas, screen transitions
  lobby.ts            menu lobby list + waiting room UI
  settings.ts         host config editor (gather/apply config, wall/move pickers)
  scoreboard.ts       Tab scoreboard overlay
  hud.ts              HUD strip (health/ammo/radar), kill log, leaderboard, match info, respawn overlay
  labels.ts           pure presentation: modeLabel, configSummary, configDetailsHtml
  announce.ts         queued kill-streak banners + announcer SFX
  audio.ts            Web Audio API engine: preloader, playSfx, BGM loop, vroom loop, global volumes
  dom.ts              $() helper, show(screen), toast, escapeHtml
  vite-env.d.ts       VITE_WS_URL env typing
  style.css           paper-&-ink theme; Outfit + Inter Google Fonts
test/             node:test files (NOT in any tsconfig include)
  game.test.ts        Game simulation (largest; reaches into privates via `as any`)
  maze.test.ts        maze connectivity / CTF paths / wall styles (graph-theoretic)
  wire.test.ts        binary codec round-trips (registry-driven)
  protocol.test.ts    POWERUP_DEFS invariants — guards the "every field has an editor" rule
  lobby.test.ts       team roster ordering / rebalancing
  labels.test.ts      presentation helpers (HTML string output)
```

---

## 4. Architecture (the netcode model)

### Server-authoritative, lobby-owned loop
The `Lobby` class (`src/server/lobby.ts`) owns the `setInterval` at `TICK_MS`
(~33 ms). The `Game` class is a **pure simulation** stepped by the lobby — it
has no loop of its own. Each tick:

1. `dt = Math.min(0.1, (now - lastStep) / 1000)` — wall-clock, capped at 0.1 s
   to avoid huge jumps after a stall. This is a fixed-target-but-variable-dt
   loop, not strictly fixed dt.
2. `game.step(dt)` — advances physics.
3. Check `game.isFinished` / `game.isRoundOver`; broadcast `gameOver` /
   `roundOver` (JSON) if so. Between rounds the world **keeps animating**
   (bullets fly, blasts settle) but players are locked out of control — the
   `roundOver` banner is non-blocking.
4. Broadcast a snapshot every `SNAPSHOT_EVERY_TICKS` (2) ticks → **15 Hz**, OR
   immediately if `game.hasEffects()` (blast/beam/event this tick) so transient
   effects are never dropped on a skipped network tick.

### Snapshot change-gating
`Lobby.broadcastSnapshot` encodes the snapshot and **skips sending if
byte-equal to last frame** (`bytesEqual`), caching the bytes. The `force` flag
bypasses this (used on game start / round start). Idle worlds cost no bandwidth.

### Binary frame discrimination
Text frames = JSON (`ClientMessage` / `ServerMessage` via `encode`/`decode`).
Binary frames = tagged bytes from `wire.ts`:

- `MSG_INPUT = 1` — 4 bytes: tag + 1 flag byte (forward/backward/turnLeft/
  turnRight/fire/eightDir/joystick) + int16 LE aim angle (quantized to
  ±32767/π, wrapped to [-π,π]).
- `MSG_SNAPSHOT = 2` — packed tanks (20 B each), bullets (8 B), powerups (5 B),
  flags (7 B), blasts (4 B), beams (8 B), events (7 B).

All multi-byte ints are **little-endian**. All counts are **uint8** → max 255
of each entity per snapshot. Coordinates quantized to u16; angles wrapped to
[-π,π] then int16 (without wrapping, accumulated bodyAngles saturate int16 and
the body freezes on the client). Timers sent as **deciseconds** (×10, u8) →
max 25.5 s on the wire. **The snapshot timestamp `t` is NOT packed** —
`decodeSnapshot` returns `t: 0`; the client uses its own clock for
interpolation timing.

`decodeSnapshot` **requires the roster** (from `gameStart`/`roster` messages)
to rejoin static info (name/color/team/maxHp/maxAmmo) and resolve owner
indices back to ids. Bullets/flags send the tank's wire **index** (255 =
unknown/none), not the string id.

### Client interpolation (~140 ms)
`Renderer` (`src/client/render.ts`) buffers snapshots with `recvAt =
performance.now()` (cap 30). `INTERP_DELAY = 140` ms — must exceed the ~66 ms
snapshot send interval with margin; **don't lower below ~100 ms** or the
client will run out of snapshots to lerp between. `interpolated(now)` finds
the two snapshots straddling `now - INTERP_DELAY` and lerps
x/y/bodyAngle/turretAngle (angles via shortest-arc `angleLerp`).

**Effects are deferred to the interpolation clock** — the core subtle
invariant. `consumeEffects(target = now - INTERP_DELAY, now)` iterates buffered
snapshots whose `recvAt` is between `consumedUntil` and `target`, spawning
explosions/beams and queueing kill events exactly when the delayed bullet
visually reaches the tank — not when the snapshot arrived. `takeEvents()`
drains queued kill-log/announcement events for the main loop. The interpolated
snapshot returned by `displayed()` has **empty**
powerups/blasts/beams/events — powerups come from `latest()`, effects from the
deferred queues. **Don't read effects off `displayed()`.**

No client-side prediction of the local tank — the server is authoritative.
The only prediction is the cosmetic line-of-sight aiming guide (`drawScope` /
`walkPath`), computed purely client-side from the maze + bullet-physics params.

### Input
Sampled every rAF frame but **sent at most ~30 Hz** (`now - lastInputSent >
1000/30`) AND only on byte-change (`bytesEqual`). The server keeps applying
the last input, so idle players send nothing. `state.lastInputBytes = null` is
forced on game start so the first frame always sends. **Aim uses
`renderer.latest()`** (responsive, non-interpolated tank position); **the
death overlay uses `renderer.displayed()`** (the delayed on-screen tank) so it
pops with the explosion. Keep these distinct.

Pausing sends an immediate idle binary frame (`encodeInput(IDLE_INPUT)`) —
that's what actually halts your tank, since the server keeps applying the last
input.

### Reconnect
On socket open the client sends `identify` with `sessionStorage[SESSION_KEY]`
(per-tab — two tabs are two distinct players). The server rebinds the
sessionId to the new socket, clears the removal timer, and replies `welcome`
with `resumed: true/false`. A disconnected slot is held for
`RECONNECT_GRACE_MS` (45 s); on reconnect, `game.setConnected(id, true)`
respawns the tank if it died while away. If `welcome` arrives with
`!resumed && state.inGame`, the session couldn't be restored (server restart)
→ the client tears down to the menu. Auto-reconnect on close after 1500 ms,
indefinitely (no backoff).

---

## 5. Wire protocol

Source of truth: `src/shared/protocol.ts`. `encode`/`decode` are just
`JSON.stringify`/`JSON.parse`. Snapshots are **not** JSON — they're binary
frames (see §4).

### Client → Server (`ClientMessage`)
| `type` | Fields | Notes |
| --- | --- | --- |
| `identify` | `sessionId?` | First message; resumes a session. Consumed on attach. |
| `setName` | `name` | Sanitized: trim, ≤16, strip control chars. |
| `setColor` | `color` | Strict 6-digit hex — security boundary. |
| `setTeam` | `team` | Lobby only. |
| `setTeamName` / `setTeamColor` | `team`, `name`/`color` | Captain only (first member of team). |
| `listLobbies` | — | |
| `createLobby` | `name`, `maxPlayers`, `config` | |
| `updateConfig` | `maxPlayers`, `config` | Host only; live-applicable tuning applies mid-match. |
| `joinLobby` | `lobbyId` | |
| `leaveLobby` | — | |
| `startGame` | — | Host only. |
| `restartGame` | — | Host only, mid-match. |
| `kickPlayer` | `targetId` | Host only; can't kick self. |
| `input` | `input: InputState` | JSON variant; the high-frequency path uses binary frames. |

### Server → Client (`ServerMessage`)
| `type` | Fields | Notes |
| --- | --- | --- |
| `welcome` | `playerId`, `sessionId`, `resumed` | `sessionId` = secret reconnect token. |
| `lobbyList` | `lobbies: LobbySummaryDTO[]` | |
| `lobbyJoined` | `lobby: LobbyDTO` | |
| `lobbyUpdate` | `lobby: LobbyDTO` | Broadcast on any lobby change. |
| `lobbyClosed` | `reason` | |
| `gameStart` | `maze`, `spawnZones`, `roster`, `round`, `totalRounds`, `standing` | JSON; first snapshot follows as binary. |
| `roster` | `roster: RosterEntry[]` | Sent when roster changes (e.g. late join). |
| `roundOver` | `round`, `totalRounds`, `winnerName`, `standing`, `nextInSeconds` | Non-blocking; match continues. |
| `gameOver` | `scores`, `winnerName`, `round`, `totalRounds`, `standing` | Match decided. |
| `latencies` | `pings: Array<{id,ms}>` | Every 2 s. |
| `kicked` | `reason` | |
| `error` | `message` | |

**DTOs** all end in `DTO` (`TankDTO`, `SnapshotDTO`, `MazeDTO`, `WallDTO`,
`FlagDTO`, `BulletDTO`, `PowerupDTO`, `BeamDTO`, `SpawnZoneDTO`,
LobbyDTO`, `LobbySummaryDTO`, `LobbyPlayerDTO`, `ScoreDTO`). Exceptions:
`RosterEntry`, `RoundStanding`, `KillEvent`. `TankDTO.index` is the compact
per-game wire id; `id` is the public player id. Both travel in the roster.

---

## 6. Conventions

### Imports (must follow)
- **Pure ESM** (`"type": "module"`).
- **`.js` extensions on relative imports are mandatory** — even when the
  source is `.ts`. NodeNext requires it for server; the codebase uses `.js`
  uniformly for client too. `import { Game } from "./game.js"`.
- **`node:` prefix** for Node built-ins: `node:http`, `node:fs/promises`,
  `node:crypto`. In tests: `node:assert/strict`, `node:test`.
- **`import type`** for type-only imports (convention; `verbatimModuleSyntax`
  is false so not enforced). Both standalone and inline:
  `import { encode, type GameConfig } from "../shared/protocol.js"`.

### Naming
- camelCase functions/vars; PascalCase classes/interfaces/types; UPPER_SNAKE
  constants; lowercase string-literal unions (`"ffa" | "ctf"`); `*DTO` suffix
  for wire objects. `DEFAULT_*` prefix for default config objects.

### The two tsconfigs (critical)
| | `tsconfig.json` | `tsconfig.server.json` |
| --- | --- | --- |
| Applies to | `src/shared`, `src/client` | `src/server`, `src/shared` |
| DOM libs | yes (`DOM`, `DOM.Iterable`) | **no** |
| Module resolution | Bundler | **NodeNext** (requires `.js`) |
| `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`/`isolatedModules` | **enforced** | not set |
| Emits | `noEmit: true` (Vite builds) | emits to `dist/` with sourcemaps |

**`src/shared/` is in BOTH `include`s** → shared code must use **no
browser-only APIs and no Node-only APIs**. It's pure protocol/constants/codec.
Adding a DOM or Node API there fails one of the two `tsc` invocations in
`typecheck`. `src/client/` may use `document`/`window`/`WebSocket`/`import.meta.env`;
`src/server/` may use `process`/`Buffer`/`setTimeout` but must not reference
browser globals.

### Comments
The codebase is heavily commented — JSDoc on exported fields (with units:
`// rad/s`, `// px/s`), file-header comments explaining each module's purpose,
`// --- section ---` divider banners, and comments that explain **why**, not
what (e.g. *"...wrap into [-π, π] before quantizing — otherwise large angles
saturate the int16 and the body freezes"*). Match this style. Don't strip
rationale comments. **Do not add comments that restate what the code does.**

### Error handling
- Defensive validation at trust boundaries via `sanitize*` in
  `src/server/index.ts` (see §10). Never trust raw client config.
- `try/catch` + `console.error` around message decode/dispatch (never crash
  the server on a bad frame). Empty `catch {}` for expected failures
  (malformed frames, closing sockets).
- No custom error classes. Server→client failures go as `{ type: "error",
  message }`.

### Git commits
Informal scoped prefixes, lowercase imperative: `Mode/CTF: add conquest type`,
`UI: kill streak announcement`, `Powerup/Scope: fix rendering…`. Not strict
Conventional Commits; no hooks enforce anything.

---

## 6b. Audio system

`src/client/audio.ts` owns all sound. It is a **client-only** module — never
import it from `src/shared/` or `src/server/`.

### Engine
- Uses the **Web Audio API** (`AudioContext`). A single shared context is
  created on first user interaction (the browser requires a gesture to unlock
  it). The module exports `audioCtx` but callers should prefer `playSfx` /
  `playVroom` / `playBgm`.
- `loadAudio(name, url)` fetches and decodes an audio file into an
  `AudioBuffer`, storing it in the `buffers` map. All calls are at module
  top-level so they fire as soon as the client bundle loads.
- **Each `playSfx` call creates a fresh `BufferSource`** — no re-use of
  sources, so the same SFX can overlap freely (e.g. rapid fire).
- Global volume knobs: `globalBgmVolume` (default 0.5) and `globalSfxVolume`
  (default 1.0) are set by the in-game sliders. `playSfx` multiplies its
  `volume` arg by `globalSfxVolume`; BGM/vroom loops multiply by
  `globalBgmVolume`.

### Sound files (`src/client/public/`)
| File | Trigger |
| --- | --- |
| `bgm.mp3` | Looping background music, played during a match. |
| `pew.ogg` | Any shot fired (normal or weapon power-up). |
| `explosion.ogg` | Tank death — fired from `consumeEffects` on the interpolation clock. |
| `reloading.ogg` | When `reloadIn` transitions from 0 → > 0. |
| `vroom.ogg` | Tank engine noise while moving; looped via `playVroom` / `stopVroom`. |
| `powerup.ogg` | When a power-up crate disappears under the local player's tank. |
| `oof.ogg` | Non-lethal HP drop on the local player's tank. |
| `first_blood.ogg` | Kill-streak tier 1 (FIRST BLOOD banner). |
| `double_kill.ogg` | Kill-streak tier 2 (DOUBLE KILL banner). |
| `triple_kill.ogg` | Kill-streak tier 3 (TRIPLE KILL banner). |
| `maniac.ogg` | Kill-streak tier 4 (MANIAC banner). |
| `savage.ogg` | Kill-streak tier 5 (SAVAGE banner). |

### Where SFX are triggered
- **`render.ts` → `detectTransients`**: iterates `lastTankState` diff each
  snapshot. Fires `pew`, `reloading`, and `oof` (non-lethal HP drop).
- **`render.ts` → `consumeEffects`**: fires `explosion` on the ~140 ms
  interpolation clock so the bang lands when the bullet visually hits.
- **`render.ts` → power-up crate tracking**: `lastPowerups` map tracks
  `PowerupDTO.id` values. When a crate id disappears and the local player was
  within pickup radius, fires `powerup`. This correctly handles duplicate
  pickups (same buff refreshed) unlike a state-diff approach.
- **`announce.ts` → `show()`**: fires the tier-appropriate announcer clip
  alongside the kill-streak banner.
- **`main.ts` / `input.ts`**: `playVroom` / `stopVroom` keyed to movement input.

### Adding a new SFX
1. Drop the file in `src/client/public/`.
2. Add `loadAudio("name", "/file.mp3")` in `audio.ts`.
3. Call `playSfx("name", volume)` from the appropriate client module.
   - Triggered by a snapshot diff → `render.ts` `detectTransients`.
   - Triggered by a UI event (button, banner) → the module that owns that event.

### Adding a volume control
Modify `globalBgmVolume` or `globalSfxVolume` in `audio.ts` from the settings
UI. The sliders live in `#volume-bgm` / `#volume-sfx` inputs in `index.html`
and are wired in `main.ts`.

---

## 7. Testing

- **Framework:** Node built-in `node:test` + `node:assert/strict`. No Jest,
  no Vitest. `tsx` transpiles at run time.
- **Structure:** `describe("<topic>", () => { it("<behaviour>", () => { ... }) })`.
  No `test()` blocks, no `before/after` hooks. Each `it` builds its own state.
- **Factories:** small helpers (`makeGame`, `lobby`, `client`, `tank`,
  `emptySnap`) that `structuredClone(DEFAULT_*)` and accept a `Partial<T>`
  override via `...over` spread.
- **Reaching into privates:** tests routinely cast `(g as any).tanks`,
  `(g as any).stepFlags(dt)`, etc. — private in TS, present at runtime. If you
  rename an internal field, tests break at **run time** not typecheck.
- **Registry-driven:** `wire.test.ts` and `protocol.test.ts` loop over
  `POWERUP_DEFS`/`WEAPON_POWERUPS`/`POWERUP_TYPES` so new power-ups are
  automatically covered. Keep them green when adding to the registry.
- **Maze tests** are graph-theoretic (flood-fill connectivity, unit-capacity
  max flow for edge-disjoint paths, 2×2-open-area detection) and sample
  multiple random generations to defend against RNG regressions.
- When adding a feature, add a test next to the relevant `describe` block.
  Run `npm test` to validate (not `typecheck`).

---

## 8. Critical invariants (do not break)

1. **`POWERUP_DEFS` is the single source of truth.** Adding an entry
   auto-wires the spawn pool, binary wire codes, crate art, HUD labels, lobby
   editor inputs, and config-detail panels. `test/protocol.test.ts` guards
   this — **every `AdvancedConfig` field must have an editor input** (either a
   hand-written one in `STATIC_ADV_KEYS` or a `config` entry on a `PowerupDef`).
   Adding a power-up without covering its new config field will break
   `gatherAdvanced()` at runtime and the protocol test.

2. **`WEAPON_POWERUPS` order = binary weapon code table.** Code 0 = none,
   then each weapon power-up in registry order. Reordering changes wire codes
   and breaks snapshot decoding for mixed client/server versions.

3. **Snapshot `t` is not packed.** `decodeSnapshot` returns `t: 0`; the client
   uses `performance.now()` from `push()` for interpolation timing.

4. **`INTERP_DELAY = 140`** must exceed the ~66 ms snapshot interval with
   margin. Don't drop below ~100 ms or the buffer starves.

5. **Aim = `renderer.latest()`; death overlay = `renderer.displayed()`.**
   Responsive aim vs. delayed visual — keep them distinct.

6. **`#lobby-config` is one shared DOM element** moved between the lobby
   screen and the pause card via a `<!-- lobby-config-home -->` comment anchor
   (`src/client/lifecycle.ts`). Don't duplicate it. `renderLobby`'s
   `firstRender` flag prevents re-populating (and losing focus on) host
   controls on every `lobbyUpdate`; `refreshPings` patches only `.ping` spans
   to avoid clobbering mid-edit team name/color inputs.

7. **Death clears all power-ups** (weapon, boost, shield, scope, laser
   charge). Spawn shield (`SPAWN_SHIELD_SECONDS = 2`) applies on initial
   spawn, respawn, and round start.

8. **Power-up shots don't consume the magazine**; only normal shots consume
   ammo and trigger reloads. Weapon shots decrement `weaponCharges` (clearing
   the active weapon at 0).

9. **CTF has no point scoring** — rounds end on captures (deliver) or
   `winScore` (conquest/carry). `ctf` mode forces `lives = 0` and
   `teamSpawnZones = true`; `lms` forces `lives >= 1`. Sanitizers enforce
   these in `src/server/index.ts`.

10. **Axis-separated wall collision** (try X move, check `circleHitsWall`,
    accept/reject; then Y) — lets tanks/bullets slide along walls. Bullets
    sub-step (`ceil((speed*dt)/(bulletRadius*0.9))`) to prevent tunneling.
    Sniper bullets fly straight with no momentum drift; other bullets inherit
    the tank's `vx`/`vy`.

11. **Homing BFS scratch is generation-stamped** (`pathGen` bumped, never
    cleared) and dropped on `startNextRound` (grid size can change). Don't
    zero the arrays.

12. **`sessionStorage` (per-tab) for `SESSION_KEY`** so two tabs are distinct
    players; `localStorage` for `STORAGE_KEY`/`MOVE_KEY`/`COLOR_KEY`
    (persisted).

13. **Power-up pickup SFX uses crate-ID tracking, not state diffing.** The
    client tracks `PowerupDTO.id` values in `Renderer.lastPowerups`. When an id
    disappears and the local player was within pickup radius, `powerup.ogg`
    plays. This correctly handles re-picking the same buff type (where a
    state-diff would see no change).

14. **SFX for non-lethal damage (`oof.ogg`) must not fire on death.** The
    `detectTransients` check is `t.hp < prev.hp` — it fires whenever HP drops,
    including the killing shot. The `explosion.ogg` is separately fired from
    `consumeEffects` on `alive` → false. Both can fire on the same death tick;
    that is intentional (oof + explosion overlap). If you want only the
    explosion on death, add an `&& t.alive` guard to the oof check.

15. **Tank collision is forced off outside FFA.** The `tankCollision` boolean in
    `GameConfig` is strictly gated in `src/server/index.ts` via `sanitizeConfig`.
    If the mode is not FFA, the sanitizer forces it to false, so tampered clients
    cannot sneak collision physics into team modes.
---

## 9. Recipes

### Add a power-up
1. Add one entry to `POWERUP_DEFS` in `src/shared/protocol.ts` with `id`,
   `kind: "buff" | "weapon"`, `label`, `emblem`, `color`, and `config` (array
   of `PowerupConfigField` with `key`/`min`/`max`/`step` for each tunable).
   This auto-wires: `POWERUP_TYPES`, the spawn pool, the binary `PUP_CODES` /
   `WEAPON_CODES` tables in `wire.ts`, the crate art + HUD label via
   `powerupDef()`, the lobby editor inputs via `buildPowerupAdvInputs()`, and
   the config-details groups via `buildConfigDetailsHtml()`.
2. Add any new fields to `AdvancedConfig` (interface + `DEFAULT_ADVANCED`,
   mirrored from `constants.ts`).
3. If a **buff**: add one entry to `BUFF_COMMANDS` in `src/server/game.ts`
   that sets the relevant timer/flag on the tank.
4. If a **weapon**: handle it in `Game.fire()` (and `fireLaser` if hitscan)
   — bullet kind, speed, bounces, lifetime, pierce behavior. Add the bullet
   kind to `BulletKind` and `KIND_CODES` in `wire.ts`. Add render styling in
   `src/client/render.ts` (`BULLET_STYLE`).
5. Add a sanitize range in `sanitizeAdvanced` (`src/server/index.ts`) —
   registry fields are auto-clamped from `PowerupDef.config`'s `min`/`max`, so
   this is only needed for non-registry fields.
6. Keep `test/protocol.test.ts` green: every new `AdvancedConfig` field must
   have an editor input (static in `STATIC_ADV_KEYS` or a `config` entry on
   your `PowerupDef`).
7. Tests are registry-driven, so `wire.test.ts`/`protocol.test.ts` cover the
   new type automatically; add behavioral tests in `game.test.ts`.

### Add a `WallStyle`
1. Add the string literal to `WallStyle` and `WALL_STYLES` in `protocol.ts`.
2. Implement a `MazeCommand` class in `src/server/maze.ts` and add it to the
   pipeline in `buildPipeline()`.
3. Add a display label to `WALL_LABEL` in `src/client/labels.ts` and
   schematic segments to `WALL_THUMB_SEGS` in `src/client/settings.ts` (for
   the visual picker).
4. Add connectivity + spawn-safety coverage in `test/maze.test.ts` (loop over
   `WALL_STYLES` is already there — your style is auto-included if you added
   it to `WALL_STYLES`).

### Add a wire message type
1. Add the variant to `ClientMessage` / `ServerMessage` in `protocol.ts`.
2. Handle it in `Hub.handle` (`src/server/index.ts`) for client→server, or
   send it from the appropriate place for server→client.
3. Handle it in `net.onMessage` (`src/client/main.ts`) for server→client, or
   send from the relevant client code for client→server.
4. **Only if high-frequency** (dominates bandwidth): add a binary tag to
   `wire.ts` instead of JSON, with `MSG_*` constant + encode/decode functions,
   and dispatch on the tag byte in the `ws.on("message")` handler.

### Add a tunable constant
1. Add it to `src/shared/constants.ts`.
2. Mirror it into `AdvancedConfig` (interface + `DEFAULT_ADVANCED`) in
   `protocol.ts` if a host should override it.
3. Read it from `this.adv.*` in `game.ts` (runtime reads the live config, not
   the constants module directly).
4. Add a sanitize range in `sanitizeAdvanced` (`src/server/index.ts`).
5. Add an editor input (either a hand-written one tracked in
   `STATIC_ADV_KEYS` in `test/protocol.test.ts`, or a `config` entry on a
   `PowerupDef`).
6. If it affects rendering (sizes, speeds, lifetimes), pass it through
   `Renderer.setParams` / `setScope` in `src/client/lifecycle.ts`.

---

## 10. Security boundaries

- **`sanitize*` in `src/server/index.ts`** is the trust boundary. Always
  validate client-supplied data before use:
  - `sanitizeName`: trim, ≤16 chars, strip control chars.
  - `sanitizeColor`: **strict `/^#[0-9a-fA-F]{6}$/`** — the color is rendered
    into other clients' DOM, so unvalidated input is an XSS vector.
  - `sanitizeTeamName`: strip `<>"'&`.
  - `sanitizeAdvanced` / `sanitizeConfig`: clamp every numeric field to an
    allowed range; power-up fields clamped from the registry's own `min`/`max`.
    Mode invariants enforced here: `lms` → `lives >= 1`; `ctf` → `lives = 0`,
    `teamCount ∈ {2,4}`, `teamSpawnZones = true`.
- **Path-traversal guard** in `serveStatic`: `normalize(pathname).replace(/^(\.\.[/\\])+/, "")`
  + SPA fallback to `index.html`. The 404 body hints to build the client first.
- **Never** log or echo secrets, keys, or the `sessionId` token beyond its
  intended transport. The `sessionId` is the reconnect credential.
- Binary input decode errors are caught and logged, never crash the server.
- Host-only actions (`startGame`, `updateConfig`, `kickPlayer`, `restartGame`)
  are gated by `lobby.hostId !== client.id` checks.

---

## Quick orientation for a fresh agent

1. Read `src/shared/protocol.ts` first — it defines every shape you'll touch.
2. Read `src/shared/wire.ts` for how snapshots/inputs are packed.
3. For server changes: `src/server/lobby.ts` (loop + broadcast) →
   `src/server/game.ts` (sim) → `src/server/maze.ts` (geometry).
4. For client changes: `src/client/main.ts` (orchestrator) →
   `src/client/render.ts` (renderer + interpolation) →
   `src/client/lifecycle.ts` (screen transitions).
5. Run `npm run dev`, open http://localhost:5173 in two tabs to test
   multiplayer. Server logs to the `server`-prefixed terminal.
6. Before finishing: `npm run typecheck && npm test`.

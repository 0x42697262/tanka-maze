// In-game overlays: kill log, ammo/weapon readout, leaderboard, round badge,
// series board, and the respawn overlay.

import { powerupDef, type PowerupType } from "../shared/protocol.js";
import { $, escapeHtml } from "./dom.js";
import { roundsToWin, standingHtml } from "./labels.js";
import { renderer, state, TEAM_TINT } from "./state.js";

// ---- Kill / suicide log (icons + colored names + points) ----
const killLog: string[] = [];

function nameSpan(index: number): string {
  const r = state.roster.get(index);
  return `<span class="lg-name" style="color:${r?.color ?? "#888"}">${escapeHtml(r?.name ?? "?")}</span>`;
}

export function logKillEvent(e: { type: number; killer: number; victim: number; points: number }): void {
  const pts = `<span class="lg-pts ${e.points >= 0 ? "pos" : "neg"}">${e.points >= 0 ? "+" : ""}${e.points}</span>`;
  let html: string;
  if (e.type === 0) html = `${nameSpan(e.killer)} 🎯 ${nameSpan(e.victim)} ${pts}`; // kill
  else if (e.type === 2) html = `${nameSpan(e.killer)} 💀 ${nameSpan(e.victim)} ${pts}`; // team-kill
  else html = `💀 ${nameSpan(e.victim)} ${pts}`; // suicide / self-destruct
  killLog.push(`<li>${html}</li>`);
  if (killLog.length > 6) killLog.shift();
  $("killlog").innerHTML = killLog.join("");
}

export function clearKillLog(): void {
  killLog.length = 0;
  $("killlog").innerHTML = "";
}

/** "Round 2 · first to 3" pill in the game header (hidden for single rounds). */
export function renderRoundBadge(): void {
  const el = $("gh-round");
  const cfg = state.currentLobby?.config;
  // A multi-round match is "first to X"; show the current round + that target
  // rather than a fraction over the (large) worst-case round cap.
  if (state.roundInfo.total > 1 && cfg) {
    el.textContent = `Round ${state.roundInfo.round} · first to ${roundsToWin(cfg)}`;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

/** In-game round scoreboard in the leaderboard sidebar (multi-round matches). */
export function renderSeriesBoard(): void {
  const board = $("series-board");
  if (state.roundInfo.total <= 1 || state.roundStanding.length === 0) {
    board.classList.add("hidden");
    return;
  }
  $("series-board-rows").innerHTML = standingHtml(state.roundStanding);
  board.classList.remove("hidden");
}

export function renderHud(
  me:
    | {
        hp: number;
        maxHp: number;
        alive: boolean;
        ammo: number;
        maxAmmo: number;
        reloadIn: number;
        weapon: string | null;
        weaponCharges: number;
        boosted: boolean;
        shielded: boolean;
        charging: boolean;
        scoped: boolean;
      }
    | undefined
): void {
  const strip = $("hud-strip");
  if (!me || !state.inGame || !me.alive) {
    strip.classList.add("hidden");
    return;
  }
  strip.classList.remove("hidden");

  // Health — hidden entirely on 1-HP games (default), where it conveys nothing.
  const healthSection = $("hud-health-section");
  if (me.maxHp <= 1) {
    healthSection.classList.add("hidden");
  } else {
    healthSection.classList.remove("hidden");
    const healthEl = $("hud-health");
    let healthHtml = "";
    for (let i = 0; i < me.maxHp; i++) {
      const isFull = i < me.hp;
      const ratio = me.hp / me.maxHp;
      const colorClass = ratio > 0.5 ? "high" : ratio > 0.25 ? "med" : "low";
      healthHtml += `<span class="health-seg ${isFull ? colorClass : ""}"></span>`;
    }
    healthEl.innerHTML = healthHtml;
  }

  // Ammo
  const ammoEl = $("hud-ammo");
  let ammoHtml = "";
  for (let i = 0; i < me.maxAmmo; i++) {
    ammoHtml += `<span class="pip ${i < me.ammo ? "" : "spent"}"></span>`;
  }
  if (me.reloadIn > 0) ammoHtml += `<span class="reload">reloading ${Math.ceil(me.reloadIn)}s</span>`;
  if (me.charging) ammoHtml += `<span class="weapon laser">charging…</span>`;
  else if (me.weapon) {
    ammoHtml += `<span class="weapon">${powerupDef(me.weapon as PowerupType).label} ×${me.weaponCharges}</span>`;
  }
  if (me.boosted) ammoHtml += `<span class="weapon boost">» boost</span>`;
  if (me.shielded) ammoHtml += `<span class="weapon shield">◈ shield</span>`;
  if (me.scoped) ammoHtml += `<span class="weapon scope">ⓘ scope</span>`;
  ammoEl.innerHTML = ammoHtml;

  // Radar — shown only when both the host's game setting and the player's own
  // toggle allow it. Blips are all red (real-radar look), regardless of team.
  const radarSection = $("hud-radar-section");
  const radarOn = (state.currentLobby?.config.radar ?? true) && state.radarEnabled;
  if (!radarOn) {
    radarSection.classList.add("hidden");
  } else {
    radarSection.classList.remove("hidden");
    const radarEl = $("radar-dots");
    let radarHtml = "";
    const snap = renderer.latest();
    if (snap) {
      const meTank = snap.tanks.find(t => t.id === state.playerId);
      if (meTank) {
        const radarRadius = 600; // units to edge of radar
        for (const t of snap.tanks) {
          if (!t.alive || t.id === state.playerId) continue;
          const dx = t.x - meTank.x;
          const dy = t.y - meTank.y;
          if (Math.hypot(dx, dy) <= radarRadius) {
            // Map [-radarRadius, radarRadius] to [0%, 100%]
            const px = ((dx / radarRadius) * 50) + 50;
            const py = ((dy / radarRadius) * 50) + 50;
            radarHtml += `<div class="radar-dot" style="left:${px}%; top:${py}%;"></div>`;
          }
        }
      }
    }
    radarEl.innerHTML = radarHtml;
  }
}

/** In-arena leaderboard. Team VS ranks by combined team points; else per-player. */
export function renderLeaderboard(): void {
  const snap = renderer.latest();
  if (!snap) return;
  const ol = $("leaderboard-rows");
  ol.innerHTML = "";

  // Match Info Panel
  const mi = $("match-info");
  if (state.inGame && state.currentLobby) {
    mi.classList.remove("hidden");
    $("mi-round").textContent = `${state.roundInfo.round} / ${state.roundInfo.total}`;
    
    if (state.matchStartTime) {
      const ms = Math.floor((performance.now() - state.matchStartTime) / 1000);
      const m = Math.floor(ms / 60).toString().padStart(2, "0");
      const s = (ms % 60).toString().padStart(2, "0");
      $("mi-time").textContent = `${m}:${s}`;
    }

    const mode = state.currentLobby.config.mode;
    let objText = "Survive";
    if (mode === "ctf") {
      objText = state.currentLobby.config.ctfScoreMode === "deliver" ? "Capture flags" : "Control flags";
    } else if (mode === "teams") {
      objText = "Team Skirmish";
    } else if (mode === "ffa") {
      objText = "Eliminate everyone";
    }
    $("mi-obj").textContent = objText;
  } else {
    mi.classList.add("hidden");
  }

  // Capture the Flag: rank teams — by flags captured (deliver) or points earned
  // (conquest/carry), live from the tanks in the snapshot.
  if (state.currentLobby?.config.mode === "ctf") {
    const names = state.currentLobby?.teamNames ?? [];
    const colors = state.currentLobby?.teamColors ?? [];
    const sm = state.currentLobby?.config.ctfScoreMode;
    const conquest = sm === "conquest" || sm === "carry";
    const myTeam = snap.tanks.find((t) => t.id === state.playerId)?.team;
    const byTeam = new Map<number, number>();
    const memberN = new Map<number, number>();
    for (const t of snap.tanks) {
      byTeam.set(t.team, (byTeam.get(t.team) ?? 0) + (conquest ? t.score : t.captures));
      memberN.set(t.team, (memberN.get(t.team) ?? 0) + 1);
    }
    [...memberN.keys()]
      .map((team) => ({ team, val: byTeam.get(team) ?? 0 }))
      .sort((a, b) => b.val - a.val || a.team - b.team)
      .forEach(({ team, val }, i) => {
        const li = document.createElement("li");
        if (team === myTeam) li.className = "me";
        const tint = colors[team] ?? TEAM_TINT[team % TEAM_TINT.length];
        const tname = names[team] ?? `Team ${team + 1}`;
        li.innerHTML =
          `<span class="rank">${i + 1}</span>` +
          `<span class="swatch" style="background:${tint}"></span>` +
          `<span class="nm">${escapeHtml(tname)} (${memberN.get(team) ?? 0})</span>` +
          `<span class="pts">${conquest ? val : `⚑ ${val}`}</span>`;
        ol.appendChild(li);
      });
    return;
  }

  if (state.currentLobby?.config.mode === "teams") {
    const totals = new Map<number, { score: number; n: number }>();
    for (const t of snap.tanks) {
      const cur = totals.get(t.team) ?? { score: 0, n: 0 };
      cur.score += t.score;
      cur.n += 1;
      totals.set(t.team, cur);
    }
    const myTeam = snap.tanks.find((t) => t.id === state.playerId)?.team;
    const names = state.currentLobby?.teamNames ?? [];
    const colors = state.currentLobby?.teamColors ?? [];
    [...totals.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[0] - b[0])
      .forEach(([team, d], i) => {
        const li = document.createElement("li");
        if (team === myTeam) li.className = "me";
        const tint = colors[team] ?? TEAM_TINT[team % TEAM_TINT.length];
        const tname = names[team] ?? `Team ${team + 1}`;
        li.innerHTML =
          `<span class="rank">${i + 1}</span>` +
          `<span class="swatch" style="background:${tint}"></span>` +
          `<span class="nm">${escapeHtml(tname)} (${d.n})</span>` +
          `<span class="pts">${d.score}</span>`;
        ol.appendChild(li);
      });
    return;
  }

  // Last Man Standing is about survival, not points — rank by lives remaining
  // (most lives, then who's still alive).
  const lms = state.currentLobby?.config.mode === "lms";
  const ranked = [...snap.tanks].sort((a, b) =>
    lms
      ? b.livesLeft - a.livesLeft || Number(b.alive) - Number(a.alive) || a.name.localeCompare(b.name)
      : b.score - a.score || a.name.localeCompare(b.name)
  );
  ranked.forEach((t, i) => {
    const li = document.createElement("li");
    li.className = `${t.id === state.playerId ? "me " : ""}${t.alive ? "" : "dead"}`.trim();
    const metric = lms ? `♥ ${t.livesLeft}` : `${t.score}`;
    li.innerHTML =
      `<span class="rank">${i + 1}</span>` +
      `<span class="swatch" style="background:${t.color}"></span>` +
      `<span class="nm">${escapeHtml(t.name)}</span>` +
      `<span class="pts">${metric}</span>`;
    ol.appendChild(li);
  });
}

export function updateRespawnOverlay(me: { alive: boolean; respawnIn: number } | undefined): void {
  const el = $("respawn");
  if (me && !me.alive && !state.matchEndTimeout) {
    el.classList.remove("hidden");
    $("respawn-count").textContent = String(Math.max(0, Math.ceil(me.respawnIn)));
  } else {
    el.classList.add("hidden");
  }
}

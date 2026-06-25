// In-game overlays: kill log, ammo/weapon readout, leaderboard, round badge,
// series board, and the respawn overlay.

import { powerupDef, type PowerupType } from "../shared/protocol.js";
import { $, escapeHtml } from "./dom.js";
import { standingHtml } from "./labels.js";
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

/** "Round 2 / 3" pill in the game header (hidden for single-round matches). */
export function renderRoundBadge(): void {
  const el = $("gh-round");
  if (state.roundInfo.total > 1) {
    el.textContent = `Round ${state.roundInfo.round} / ${state.roundInfo.total}`;
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

export function renderAmmo(
  me:
    | {
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
  const el = $("ammo");
  if (!me) {
    el.innerHTML = "";
    return;
  }
  let html = "";
  for (let i = 0; i < me.maxAmmo; i++) {
    html += `<span class="pip ${i < me.ammo ? "" : "spent"}"></span>`;
  }
  if (me.reloadIn > 0) html += `<span class="reload">reloading ${Math.ceil(me.reloadIn)}s</span>`;
  if (me.charging) html += `<span class="weapon laser">charging…</span>`;
  else if (me.weapon) {
    html += `<span class="weapon">${powerupDef(me.weapon as PowerupType).label} ×${me.weaponCharges}</span>`;
  }
  if (me.boosted) html += `<span class="weapon boost">» boost</span>`;
  if (me.shielded) html += `<span class="weapon shield">◈ shield</span>`;
  if (me.scoped) html += `<span class="weapon scope">ⓘ scope</span>`;
  el.innerHTML = html;
}

/** In-arena leaderboard. Team VS ranks by combined team points; else per-player. */
export function renderLeaderboard(): void {
  const snap = renderer.latest();
  if (!snap) return;
  const ol = $("leaderboard-rows");
  ol.innerHTML = "";

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
  if (me && !me.alive) {
    el.classList.remove("hidden");
    $("respawn-count").textContent = String(Math.max(0, Math.ceil(me.respawnIn)));
  } else {
    el.classList.add("hidden");
  }
}

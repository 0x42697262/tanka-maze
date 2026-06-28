// In-game scoreboard (Tab): connected players, latency, full config, host kick.

import { $, escapeHtml } from "./dom.js";
import { buildConfigDetailsHtml } from "./labels.js";
import { pingBadge } from "./lobby.js";
import { net, renderer, state } from "./state.js";

export function renderScoreboard(): void {
  if (!state.currentLobby) return;
  const lobby = state.currentLobby;
  const ctf = lobby.config.mode === "ctf";
  const sm = lobby.config.ctfScoreMode;
  const conquest = ctf && (sm === "conquest" || sm === "carry");
  const teams = lobby.config.mode === "teams" || ctf;
  const lms = lobby.config.mode === "lms"; // rank by survival (lives), not points
  const isHost = lobby.hostId === state.playerId;
  const snap = renderer.latest();
  // Metric column: conquest points / flags captured (CTF), lives (LMS), else score.
  const metricById = new Map<string, number>();
  if (snap) {
    for (const t of snap.tanks) {
      metricById.set(t.id, conquest ? Math.round(t.score) : ctf ? t.captures : lms ? t.livesLeft : t.score);
    }
  }

  const rows = [...lobby.players].sort(
    (a, b) => (metricById.get(b.id) ?? 0) - (metricById.get(a.id) ?? 0)
  );
  const teamHead = teams ? "<th>Team</th>" : "";
  const body = rows
    .map((p) => {
      const teamCell = teams
        ? `<td>${escapeHtml(lobby.teamNames[p.team] ?? `Team ${p.team + 1}`)}</td>`
        : "";
      const kick =
        isHost && p.id !== state.playerId
          ? `<button class="sb-kick ghost small" data-id="${p.id}">Kick</button>`
          : "";
      const tag = p.id === state.playerId ? ' <span class="sb-you">you</span>' : "";
      const host = p.id === lobby.hostId ? ' <span class="sb-host">host</span>' : "";
      return (
        `<tr class="${p.connected ? "" : "sb-off"}">` +
        `<td><span class="swatch" style="background:${p.color}"></span>${escapeHtml(p.name)}${tag}${host}</td>` +
        teamCell +
        `<td class="sb-score">${metricById.get(p.id) ?? 0}</td>` +
        `<td>${pingBadge(p.id)}</td>` +
        `<td class="sb-act">${kick}</td>` +
        `</tr>`
      );
    })
    .join("");

  $("sb-table-wrap").innerHTML =
    `<table class="sb-table"><thead><tr>` +
    `<th>Player</th>${teamHead}<th>${conquest ? "Points" : ctf ? "Flags" : lms ? "Lives" : "Score"}</th><th>Ping</th><th></th>` +
    `</tr></thead><tbody>${body}</tbody></table>`;

  $("sb-table-wrap")
    .querySelectorAll<HTMLButtonElement>(".sb-kick")
    .forEach((b) => {
      b.onclick = () => net.send({ type: "kickPlayer", targetId: b.dataset.id ?? "" });
    });

  $("sb-details").innerHTML = buildConfigDetailsHtml(lobby);
}

export function openScoreboard(): void {
  if (!state.inGame) return;
  state.scoreboardOpen = true;
  renderScoreboard();
  $("scoreboard").classList.remove("hidden");
  if (state.scoreboardTimer) clearInterval(state.scoreboardTimer);
  state.scoreboardTimer = setInterval(renderScoreboard, 500); // live scores + latency
}

export function closeScoreboard(): void {
  state.scoreboardOpen = false;
  $("scoreboard").classList.add("hidden");
  if (state.scoreboardTimer) {
    clearInterval(state.scoreboardTimer);
    state.scoreboardTimer = null;
  }
}

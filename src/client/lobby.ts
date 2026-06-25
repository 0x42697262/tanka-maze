// Menu (lobby list) + lobby waiting room UI: roster, team boxes, the read-only
// config panel, and the player's name/color controls.

import type { LobbyDTO, LobbySummaryDTO } from "../shared/protocol.js";
import { $, escapeHtml } from "./dom.js";
import { buildConfigDetailsHtml, configSummary, modeLabel } from "./labels.js";
import { applyConfigToControls } from "./settings.js";
import {
  COLOR_KEY,
  STORAGE_KEY,
  TEAM_TINT,
  colorInput,
  latencies,
  net,
  PRESET_COLORS,
  state,
} from "./state.js";

export function renderLobbyList(lobbies: LobbySummaryDTO[]): void {
  const ul = $("lobby-list");
  ul.innerHTML = "";
  if (lobbies.length === 0) {
    ul.innerHTML = `<li class="empty">No lobbies yet — create one!</li>`;
    return;
  }
  for (const l of lobbies) {
    const li = document.createElement("li");
    const full = l.playerCount >= l.maxPlayers;
    const closed = l.inGame && !l.allowLateJoin; // started + late join disabled
    const joinable = !full && !closed;
    const status = l.inGame ? (closed ? "● in progress" : "● live") : "";
    li.innerHTML = `
      <div class="lobby-info">
        <span class="name">${escapeHtml(l.name)}</span>
        <span class="sub">host ${escapeHtml(l.hostName)} · ${modeLabel(l.mode)}</span>
      </div>
      <span class="badge ${l.inGame ? "live" : ""}">
        ${status} ${l.playerCount}/${l.maxPlayers}
      </span>`;
    const btn = document.createElement("button");
    btn.className = "ghost small";
    btn.textContent = full ? "Full" : closed ? "Closed" : l.inGame ? "Join live" : "Join";
    btn.disabled = !joinable;
    btn.onclick = () => net.send({ type: "joinLobby", lobbyId: l.id });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

export function renderLobby(lobby: LobbyDTO, firstRender: boolean): void {
  $("lobby-title").textContent = lobby.name;
  $("lobby-meta").textContent = `${lobby.players.length}/${lobby.maxPlayers} players · ${configSummary(lobby.config)}`;

  const teams = lobby.config.mode === "teams";
  const isHost = lobby.hostId === state.playerId;
  const ul = $("lobby-players");
  ul.innerHTML = "";

  if (teams) {
    // A boxed roster per team; clicking a box joins that team.
    ul.classList.add("teams");
    for (let team = 0; team < lobby.config.teamCount; team++) {
      const members = lobby.players.filter((p) => p.team === team);
      const mine = lobby.players.find((p) => p.id === state.playerId)?.team === team;
      const captain = members[0]?.id === state.playerId; // first player of this team
      const tint = lobby.teamColors[team] ?? TEAM_TINT[team % TEAM_TINT.length];
      const tname = lobby.teamNames[team] ?? `Team ${team + 1}`;

      const box = document.createElement("li");
      box.className = `team-box${mine ? " mine" : ""}`;
      box.style.borderColor = tint;

      const head = document.createElement("div");
      head.className = "team-head";
      head.style.color = tint;
      if (captain) {
        // Captain (first player) may edit the team's color + name.
        head.appendChild(teamColorInput(team, tint));
        head.appendChild(teamNameInput(team, tname));
      } else {
        head.innerHTML = `<span class="swatch" style="background:${tint}"></span>${escapeHtml(tname)}`;
      }
      const count = document.createElement("span");
      count.className = "team-n";
      count.textContent = `(${members.length})`;
      head.appendChild(count);
      box.appendChild(head);

      const sub = document.createElement("ul");
      members.forEach((p) => sub.appendChild(playerRow(p, lobby.hostId)));
      box.appendChild(sub);
      box.onclick = () => {
        if (!mine) net.send({ type: "setTeam", team });
      };
      ul.appendChild(box);
    }
  } else {
    ul.classList.remove("teams");
    lobby.players.forEach((p) => ul.appendChild(playerRow(p, lobby.hostId)));
  }

  $("team-hint").classList.toggle("hidden", !teams);
  $("start").classList.toggle("hidden", !isHost);
  $("waiting-host").classList.toggle("hidden", isHost);

  // Per-player tank color: reflect the server-assigned color; hide in Team VS
  // (there the team color governs the tank's in-game appearance).
  const me = lobby.players.find((p) => p.id === state.playerId);
  if (me) {
    colorInput.value = me.color;
    updateSwatchSelection();
  }
  $("lobby-customize").classList.toggle("hidden", teams);

  // Host configures the game here; populate the controls once on entry.
  $("lobby-config").classList.toggle("hidden", !isHost);
  if (isHost && firstRender) applyConfigToControls(lobby.config, lobby.maxPlayers);

  // Everyone sees the full, read-only configuration on the right.
  renderConfigDetails(lobby);
}

/** Render the complete (read-only) lobby configuration into the lobby sidebar. */
function renderConfigDetails(lobby: LobbyDTO): void {
  $("details-body").innerHTML = buildConfigDetailsHtml(lobby);
}

function teamColorInput(team: number, color: string): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "color";
  el.className = "team-color-input";
  el.value = color;
  el.title = "Team color";
  el.onclick = (e) => e.stopPropagation();
  el.onchange = () => net.send({ type: "setTeamColor", team, color: el.value });
  return el;
}

function teamNameInput(team: number, name: string): HTMLInputElement {
  const el = document.createElement("input");
  el.className = "team-name-input";
  el.maxLength = 16;
  el.value = name;
  el.title = "Team name";
  el.onclick = (e) => e.stopPropagation();
  el.onchange = () => {
    const v = el.value.trim();
    if (v) net.send({ type: "setTeamName", team, name: v });
  };
  return el;
}

function playerRow(p: LobbyDTO["players"][number], hostId: string): HTMLLIElement {
  const li = document.createElement("li");
  if (!p.connected) li.className = "offline";
  const you = p.id === state.playerId ? " (you)" : "";
  const tag = p.connected ? you : " (reconnecting…)";
  li.innerHTML = `<span><span class="swatch" style="background:${p.color}"></span>${escapeHtml(p.name)}${tag}</span>${pingBadge(p.id)}`;
  if (p.id === hostId) {
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = "HOST";
    li.appendChild(host);
  }
  return li;
}

/** Colored latency badge (— when unknown) for a player id. */
export function pingBadge(id: string): string {
  const ms = latencies.get(id);
  if (ms == null) return `<span class="ping">—</span>`;
  const cls = ms < 80 ? "good" : ms < 160 ? "ok" : "bad";
  return `<span class="ping ${cls}">${ms} ms</span>`;
}

// ---- Player name + color controls ----
export function commitName(): void {
  const value = ($("name") as HTMLInputElement).value.trim();
  if (value) {
    localStorage.setItem(STORAGE_KEY, value);
    net.send({ type: "setName", name: value });
  }
}

export function commitColor(): void {
  const value = colorInput.value;
  localStorage.setItem(COLOR_KEY, value);
  net.send({ type: "setColor", color: value });
  updateSwatchSelection();
}

export function updateSwatchSelection(): void {
  const current = colorInput.value.toLowerCase();
  $("swatches")
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((b) => b.classList.toggle("selected", (b.dataset.color ?? "") === current));
}

export function buildSwatches(): void {
  const wrap = $("swatches");
  wrap.innerHTML = "";
  for (const c of PRESET_COLORS) {
    const b = document.createElement("button");
    b.style.background = c;
    b.dataset.color = c;
    b.title = c;
    b.onclick = () => {
      colorInput.value = c;
      commitColor();
    };
    wrap.appendChild(b);
  }
}

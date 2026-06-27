// MOBA-style kill-streak banners (top-centre, fade quickly). The server decides
// the tier (KillEvent.streak) so every client agrees; this is pure presentation.
// Announcements QUEUE rather than replace: if several land together they play in
// arrival order, one after another.

import { type KillEvent } from "../shared/protocol.js";
import { $, escapeHtml } from "./dom.js";
import { state } from "./state.js";

/** tier code (KillEvent.streak) → banner label + CSS class. Enemy multikills
 *  (1-5) get flashier; team-kill betrayals (6-8) get grim, horror styling. */
const TIERS: Record<number, { label: string; cls: string }> = {
  1: { label: "FIRST BLOOD!", cls: "fb" },
  2: { label: "DOUBLE KILL!", cls: "t2" },
  3: { label: "TRIPLE KILL!!", cls: "t3" },
  4: { label: "MANIAC!!", cls: "t4" },
  5: { label: "SAVAGE!!!", cls: "t5" },
  6: { label: "BETRAYAL", cls: "b1" },
  7: { label: "TRAITOR", cls: "b2" },
  8: { label: "KINSLAYER", cls: "b3" },
};

const DISPLAY_MS = 1500; // each queued banner holds this long before the next plays

interface Item {
  tier: number;
  killer: number;
}
const queue: Item[] = [];
let playTimer: ReturnType<typeof setTimeout> | null = null;
let playing = false;

/** Clear the queue and the on-screen banner (call on match/round start). */
export function resetAnnouncements(): void {
  queue.length = 0;
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
  playing = false;
  const el = $("announce");
  el.className = "announce";
  el.innerHTML = "";
}

/** Queue a kill event's announcement (no-op when the server set no tier). */
export function announceKill(e: KillEvent): void {
  if (!e.streak || !TIERS[e.streak]) return;
  queue.push({ tier: e.streak, killer: e.killer });
  if (!playing) playNext();
}

function playNext(): void {
  const item = queue.shift();
  if (!item) {
    playing = false;
    return;
  }
  playing = true;
  show(item);
  playTimer = setTimeout(playNext, DISPLAY_MS);
}

function show(item: Item): void {
  const t = TIERS[item.tier];
  const r = state.roster.get(item.killer);
  const el = $("announce");
  el.className = "announce";
  void el.offsetWidth; // force reflow so the pop replays even back-to-back
  el.className = `announce show ${t.cls}`;
  el.innerHTML =
    `<div class="ann-label">${escapeHtml(t.label)}</div>` +
    `<div class="ann-by" style="color:${r?.color ?? "#ddd"}">${escapeHtml(r?.name ?? "?")}</div>`;
}

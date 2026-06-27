// MOBA-style kill-streak announcements (top-centre, fades quickly). Purely a
// client-side flourish driven by the kill events already in each snapshot. The
// streak decision (evaluateKill) is DOM-free and unit-tested; flash() paints it.

import { type KillEvent } from "../shared/protocol.js";
import { $ } from "./dom.js";

// Max gap between a killer's kills to chain a multikill (MOBA "multikill" window).
export const MULTIKILL_WINDOW = 4000;
// Team-kill "denied" pops at most once per this window per killer (2× the enemy
// window) so a serial team-killer doesn't carpet the screen with it.
export const TEAMKILL_WINDOW = MULTIKILL_WINDOW * 2;

export interface Announcement {
  label: string;
  tier: string; // CSS tier class; flashier the higher the streak
}

/** Multikill label + flashiness tier by chained kill count (null below 2). */
function multikill(count: number): Announcement | null {
  if (count === 2) return { label: "DOUBLE KILL", tier: "t2" };
  if (count === 3) return { label: "TRIPLE KILL", tier: "t3" };
  if (count === 4) return { label: "MANIAC", tier: "t4" };
  if (count >= 5) return { label: "SAVAGE", tier: "t5" };
  return null;
}

interface Streak {
  count: number;
  last: number;
}
const enemyStreak = new Map<number, Streak>();
const teamKillAt = new Map<number, number>();
let firstBlood = false;

/** Clear streak state only (DOM-free; used by tests and resetAnnouncements). */
export function resetStreaks(): void {
  enemyStreak.clear();
  teamKillAt.clear();
  firstBlood = false;
}

/**
 * Decide what (if anything) a kill should announce, updating streak state.
 * Suicides never announce; team kills flash a throttled "DENIED"; enemy kills
 * drive First Blood and the multikill chain. Pure — no DOM.
 */
export function evaluateKill(e: KillEvent, nowMs: number): Announcement | null {
  if (e.type === 1) return null; // suicide / self-destruct — no glory
  if (e.type === 2) {
    // Team kill: repeatable "denied", but throttled to once per (2×) window —
    // measured from the last time it was *shown*, so continuous team-killing
    // keeps re-showing it every window rather than pushing it off forever.
    const lastShown = teamKillAt.get(e.killer) ?? -Infinity;
    if (nowMs - lastShown < TEAMKILL_WINDOW) return null;
    teamKillAt.set(e.killer, nowMs);
    return { label: "DENIED", tier: "denied" };
  }
  // Enemy kill: extend or restart the killer's multikill chain.
  const prev = enemyStreak.get(e.killer);
  const count = prev && nowMs - prev.last <= MULTIKILL_WINDOW ? prev.count + 1 : 1;
  enemyStreak.set(e.killer, { count, last: nowMs });
  if (!firstBlood) {
    firstBlood = true;
    return { label: "FIRST BLOOD", tier: "fb" };
  }
  return multikill(count);
}

let hideTimer: ReturnType<typeof setTimeout> | null = null;

/** Reset all streak state and clear the on-screen announcement (match/round start). */
export function resetAnnouncements(): void {
  resetStreaks();
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  const el = $("announce");
  el.className = "announce";
  el.textContent = "";
}

/** Flash a label centre-screen (CSS controls the pop + fade). */
function flash(a: Announcement): void {
  const el = $("announce");
  el.textContent = a.label;
  // Restart the CSS animation even on a back-to-back announcement.
  el.className = "announce";
  void el.offsetWidth; // force reflow so re-adding the class replays the keyframes
  el.className = `announce show ${a.tier}`;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    el.className = "announce";
  }, 1700);
}

/** Process one kill event and flash a streak milestone if warranted. */
export function announceKill(e: KillEvent, nowMs: number): void {
  const a = evaluateKill(e, nowMs);
  if (a) flash(a);
}

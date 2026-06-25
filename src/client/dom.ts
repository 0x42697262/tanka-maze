// Small DOM helpers shared by every client UI module.

/** Typed `document.getElementById`. */
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const screens = {
  menu: $("menu"),
  lobby: $("lobby"),
  game: $("game"),
};

/** Show one top-level screen (menu / lobby / game), hiding the others. */
export function show(name: keyof typeof screens): void {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle("hidden", key !== name);
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
/** Briefly flash a message at the bottom of the screen. */
export function toast(message: string): void {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
}

/** Escape a string for safe interpolation into innerHTML. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

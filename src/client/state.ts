// Shared client state + long-lived singletons. Modules read/write `state.*`
// (an object, so the live value is shared across modules — unlike a re-exported
// `let`, which can't be reassigned by importers).

import type { InputState, LobbyDTO, RosterEntry, RoundStanding } from "../shared/protocol.js";
import { $ } from "./dom.js";
import type { Input } from "./input.js";
import { Net } from "./net.js";
import { Renderer } from "./render.js";

// Singletons.
export const net = new Net();
export const canvas = $<HTMLCanvasElement>("canvas");
export const renderer = new Renderer(canvas);
export const colorInput = $<HTMLInputElement>("color");

/** Player id -> last measured round-trip latency (ms). */
export const latencies = new Map<string, number>();

export const IS_TOUCH =
  typeof window !== "undefined" &&
  (window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window);

// localStorage / sessionStorage keys.
export const STORAGE_KEY = "tanka-maze-name";
export const MOVE_KEY = "tanka-maze-move"; // "relative" | "eight"
export const COLOR_KEY = "tanka-maze-color";
export const SESSION_KEY = "tanka-maze-session";
export const FPS_KEY = "tanka-maze-fps"; // "30" | "60" | "120"
export const QUALITY_KEY = "tanka-maze-quality"; // "low" | "medium" | "high"

/** Render-quality presets → devicePixelRatio cap. */
export const QUALITY_DPR: Record<"low" | "medium" | "high", number> = {
  low: 1,
  medium: 1.5,
  high: Infinity,
};

export const PRESET_COLORS = [
  "#e6453f",
  "#3f8ce6",
  "#46c24f",
  "#e6c23f",
  "#b04fe6",
  "#e6863f",
  "#3fd9e6",
  "#e63f9e",
];

/** In-game team tints (also used as a fallback when no team color is set). */
export const TEAM_TINT = ["#3f8ce6", "#e6453f", "#46c24f", "#e6c23f"];

/** Sent to halt the tank (e.g. while paused). */
export const IDLE_INPUT: InputState = {
  forward: false,
  backward: false,
  turnLeft: false,
  turnRight: false,
  fire: false,
  aim: 0,
  eightDir: false,
  joystick: false,
};

/** Mutable, shared application state. */
export interface AppState {
  input: Input | null;
  playerId: string;
  currentLobby: LobbyDTO | null;
  inGame: boolean;
  paused: boolean;
  lastInputSent: number;
  lastInputBytes: Uint8Array | null;
  roster: Map<number, RosterEntry>;
  arena: { w: number; h: number } | null;
  moveMode: "relative" | "eight";
  fpsCap: 30 | 60 | 120;
  quality: "low" | "medium" | "high";
  roundInfo: { round: number; total: number };
  roundStanding: RoundStanding[];
  roundCountdown: ReturnType<typeof setInterval> | null;
  scoreboardOpen: boolean;
  scoreboardTimer: ReturnType<typeof setInterval> | null;
}

export const state: AppState = {
  input: null,
  playerId: "",
  currentLobby: null,
  inGame: false,
  paused: false,
  lastInputSent: 0,
  lastInputBytes: null,
  roster: new Map(),
  arena: null,
  moveMode: "relative",
  fpsCap: 60,
  quality: "medium",
  roundInfo: { round: 1, total: 1 },
  roundStanding: [],
  roundCountdown: null,
  scoreboardOpen: false,
  scoreboardTimer: null,
};

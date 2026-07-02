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
export const THEME_KEY = "tanka-maze-theme";
export const BGM_KEY = "tanka-maze-bgm";
export const BGM_VOL_KEY = "tanka-maze-bgm-vol";
export const SFX_VOL_KEY = "tanka-sfx-vol";
export const RADAR_KEY = "tanka-maze-radar"; // personal radar toggle ("false" = off)
export const RETRO_KEY = "tanka-maze-retro"; // retro 8-bit mode toggle
export const BATTLECITY_KEY = "tanka-maze-battlecity"; // Battle City skin toggle
export const BCTANK_KEY = "tanka-maze-bctank"; // Battle City tank style ("basic" | "fast" | "heavy" | "armored")
export const MODERN_KEY = "tanka-maze-modern"; // Modern 4K skin toggle
export const MODERN_STYLE_KEY = "tanka-maze-modern-style"; // Modern tank style ("railgun" | "hover" | "plasma" | "siege")
export const REALISTIC_KEY = "tanka-maze-realistic"; // Realistic military skin toggle
export const REALISTIC_STYLE_KEY = "tanka-maze-realistic-style"; // Realistic tank style ("abrams" | "leopard" | "t90" | "bradley")

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
  theme: string;
  bgmEnabled: boolean;
  bgmVolume: number;
  sfxVolume: number;
  radarEnabled: boolean;
  moveMode: "relative" | "eight";
  fpsCap: 30 | 60 | 120;
  quality: "low" | "medium" | "high";
  retroEnabled: boolean;
  battleCityEnabled: boolean;
  retroStyle: "basic" | "fast" | "heavy" | "armored";
  modernEnabled: boolean;
  modernStyle: "railgun" | "hover" | "plasma" | "siege";
  realisticEnabled: boolean;
  realisticStyle: "abrams" | "leopard" | "t90" | "bradley";
  roundInfo: { round: number; total: number };
  roundStanding: RoundStanding[];
  roundCountdown: ReturnType<typeof setInterval> | null;
  scoreboardOpen: boolean;
  scoreboardTimer: ReturnType<typeof setInterval> | null;
  matchStartTime: number | null;
  matchEndTimeout: ReturnType<typeof setTimeout> | null;
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
  theme: "parchment",
  bgmEnabled: localStorage.getItem(BGM_KEY) !== "false",
  bgmVolume: parseFloat(localStorage.getItem(BGM_VOL_KEY) ?? "0.5"),
  sfxVolume: parseFloat(localStorage.getItem(SFX_VOL_KEY) ?? "1.0"),
  radarEnabled: localStorage.getItem(RADAR_KEY) !== "false",
  moveMode: "relative",
  fpsCap: 60,
  quality: "medium",
  retroEnabled: localStorage.getItem(RETRO_KEY) === "true",
  battleCityEnabled: localStorage.getItem(BATTLECITY_KEY) === "true",
  retroStyle: (localStorage.getItem(BCTANK_KEY) ?? "basic") as any,
  modernEnabled: localStorage.getItem(MODERN_KEY) === "true",
  modernStyle: (localStorage.getItem(MODERN_STYLE_KEY) ?? "railgun") as any,
  realisticEnabled: localStorage.getItem(REALISTIC_KEY) === "true",
  realisticStyle: (localStorage.getItem(REALISTIC_STYLE_KEY) ?? "abrams") as any,
  roundInfo: { round: 1, total: 1 },
  roundStanding: [],
  roundCountdown: null,
  scoreboardOpen: false,
  scoreboardTimer: null,
  matchStartTime: null,
  matchEndTimeout: null,
};

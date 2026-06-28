import { CELL, MAZE_COLS, MAZE_ROWS } from "./constants.js";

const NORMAL_MAP_AREA = MAZE_COLS * CELL * MAZE_ROWS * CELL;

/**
 * Scale a configured vision radius by map area so the same setting reveals a
 * comparable fraction of small, normal, large, and random arenas.
 */
export function effectiveVisionRadius(baseRadius: number, mapWidth: number, mapHeight: number): number {
  const area = Math.max(1, mapWidth * mapHeight);
  return baseRadius * Math.sqrt(area / NORMAL_MAP_AREA);
}

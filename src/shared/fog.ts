import { CELL, MAZE_COLS, MAZE_ROWS } from "./constants.js";

const NORMAL_MAP_AREA = MAZE_COLS * CELL * MAZE_ROWS * CELL;
const CIRCLE_SAMPLES = 128;
const RAY_EPS = 0.000001;
const GEOM_EPS = 1e-7;

export interface FogPoint {
  x: number;
  y: number;
}

export interface FogWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface FogRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FogShape =
  | ({ kind: "rect" } & FogRect)
  | { kind: "circle"; x: number; y: number; radius: number }
  | { kind: "polygon"; points: FogPoint[] };

export interface FogShapeInput {
  x: number;
  y: number;
  radius: number;
  seesThroughWalls: boolean;
  arena: FogRect;
  walls: readonly FogWall[];
}

/**
 * Scale a configured vision radius by map area so the same setting reveals a
 * comparable fraction of small, normal, large, and random arenas.
 */
export function effectiveVisionRadius(baseRadius: number, mapWidth: number, mapHeight: number): number {
  const area = Math.max(1, mapWidth * mapHeight);
  return baseRadius * Math.sqrt(area / NORMAL_MAP_AREA);
}

/**
 * Build one renderable reveal shape for a fog source. Fast paths keep common
 * cases exact: x-ray / open sight is a rect or circle, while wall-blocked sight
 * uses an event-ray visibility polygon against only nearby internal walls.
 */
export function buildFogShape(input: FogShapeInput): FogShape {
  const arena = input.arena;
  const radius = Math.max(0, input.radius);
  const fullArena = circleCoversRect(input.x, input.y, radius, arena);
  const blockers = input.seesThroughWalls ? [] : activeBlockers(input.x, input.y, radius, arena, input.walls);

  if (fullArena && blockers.length === 0) return { kind: "rect", ...arena };
  if (input.seesThroughWalls || blockers.length === 0) return { kind: "circle", x: input.x, y: input.y, radius };

  const segments = [...arenaSegments(arena), ...blockers];
  const angles = visibilityAngles(input.x, input.y, radius, arena, blockers, fullArena);
  const points = dedupePoints(angles.map((angle) => castRay(input.x, input.y, angle, radius, segments)));
  return { kind: "polygon", points };
}

export function pointInFogShape(x: number, y: number, shape: FogShape): boolean {
  switch (shape.kind) {
    case "rect":
      return x >= shape.x && x <= shape.x + shape.width && y >= shape.y && y <= shape.y + shape.height;
    case "circle":
      return (x - shape.x) ** 2 + (y - shape.y) ** 2 <= shape.radius * shape.radius + GEOM_EPS;
    case "polygon":
      return pointInPolygon(x, y, shape.points);
  }
}

function activeBlockers(
  x: number,
  y: number,
  radius: number,
  arena: FogRect,
  walls: readonly FogWall[]
): FogWall[] {
  const r2 = radius * radius;
  return walls.filter((w) => !isArenaBoundaryWall(w, arena) && pointSegDist2(x, y, w.x1, w.y1, w.x2, w.y2) <= r2);
}

function visibilityAngles(
  x: number,
  y: number,
  radius: number,
  arena: FogRect,
  blockers: readonly FogWall[],
  fullArena: boolean
): number[] {
  const angles: number[] = [];
  const add = (angle: number) => angles.push(normalizeAngle(angle));
  const addPoint = (px: number, py: number, straddle: boolean) => {
    const a = Math.atan2(py - y, px - x);
    if (straddle) add(a - RAY_EPS);
    add(a);
    if (straddle) add(a + RAY_EPS);
  };

  // The arena rectangle is the hard outer clip. Exact corner rays prevent the
  // visibility polygon from cutting a visible map corner with a chord.
  for (const p of arenaCorners(arena)) addPoint(p.x, p.y, false);

  // If the sight radius ends inside the arena, sample that circular boundary.
  // Full-arena sight needs no coarse samples; wall/corner events are exact.
  if (!fullArena) {
    const span = Math.PI * 2;
    for (let i = 0; i < CIRCLE_SAMPLES; i++) add((span * i) / CIRCLE_SAMPLES);
  }

  const r2 = radius * radius;
  for (const w of blockers) {
    for (const p of [
      { x: w.x1, y: w.y1 },
      { x: w.x2, y: w.y2 },
    ]) {
      if ((p.x - x) ** 2 + (p.y - y) ** 2 <= r2 + GEOM_EPS) addPoint(p.x, p.y, true);
    }
    for (const p of segmentCircleIntersections(x, y, radius, w)) addPoint(p.x, p.y, true);
  }

  for (let i = 0; i < blockers.length; i++) {
    for (let j = i + 1; j < blockers.length; j++) {
      const p = segmentIntersectionPoint(blockers[i], blockers[j]);
      if (p && (p.x - x) ** 2 + (p.y - y) ** 2 <= r2 + GEOM_EPS) addPoint(p.x, p.y, true);
    }
  }

  return withMidpointAngles(dedupeAngles(angles));
}

function castRay(x: number, y: number, angle: number, radius: number, segments: readonly FogWall[]): FogPoint {
  const rx = Math.cos(angle);
  const ry = Math.sin(angle);
  let best = radius;
  for (const s of segments) {
    const hit = raySegmentDistance(x, y, rx, ry, s.x1, s.y1, s.x2, s.y2);
    if (hit !== null && hit < best) best = hit;
  }
  return { x: x + rx * best, y: y + ry * best };
}

function circleCoversRect(x: number, y: number, radius: number, rect: FogRect): boolean {
  const r2 = radius * radius;
  return arenaCorners(rect).every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 <= r2 + GEOM_EPS);
}

function arenaCorners(rect: FogRect): FogPoint[] {
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  return [
    { x: rect.x, y: rect.y },
    { x: x2, y: rect.y },
    { x: x2, y: y2 },
    { x: rect.x, y: y2 },
  ];
}

function arenaSegments(rect: FogRect): FogWall[] {
  const [a, b, c, d] = arenaCorners(rect);
  return [
    { x1: a.x, y1: a.y, x2: b.x, y2: b.y },
    { x1: b.x, y1: b.y, x2: c.x, y2: c.y },
    { x1: c.x, y1: c.y, x2: d.x, y2: d.y },
    { x1: d.x, y1: d.y, x2: a.x, y2: a.y },
  ];
}

function isArenaBoundaryWall(w: FogWall, arena: FogRect): boolean {
  const x1 = arena.x;
  const y1 = arena.y;
  const x2 = arena.x + arena.width;
  const y2 = arena.y + arena.height;
  return (
    (w.x1 === x1 && w.x2 === x1) ||
    (w.x1 === x2 && w.x2 === x2) ||
    (w.y1 === y1 && w.y2 === y1) ||
    (w.y1 === y2 && w.y2 === y2)
  );
}

function segmentCircleIntersections(cx: number, cy: number, radius: number, w: FogWall): FogPoint[] {
  const dx = w.x2 - w.x1;
  const dy = w.y2 - w.y1;
  const fx = w.x1 - cx;
  const fy = w.y1 - cy;
  const a = dx * dx + dy * dy;
  if (a <= GEOM_EPS) return [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < -GEOM_EPS) return [];
  const root = Math.sqrt(Math.max(0, disc));
  const out: FogPoint[] = [];
  for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
    if (t > GEOM_EPS && t < 1 - GEOM_EPS) out.push({ x: w.x1 + dx * t, y: w.y1 + dy * t });
  }
  return dedupePoints(out);
}

function segmentIntersectionPoint(a: FogWall, b: FogWall): FogPoint | null {
  const ax = a.x2 - a.x1;
  const ay = a.y2 - a.y1;
  const bx = b.x2 - b.x1;
  const by = b.y2 - b.y1;
  const denom = ax * by - ay * bx;
  if (Math.abs(denom) < 1e-9) return null;
  const qx = b.x1 - a.x1;
  const qy = b.y1 - a.y1;
  const t = (qx * by - qy * bx) / denom;
  const u = (qx * ay - qy * ax) / denom;
  if (t < -GEOM_EPS || t > 1 + GEOM_EPS || u < -GEOM_EPS || u > 1 + GEOM_EPS) return null;
  return { x: a.x1 + ax * t, y: a.y1 + ay * t };
}

function normalizeAngle(a: number): number {
  const v = a % (Math.PI * 2);
  return v < 0 ? v + Math.PI * 2 : v;
}

function dedupeAngles(angles: number[]): number[] {
  const sorted = [...angles].sort((a, b) => a - b);
  const out: number[] = [];
  for (const a of sorted) {
    if (out.length === 0 || Math.abs(a - out[out.length - 1]) > GEOM_EPS) out.push(a);
  }
  if (out.length > 1 && Math.abs(out[0] + Math.PI * 2 - out[out.length - 1]) <= GEOM_EPS) out.pop();
  return out;
}

function withMidpointAngles(angles: number[]): number[] {
  if (angles.length < 2) return angles;
  const out = [...angles];
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i];
    const b = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
    out.push(normalizeAngle((a + b) / 2));
  }
  return dedupeAngles(out);
}

function dedupePoints(points: FogPoint[]): FogPoint[] {
  const out: FogPoint[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || (p.x - prev.x) ** 2 + (p.y - prev.y) ** 2 > GEOM_EPS) out.push(p);
  }
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if ((first.x - last.x) ** 2 + (first.y - last.y) ** 2 <= GEOM_EPS) out.pop();
  }
  return out;
}

/** Distance along a unit ray to its first intersection with a segment. */
function raySegmentDistance(
  ox: number,
  oy: number,
  rx: number,
  ry: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number | null {
  const sx = bx - ax;
  const sy = by - ay;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qx = ax - ox;
  const qy = ay - oy;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  return t >= 0 && u >= 0 && u <= 1 ? t : null;
}

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by). */
function pointSegDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

function pointInPolygon(x: number, y: number, points: readonly FogPoint[]): boolean {
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j];
    const b = points[i];
    if (pointSegDist2(x, y, a.x, a.y, b.x, b.y) <= 1e-5) return true;
    if ((a.y > y) !== (b.y > y)) {
      const ix = ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
      if (x < ix) inside = !inside;
    }
  }
  return inside;
}

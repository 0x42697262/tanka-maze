import type { SnapshotDTO } from "../../shared/protocol.js";

export interface BufferedSnapshot {
  readonly snapshot: SnapshotDTO;
  readonly receivedAtMs: number;
}

export interface SnapshotPair {
  readonly previous: BufferedSnapshot;
  readonly next: BufferedSnapshot;
  readonly alpha: number;
}

const DEFAULT_MAX_SNAPSHOTS = 30;

/**
 * Render-buffer for remote authoritative snapshots. Rendering a short delay in
 * the past gives the client two server frames to interpolate between, hiding the
 * lower-frequency network tick without client-side physics authority.
 */
export class SnapshotInterpolationBuffer {
  private readonly snapshots: BufferedSnapshot[] = [];

  constructor(private readonly maxSnapshots = DEFAULT_MAX_SNAPSHOTS) {}

  push(snapshot: SnapshotDTO, receivedAtMs: number): void {
    this.snapshots.push({ snapshot, receivedAtMs });
    while (this.snapshots.length > this.maxSnapshots) this.snapshots.shift();
  }

  latest(): SnapshotDTO | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1].snapshot : null;
  }

  pairFor(renderTimeMs: number): SnapshotPair | null {
    if (this.snapshots.length === 0) return null;
    if (this.snapshots.length === 1) {
      const only = this.snapshots[0];
      return { previous: only, next: only, alpha: 1 };
    }

    let previous = this.snapshots[0];
    let next = this.snapshots[this.snapshots.length - 1];
    for (let i = 0; i < this.snapshots.length - 1; i++) {
      if (this.snapshots[i].receivedAtMs <= renderTimeMs && this.snapshots[i + 1].receivedAtMs >= renderTimeMs) {
        previous = this.snapshots[i];
        next = this.snapshots[i + 1];
        break;
      }
    }

    const span = next.receivedAtMs - previous.receivedAtMs;
    const alpha = span > 0 ? clamp01((renderTimeMs - previous.receivedAtMs) / span) : 1;
    return { previous, next, alpha };
  }

  clear(): void {
    this.snapshots.length = 0;
  }

  get frames(): readonly BufferedSnapshot[] {
    return this.snapshots;
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

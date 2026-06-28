import type { InputState } from "../../shared/protocol.js";

export interface PredictedInputFrame {
  readonly sequence: number;
  readonly sentAtMs: number;
  readonly input: InputState;
}

/**
 * Stores local inputs in order so a future authoritative correction can rewind
 * to the accepted server frame and re-simulate unacknowledged client inputs.
 * Current gameplay remains server-authoritative and interpolation-only.
 */
export class InputHistoryBuffer {
  private readonly frames: PredictedInputFrame[] = [];
  private nextSequence = 1;

  push(input: InputState, sentAtMs: number): PredictedInputFrame {
    const frame: PredictedInputFrame = {
      sequence: this.nextSequence++,
      sentAtMs,
      input: { ...input },
    };
    this.frames.push(frame);
    return frame;
  }

  acknowledge(sequence: number): void {
    while (this.frames.length > 0 && this.frames[0].sequence <= sequence) {
      this.frames.shift();
    }
  }

  clear(): void {
    this.frames.length = 0;
  }

  get pending(): readonly PredictedInputFrame[] {
    return this.frames;
  }
}

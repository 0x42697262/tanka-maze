import { TICK_RATE } from "../../shared/constants.js";

export interface FixedTimestepLoopOptions {
  readonly fixedStepSeconds?: number;
  readonly maxFrameSeconds?: number;
}

export interface FixedTimestepLoopCallbacks {
  readonly update: (dt: number) => void;
  readonly render: (alpha: number, nowMs: number) => void;
}

const DEFAULT_MAX_FRAME_SECONDS = 0.1;

/**
 * Browser RAF loop with a deterministic fixed update accumulator and an
 * uncapped render pass. The default update rate intentionally follows the
 * authoritative server's 30 Hz simulation to preserve existing game feel.
 */
export class FixedTimestepLoop {
  private readonly fixedStepSeconds: number;
  private readonly maxFrameSeconds: number;
  private frameHandle = 0;
  private previousMs = 0;
  private accumulator = 0;
  private running = false;

  constructor(
    private readonly callbacks: FixedTimestepLoopCallbacks,
    options: FixedTimestepLoopOptions = {}
  ) {
    this.fixedStepSeconds = options.fixedStepSeconds ?? 1 / TICK_RATE;
    this.maxFrameSeconds = options.maxFrameSeconds ?? DEFAULT_MAX_FRAME_SECONDS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.previousMs = performance.now();
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.accumulator = 0;
  }

  private readonly frame = (nowMs: number): void => {
    if (!this.running) return;
    const frameSeconds = Math.min(this.maxFrameSeconds, Math.max(0, (nowMs - this.previousMs) / 1000));
    this.previousMs = nowMs;
    this.accumulator += frameSeconds;

    while (this.accumulator >= this.fixedStepSeconds) {
      this.callbacks.update(this.fixedStepSeconds);
      this.accumulator -= this.fixedStepSeconds;
    }

    this.callbacks.render(this.accumulator / this.fixedStepSeconds, nowMs);
    this.frameHandle = requestAnimationFrame(this.frame);
  };
}

import { FixedTimestepLoop, type FixedTimestepLoopOptions } from "./FixedTimestepLoop.js";

export interface Scene {
  enter?(): void;
  exit?(): void;
  update(dt: number): void;
  render(alpha: number, nowMs: number): void;
}

/**
 * Minimal scene-driven client engine. It keeps update/render orchestration away
 * from DOM modules and allows menu, lobby, play, and game-over scenes to evolve
 * independently without a monolithic browser entry point.
 */
export class Engine {
  private readonly loop: FixedTimestepLoop;
  private scene: Scene | null = null;

  constructor(options: FixedTimestepLoopOptions = {}) {
    this.loop = new FixedTimestepLoop(
      {
        update: (dt) => this.scene?.update(dt),
        render: (alpha, nowMs) => this.scene?.render(alpha, nowMs),
      },
      options
    );
  }

  setScene(scene: Scene): void {
    this.scene?.exit?.();
    this.scene = scene;
    this.scene.enter?.();
  }

  /** Cap the render frame rate (see FixedTimestepLoop.setRenderHz). */
  setRenderHz(hz: number): void {
    this.loop.setRenderHz(hz);
  }

  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }
}

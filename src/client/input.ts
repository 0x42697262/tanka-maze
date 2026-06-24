import type { InputState } from "../shared/protocol.js";

/**
 * Tracks keyboard + mouse and produces an InputState. The aim angle is computed
 * from the mouse position relative to the local tank's *world* position, which
 * the caller supplies each frame.
 */
export class Input {
  private keys = new Set<string>();
  private mouseDown = false;
  private mouseX = 0; // canvas (world) pixel space
  private mouseY = 0;
  private canvas: HTMLCanvasElement;
  /** Control scheme: true = 8-direction world movement. Set from settings. */
  eightDir = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    canvas.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.keys.clear();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Space fires; prevent it from scrolling the page.
    if (e.code === "Space") e.preventDefault();
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  private onMouseMove = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    this.mouseX = (e.clientX - rect.left) * scaleX;
    this.mouseY = (e.clientY - rect.top) * scaleY;
  };
  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) this.mouseDown = true;
  };
  private onMouseUp = () => {
    this.mouseDown = false;
  };

  /** Build the input snapshot, aiming the turret from (tankX, tankY). */
  getState(tankX: number, tankY: number): InputState {
    return {
      forward: this.keys.has("KeyW") || this.keys.has("ArrowUp"),
      backward: this.keys.has("KeyS") || this.keys.has("ArrowDown"),
      turnLeft: this.keys.has("KeyA") || this.keys.has("ArrowLeft"),
      turnRight: this.keys.has("KeyD") || this.keys.has("ArrowRight"),
      fire: this.mouseDown || this.keys.has("Space"),
      aim: Math.atan2(this.mouseY - tankY, this.mouseX - tankX),
      eightDir: this.eightDir,
    };
  }
}

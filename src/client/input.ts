import type { InputState } from "../shared/protocol.js";

/**
 * Tracks keyboard + mouse and produces an InputState. The aim angle is computed
 * from the mouse position relative to the local tank's *world* position, which
 * the caller supplies each frame.
 *
 * On touch devices a twin-stick scheme is layered on top: a left stick drives
 * (mapped to the same forward/back/turn booleans) and a right stick aims and
 * fires. Either input source can drive the tank; they're OR-ed together.
 */
export class Input {
  private keys = new Set<string>();
  private mouseDown = false;
  private mouseX = 0; // canvas (world) pixel space
  private mouseY = 0;
  private canvas: HTMLCanvasElement;
  /** Control scheme: true = 8-direction world movement. Set from settings. */
  eightDir = false;

  // Touch (twin-stick) state.
  private moveBase: HTMLElement | null = null;
  private moveKnob: HTMLElement | null = null;
  private aimBase: HTMLElement | null = null;
  private aimKnob: HTMLElement | null = null;
  private moveId: number | null = null;
  private aimId: number | null = null;
  private moveX = 0; // normalized -1..1
  private moveY = 0;
  private aimActive = false;
  private aimAngle = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    canvas.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** Wire the on-screen joysticks (touch devices). */
  enableTouch(moveBase: HTMLElement, aimBase: HTMLElement): void {
    this.moveBase = moveBase;
    this.moveKnob = moveBase.querySelector(".stick-knob");
    this.aimBase = aimBase;
    this.aimKnob = aimBase.querySelector(".stick-knob");
    moveBase.addEventListener("touchstart", this.onMoveStart, { passive: false });
    moveBase.addEventListener("touchmove", this.onMoveMove, { passive: false });
    moveBase.addEventListener("touchend", this.onMoveEnd);
    moveBase.addEventListener("touchcancel", this.onMoveEnd);
    aimBase.addEventListener("touchstart", this.onAimStart, { passive: false });
    aimBase.addEventListener("touchmove", this.onAimMove, { passive: false });
    aimBase.addEventListener("touchend", this.onAimEnd);
    aimBase.addEventListener("touchcancel", this.onAimEnd);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    if (this.moveBase) {
      this.moveBase.removeEventListener("touchstart", this.onMoveStart);
      this.moveBase.removeEventListener("touchmove", this.onMoveMove);
      this.moveBase.removeEventListener("touchend", this.onMoveEnd);
      this.moveBase.removeEventListener("touchcancel", this.onMoveEnd);
    }
    if (this.aimBase) {
      this.aimBase.removeEventListener("touchstart", this.onAimStart);
      this.aimBase.removeEventListener("touchmove", this.onAimMove);
      this.aimBase.removeEventListener("touchend", this.onAimEnd);
      this.aimBase.removeEventListener("touchcancel", this.onAimEnd);
    }
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

  // --- Touch joysticks -----------------------------------------------------
  private stickVec(base: HTMLElement, t: Touch): { kx: number; ky: number; nx: number; ny: number; dist: number } {
    const r = base.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const rad = r.width / 2;
    const dx = t.clientX - cx;
    const dy = t.clientY - cy;
    const dist = Math.hypot(dx, dy) || 0.0001;
    const clamped = Math.min(dist, rad);
    return { kx: (dx / dist) * clamped, ky: (dy / dist) * clamped, nx: dx / rad, ny: dy / rad, dist };
  }

  private onMoveStart = (e: TouchEvent) => {
    e.preventDefault();
    if (this.moveId !== null) return;
    const t = e.changedTouches[0];
    this.moveId = t.identifier;
    this.applyMove(t);
  };
  private onMoveMove = (e: TouchEvent) => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) if (t.identifier === this.moveId) this.applyMove(t);
  };
  private onMoveEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.moveId) {
        this.moveId = null;
        this.moveX = 0;
        this.moveY = 0;
        if (this.moveKnob) this.moveKnob.style.transform = "";
      }
    }
  };
  private applyMove(t: Touch): void {
    if (!this.moveBase) return;
    const v = this.stickVec(this.moveBase, t);
    if (this.moveKnob) this.moveKnob.style.transform = `translate(${v.kx}px, ${v.ky}px)`;
    this.moveX = Math.max(-1, Math.min(1, v.nx));
    this.moveY = Math.max(-1, Math.min(1, v.ny));
  }

  private onAimStart = (e: TouchEvent) => {
    e.preventDefault();
    if (this.aimId !== null) return;
    const t = e.changedTouches[0];
    this.aimId = t.identifier;
    this.aimActive = true;
    this.applyAim(t);
  };
  private onAimMove = (e: TouchEvent) => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) if (t.identifier === this.aimId) this.applyAim(t);
  };
  private onAimEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.aimId) {
        this.aimId = null;
        this.aimActive = false;
        if (this.aimKnob) this.aimKnob.style.transform = "";
      }
    }
  };
  private applyAim(t: Touch): void {
    if (!this.aimBase) return;
    const v = this.stickVec(this.aimBase, t);
    if (this.aimKnob) this.aimKnob.style.transform = `translate(${v.kx}px, ${v.ky}px)`;
    const r = this.aimBase.getBoundingClientRect();
    // Only re-aim once the stick is pushed past a small dead zone.
    if (v.dist > r.width * 0.12) this.aimAngle = Math.atan2(v.ky, v.kx);
  }

  /** Build the input snapshot, aiming the turret from (tankX, tankY). */
  getState(tankX: number, tankY: number): InputState {
    const DZ = 0.35; // stick dead zone before a direction registers
    return {
      forward: this.keys.has("KeyW") || this.keys.has("ArrowUp") || this.moveY < -DZ,
      backward: this.keys.has("KeyS") || this.keys.has("ArrowDown") || this.moveY > DZ,
      turnLeft: this.keys.has("KeyA") || this.keys.has("ArrowLeft") || this.moveX < -DZ,
      turnRight: this.keys.has("KeyD") || this.keys.has("ArrowRight") || this.moveX > DZ,
      fire: this.mouseDown || this.keys.has("Space") || this.aimActive,
      aim: this.aimActive ? this.aimAngle : Math.atan2(this.mouseY - tankY, this.mouseX - tankX),
      eightDir: this.eightDir,
    };
  }
}

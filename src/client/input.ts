import type { InputState } from "../shared/protocol.js";
import {
  FireCommand,
  MoveBackwardCommand,
  MoveForwardCommand,
  TurnLeftCommand,
  TurnRightCommand,
  type InputCommand,
} from "./input/commands.js";

const KEY_SPACE = "Space";
const KEY_BINDINGS: ReadonlyArray<readonly [string, InputCommand]> = [
  ["KeyW", new MoveForwardCommand()],
  ["ArrowUp", new MoveForwardCommand()],
  ["KeyS", new MoveBackwardCommand()],
  ["ArrowDown", new MoveBackwardCommand()],
  ["KeyA", new TurnLeftCommand()],
  ["ArrowLeft", new TurnLeftCommand()],
  ["KeyD", new TurnRightCommand()],
  ["ArrowRight", new TurnRightCommand()],
  [KEY_SPACE, new FireCommand()],
];

/**
 * Tracks keyboard + mouse and produces an InputState. The aim angle is computed
 * from the mouse position relative to the local tank's *world* position, which
 * the caller supplies each frame.
 *
 * On touch devices a single 360° joystick controls movement: the tank faces and
 * drives toward the stick direction (`joystick` mode on the server), and the
 * turret/shot follow that same heading. A separate fire button shoots.
 */
export class InputManager {
  private keys = new Set<string>();
  private mouseDown = false;
  private mouseX = 0; // canvas (world) pixel space
  private mouseY = 0;
  private canvas: HTMLCanvasElement;
  /** Control scheme: true = 8-direction world movement. Set from settings. */
  eightDir = false;

  // Touch (single-joystick) state.
  private touchMode = false;
  private moveBase: HTMLElement | null = null;
  private moveKnob: HTMLElement | null = null;
  private fireBtn: HTMLElement | null = null;
  private moveId: number | null = null;
  private moveActive = false; // stick pushed past the dead zone
  private moveAngle = 0; // last stick heading (retained when released)
  private touchFire = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    canvas.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** Wire the on-screen joystick + fire button (touch devices). */
  enableTouch(moveBase: HTMLElement, fireBtn: HTMLElement): void {
    this.touchMode = true;
    this.moveBase = moveBase;
    this.moveKnob = moveBase.querySelector(".stick-knob");
    this.fireBtn = fireBtn;
    moveBase.addEventListener("touchstart", this.onMoveStart, { passive: false });
    moveBase.addEventListener("touchmove", this.onMoveMove, { passive: false });
    moveBase.addEventListener("touchend", this.onMoveEnd);
    moveBase.addEventListener("touchcancel", this.onMoveEnd);
    fireBtn.addEventListener("touchstart", this.onFireDown, { passive: false });
    fireBtn.addEventListener("touchend", this.onFireUp);
    fireBtn.addEventListener("touchcancel", this.onFireUp);
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
    if (this.fireBtn) {
      this.fireBtn.removeEventListener("touchstart", this.onFireDown);
      this.fireBtn.removeEventListener("touchend", this.onFireUp);
      this.fireBtn.removeEventListener("touchcancel", this.onFireUp);
    }
    this.keys.clear();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === KEY_SPACE) e.preventDefault();
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  private onMouseMove = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const worldWidth = Number(this.canvas.dataset.worldWidth) || this.canvas.width;
    const worldHeight = Number(this.canvas.dataset.worldHeight) || this.canvas.height;
    const scaleX = worldWidth / rect.width;
    const scaleY = worldHeight / rect.height;
    this.mouseX = (e.clientX - rect.left) * scaleX;
    this.mouseY = (e.clientY - rect.top) * scaleY;
  };
  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) this.mouseDown = true;
  };
  private onMouseUp = () => {
    this.mouseDown = false;
  };

  // --- Touch joystick + fire button ----------------------------------------
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
        this.moveActive = false; // stop driving, but keep the last heading
        if (this.moveKnob) this.moveKnob.style.transform = "";
      }
    }
  };
  private applyMove(t: Touch): void {
    if (!this.moveBase) return;
    const r = this.moveBase.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const rad = r.width / 2;
    const dx = t.clientX - cx;
    const dy = t.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (this.moveKnob) {
      const cl = Math.min(dist || 0, rad);
      const ux = dx / (dist || 1);
      const uy = dy / (dist || 1);
      this.moveKnob.style.transform = `translate(${ux * cl}px, ${uy * cl}px)`;
    }
    // Past a small dead zone the tank drives toward (and faces) the stick.
    if (dist > rad * 0.28) {
      this.moveActive = true;
      this.moveAngle = Math.atan2(dy, dx);
    } else {
      this.moveActive = false;
    }
  }

  private onFireDown = (e: TouchEvent) => {
    e.preventDefault();
    this.touchFire = true;
  };
  private onFireUp = () => {
    this.touchFire = false;
  };

  /** Build the input snapshot, aiming the turret from (tankX, tankY). */
  getState(tankX: number, tankY: number): InputState {
    if (this.touchMode) {
      // Single-stick: move + face + shoot along one heading; button fires.
      return {
        forward: this.moveActive,
        backward: false,
        turnLeft: false,
        turnRight: false,
        fire: this.touchFire,
        aim: this.moveAngle,
        eightDir: false,
        joystick: true,
      };
    }
    const state: InputState = {
      forward: false,
      backward: false,
      turnLeft: false,
      turnRight: false,
      fire: this.mouseDown,
      aim: Math.atan2(this.mouseY - tankY, this.mouseX - tankX),
      eightDir: this.eightDir,
      joystick: false,
    };
    this.applyCommands(state);
    return state;
  }

  private applyCommands(state: InputState): void {
    for (const [code, command] of KEY_BINDINGS) {
      if (this.keys.has(code)) command.execute(state);
    }
  }
}

export { InputManager as Input };

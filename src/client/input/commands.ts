import type { InputState } from "../../shared/protocol.js";

export type InputAction =
  | "moveForward"
  | "moveBackward"
  | "turnLeft"
  | "turnRight"
  | "fire"
  | "aim"
  | "joystickMove";

export interface InputCommand {
  readonly action: InputAction;
  execute(state: MutableInputState): void;
}

export type MutableInputState = InputState;

export class MoveForwardCommand implements InputCommand {
  readonly action = "moveForward";
  execute(state: MutableInputState): void {
    state.forward = true;
  }
}

export class MoveBackwardCommand implements InputCommand {
  readonly action = "moveBackward";
  execute(state: MutableInputState): void {
    state.backward = true;
  }
}

export class TurnLeftCommand implements InputCommand {
  readonly action = "turnLeft";
  execute(state: MutableInputState): void {
    state.turnLeft = true;
  }
}

export class TurnRightCommand implements InputCommand {
  readonly action = "turnRight";
  execute(state: MutableInputState): void {
    state.turnRight = true;
  }
}

export class FireCommand implements InputCommand {
  readonly action = "fire";
  execute(state: MutableInputState): void {
    state.fire = true;
  }
}

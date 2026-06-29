import type { InputState, SnapshotDTO } from "../../shared/protocol.js";
import type { PredictedInputFrame } from "./InputHistoryBuffer.js";

export interface AuthoritativeCorrection {
  readonly acknowledgedInputSequence: number;
  readonly snapshot: SnapshotDTO;
}

export interface ClientPredictionModel<TState> {
  applyInput(state: TState, input: InputState, dt: number): TState;
  fromSnapshot(snapshot: SnapshotDTO): TState;
}

/**
 * Stateless reconciliation helper. It is intentionally generic so prediction can
 * be introduced for the local player without changing bullet or tank mechanics.
 */
export function reconcile<TState>(
  model: ClientPredictionModel<TState>,
  correction: AuthoritativeCorrection,
  pendingInputs: readonly PredictedInputFrame[],
  fixedDt: number
): TState {
  let state = model.fromSnapshot(correction.snapshot);
  for (const frame of pendingInputs) {
    if (frame.sequence > correction.acknowledgedInputSequence) {
      state = model.applyInput(state, frame.input, fixedDt);
    }
  }
  return state;
}

import {
  ALLOWED_TRANSITIONS,
  type SessionState,
} from '../contracts/schemas'

/**
 * Custom error for invalid state transitions.
 * Carries the from/to states in the message and a machine-readable code.
 */
export class InvalidTransitionError extends Error {
  /** Machine-readable error code */
  readonly code = 'invalid_state_transition' as const
  /** The state the session was in */
  readonly from: SessionState
  /** The state the session tried to transition to */
  readonly to: SessionState

  constructor(from: SessionState, to: SessionState) {
    super(
      `Invalid state transition: ${from} → ${to}. ` +
      `Allowed from "${from}": [${(ALLOWED_TRANSITIONS[from] ?? []).join(', ')}]`,
    )
    this.name = 'InvalidTransitionError'
    this.from = from
    this.to = to
  }
}

/**
 * Checks whether a state transition is allowed by the C5 state machine.
 *
 * @param from - Current session state
 * @param to - Desired next state
 * @returns true if the transition is defined in ALLOWED_TRANSITIONS
 */
export function canTransition(from: SessionState, to: SessionState): boolean {
  const allowed = ALLOWED_TRANSITIONS[from]
  // istanbul ignore if: type-safe, but guard against undefined
  if (!allowed) return false
  return allowed.includes(to)
}

/**
 * Asserts that a state transition is legal. Throws InvalidTransitionError
 * with code 'invalid_state_transition' if the transition is not allowed.
 *
 * @param from - Current session state
 * @param to - Desired next state
 * @throws {InvalidTransitionError} if the transition is illegal
 */
export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to)
  }
}

/**
 * Returns true if the given state is a terminal state (session is finished).
 *
 * In the C5 state machine, only `done` is terminal — no further transitions
 * are expected in normal operation (though `done → refining` is allowed
 * for restore-edit flows).
 */
export function isTerminal(state: SessionState): boolean {
  return state === 'done'
}

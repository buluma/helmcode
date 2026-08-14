import * as Schedule from "effect/Schedule";

/**
 * Retry policy for the initial subprocess spawn of a provider CLI/app-server.
 * Spawn failures here (ENOENT during a PATH resolution race, EAGAIN under
 * process-table pressure, EBUSY right after a rapid respawn) are transient,
 * and spawning itself has no observable side effect to duplicate on retry.
 *
 * This must only wrap the spawn call itself, never a turn-start or
 * message-send: those are not safe to retry blindly, since the model or the
 * user's workspace may have already observed the first attempt's effects.
 */
export const PROVIDER_SPAWN_RETRY_SCHEDULE = Schedule.exponential("200 millis").pipe(
  Schedule.upTo({ times: 2 }),
);

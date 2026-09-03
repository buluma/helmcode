/**
 * ScheduleReactor - Scheduled task reactor service interface.
 *
 * Owns background fibers that fire scheduled turns on threads at configured
 * intervals/cron times. Subscribes to domain events for schedule lifecycle
 * and manages per-thread timer fibers.
 *
 * @module ScheduleReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ScheduleReactorShape - Service API for schedule reactor lifecycle.
 */
export interface ScheduleReactorShape {
  /**
   * Start reacting to thread.schedule.create / thread.unscheduled domain
   * events and fire due schedules.
   *
   * The returned effect must be run in a scope so all timer fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ScheduleReactor - Service tag for schedule reactor workers.
 */
export class ScheduleReactor extends Context.Service<ScheduleReactor, ScheduleReactorShape>()(
  "helmcode/orchestration/Services/ScheduleReactor",
) {}

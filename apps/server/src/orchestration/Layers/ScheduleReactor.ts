import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationThread,
  MessageId,
  type ThreadSchedule,
  ThreadId,
} from "@helmcode/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ScheduleReactor, type ScheduleReactorShape } from "../Services/ScheduleReactor.ts";

const RRULE_FREQ = /FREQ=(DAILY|WEEKLY|MONTHLY|HOURLY)/;
const RRULE_HOUR = /BYHOUR=(\d+)/;
const RRULE_MINUTE = /BYMINUTE=(\d+)/;
const RRULE_WEEKDAY = /BYDAY=(MO|TU|WE|TH|FR|SA|SU)/;
const WEEKDAY_TO_JS_DAY: Record<string, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 0,
};

/**
 * Compute the next run time for an interval- or cron-based schedule.
 * Supports the basic RRULE subset (FREQ=DAILY|WEEKLY|MONTHLY|HOURLY with
 * optional BYHOUR/BYMINUTE/BYDAY); anything else falls back to +1 hour.
 */
export const computeNextRunAt = (
  schedule: Pick<ThreadSchedule, "cron" | "intervalMs">,
  now: DateTime.DateTime,
): DateTime.DateTime => {
  if (schedule.intervalMs != null) {
    return DateTime.add(now, { milliseconds: Math.max(1, schedule.intervalMs) });
  }

  const cron = schedule.cron;
  if (cron == null) {
    // Fallback: 1 hour from now.
    return DateTime.add(now, { hours: 1 });
  }

  const upper = cron.toUpperCase();
  const freq = RRULE_FREQ.exec(upper)?.[1];
  const hour = RRULE_HOUR.exec(upper)?.[1];
  const minute = RRULE_MINUTE.exec(upper)?.[1];

  if (freq === "HOURLY") {
    // "Every hour at :BYMINUTE" (default :00), not a flat +1h from now.
    const targetMinute = minute === undefined ? 0 : Number(minute);
    let next = DateTime.makeUnsafe({
      year: DateTime.getPartUtc(now, "year"),
      month: DateTime.getPartUtc(now, "month"),
      day: DateTime.getPartUtc(now, "day"),
      hour: DateTime.getPartUtc(now, "hour"),
      minute: targetMinute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.isLessThanOrEqualTo(next, now)) {
      next = DateTime.add(next, { hours: 1 });
    }
    return next;
  }

  const targetHour = hour === undefined ? DateTime.getPartUtc(now, "hour") : Number(hour);
  const targetMinute = minute === undefined ? DateTime.getPartUtc(now, "minute") : Number(minute);

  // Build the candidate "this period at target time" as UTC.
  let next = DateTime.makeUnsafe({
    year: DateTime.getPartUtc(now, "year"),
    month: DateTime.getPartUtc(now, "month"),
    day: DateTime.getPartUtc(now, "day"),
    hour: targetHour,
    minute: targetMinute,
    second: 0,
    millisecond: 0,
  });

  if (freq === "WEEKLY") {
    const weekday = RRULE_WEEKDAY.exec(upper)?.[1];
    const targetDay = weekday === undefined ? 1 : (WEEKDAY_TO_JS_DAY[weekday] ?? 1);
    const currentDay = DateTime.getPartUtc(now, "weekDay");
    let daysAhead = targetDay - currentDay;
    // Target earlier in the week than today: roll to next week.
    if (daysAhead < 0) daysAhead += 7;
    // Same weekday but the target time already passed: roll to next week.
    if (daysAhead === 0 && DateTime.isLessThanOrEqualTo(next, now)) daysAhead = 7;
    next = DateTime.add(next, { days: daysAhead });
  } else if (DateTime.isLessThanOrEqualTo(next, now)) {
    // DAILY advances a day; MONTHLY advances a calendar month.
    next = DateTime.add(next, freq === "MONTHLY" ? { months: 1 } : { days: 1 });
  }

  return next;
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  // Map of threadId → active timer fiber. Kept in a Ref so schedule changes
  // can interrupt and replace a fiber. Most of these are asleep until
  // nextRunAt; `firingSemaphore` below (not this map) is what `drain` waits
  // on, since interrupting/joining a sleeping timer isn't "idle work".
  const timers = yield* Ref.make(HashMap.empty<ThreadId, Fiber.Fiber<void, never>>());

  // Acquired for the duration of a fire (dispatching the turn-start and
  // rescheduling) so `drain` can wait for in-flight fires without joining
  // the (typically many) timer fibers asleep until their next run. The
  // permit count is just a generous ceiling on concurrent fires, not a
  // concurrency limit — schedules never contend for it in practice.
  const MAX_CONCURRENT_FIRINGS = 10_000;
  const firingSemaphore = yield* Semaphore.make(MAX_CONCURRENT_FIRINGS);

  // Dispatch a schedule command (already built as an effect to surface UUID
  // generation failures). Any error is logged and swallowed so the timer fiber
  // never fails below.
  const dispatchScheduleUpdate = (
    commandEffect: Effect.Effect<
      OrchestrationCommand,
      PlatformError.PlatformError | OrchestrationDispatchError,
      never
    >,
  ): Effect.Effect<void, never, never> =>
    commandEffect.pipe(
      Effect.flatMap((command) => orchestrationEngine.dispatch(command)),
      Effect.catch((error) =>
        Effect.logWarning("schedule reactor failed to dispatch command", {
          cause: String(error),
        }),
      ),
      Effect.asVoid,
    );

  const scheduleCreateCommand = (
    threadId: ThreadId,
    schedule: ThreadSchedule,
  ): Effect.Effect<OrchestrationCommand, PlatformError.PlatformError, never> =>
    Effect.map(serverCommandId("schedule-update"), (commandId) => ({
      type: "thread.schedule.create" as const,
      commandId,
      threadId,
      schedule,
    }));

  // Dispatches the turn-start for a thread's schedule, then advances the
  // schedule's nextRunAt so the timer chain continues.
  const fireSchedule = Effect.fn("fireSchedule")(function* (thread: OrchestrationThread) {
    const schedule = thread.schedule;
    if (schedule == null || !schedule.enabled) {
      return;
    }

    // Skip firing while a turn is already running; retry in 5 minutes.
    if (thread.session != null && thread.session.status === "running") {
      const now = yield* DateTime.now;
      const nextRunAt = DateTime.formatIso(DateTime.add(now, { minutes: 5 }));
      yield* dispatchScheduleUpdate(scheduleCreateCommand(thread.id, { ...schedule, nextRunAt }));
      return;
    }

    const now = yield* DateTime.now;
    const createdAt = DateTime.formatIso(now);
    const messageId = yield* randomUUID.pipe(
      Effect.map(MessageId.make),
      Effect.catch((error) =>
        Effect.logWarning("schedule reactor failed to generate message id", {
          threadId: thread.id,
          cause: String(error),
        }).pipe(Effect.as(MessageId.make(`schedule:${thread.id}:${DateTime.toEpochMillis(now)}`))),
      ),
    );
    yield* dispatchScheduleUpdate(
      Effect.map(serverCommandId("schedule-turn-start"), (commandId) => ({
        type: "thread.turn.start" as const,
        commandId,
        threadId: thread.id,
        message: {
          messageId,
          role: "user" as const,
          text: schedule.prompt,
          attachments: [],
        },
        ...(schedule.modelSelection !== undefined
          ? { modelSelection: schedule.modelSelection }
          : {}),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      })),
    );

    const nextRunAt = DateTime.formatIso(computeNextRunAt(schedule, yield* DateTime.now));
    yield* dispatchScheduleUpdate(scheduleCreateCommand(thread.id, { ...schedule, nextRunAt }));
  });

  // Interrupt any timer already scheduled for the thread (whether asleep or
  // mid-fire — firing runs inline in the same fiber, see startTimerForSchedule)
  // so a schedule update replaces rather than stacks. Removes the map entry
  // too, but only if it still points at the fiber just interrupted — a
  // concurrent replacement that already installed a newer fiber under the
  // same key is left untouched. Without this removal, a cancelled (never
  // re-scheduled) thread would leave a dead fiber reference in the map
  // forever.
  const interruptTimer = Effect.fn("interruptTimer")(function* (threadId: ThreadId) {
    const map = yield* Ref.get(timers);
    const entry = HashMap.get(map, threadId);
    if (Option.isNone(entry)) return;
    const fiber = entry.value;
    yield* Fiber.interrupt(fiber);
    yield* Ref.update(timers, (current) =>
      Option.match(HashMap.get(current, threadId), {
        onNone: () => current,
        onSome: (owner) => (owner === fiber ? HashMap.remove(current, threadId) : current),
      }),
    );
  });

  // Reads the freshest state for just this thread and fires its schedule if
  // due. A single-thread read (rather than the full projection snapshot,
  // which hydrates every thread/message/activity in the system) since only
  // one thread's schedule/session is needed to decide whether to fire.
  const fireTimerForThread = Effect.fn("fireTimerForThread")(function* (threadId: ThreadId) {
    const threadOption = yield* snapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("schedule reactor failed to read thread", {
          threadId,
          cause: String(error),
        }).pipe(Effect.as(Option.none())),
      ),
    );
    if (Option.isNone(threadOption)) {
      return;
    }
    const thread = threadOption.value;
    yield* fireSchedule(thread);
  });

  const startTimerForSchedule = Effect.fn("startTimerForSchedule")(function* (
    threadId: ThreadId,
    schedule: ThreadSchedule,
  ) {
    if (!schedule.enabled) {
      return;
    }

    yield* interruptTimer(threadId);

    const now = yield* DateTime.now;
    const nextRunAt = Option.getOrElse(DateTime.make(schedule.nextRunAt), () => now);
    const delayMs = Math.max(0, DateTime.toEpochMillis(nextRunAt) - DateTime.toEpochMillis(now));

    const timer = Effect.sleep(`${delayMs} millis`).pipe(
      // Runs inline (no extra fork) so interrupting this same fiber — e.g. a
      // schedule cancelled or replaced mid-fire — cancels the fire too.
      // Holding a permit for the duration is what lets `drain` (below) wait
      // for in-flight fires without also waiting on fibers still asleep.
      Effect.andThen(() => firingSemaphore.withPermits(1)(fireTimerForThread(threadId))),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          // Let interrupts (schedule replacement / scope close) propagate so the
          // fiber ends cleanly instead of leaving a stray firing behind.
          return Effect.failCause(cause);
        }
        return Effect.logWarning("schedule timer failed", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

    const fiber = yield* Effect.forkScoped(timer);
    yield* Ref.update(timers, (map) => HashMap.set(map, threadId, fiber));
  });

  const start: ScheduleReactorShape["start"] = Effect.fn("start")(function* () {
    // Subscribe to schedule lifecycle events before reading the bootstrap
    // snapshot below: streamDomainEvents is a hot, events-from-now-only
    // stream, so a schedule created in the gap between a snapshot read and
    // the subscription would otherwise never get a timer. startTimerForSchedule
    // already interrupts and replaces any existing timer for a thread, so a
    // thread seen by both the subscription and the snapshot is harmless.
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "thread.scheduled") {
          return startTimerForSchedule(event.payload.threadId, event.payload.schedule);
        }
        if (event.type === "thread.unscheduled") {
          return interruptTimer(event.payload.threadId);
        }
        return Effect.void;
      }),
    );

    // Bootstrap timers for schedules that already exist, now that the
    // subscription above is live.
    const snapshot = yield* snapshotQuery.getSnapshot().pipe(
      Effect.catch((error) =>
        Effect.logWarning("schedule reactor failed to read snapshot on start", {
          cause: String(error),
        }).pipe(Effect.as(null)),
      ),
    );
    if (snapshot != null) {
      for (const thread of snapshot.threads) {
        if (thread.schedule != null && thread.schedule.enabled) {
          yield* startTimerForSchedule(thread.id, thread.schedule);
        }
      }
    }
  });

  // Acquiring every permit blocks until no fire is in flight, without
  // waiting on the (typically many) timer fibers asleep until their nextRunAt.
  const drain: ScheduleReactorShape["drain"] = firingSemaphore
    .withPermits(MAX_CONCURRENT_FIRINGS)(Effect.void)
    .pipe(Effect.asVoid);

  return {
    start,
    drain,
  } satisfies ScheduleReactorShape;
});

export const ScheduleReactorLive = Layer.effect(ScheduleReactor, make);

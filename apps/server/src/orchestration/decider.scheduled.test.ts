import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadSchedule,
} from "@helmcode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
// The decider's clock is the Effect test clock, pinned to the epoch, so
// "future" run times are relative to 1970-01-01T00:00:00.000Z.
const FUTURE_RUN_AT = "1970-01-02T09:00:00.000Z";
const PAST_RUN_AT = "1969-12-31T09:00:00.000Z";

function schedule(overrides: Partial<ThreadSchedule> = {}): ThreadSchedule {
  return {
    enabled: true,
    cron: null,
    intervalMs: 3_600_000,
    prompt: "Continue where you left off.",
    nextRunAt: FUTURE_RUN_AT,
    createdAt: NOW,
    ...overrides,
  };
}

function makeReadModel(input: {
  readonly schedule?: ThreadSchedule | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        schedule: input.schedule ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const expectScheduleRejected = (input: ThreadSchedule) =>
  Effect.gen(function* () {
    const error = yield* decideOrchestrationCommand({
      command: {
        type: "thread.schedule.create",
        commandId: CommandId.make("cmd-schedule"),
        threadId: ThreadId.make("thread-1"),
        schedule: input,
      },
      readModel: makeReadModel({}),
    }).pipe(Effect.flip);
    expect(error._tag).toBe("OrchestrationCommandInvariantError");
  });

it.layer(NodeServices.layer)("scheduled thread decider", (it) => {
  it.effect("creates a schedule with an interval cadence", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.schedule.create",
          commandId: CommandId.make("cmd-schedule"),
          threadId: ThreadId.make("thread-1"),
          schedule: schedule(),
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.scheduled");
    }),
  );

  it.effect("creates a schedule with a supported cron cadence", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.schedule.create",
          commandId: CommandId.make("cmd-schedule"),
          threadId: ThreadId.make("thread-1"),
          schedule: schedule({ cron: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", intervalMs: null }),
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.scheduled");
    }),
  );

  it.effect("rejects a schedule with neither cron nor intervalMs", () =>
    expectScheduleRejected(schedule({ cron: null, intervalMs: null })),
  );

  it.effect("rejects a schedule with both cron and intervalMs set", () =>
    expectScheduleRejected(schedule({ cron: "FREQ=DAILY", intervalMs: 3_600_000 })),
  );

  it.effect("rejects a non-positive intervalMs", () =>
    Effect.gen(function* () {
      yield* expectScheduleRejected(schedule({ intervalMs: 0 }));
      yield* expectScheduleRejected(schedule({ intervalMs: -1 }));
    }),
  );

  it.effect("rejects a cron outside the supported RRULE subset", () =>
    Effect.gen(function* () {
      yield* expectScheduleRejected(schedule({ cron: "FREQ=YEARLY", intervalMs: null }));
      yield* expectScheduleRejected(schedule({ cron: "BYHOUR=9", intervalMs: null }));
      yield* expectScheduleRejected(schedule({ cron: "FREQ=DAILY;COUNT=5", intervalMs: null }));
    }),
  );

  it.effect("rejects a nextRunAt that is not in the future", () =>
    expectScheduleRejected(schedule({ nextRunAt: PAST_RUN_AT })),
  );

  it.effect("rejects an empty prompt", () => expectScheduleRejected(schedule({ prompt: "   " })));
});

it.layer(NodeServices.layer)("schedule cancellation decider", (it) => {
  it.effect("cancels an existing schedule and bumps updatedAt", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.schedule.cancel",
          commandId: CommandId.make("cmd-cancel"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ schedule: schedule() }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.unscheduled");
      if (events[0]?.type === "thread.unscheduled") {
        expect(events[0].payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("cancelling an already-unscheduled thread is a no-op that preserves updatedAt", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.schedule.cancel",
          commandId: CommandId.make("cmd-cancel-again"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ schedule: null }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.unscheduled");
      if (events[0]?.type === "thread.unscheduled") {
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );
});

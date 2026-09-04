import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@helmcode/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ScheduleReactor } from "../Services/ScheduleReactor.ts";
import { computeNextRunAt, ScheduleReactorLive } from "./ScheduleReactor.ts";

const now = "1970-01-01T00:00:00.000Z";
const threadId = ThreadId.make("schedule-reactor-test-thread");
const projectId = ProjectId.make("schedule-reactor-test-project");

const fakeCrypto: Crypto.Crypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(() => globalThis.crypto.subtle.digest(algorithm as string, data)).pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
    ),
});

const stubSnapshotQuery = (
  getSnapshot: () => Effect.Effect<OrchestrationReadModel>,
): ProjectionSnapshotQuery["Service"] => ({
  getCommandReadModel: getSnapshot,
  getSnapshot,
  getShellSnapshot: () =>
    Effect.succeed({ snapshotSequence: 1, projects: [], threads: [], updatedAt: now }),
  getArchivedShellSnapshot: () =>
    Effect.succeed({ snapshotSequence: 1, projects: [], threads: [], updatedAt: now }),
  getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
  getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
  getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
  getProjectShellById: () => Effect.succeed(Option.none()),
  getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
  getThreadCheckpointContext: () => Effect.succeed(Option.none()),
  getFullThreadDiffContext: () => Effect.succeed(Option.none()),
  getThreadShellById: () => Effect.succeed(Option.none()),
  getThreadDetailById: (threadId) =>
    getSnapshot().pipe(
      Effect.map((rm) => Option.fromNullishOr(rm.threads.find((thread) => thread.id === threadId))),
    ),
  getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
  searchThreads: () => Effect.succeed({ matches: [] }),
});

type ThreadOverrides = {
  schedule?: OrchestrationReadModel["threads"][number]["schedule"];
  session?: OrchestrationReadModel["threads"][number]["session"];
};

const readModel = (overrides: ThreadOverrides): OrchestrationReadModel => ({
  snapshotSequence: 1,
  updatedAt: now,
  projects: [
    {
      id: projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: threadId,
      projectId,
      title: "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      messages: [],
      session: overrides.session ?? null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
      schedule: overrides.schedule ?? null,
    },
  ],
});

const runningSession: NonNullable<ThreadOverrides["session"]> = {
  threadId,
  status: "running",
  providerName: null,
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
};

const schedule = (
  overrides: Partial<{
    nextRunAt: string;
    intervalMs: number | null;
    cron: string | null;
    enabled: boolean;
    prompt: string;
  }> = {},
) => ({
  enabled: overrides.enabled ?? true,
  cron: overrides.cron ?? null,
  intervalMs: overrides.intervalMs ?? 60_000,
  prompt: overrides.prompt ?? "Continue where you left off.",
  nextRunAt: overrides.nextRunAt ?? "1970-01-01T00:00:10.000Z",
  createdAt: now,
});

/**
 * Boots the ScheduleReactor against mock engine + snapshot services under a
 * TestClock, advances the virtual clock past `nextRunAt` so the timer fires
 * deterministically, and returns the recorded commands.
 */
const runReactor = (
  overrides: ThreadOverrides,
  adjust: Duration.Duration,
): Effect.Effect<
  {
    readonly commands: Array<OrchestrationCommand["type"]>;
    readonly turnStarts: Array<{ threadId: ThreadId; text: string }>;
    readonly reschedules: Array<string>;
  },
  never,
  never
> =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<Array<OrchestrationCommand["type"]>>([]);
    const turnStarts = yield* Ref.make<Array<{ threadId: ThreadId; text: string }>>([]);
    const reschedules = yield* Ref.make<Array<string>>([]);
    // TestClock.adjust only guarantees a due sleep's *immediate* continuation
    // gets a turn to run — it does not wait for that continuation's own
    // further async steps (dispatching commands here) to finish, so reading
    // the Refs right after adjust races the fire. thread.schedule.create is
    // always the last command fireSchedule dispatches (both the normal fire
    // and the "turn already running" retry path end with it), so resolving
    // this once it's seen is a reliable "fire has fully completed" signal —
    // the same Deferred-based pattern VcsStatusBroadcaster.test.ts uses for
    // the same class of TestClock race.
    const fired = yield* Deferred.make<void>();

    const engine: OrchestrationEngineService["Service"] = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(commands, (calls) => [...calls, command.type]).pipe(
          Effect.flatMap(() => {
            if (command.type === "thread.turn.start") {
              return Ref.update(turnStarts, (calls) => [
                ...calls,
                { threadId: command.threadId, text: command.message.text },
              ]);
            }
            if (command.type === "thread.schedule.create") {
              return Ref.update(reschedules, (calls) => [
                ...calls,
                command.schedule.nextRunAt,
              ]).pipe(Effect.andThen(Deferred.succeed(fired, undefined)));
            }
            return Effect.void;
          }),
          Effect.as({ sequence: 1 } as const),
        ),
      streamDomainEvents: Stream.never,
      latestSequence: Effect.succeed(0),
    };

    const snapshotQuery = stubSnapshotQuery(() => Effect.succeed(readModel(overrides)));

    const testLayer = ScheduleReactorLive.pipe(
      Layer.provideMerge(TestClock.layer()),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
      Layer.provideMerge(Layer.succeed(Crypto.Crypto, fakeCrypto)),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* Effect.service(ScheduleReactor);
        yield* reactor.start();
        yield* TestClock.adjust(adjust);
        yield* Deferred.await(fired);
      }),
    ).pipe(Effect.provide(testLayer));

    return {
      commands: yield* Ref.get(commands),
      turnStarts: yield* Ref.get(turnStarts),
      reschedules: yield* Ref.get(reschedules),
    };
  });

describe("computeNextRunAt", () => {
  it("adds the interval for interval-based schedules", () => {
    const next = computeNextRunAt({ cron: null, intervalMs: 3_600_000 }, DateTime.makeUnsafe(now));
    expect(DateTime.formatIso(next)).toBe("1970-01-01T01:00:00.000Z");
  });

  it("returns +1 hour for HOURLY cron with no BYMINUTE (defaults to :00)", () => {
    const next = computeNextRunAt(
      { cron: "FREQ=HOURLY", intervalMs: null },
      DateTime.makeUnsafe(now),
    );
    expect(DateTime.formatIso(next)).toBe("1970-01-01T01:00:00.000Z");
  });

  it("respects BYMINUTE for HOURLY cron, rolling to the next hour once passed", () => {
    const next = computeNextRunAt(
      { cron: "FREQ=HOURLY;BYMINUTE=30", intervalMs: null },
      DateTime.makeUnsafe("1970-01-01T00:10:00.000Z"),
    );
    expect(DateTime.formatIso(next)).toBe("1970-01-01T00:30:00.000Z");

    const wrapped = computeNextRunAt(
      { cron: "FREQ=HOURLY;BYMINUTE=30", intervalMs: null },
      DateTime.makeUnsafe("1970-01-01T00:45:00.000Z"),
    );
    expect(DateTime.formatIso(wrapped)).toBe("1970-01-01T01:30:00.000Z");
  });

  it("computes the next DAILY run at the target time, advancing a day when passed", () => {
    const midnight = DateTime.makeUnsafe(now);
    const next = computeNextRunAt(
      { cron: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", intervalMs: null },
      midnight,
    );
    expect(DateTime.formatIso(next)).toBe("1970-01-01T09:00:00.000Z");

    const midday = DateTime.makeUnsafe("1970-01-01T12:00:00.000Z");
    const nextDay = computeNextRunAt(
      { cron: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", intervalMs: null },
      midday,
    );
    expect(DateTime.formatIso(nextDay)).toBe("1970-01-02T09:00:00.000Z");
  });

  it("rolls a WEEKLY schedule forward to the configured weekday, wrapping to next week", () => {
    // 2026-09-04 is a Friday; the next Monday is 2 days ahead.
    const friday = DateTime.makeUnsafe("2026-09-04T10:00:00.000Z");
    const next = computeNextRunAt(
      { cron: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", intervalMs: null },
      friday,
    );
    expect(DateTime.formatIso(next)).toBe("2026-09-07T09:00:00.000Z");

    // A Monday morning before the target time schedules the same Monday.
    const mondayEarly = DateTime.makeUnsafe("2026-09-07T08:00:00.000Z");
    const sameDay = computeNextRunAt(
      { cron: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", intervalMs: null },
      mondayEarly,
    );
    expect(DateTime.formatIso(sameDay)).toBe("2026-09-07T09:00:00.000Z");
  });

  it("defaults a DAILY cron without a parseable target to +1 day", () => {
    const next = computeNextRunAt(
      { cron: "FREQ=DAILY", intervalMs: null },
      DateTime.makeUnsafe(now),
    );
    expect(DateTime.formatIso(next)).toBe("1970-01-02T00:00:00.000Z");
  });

  it("advances a MONTHLY cron by a calendar month once the target time has passed", () => {
    const next = computeNextRunAt(
      { cron: "FREQ=MONTHLY;BYHOUR=9;BYMINUTE=0", intervalMs: null },
      DateTime.makeUnsafe("1970-01-01T12:00:00.000Z"),
    );
    expect(DateTime.formatIso(next)).toBe("1970-02-01T09:00:00.000Z");
  });
});

describe("ScheduleReactor firing", () => {
  it.effect(
    "dispatches a turn start with the schedule prompt and reschedules when the timer fires",
    () =>
      Effect.gen(function* () {
        const { commands, turnStarts, reschedules } = yield* runReactor(
          { schedule: schedule() },
          Duration.seconds(10),
        );

        // thread.turn.start must dispatch before the reschedule so a fired
        // schedule cannot be "reset" ahead of the turn it was meant to start.
        expect(commands).toEqual(["thread.turn.start", "thread.schedule.create"]);
        expect(turnStarts).toEqual([{ threadId, text: "Continue where you left off." }]);
        // Fired at the schedule's default nextRunAt (00:00:10) with
        // intervalMs: 60_000, so the reschedule lands exactly 60s later.
        expect(reschedules).toEqual(["1970-01-01T00:01:10.000Z"]);
      }),
  );

  it.effect("skips firing while a turn is running and only reschedules", () =>
    Effect.gen(function* () {
      const { commands, turnStarts, reschedules } = yield* runReactor(
        { schedule: schedule(), session: runningSession },
        Duration.seconds(10),
      );

      expect(commands).toEqual(["thread.schedule.create"]);
      expect(turnStarts).toEqual([]);
      // Retried 5 minutes after the fire time (00:00:10), not the schedule's
      // normal cadence.
      expect(reschedules).toEqual(["1970-01-01T00:05:10.000Z"]);
    }),
  );
});

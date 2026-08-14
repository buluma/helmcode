import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { PROVIDER_SPAWN_RETRY_SCHEDULE } from "./providerSpawnRetry.ts";

describe("PROVIDER_SPAWN_RETRY_SCHEDULE", () => {
  it.effect("retries a failing spawn up to 3 total attempts before giving up", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const failing = Ref.updateAndGet(attempts, (count) => count + 1).pipe(
        Effect.flatMap(() => Effect.fail("ENOENT")),
      );

      const fiber = yield* failing.pipe(
        Effect.retry(PROVIDER_SPAWN_RETRY_SCHEDULE),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("10 seconds");
      const exit = yield* Effect.exit(Fiber.join(fiber));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* Ref.get(attempts)).toBe(3);
    }),
  );

  it.effect("does not retry once the spawn succeeds", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const succeeding = Ref.updateAndGet(attempts, (count) => count + 1);

      const result = yield* succeeding.pipe(Effect.retry(PROVIDER_SPAWN_RETRY_SCHEDULE));

      expect(result).toBe(1);
      expect(yield* Ref.get(attempts)).toBe(1);
    }),
  );
});

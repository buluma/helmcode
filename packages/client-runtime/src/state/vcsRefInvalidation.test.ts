import { EnvironmentId } from "@helmcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import * as Persistence from "../platform/persistence.ts";

import {
  invalidateCachedVcsRefs,
  invalidateVcsRefs,
  vcsRefsCacheStateAtom,
  withVcsRefsPersistenceLock,
} from "./vcsRefInvalidation.ts";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

function cacheWithRefs(overrides: Partial<Persistence.EnvironmentCacheStore["Service"]> = {}) {
  return Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
    ...overrides,
  });
}

describe("withVcsRefsPersistenceLock", () => {
  it.effect("serializes concurrent holders for the same environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const order = yield* Ref.make<ReadonlyArray<string>>([]);
        const firstEntered = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();

        const first = yield* withVcsRefsPersistenceLock(
          ENVIRONMENT_A,
          Effect.gen(function* () {
            yield* Ref.update(order, (current) => [...current, "first-enter"]);
            yield* Deferred.done(firstEntered, Exit.void);
            yield* Deferred.await(releaseFirst);
            yield* Ref.update(order, (current) => [...current, "first-exit"]);
          }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(firstEntered);

        const second = yield* withVcsRefsPersistenceLock(
          ENVIRONMENT_A,
          Ref.update(order, (current) => [...current, "second-enter"]),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        // Give the second fiber a chance to run; it must not enter while the
        // first still holds the permit for this environment.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(yield* Ref.get(order)).toEqual(["first-enter"]);

        yield* Deferred.done(releaseFirst, Exit.void);
        yield* Fiber.join(first);
        yield* Fiber.join(second);

        expect(yield* Ref.get(order)).toEqual(["first-enter", "first-exit", "second-enter"]);
      }),
    ),
  );

  // `PartitionedSemaphore` draws from one shared permit pool (here, exactly
  // one permit) — the partition key only orders waiters fairly, it does not
  // give each key its own concurrency slot. So a lock held for one
  // environment also blocks a different environment's holder until release.
  it.effect("blocks a different environment's holder too, since the permit pool is shared", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const order = yield* Ref.make<ReadonlyArray<string>>([]);
        const aEntered = yield* Deferred.make<void>();
        const releaseA = yield* Deferred.make<void>();

        const a = yield* withVcsRefsPersistenceLock(
          ENVIRONMENT_A,
          Effect.gen(function* () {
            yield* Ref.update(order, (current) => [...current, "a-enter"]);
            yield* Deferred.done(aEntered, Exit.void);
            yield* Deferred.await(releaseA);
            yield* Ref.update(order, (current) => [...current, "a-exit"]);
          }),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(aEntered);

        const b = yield* withVcsRefsPersistenceLock(
          ENVIRONMENT_B,
          Ref.update(order, (current) => [...current, "b-enter"]),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(yield* Ref.get(order)).toEqual(["a-enter"]);

        yield* Deferred.done(releaseA, Exit.void);
        yield* Fiber.join(a);
        yield* Fiber.join(b);

        expect(yield* Ref.get(order)).toEqual(["a-enter", "a-exit", "b-enter"]);
      }),
    ),
  );
});

describe("invalidateVcsRefs", () => {
  it("bumps the revision and preserves persistedCacheReadable by default", () => {
    const registry = AtomRegistry.make();
    const target = { environmentId: ENVIRONMENT_A };

    invalidateVcsRefs(registry, target);

    expect(registry.get(vcsRefsCacheStateAtom(target))).toEqual({
      revision: 1,
      persistedCacheReadable: true,
    });
  });

  it("can override persistedCacheReadable while bumping the revision", () => {
    const registry = AtomRegistry.make();
    const target = { environmentId: ENVIRONMENT_A };

    invalidateVcsRefs(registry, target, false);

    expect(registry.get(vcsRefsCacheStateAtom(target))).toEqual({
      revision: 1,
      persistedCacheReadable: false,
    });
  });

  it("only affects the state for the mutated environment", () => {
    const registry = AtomRegistry.make();
    const targetA = { environmentId: ENVIRONMENT_A };
    const targetB = { environmentId: ENVIRONMENT_B };

    invalidateVcsRefs(registry, targetA);

    expect(registry.get(vcsRefsCacheStateAtom(targetA)).revision).toBe(1);
    expect(registry.get(vcsRefsCacheStateAtom(targetB)).revision).toBe(0);
  });
});

describe("invalidateCachedVcsRefs", () => {
  it.effect("clears the persisted cache before bumping the revision", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const target = { environmentId: ENVIRONMENT_A, cwd: "/repo" };
      const revisionDuringClear = yield* Ref.make(-1);
      const cache = cacheWithRefs({
        clearVcsRefs: () =>
          Ref.set(revisionDuringClear, registry.get(vcsRefsCacheStateAtom(target)).revision),
      });

      yield* invalidateCachedVcsRefs(registry, target).pipe(
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      );

      // The clear must observe the pre-invalidation revision, or a restarted
      // stream could rehydrate the snapshot this call is trying to drop.
      expect(yield* Ref.get(revisionDuringClear)).toBe(0);
      expect(registry.get(vcsRefsCacheStateAtom(target))).toEqual({
        revision: 1,
        persistedCacheReadable: true,
      });
    }),
  );

  it.effect("marks the cache unreadable, but still bumps the revision, when clearing fails", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const target = { environmentId: ENVIRONMENT_A, cwd: "/repo" };
      const cache = cacheWithRefs({
        clearVcsRefs: () =>
          Effect.fail(
            new Persistence.ConnectionPersistenceError({
              operation: "clear-vcs-refs",
              message: "storage unavailable",
            }),
          ),
      });

      yield* invalidateCachedVcsRefs(registry, target).pipe(
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      );

      expect(registry.get(vcsRefsCacheStateAtom(target))).toEqual({
        revision: 1,
        persistedCacheReadable: false,
      });
    }),
  );
});

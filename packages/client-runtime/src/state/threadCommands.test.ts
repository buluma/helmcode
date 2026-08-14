import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type ServerConfig,
} from "@helmcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

import { createThreadEnvironmentAtoms, ThreadCommandUnsupportedError } from "./threadCommands.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const CONNECTED_CONNECTION_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

function serverConfigWith(threadSettlement: boolean): ServerConfig {
  return {
    environment: {
      environmentId: TARGET.environmentId,
      label: "Test environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { threadSettlement },
    },
  } as unknown as ServerConfig;
}

const setUp = Effect.fn("setUp")(function* (dispatches: Ref.Ref<number>) {
  const client = {
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: () =>
      Ref.update(dispatches, (count) => count + 1).pipe(Effect.as({ sequence: 1 })),
  } as unknown as WsRpcProtocolClient;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      TEST_CRYPTO_LAYER,
    ),
  );
  const knownConfig = { current: null as ServerConfig | null };
  const configAtom = Atom.make<ServerConfig | null>(() => knownConfig.current);
  const atoms = createThreadEnvironmentAtoms(runtime, () => configAtom);
  const registry = AtomRegistry.make();
  return { atoms, registry, knownConfig };
});

describe("createThreadEnvironmentAtoms capability gating", () => {
  it.effect("dispatches when the server config is not known yet", () =>
    Effect.gen(function* () {
      const dispatches = yield* Ref.make(0);
      const { atoms, registry } = yield* setUp(dispatches);

      const result = yield* Effect.promise(() =>
        atoms.settle.run(registry, {
          environmentId: TARGET.environmentId,
          input: { threadId: ThreadId.make("thread-1"), commandId: CommandId.make("cmd-1") },
        }),
      );

      expect(AsyncResult.isSuccess(result)).toBe(true);
      expect(yield* Ref.get(dispatches)).toBe(1);
    }),
  );

  it.effect("dispatches when the server advertises the capability", () =>
    Effect.gen(function* () {
      const dispatches = yield* Ref.make(0);
      const { atoms, registry, knownConfig } = yield* setUp(dispatches);
      knownConfig.current = serverConfigWith(true);

      const result = yield* Effect.promise(() =>
        atoms.settle.run(registry, {
          environmentId: TARGET.environmentId,
          input: { threadId: ThreadId.make("thread-1"), commandId: CommandId.make("cmd-1") },
        }),
      );

      expect(AsyncResult.isSuccess(result)).toBe(true);
      expect(yield* Ref.get(dispatches)).toBe(1);
    }),
  );

  it.effect("fails without dispatching when the server explicitly lacks the capability", () =>
    Effect.gen(function* () {
      const dispatches = yield* Ref.make(0);
      const { atoms, registry, knownConfig } = yield* setUp(dispatches);
      knownConfig.current = serverConfigWith(false);

      const result = yield* Effect.promise(() =>
        atoms.settle.run(registry, {
          environmentId: TARGET.environmentId,
          input: { threadId: ThreadId.make("thread-1"), commandId: CommandId.make("cmd-1") },
        }),
      );

      expect(AsyncResult.isFailure(result)).toBe(true);
      if (AsyncResult.isFailure(result)) {
        expect(Cause.squash(result.cause)).toBeInstanceOf(ThreadCommandUnsupportedError);
      }
      expect(yield* Ref.get(dispatches)).toBe(0);
    }),
  );
});

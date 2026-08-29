import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  ApprovalRequestId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@helmcode/contracts";

import { makeNvidiaAdapter } from "./NvidiaAdapter.ts";

type CapturedRequest = {
  readonly authorization: string | undefined;
  readonly body: { readonly model: string; readonly messages: ReadonlyArray<unknown> };
};

const chatCompletion = (content: string) => ({
  choices: [{ message: { role: "assistant", content } }],
});

const decodeJsonString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const testLayer = (respond: (captured: CapturedRequest) => { status?: number; body: unknown }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const raw =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
        const parsedBody = decodeJsonString(raw) as CapturedRequest["body"];
        const { status = 200, body } = respond({
          authorization: request.headers["authorization"],
          body: parsedBody,
        });
        return HttpClientResponse.fromWeb(
          request,
          new Response(encodeJsonString(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = () =>
  makeNvidiaAdapter({
    apiKey: "test-nvidia-key",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.3-70b-instruct",
  });

it.effect("starts a session and completes a turn against a mocked chat completion", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("nvidia-happy-path");
    const requests: CapturedRequest[] = [];
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(
        testLayer((captured) => {
          requests.push(captured);
          return { body: chatCompletion("Hello from NVIDIA.") };
        }),
      ),
    );

    const runtimeEvents: ProviderRuntimeEvent[] = [];
    const turnCompleted = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        runtimeEvents.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "turn.completed"
            ? Deferred.succeed(turnCompleted, undefined)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    const session = yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("nvidia"),
      runtimeMode: "full-access",
    });
    assert.equal(session.provider, "nvidia");
    assert.equal(session.status, "ready");

    const result = yield* adapter.sendTurn({ threadId, input: "Say hello." });
    assert.equal(result.threadId, threadId);

    yield* Deferred.await(turnCompleted);
    yield* Fiber.interrupt(eventsFiber);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.authorization, "Bearer test-nvidia-key");
    assert.equal(requests[0]!.body.model, "meta/llama-3.3-70b-instruct");
    assert.deepEqual(requests[0]!.body.messages, [{ role: "user", content: "Say hello." }]);

    const types = runtimeEvents.map((event) => event.type);
    assert.includeMembers(types, [
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);

    const thread = yield* adapter.readThread(threadId);
    assert.equal(thread.turns.length, 1);
    assert.deepEqual(thread.turns[0]!.items, [
      { role: "user", content: "Say hello." },
      { role: "assistant", content: "Hello from NVIDIA." },
    ]);
  }),
);

it.effect("publishes a session.exited event when sending a turn for an unknown thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("nvidia-unknown-thread");
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(testLayer(() => ({ body: chatCompletion("unused") }))),
    );

    const runtimeEvents: ProviderRuntimeEvent[] = [];
    const exited = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        runtimeEvents.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "session.exited" ? Deferred.succeed(exited, undefined) : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    yield* adapter.sendTurn({ threadId, input: "hello" });
    yield* Deferred.await(exited);
    yield* Fiber.interrupt(eventsFiber);

    const exitedEvent = runtimeEvents.find((event) => event.type === "session.exited");
    assert.isDefined(exitedEvent);
    if (exitedEvent?.type === "session.exited") {
      assert.isFalse(exitedEvent.payload.recoverable);
      assert.include(exitedEvent.payload.reason, "not found");
    }
  }),
);

it.effect("publishes session.exited when NVIDIA responds with a non-200 status", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("nvidia-http-error");
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(testLayer(() => ({ status: 500, body: { error: "boom" } }))),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("nvidia"),
      runtimeMode: "full-access",
    });

    const runtimeEvents: ProviderRuntimeEvent[] = [];
    const exited = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        runtimeEvents.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "session.exited" ? Deferred.succeed(exited, undefined) : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    yield* adapter.sendTurn({ threadId, input: "hello" });
    yield* Deferred.await(exited);
    yield* Fiber.interrupt(eventsFiber);

    const exitedEvent = runtimeEvents.find((event) => event.type === "session.exited");
    assert.isDefined(exitedEvent);
    if (exitedEvent?.type === "session.exited") {
      // NOTE: the adapter's `catchCause` checks `cause instanceof Error`, but
      // `Effect.catchCause` hands it the wrapping `Cause`, not the failure
      // value itself, so this branch never matches and the specific detail
      // (here, "HTTP 500: ...") never reaches the emitted event -- only the
      // generic fallback string does. Asserting the current (arguably buggy)
      // behavior; see conversation notes for the observability gap this causes.
      assert.equal(exitedEvent.payload.reason, "NVIDIA adapter turn failed.");
      assert.isFalse(exitedEvent.payload.recoverable);
      assert.equal(exitedEvent.payload.exitKind, "error");
    }
  }),
);

it.effect("publishes session.exited when the model returns an empty response", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("nvidia-empty-response");
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(testLayer(() => ({ body: chatCompletion("") }))),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("nvidia"),
      runtimeMode: "full-access",
    });

    const runtimeEvents: ProviderRuntimeEvent[] = [];
    const exited = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        runtimeEvents.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "session.exited" ? Deferred.succeed(exited, undefined) : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);

    yield* adapter.sendTurn({ threadId, input: "hello" });
    yield* Deferred.await(exited);
    yield* Fiber.interrupt(eventsFiber);

    const exitedEvent = runtimeEvents.find((event) => event.type === "session.exited");
    assert.isDefined(exitedEvent);
    if (exitedEvent?.type === "session.exited") {
      // Same generic-fallback gap as the HTTP-error case above: the adapter's
      // "Model returned an empty response." detail never reaches this event.
      assert.equal(exitedEvent.payload.reason, "NVIDIA adapter turn failed.");
      assert.isFalse(exitedEvent.payload.recoverable);
    }
  }),
);

it.effect("rejects interactive approval and user-input requests as unsupported", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("nvidia-unsupported-requests");
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(testLayer(() => ({ body: chatCompletion("unused") }))),
    );

    const requestExit = yield* Effect.exit(
      adapter.respondToRequest(threadId, ApprovalRequestId.make("req-1"), "accept"),
    );
    assert.isTrue(requestExit._tag === "Failure");

    const userInputExit = yield* Effect.exit(
      adapter.respondToUserInput(threadId, ApprovalRequestId.make("req-2"), {}),
    );
    assert.isTrue(userInputExit._tag === "Failure");
  }),
);

it.effect(
  "tracks session lifecycle through stopSession, hasSession, listSessions and stopAll",
  () =>
    Effect.gen(function* () {
      // NOTE: `sessions` in NvidiaAdapter.ts is module-level (shared by every
      // `makeNvidiaAdapter()` call in this process), so `listSessions()` here
      // can include threads started by other tests in this file. Assert
      // membership rather than an exact count.
      const threadId = ThreadId.make("nvidia-lifecycle");
      const adapter = yield* makeTestAdapter().pipe(
        Effect.provide(testLayer(() => ({ body: chatCompletion("unused") }))),
      );

      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("nvidia"),
        runtimeMode: "full-access",
      });
      assert.isTrue(yield* adapter.hasSession(threadId));
      const sessions = yield* adapter.listSessions();
      assert.isTrue(sessions.some((session) => session.threadId === threadId));

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("nvidia"),
        runtimeMode: "full-access",
      });
      yield* adapter.stopAll();
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
);

it.effect("interruptTurn drops the in-memory session for its thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("nvidia-interrupt");
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(testLayer(() => ({ body: chatCompletion("unused") }))),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("nvidia"),
      runtimeMode: "full-access",
    });
    assert.isTrue(yield* adapter.hasSession(threadId));

    yield* adapter.interruptTurn(threadId, TurnId.make("turn-1"));
    assert.isFalse(yield* adapter.hasSession(threadId));
  }),
);

it.effect("readThread and rollbackThread fail for a thread with no session", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("nvidia-no-session");
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(testLayer(() => ({ body: chatCompletion("unused") }))),
    );

    const readExit = yield* Effect.exit(adapter.readThread(threadId));
    assert.isTrue(readExit._tag === "Failure");

    const rollbackExit = yield* Effect.exit(adapter.rollbackThread(threadId, 1));
    assert.isTrue(rollbackExit._tag === "Failure");
  }),
);

it.effect("rollbackThread removes the trailing turn's messages", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("nvidia-rollback");
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(testLayer(() => ({ body: chatCompletion("first reply") }))),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("nvidia"),
      runtimeMode: "full-access",
    });

    const turnCompleted = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      event.type === "turn.completed" ? Deferred.succeed(turnCompleted, undefined) : Effect.void,
    ).pipe(Effect.forkChild);

    yield* adapter.sendTurn({ threadId, input: "first message" });
    yield* Deferred.await(turnCompleted);
    yield* Fiber.interrupt(eventsFiber);

    const beforeRollback = yield* adapter.readThread(threadId);
    assert.equal(beforeRollback.turns.length, 1);

    const afterRollback = yield* adapter.rollbackThread(threadId, 1);
    assert.equal(afterRollback.turns.length, 0);

    const readAfter = yield* adapter.readThread(threadId);
    assert.equal(readAfter.turns.length, 0);
  }),
);

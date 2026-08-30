import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  ApprovalRequestId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@helmcode/contracts";

import { makeOpenRouterAdapter } from "./OpenRouterAdapter.ts";

type CapturedRequest = {
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: {
    readonly model: string;
    readonly messages: ReadonlyArray<unknown>;
    readonly tools?: unknown;
  };
};

const chatCompletion = (content: string) => ({
  choices: [{ message: { role: "assistant", content } }],
});

const toolCallCompletion = (calls: ReadonlyArray<{ id: string; name: string; args: unknown }>) => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
    },
  ],
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
        const captured: CapturedRequest = {
          authorization: request.headers["authorization"],
          contentType: request.headers["content-type"],
          body: parsedBody,
        };
        // Regression guard: OpenRouter's real API rejects anything but
        // application/json with a 415, which is exactly what
        // `bodyText(bodyText)` (no explicit content type) sent, since
        // HttpBody.text defaults to text/plain and silently overwrites
        // whatever `setHeader("Content-Type", ...)` set before it.
        const { status = 200, body } = captured.contentType?.startsWith("application/json")
          ? respond(captured)
          : { status: 415, body: { error: "Unsupported Media Type" } };
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
  makeOpenRouterAdapter({
    apiKey: "test-openrouter-key",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.5",
  });

it.effect("starts a session and completes a turn against a mocked chat completion", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("openrouter-happy-path");
    const requests: CapturedRequest[] = [];
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(
        testLayer((captured) => {
          requests.push(captured);
          return { body: chatCompletion("Hello from OpenRouter.") };
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
      provider: ProviderDriverKind.make("openrouter"),
      runtimeMode: "full-access",
    });
    assert.equal(session.provider, "openrouter");
    assert.equal(session.status, "ready");

    const result = yield* adapter.sendTurn({ threadId, input: "Say hello." });
    assert.equal(result.threadId, threadId);

    yield* Deferred.await(turnCompleted);
    yield* Fiber.interrupt(eventsFiber);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.authorization, "Bearer test-openrouter-key");
    assert.equal(requests[0]!.contentType, "application/json");
    assert.equal(requests[0]!.body.model, "anthropic/claude-sonnet-4.5");
    assert.deepEqual(requests[0]!.body.messages, [
      {
        role: "system",
        content:
          "You have no file, shell, or tool access -- you cannot read or list any codebase. If the user asks about code, ask them to paste it.",
      },
      { role: "user", content: "Say hello." },
    ]);

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
      { role: "assistant", content: "Hello from OpenRouter." },
    ]);
  }),
);

it.effect("publishes a session.exited event when sending a turn for an unknown thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("openrouter-unknown-thread");
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

it.effect("publishes session.exited when OpenRouter responds with a non-200 status", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("openrouter-http-error");
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(testLayer(() => ({ status: 500, body: { error: "boom" } }))),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("openrouter"),
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
    // Persistent 5xx exhausts the adapter's retry-with-backoff schedule
    // before giving up; advance the virtual clock past its total delay
    // (500ms + 1s + 2s) instead of waiting on it in real time.
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.seconds(4));
    yield* Deferred.await(exited);
    yield* Fiber.interrupt(eventsFiber);

    const exitedEvent = runtimeEvents.find((event) => event.type === "session.exited");
    assert.isDefined(exitedEvent);
    if (exitedEvent?.type === "session.exited") {
      assert.include(exitedEvent.payload.reason, "HTTP 500");
      assert.isFalse(exitedEvent.payload.recoverable);
      assert.equal(exitedEvent.payload.exitKind, "error");
    }
  }),
);

it.effect("publishes session.exited when the model returns an empty response", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("openrouter-empty-response");
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(testLayer(() => ({ body: chatCompletion("") }))),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("openrouter"),
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
      assert.include(exitedEvent.payload.reason, "empty response");
      assert.isFalse(exitedEvent.payload.recoverable);
    }
  }),
);

it.effect("rejects interactive approval and user-input requests as unsupported", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("openrouter-unsupported-requests");
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
      // NOTE: `sessions` in OpenRouterAdapter.ts is module-level (shared by every
      // `makeOpenRouterAdapter()` call in this process), so `listSessions()` here
      // can include threads started by other tests in this file. Assert
      // membership rather than an exact count.
      const threadId = ThreadId.make("openrouter-lifecycle");
      const adapter = yield* makeTestAdapter().pipe(
        Effect.provide(testLayer(() => ({ body: chatCompletion("unused") }))),
      );

      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("openrouter"),
        runtimeMode: "full-access",
      });
      assert.isTrue(yield* adapter.hasSession(threadId));
      const sessions = yield* adapter.listSessions();
      assert.isTrue(sessions.some((session) => session.threadId === threadId));

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("openrouter"),
        runtimeMode: "full-access",
      });
      yield* adapter.stopAll();
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
);

it.effect("interruptTurn drops the in-memory session for its thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("openrouter-interrupt");
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(testLayer(() => ({ body: chatCompletion("unused") }))),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("openrouter"),
      runtimeMode: "full-access",
    });
    assert.isTrue(yield* adapter.hasSession(threadId));

    yield* adapter.interruptTurn(threadId, TurnId.make("turn-1"));
    assert.isFalse(yield* adapter.hasSession(threadId));
  }),
);

it.effect("readThread and rollbackThread fail for a thread with no session", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("openrouter-no-session");
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
    const threadId = ThreadId.make("openrouter-rollback");
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(testLayer(() => ({ body: chatCompletion("first reply") }))),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("openrouter"),
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

it.effect(
  "completes the turn even after the fiber that called sendTurn has finished (regression: forkChild vs forkDetach)",
  () =>
    Effect.gen(function* () {
      // Mirrors ProviderCommandReactor.ts, which runs `sendTurn` inside a
      // short-lived `Effect.forkScoped` fiber that completes the instant
      // `sendTurn` returns. `Effect.forkChild` ties its forked fiber's
      // lifetime to that parent, so the background HTTP call would be
      // interrupted before it ever ran -- session.started fires, then
      // nothing else, forever. `Effect.forkDetach` fixes it.
      const threadId = ThreadId.make("openrouter-detached-turn");
      const adapter = yield* makeTestAdapter().pipe(
        Effect.provide(testLayer(() => ({ body: chatCompletion("survived the parent fiber") }))),
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("openrouter"),
        runtimeMode: "full-access",
      });

      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(turnCompleted, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      const callerFiber = yield* adapter.sendTurn({ threadId, input: "hi" }).pipe(Effect.forkChild);
      yield* Fiber.join(callerFiber);

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);
    }),
);

it.effect("runs a workspace tool call before answering when a cwd is set", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${cwd}/notes.txt`, "hello from disk");

    const threadId = ThreadId.make("openrouter-tool-call");
    const requests: CapturedRequest[] = [];
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(
        testLayer((captured) => {
          requests.push(captured);
          return requests.length === 1
            ? {
                body: toolCallCompletion([
                  { id: "call_1", name: "read_file", args: { path: "notes.txt" } },
                ]),
              }
            : { body: chatCompletion("The file says: hello from disk") };
        }),
      ),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("openrouter"),
      runtimeMode: "full-access",
      cwd,
    });

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

    yield* adapter.sendTurn({ threadId, input: "what does notes.txt say?" });
    yield* Deferred.await(turnCompleted);
    yield* Fiber.interrupt(eventsFiber);

    assert.equal(requests.length, 2);
    // First round offered the tools; the second round included the tool
    // result as a "tool" message so the model could use it.
    assert.isDefined(requests[0]!.body.tools);
    const secondRoundMessages = requests[1]!.body.messages as Array<Record<string, unknown>>;
    const toolResultMessage = secondRoundMessages.find((message) => message.role === "tool");
    assert.isDefined(toolResultMessage);
    assert.equal(toolResultMessage?.content, "hello from disk");

    const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
    const toolCompleted = runtimeEvents.find(
      (event) => event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
    );
    assert.isDefined(toolStarted);
    assert.isDefined(toolCompleted);
    if (toolCompleted?.type === "item.completed") {
      assert.equal(toolCompleted.payload.title, "read_file");
      assert.equal(toolCompleted.payload.detail, "hello from disk");
    }

    const finalContent = runtimeEvents.find((event) => event.type === "content.delta");
    if (finalContent?.type === "content.delta") {
      assert.equal(finalContent.payload.delta, "The file says: hello from disk");
    } else {
      assert.fail("expected a content.delta event");
    }

    const thread = yield* adapter.readThread(threadId);
    assert.equal(thread.turns.length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a read_file path that escapes the project root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped();

    const threadId = ThreadId.make("openrouter-tool-path-escape");
    const requests: CapturedRequest[] = [];
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(
        testLayer((captured) => {
          requests.push(captured);
          return requests.length === 1
            ? {
                body: toolCallCompletion([
                  { id: "call_1", name: "read_file", args: { path: "../../etc/passwd" } },
                ]),
              }
            : { body: chatCompletion("I can't read outside the project.") };
        }),
      ),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("openrouter"),
      runtimeMode: "full-access",
      cwd,
    });

    const turnCompleted = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      event.type === "turn.completed" ? Deferred.succeed(turnCompleted, undefined) : Effect.void,
    ).pipe(Effect.forkChild);

    yield* adapter.sendTurn({ threadId, input: "read /etc/passwd" });
    yield* Deferred.await(turnCompleted);
    yield* Fiber.interrupt(eventsFiber);

    assert.equal(requests.length, 2);
    const secondRoundMessages = requests[1]!.body.messages as Array<Record<string, unknown>>;
    const toolResultMessage = secondRoundMessages.find((message) => message.role === "tool");
    assert.isDefined(toolResultMessage);
    assert.include(toolResultMessage?.content as string, "outside the project root");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("falls back to no tools when the model rejects the tools field", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped();

    const threadId = ThreadId.make("openrouter-tools-unsupported");
    const requests: CapturedRequest[] = [];
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(
        testLayer((captured) => {
          requests.push(captured);
          return captured.body.tools
            ? { status: 400, body: { error: "tools is not supported for this model" } }
            : { body: chatCompletion("plain answer, no tools") };
        }),
      ),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("openrouter"),
      runtimeMode: "full-access",
      cwd,
    });

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

    yield* adapter.sendTurn({ threadId, input: "hello" });
    yield* Deferred.await(turnCompleted);
    yield* Fiber.interrupt(eventsFiber);

    assert.equal(requests.length, 2);
    assert.isDefined(requests[0]!.body.tools);
    assert.isUndefined(requests[1]!.body.tools);

    const finalContent = runtimeEvents.find((event) => event.type === "content.delta");
    if (finalContent?.type === "content.delta") {
      assert.equal(finalContent.payload.delta, "plain answer, no tools");
    } else {
      assert.fail("expected a content.delta event");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not follow a symlink that escapes the project root during search_text", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const outsideDir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${outsideDir}/secret.txt`, "top secret leak marker");
    yield* fs.symlink(`${outsideDir}/secret.txt`, `${cwd}/innocuous-link.txt`);

    const threadId = ThreadId.make("openrouter-symlink-escape");
    const requests: CapturedRequest[] = [];
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(
        testLayer((captured) => {
          requests.push(captured);
          return requests.length === 1
            ? {
                body: toolCallCompletion([
                  { id: "call_1", name: "search_text", args: { query: "top secret" } },
                ]),
              }
            : { body: chatCompletion("no leak") };
        }),
      ),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("openrouter"),
      runtimeMode: "full-access",
      cwd,
    });

    const turnCompleted = yield* Deferred.make<void>();
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      event.type === "turn.completed" ? Deferred.succeed(turnCompleted, undefined) : Effect.void,
    ).pipe(Effect.forkChild);

    yield* adapter.sendTurn({ threadId, input: "search for the leak" });
    yield* Deferred.await(turnCompleted);
    yield* Fiber.interrupt(eventsFiber);

    assert.equal(requests.length, 2);
    const secondRoundMessages = requests[1]!.body.messages as Array<Record<string, unknown>>;
    const toolResultMessage = secondRoundMessages.find((message) => message.role === "tool");
    assert.isDefined(toolResultMessage);
    assert.notInclude(toolResultMessage?.content as string, "top secret leak marker");
    assert.equal(toolResultMessage?.content, "No matches found.");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("ignores a malformed tool_call instead of crashing the turn", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped();

    const threadId = ThreadId.make("openrouter-malformed-tool-call");
    const requests: CapturedRequest[] = [];
    const adapter = yield* makeTestAdapter().pipe(
      Effect.provide(
        testLayer((captured) => {
          requests.push(captured);
          return {
            body: {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "answered anyway",
                    // Missing `function` entirely -- a real model/proxy bug,
                    // not something the adapter should ever construct itself.
                    tool_calls: [{ id: "call_1" }],
                  },
                },
              ],
            },
          };
        }),
      ),
    );

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("openrouter"),
      runtimeMode: "full-access",
      cwd,
    });

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

    yield* adapter.sendTurn({ threadId, input: "hello" });
    yield* Deferred.await(turnCompleted);
    yield* Fiber.interrupt(eventsFiber);

    // The malformed tool_call is dropped, leaving no valid tool calls, so
    // the turn treats the response's content as the final answer in a
    // single round rather than crashing.
    assert.equal(requests.length, 1);
    const finalContent = runtimeEvents.find((event) => event.type === "content.delta");
    if (finalContent?.type === "content.delta") {
      assert.equal(finalContent.payload.delta, "answered anyway");
    } else {
      assert.fail("expected a content.delta event");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

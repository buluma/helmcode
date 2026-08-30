import type { NvidiaAdapterShape } from "../Services/NvidiaAdapter.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import { PROVIDER_RUNTIME_EVENT_QUEUE_CAPACITY } from "../runtimeEventQueueCapacity.ts";

import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  EventId,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@helmcode/contracts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";

const NVIDIA = ProviderDriverKind.make("nvidia");

const encodeJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeJsonStringExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

interface Session {
  readonly cwd: string | undefined;
  readonly messages: Array<{ readonly role: "user" | "assistant"; readonly content: string }>;
}

const sessions = new Map<ThreadId, Session>();

/**
 * NVIDIA's gateway occasionally 500s on its own auth-extension plumbing
 * (observed: "Missing request extension ... axum::Extension") and clears up
 * seconds later -- distinct from this file's own class of the same name
 * duplicated in OpenRouterAdapter.ts. Marks a response as worth retrying;
 * never thrown for 4xx (bad key/model/quota), which are not transient.
 */
class NvidiaTransientHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

// Retried request never touched session state or produced any content, so
// re-issuing it duplicates nothing -- unlike a turn already visible to the
// user or the workspace.
const NVIDIA_HTTP_RETRY_SCHEDULE = Schedule.exponential("500 millis").pipe(
  Schedule.upTo({ times: 3 }),
);

// This adapter is a bare chat-completions passthrough -- no tool calling, no
// filesystem access -- so the model otherwise has nothing telling it which
// repo it's supposedly helping with. A system message naming the working
// directory at least stops it from claiming no codebase was shared.
function systemMessageFor(cwd: string | undefined): { role: "system"; content: string } {
  return {
    role: "system",
    content: cwd
      ? `You are assisting with the project checked out at ${cwd}. You have no file, shell, or tool access -- you cannot read or list its contents. If the user asks about code, ask them to paste it.`
      : "You have no file, shell, or tool access -- you cannot read or list any codebase. If the user asks about code, ask them to paste it.",
  };
}

export const makeNvidiaAdapter = Effect.fn("makeNvidiaAdapter")(function* (input: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
}) {
  const events = yield* PubSub.bounded<ProviderRuntimeEvent>(PROVIDER_RUNTIME_EVENT_QUEUE_CAPACITY);

  const publish = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.ignoreCause(PubSub.publish(events, event));

  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;

  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: NVIDIA,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate NVIDIA runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, EventId.make);
  const nextTurnId = Effect.map(randomUUIDv4, TurnId.make);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const attemptChatCompletions = (payload: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    readonly model: string;
  }): Effect.Effect<string, ProviderAdapterRequestError | NvidiaTransientHttpError> =>
    Effect.gen(function* () {
      const bodyEncoded = encodeJsonStringExit({
        model: payload.model,
        messages: payload.messages,
        temperature: 0.2,
      });
      const bodyText =
        bodyEncoded._tag === "Failure"
          ? yield* new ProviderAdapterRequestError({
              provider: NVIDIA,
              method: "chat.completions",
              detail: "Failed to encode request body.",
              cause: bodyEncoded.cause,
            })
          : bodyEncoded.value;

      const request = HttpClientRequest.post(
        `${input.baseUrl.replace(/\/$/, "")}/chat/completions`,
      ).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${input.apiKey}`),
        // bodyText's own contentType arg is authoritative -- HttpBody.text
        // defaults to "text/plain" and overwrites whatever setHeader set
        // before it, which was silently clobbering this to text/plain and
        // getting every request rejected with 415 by NVIDIA's API.
        HttpClientRequest.bodyText(bodyText, "application/json"),
      );

      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: NVIDIA,
              method: "chat.completions",
              detail: "Failed to reach NVIDIA NIM.",
              cause,
            }),
        ),
      );

      if (response.status !== 200) {
        const text = yield* response.text.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: NVIDIA,
                method: "chat.completions",
                detail: `Failed to read error response body: ${cause}`,
                cause,
              }),
          ),
        );
        const detail = `HTTP ${response.status}: ${text.trim().length > 0 ? text.trim() : String(response.status)}`;
        if (response.status >= 500) {
          return yield* Effect.fail(new NvidiaTransientHttpError(response.status, detail));
        }
        return yield* new ProviderAdapterRequestError({
          provider: NVIDIA,
          method: "chat.completions",
          detail,
          cause: new Error(`HTTP ${response.status}`),
        });
      }

      const responseText = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: NVIDIA,
              method: "chat.completions",
              detail: `Failed to read response body: ${cause}`,
              cause,
            }),
        ),
      );

      const parsed = yield* Effect.try({
        try: () => {
          const result = decodeJsonStringExit(responseText);
          if (result._tag === "Failure") throw result.cause;
          return result.value as Record<string, unknown>;
        },
        catch: (error) =>
          new ProviderAdapterRequestError({
            provider: NVIDIA,
            method: "chat.completions",
            detail: "NVIDIA response body was not valid JSON.",
            cause: error,
          }),
      });

      const choices = (parsed.choices as Array<Record<string, unknown>> | undefined) ?? [];
      const content = (choices[0]?.message as Record<string, unknown> | undefined)?.content as
        | string
        | undefined;
      if (!content || content.trim().length === 0) {
        return yield* new ProviderAdapterRequestError({
          provider: NVIDIA,
          method: "chat.completions",
          detail: "Model returned an empty response.",
        });
      }

      return content;
    });

  const callChatCompletions = (payload: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    readonly model: string;
  }): Effect.Effect<string, ProviderAdapterRequestError> =>
    attemptChatCompletions(payload).pipe(
      Effect.retry({
        while: (error) => error instanceof NvidiaTransientHttpError,
        schedule: NVIDIA_HTTP_RETRY_SCHEDULE,
      }),
      Effect.catch((error) =>
        Effect.fail(
          error instanceof NvidiaTransientHttpError
            ? new ProviderAdapterRequestError({
                provider: NVIDIA,
                method: "chat.completions",
                detail: error.message,
                cause: error,
              })
            : error,
        ),
      ),
    );

  const startSession: NvidiaAdapterShape["startSession"] = (sessionInput) =>
    Effect.gen(function* () {
      sessions.set(sessionInput.threadId, { cwd: sessionInput.cwd, messages: [] });

      yield* publish({
        eventId: yield* nextEventId,
        provider: NVIDIA,
        threadId: sessionInput.threadId,
        createdAt: yield* nowIso,
        type: "session.started",
        payload: { message: sessionInput.cwd ?? undefined },
      });

      return {
        provider: NVIDIA,
        status: "ready",
        runtimeMode: sessionInput.runtimeMode,
        cwd: sessionInput.cwd,
        threadId: sessionInput.threadId,
        createdAt: yield* nowIso,
        updatedAt: yield* nowIso,
      };
    });

  const sendTurn: NvidiaAdapterShape["sendTurn"] = (turnInput) =>
    Effect.gen(function* () {
      const turnId = yield* nextTurnId;

      const work = Effect.gen(function* () {
        const session = sessions.get(turnInput.threadId);
        if (!session) {
          yield* publish({
            eventId: yield* nextEventId,
            provider: NVIDIA,
            threadId: turnInput.threadId,
            turnId,
            createdAt: yield* nowIso,
            type: "session.exited",
            payload: {
              reason: `Session for thread ${turnInput.threadId} not found.`,
              recoverable: false,
              exitKind: "error",
            },
          });
          return;
        }

        yield* publish({
          eventId: yield* nextEventId,
          provider: NVIDIA,
          threadId: turnInput.threadId,
          turnId,
          createdAt: yield* nowIso,
          type: "turn.started",
          payload: { model: turnInput.modelSelection?.model ?? input.defaultModel },
        });

        const userMessage = turnInput.input ?? "";

        const fullText = yield* callChatCompletions({
          messages: [
            systemMessageFor(session.cwd),
            ...session.messages,
            { role: "user" as const, content: userMessage },
          ],
          model: turnInput.modelSelection?.model ?? input.defaultModel,
        });

        sessions.set(turnInput.threadId, {
          cwd: session.cwd,
          messages: [
            ...session.messages,
            { role: "user" as const, content: userMessage },
            { role: "assistant" as const, content: fullText },
          ],
        });

        yield* publish({
          eventId: yield* nextEventId,
          provider: NVIDIA,
          threadId: turnInput.threadId,
          turnId,
          createdAt: yield* nowIso,
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: fullText },
        });

        yield* publish({
          eventId: yield* nextEventId,
          provider: NVIDIA,
          threadId: turnInput.threadId,
          turnId,
          createdAt: yield* nowIso,
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            detail: fullText,
          },
        });

        yield* publish({
          eventId: yield* nextEventId,
          provider: NVIDIA,
          threadId: turnInput.threadId,
          turnId,
          createdAt: yield* nowIso,
          type: "turn.completed",
          payload: { state: "completed" },
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            // The pino JSON logger serializes a raw Cause as an opaque
            // { _id: 'Cause', failures: [Object] } blob -- Cause.pretty
            // renders the actual error chain into readable text.
            yield* Effect.logError("NVIDIA adapter turn failed", { cause: Cause.pretty(cause) });
            yield* publish({
              eventId: yield* nextEventId,
              provider: NVIDIA,
              threadId: turnInput.threadId,
              turnId,
              createdAt: yield* nowIso,
              type: "session.exited",
              payload: {
                reason: (() => {
                  const squashed = Cause.squash(cause);
                  return squashed instanceof Error && squashed.message.length > 0
                    ? squashed.message
                    : "NVIDIA adapter turn failed.";
                })(),
                recoverable: false,
                exitKind: "error",
              },
            });
          }),
        ),
      );

      // The caller (ProviderCommandReactor) runs sendTurn inside a
      // short-lived Effect.forkScoped fiber that completes the instant this
      // function returns. Effect.forkChild ties the forked fiber's lifetime
      // to that parent fiber, so `work` would be interrupted before it ever
      // reaches the HTTP call. Effect.forkDetach attaches it to the global
      // scope instead, so it survives past sendTurn's own return.
      yield* Effect.forkDetach(work);

      return { threadId: turnInput.threadId, turnId };
    });

  const interruptTurn: NvidiaAdapterShape["interruptTurn"] = (
    _threadId: ThreadId,
    _turnId?: TurnId,
  ) =>
    Effect.sync(() => {
      sessions.delete(_threadId);
    });

  const respondToRequest: NvidiaAdapterShape["respondToRequest"] = (
    _threadId: ThreadId,
    _requestId: string,
    _decision: string,
  ) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: NVIDIA,
        operation: "respondToRequest",
        issue: "Interactive approval requests are not supported by this adapter.",
      }),
    );

  const respondToUserInput: NvidiaAdapterShape["respondToUserInput"] = (
    _threadId: ThreadId,
    _requestId: string,
    _answers: unknown,
  ) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: NVIDIA,
        operation: "respondToUserInput",
        issue: "Structured user-input requests are not supported by this adapter.",
      }),
    );

  const stopSession: NvidiaAdapterShape["stopSession"] = (threadId: ThreadId) =>
    Effect.sync(() => {
      sessions.delete(threadId);
    });

  const listSessions: NvidiaAdapterShape["listSessions"] = () =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const result: Array<{
        provider: typeof NVIDIA;
        status: "ready";
        runtimeMode: "auto";
        threadId: ThreadId;
        createdAt: string;
        updatedAt: string;
      }> = [];
      for (const [threadId] of sessions) {
        result.push({
          provider: NVIDIA,
          status: "ready",
          runtimeMode: "auto",
          threadId,
          createdAt,
          updatedAt: createdAt,
        });
      }
      return result;
    });

  const hasSession: NvidiaAdapterShape["hasSession"] = (threadId: ThreadId) =>
    Effect.succeed(sessions.has(threadId));

  const readThread: NvidiaAdapterShape["readThread"] = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({ provider: NVIDIA, threadId });
      }

      const turns: Array<ProviderThreadTurnSnapshot> = [];
      for (let i = 0; i < session.messages.length; i += 2) {
        const items: Array<unknown> = [];
        const userMessage = session.messages[i];
        const assistantMessage = session.messages[i + 1];
        if (userMessage) {
          items.push({ role: userMessage.role, content: userMessage.content });
        }
        if (assistantMessage) {
          items.push({ role: assistantMessage.role, content: assistantMessage.content });
        }
        turns.push({ id: yield* nextTurnId, items });
      }

      return { threadId, turns } as ProviderThreadSnapshot;
    });

  const rollbackThread: NvidiaAdapterShape["rollbackThread"] = (
    threadId: ThreadId,
    numTurns: number,
  ) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({ provider: NVIDIA, threadId });
      }

      sessions.set(threadId, {
        cwd: session.cwd,
        messages: session.messages.slice(0, -numTurns * 2),
      });
      return { threadId, turns: [] } as ProviderThreadSnapshot;
    });

  const stopAll: NvidiaAdapterShape["stopAll"] = () =>
    Effect.sync(() => {
      sessions.clear();
    });

  return {
    provider: NVIDIA,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(events),
  } satisfies NvidiaAdapterShape;
});

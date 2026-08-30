import type { OpenRouterAdapterShape } from "../Services/OpenRouterAdapter.ts";
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

const OPENROUTER = ProviderDriverKind.make("openrouter");

const encodeJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeJsonStringExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

interface Session {
  readonly cwd: string | undefined;
  readonly messages: Array<{ readonly role: "user" | "assistant"; readonly content: string }>;
}

const sessions = new Map<ThreadId, Session>();

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

/**
 * Upstream gateways occasionally 500 on transient plumbing issues (observed
 * on NVIDIA's equivalent adapter: "Missing request extension ...
 * axum::Extension") and clear up seconds later -- distinct from this file's
 * own class of the same name duplicated in NvidiaAdapter.ts. Marks a
 * response as worth retrying; never thrown for 4xx (bad key/model/quota),
 * which are not transient.
 */
class OpenRouterTransientHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

// Retried request never touched session state or produced any content, so
// re-issuing it duplicates nothing -- unlike a turn already visible to the
// user or the workspace.
const OPENROUTER_HTTP_RETRY_SCHEDULE = Schedule.exponential("500 millis").pipe(
  Schedule.upTo({ times: 3 }),
);

export const makeOpenRouterAdapter = Effect.fn("makeOpenRouterAdapter")(function* (input: {
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
          provider: OPENROUTER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate OpenRouter runtime identifier.",
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
  }): Effect.Effect<string, ProviderAdapterRequestError | OpenRouterTransientHttpError> =>
    Effect.gen(function* () {
      const bodyEncoded = encodeJsonStringExit({
        model: payload.model,
        messages: payload.messages,
        temperature: 0.2,
      });
      const bodyText =
        bodyEncoded._tag === "Failure"
          ? yield* new ProviderAdapterRequestError({
              provider: OPENROUTER,
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
        // getting every request rejected with a 415 by the upstream API.
        HttpClientRequest.bodyText(bodyText, "application/json"),
      );

      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: OPENROUTER,
              method: "chat.completions",
              detail: "Failed to reach OpenRouter.",
              cause,
            }),
        ),
      );

      if (response.status !== 200) {
        const text = yield* response.text.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: OPENROUTER,
                method: "chat.completions",
                detail: `Failed to read error response body: ${cause}`,
                cause,
              }),
          ),
        );
        const detail = `HTTP ${response.status}: ${text.trim().length > 0 ? text.trim() : String(response.status)}`;
        if (response.status >= 500) {
          return yield* Effect.fail(new OpenRouterTransientHttpError(response.status, detail));
        }
        return yield* new ProviderAdapterRequestError({
          provider: OPENROUTER,
          method: "chat.completions",
          detail,
          cause: new Error(`HTTP ${response.status}`),
        });
      }

      const responseText = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: OPENROUTER,
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
            provider: OPENROUTER,
            method: "chat.completions",
            detail: "OpenRouter response body was not valid JSON.",
            cause: error,
          }),
      });

      const choices = (parsed.choices as Array<Record<string, unknown>> | undefined) ?? [];
      const content = (choices[0]?.message as Record<string, unknown> | undefined)?.content as
        | string
        | undefined;
      if (!content || content.trim().length === 0) {
        return yield* new ProviderAdapterRequestError({
          provider: OPENROUTER,
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
        while: (error) => error instanceof OpenRouterTransientHttpError,
        schedule: OPENROUTER_HTTP_RETRY_SCHEDULE,
      }),
      Effect.catch((error) =>
        Effect.fail(
          error instanceof OpenRouterTransientHttpError
            ? new ProviderAdapterRequestError({
                provider: OPENROUTER,
                method: "chat.completions",
                detail: error.message,
                cause: error,
              })
            : error,
        ),
      ),
    );

  const startSession: OpenRouterAdapterShape["startSession"] = (sessionInput) =>
    Effect.gen(function* () {
      sessions.set(sessionInput.threadId, { cwd: sessionInput.cwd, messages: [] });

      yield* publish({
        eventId: yield* nextEventId,
        provider: OPENROUTER,
        threadId: sessionInput.threadId,
        createdAt: yield* nowIso,
        type: "session.started",
        payload: { message: sessionInput.cwd ?? undefined },
      });

      return {
        provider: OPENROUTER,
        status: "ready",
        runtimeMode: sessionInput.runtimeMode,
        cwd: sessionInput.cwd,
        threadId: sessionInput.threadId,
        createdAt: yield* nowIso,
        updatedAt: yield* nowIso,
      };
    });

  const sendTurn: OpenRouterAdapterShape["sendTurn"] = (turnInput) =>
    Effect.gen(function* () {
      const turnId = yield* nextTurnId;

      const work = Effect.gen(function* () {
        const session = sessions.get(turnInput.threadId);
        if (!session) {
          yield* publish({
            eventId: yield* nextEventId,
            provider: OPENROUTER,
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
          provider: OPENROUTER,
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
          provider: OPENROUTER,
          threadId: turnInput.threadId,
          turnId,
          createdAt: yield* nowIso,
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: fullText },
        });

        yield* publish({
          eventId: yield* nextEventId,
          provider: OPENROUTER,
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
          provider: OPENROUTER,
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
            yield* Effect.logError("OpenRouter adapter turn failed", {
              cause: Cause.pretty(cause),
            });
            yield* publish({
              eventId: yield* nextEventId,
              provider: OPENROUTER,
              threadId: turnInput.threadId,
              turnId,
              createdAt: yield* nowIso,
              type: "session.exited",
              payload: {
                reason: (() => {
                  const squashed = Cause.squash(cause);
                  return squashed instanceof Error && squashed.message.length > 0
                    ? squashed.message
                    : "OpenRouter adapter turn failed.";
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

  const interruptTurn: OpenRouterAdapterShape["interruptTurn"] = (
    _threadId: ThreadId,
    _turnId?: TurnId,
  ) =>
    Effect.sync(() => {
      sessions.delete(_threadId);
    });

  const respondToRequest: OpenRouterAdapterShape["respondToRequest"] = (
    _threadId: ThreadId,
    _requestId: string,
    _decision: string,
  ) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: OPENROUTER,
        operation: "respondToRequest",
        issue: "Interactive approval requests are not supported by this adapter.",
      }),
    );

  const respondToUserInput: OpenRouterAdapterShape["respondToUserInput"] = (
    _threadId: ThreadId,
    _requestId: string,
    _answers: unknown,
  ) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: OPENROUTER,
        operation: "respondToUserInput",
        issue: "Structured user-input requests are not supported by this adapter.",
      }),
    );

  const stopSession: OpenRouterAdapterShape["stopSession"] = (threadId: ThreadId) =>
    Effect.sync(() => {
      sessions.delete(threadId);
    });

  const listSessions: OpenRouterAdapterShape["listSessions"] = () =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const result: Array<{
        provider: typeof OPENROUTER;
        status: "ready";
        runtimeMode: "auto";
        threadId: ThreadId;
        createdAt: string;
        updatedAt: string;
      }> = [];
      for (const [threadId] of sessions) {
        result.push({
          provider: OPENROUTER,
          status: "ready",
          runtimeMode: "auto",
          threadId,
          createdAt,
          updatedAt: createdAt,
        });
      }
      return result;
    });

  const hasSession: OpenRouterAdapterShape["hasSession"] = (threadId: ThreadId) =>
    Effect.succeed(sessions.has(threadId));

  const readThread: OpenRouterAdapterShape["readThread"] = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({ provider: OPENROUTER, threadId });
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

  const rollbackThread: OpenRouterAdapterShape["rollbackThread"] = (
    threadId: ThreadId,
    numTurns: number,
  ) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({ provider: OPENROUTER, threadId });
      }

      sessions.set(threadId, {
        cwd: session.cwd,
        messages: session.messages.slice(0, -numTurns * 2),
      });
      return { threadId, turns: [] } as ProviderThreadSnapshot;
    });

  const stopAll: OpenRouterAdapterShape["stopAll"] = () =>
    Effect.sync(() => {
      sessions.clear();
    });

  return {
    provider: OPENROUTER,
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
  } satisfies OpenRouterAdapterShape;
});

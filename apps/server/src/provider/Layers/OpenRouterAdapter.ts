import type { OpenRouterAdapterShape } from "../Services/OpenRouterAdapter.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import { PROVIDER_RUNTIME_EVENT_QUEUE_CAPACITY } from "../runtimeEventQueueCapacity.ts";

import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as PubSub from "effect/PubSub";
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

interface Session {
  readonly messages: Array<{ readonly role: "user" | "assistant"; readonly content: string }>;
}

const sessions = new Map<ThreadId, Session>();

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

  const callChatCompletions = (payload: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    readonly model: string;
  }): Effect.Effect<string, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      const bodyText = JSON.stringify({
        model: payload.model,
        messages: payload.messages,
        temperature: 0.2,
      });

      const request = HttpClientRequest.post(
        `${input.baseUrl.replace(/\/$/, "")}/chat/completions`,
      ).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${input.apiKey}`),
        HttpClientRequest.setHeader("Content-Type", "application/json"),
        HttpClientRequest.bodyText(bodyText),
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
        return yield* Effect.fail(
          new ProviderAdapterRequestError({
            provider: OPENROUTER,
            method: "chat.completions",
            detail: `HTTP ${response.status}: ${text.trim().length > 0 ? text.trim() : String(response.status)}`,
            cause: new Error(`HTTP ${response.status}`),
          }),
        );
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
        try: () => JSON.parse(responseText) as Record<string, unknown>,
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
        return yield* Effect.fail(
          new ProviderAdapterRequestError({
            provider: OPENROUTER,
            method: "chat.completions",
            detail: "Model returned an empty response.",
          }),
        );
      }

      return content;
    });

  const startSession: OpenRouterAdapterShape["startSession"] = (sessionInput) =>
    Effect.gen(function* () {
      sessions.set(sessionInput.threadId, { messages: [] });

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
          messages: [...session.messages, { role: "user" as const, content: userMessage }],
          model: turnInput.modelSelection?.model ?? input.defaultModel,
        });

        sessions.set(turnInput.threadId, {
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
          Effect.ignoreCause(Effect.logError("OpenRouter adapter turn failed", { cause })),
        ),
      );

      yield* Effect.forkChild(work);

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
        return yield* Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: OPENROUTER, threadId }),
        );
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
        return yield* Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: OPENROUTER, threadId }),
        );
      }

      sessions.set(threadId, { messages: session.messages.slice(0, -numTurns * 2) });
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

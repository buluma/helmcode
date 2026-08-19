import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Schema from "effect/Schema";

import { TextGenerationError } from "@helmcode/contracts";
import { sanitizeBranchFragment } from "@helmcode/shared/git";
import { extractJsonObject } from "@helmcode/shared/schemaJson";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import * as TextGeneration from "./TextGeneration.ts";

class OpenAICompatibleTextGenerationRequestError extends Schema.TaggedErrorClass<OpenAICompatibleTextGenerationRequestError>()(
  "OpenAICompatibleTextGenerationRequestError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
    detail: Schema.String,
  },
) {
  override get message() {
    return `OpenAI-compatible text generation request failed for ${this.operation}.`;
  }
}

class OpenAICompatibleTextGenerationResponseError extends Schema.TaggedErrorClass<OpenAICompatibleTextGenerationResponseError>()(
  "OpenAICompatibleTextGenerationResponseError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `OpenAI-compatible response was missing content for ${this.operation}.`;
  }
}

class OpenAICompatibleTextGenerationOutputError extends Schema.TaggedErrorClass<OpenAICompatibleTextGenerationOutputError>()(
  "OpenAICompatibleTextGenerationOutputError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    detail: Schema.String,
  },
) {
  override get message() {
    return `OpenAI-compatible output parsing failed for ${this.operation}: ${this.detail}`;
  }
}

const DEFAULT_TEMPERATURE = 0.2;

const encodeJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeJsonStringExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const callChatCompletions = (
  input: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly defaultModel: string;
  },
  payload: {
    readonly model: string;
    readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  },
  httpClient: HttpClient.HttpClient,
): Effect.Effect<Record<string, unknown>, OpenAICompatibleTextGenerationRequestError> =>
  Effect.gen(function* () {

    const bodyEncoded = encodeJsonStringExit({
      model: payload.model,
      messages: payload.messages,
      temperature: DEFAULT_TEMPERATURE,
      response_format: { type: "json_object" },
    });
    const bodyText = yield* Effect.try({
      try: () => {
        if (bodyEncoded._tag === "Failure") throw bodyEncoded.cause;
        return bodyEncoded.value;
      },
      catch: (error) =>
        new OpenAICompatibleTextGenerationRequestError({
          operation: payload.model,
          detail: error instanceof Error ? error.message : String(error),
          cause: error,
        }),
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
          new OpenAICompatibleTextGenerationRequestError({
            operation: payload.model,
            detail: "OpenAI-compatible endpoint returned a failed response.",
            cause,
          }),
      ),
    );

    if (response.status !== 200) {
      const text = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new OpenAICompatibleTextGenerationRequestError({
              operation: payload.model,
              detail: `HTTP ${response.status}`,
              cause,
            }),
        ),
      );
      return yield* Effect.fail(
        new OpenAICompatibleTextGenerationRequestError({
          operation: payload.model,
          detail: `HTTP ${response.status}: ${text.trim().length > 0 ? text.trim() : String(response.status)}`,
          cause: new Error(`HTTP ${response.status}`),
        }),
      );
    }

    const responseText = yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          new OpenAICompatibleTextGenerationRequestError({
            operation: payload.model,
            detail: "OpenAI-compatible response body was not valid JSON.",
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
        new OpenAICompatibleTextGenerationRequestError({
          operation: payload.model,
          detail: "OpenAI-compatible response body was not valid JSON.",
          cause: error,
        }),
    });

    return parsed;
  });

const isTextGenerationError = Schema.is(TextGenerationError);

const decodeChatOutput = <A>(
  operation: string,
  schema: Schema.Schema<A>,
  raw: Record<string, unknown>,
): Effect.Effect<
  A,
  OpenAICompatibleTextGenerationResponseError | OpenAICompatibleTextGenerationOutputError
> => {
  const decoder = Schema.decodeUnknownExit(
    schema as unknown as Schema.ConstraintDecoder<unknown, never>,
  );
  const exit = decoder(raw);
  if (exit._tag === "Failure") {
    return Effect.fail(
      new OpenAICompatibleTextGenerationOutputError({
        operation,
        detail: `Decoded value does not match the requested schema.`,
        cause: exit.cause instanceof Error ? exit.cause : undefined,
      }),
    );
  }
  return Effect.succeed(exit.value as A);
};

const processTextGeneratorResult = <A>(
  operation: string,
  schema: Schema.Schema<A>,
  raw: Record<string, unknown>,
): Effect.Effect<A, TextGenerationError> =>
  decodeChatOutput(operation, schema, raw).pipe(
    Effect.catchTags({
      OpenAICompatibleTextGenerationResponseError: (error) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: error.detail,
            cause: error,
          }),
        ),
      OpenAICompatibleTextGenerationOutputError: (error) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: error.detail,
            cause: error,
          }),
        ),
    }),
  );

export const makeOpenAICompatibleTextGeneration = Effect.fn("makeOpenAICompatibleTextGeneration")(
  function* (input: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly defaultModel: string;
  }) {
    const httpClient = yield* HttpClient.HttpClient;

    return TextGeneration.TextGeneration.of({
      generateCommitMessage: (commitInput) =>
        Effect.gen(function* () {
          const prompt = buildCommitMessagePrompt({
            branch: commitInput.branch,
            stagedSummary: commitInput.stagedSummary,
            stagedPatch: commitInput.stagedPatch,
            includeBranch: commitInput.includeBranch ?? false,
            policy: commitInput.policy,
          });

          const raw = yield* callChatCompletions(input, {
            model: commitInput.modelSelection?.model ?? input.defaultModel,
            messages: [
              {
                role: "user",
                content: prompt.prompt,
              },
            ],
          }, httpClient);

          const decoded = yield* processTextGeneratorResult(
            "generateCommitMessage",
            prompt.outputSchema,
            raw,
          );

          const record = decoded as Record<string, unknown>;
          return {
            subject: sanitizeCommitSubject(record.subject as string),
            body: (record.body as string) ?? "",
          };
        }).pipe(
          Effect.mapError((cause) =>
            isTextGenerationError(cause)
              ? cause
              : new TextGenerationError({
                  operation: "generateCommitMessage",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
          ),
        ),

      generatePrContent: (prInput) =>
        Effect.gen(function* () {
          const prompt = buildPrContentPrompt({
            baseBranch: prInput.baseBranch,
            headBranch: prInput.headBranch,
            commitSummary: prInput.commitSummary,
            diffSummary: prInput.diffSummary,
            diffPatch: prInput.diffPatch,
            changeRequestTemplate: prInput.changeRequestTemplate,
            policy: prInput.policy,
          });

          const raw = yield* callChatCompletions(input, {
            model: prInput.modelSelection?.model ?? input.defaultModel,
            messages: [{ role: "user", content: prompt.prompt }],
          }, httpClient);

          const decoded = yield* processTextGeneratorResult(
            "generatePrContent",
            prompt.outputSchema,
            raw,
          );

          return {
            title: sanitizePrTitle((decoded as Record<string, unknown>).title as string),
            body: extractJsonObject((decoded as Record<string, unknown>).body as string),
          };
        }).pipe(
          Effect.mapError((cause) =>
            isTextGenerationError(cause)
              ? cause
              : new TextGenerationError({
                  operation: "generatePrContent",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
          ),
        ),

      generateBranchName: (branchInput) =>
        Effect.gen(function* () {
          const prompt = buildBranchNamePrompt({
            message: branchInput.message,
            attachments: branchInput.attachments,
          });

          const raw = yield* callChatCompletions(input, {
            model: branchInput.modelSelection?.model ?? input.defaultModel,
            messages: [{ role: "user", content: prompt.prompt }],
          }, httpClient);

          const decoded = yield* processTextGeneratorResult(
            "generateBranchName",
            prompt.outputSchema,
            raw,
          );

          return {
            branch: sanitizeBranchFragment((decoded as Record<string, unknown>).branch as string),
          };
        }).pipe(
          Effect.mapError((cause) =>
            isTextGenerationError(cause)
              ? cause
              : new TextGenerationError({
                  operation: "generateBranchName",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
          ),
        ),

      generateThreadTitle: (titleInput) =>
        Effect.gen(function* () {
          const prompt = buildThreadTitlePrompt({
            message: titleInput.message,
            previousTitle: titleInput.previousTitle,
            attachments: titleInput.attachments,
          });

          const raw = yield* callChatCompletions(input, {
            model: titleInput.modelSelection.model ?? input.defaultModel,
            messages: [{ role: "user", content: prompt.prompt }],
          }, httpClient);

          const decoded = yield* processTextGeneratorResult(
            "generateThreadTitle",
            prompt.outputSchema,
            raw,
          );

          return {
            title: sanitizeThreadTitle((decoded as Record<string, unknown>).title as string),
          };
        }).pipe(
          Effect.mapError((cause) =>
            isTextGenerationError(cause)
              ? cause
              : new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
          ),
        ),
    });
  },
);

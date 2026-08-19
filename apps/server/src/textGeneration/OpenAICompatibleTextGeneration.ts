import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Schema from "effect/Schema";

import { TextGenerationError, type ModelSelection } from "@helmcode/contracts";
import { extractJsonObject } from "@helmcode/shared/schemaJson";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeBranchFragment,
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

const chatCompletionsResponseSchema = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.optionalWith(Schema.String, { default: () => "" }),
      }),
    }),
  ),
});

const callChatCompletions = (input: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
}, payload: {
  readonly model: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
}): Effect.Effect<Record<string, unknown>, OpenAICompatibleTextGenerationRequestError> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;

    const bodyText = yield* Effect.try({
      try: () =>
        JSON.stringify({
          model: payload.model,
          messages: payload.messages,
          temperature: DEFAULT_TEMPERATURE,
          response_format: { type: "json_object" },
        }),
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
      const text = yield* Effect.tryPromise({
        try: () => response.text,
        catch: (cause) =>
          new OpenAICompatibleTextGenerationRequestError({
            operation: payload.model,
            detail: `HTTP ${response.status}`,
            cause,
          }),
      });
      throw new OpenAICompatibleTextGenerationRequestError({
        operation: payload.model,
        detail: `HTTP ${response.status}: ${text.trim().length > 0 ? text.trim() : String(response.status)}`,
        cause: new Error(`HTTP ${response.status}`),
      });
    }

    const responseText = yield* Effect.tryPromise({
      try: () => response.text,
      catch: (cause) =>
        new OpenAICompatibleTextGenerationRequestError({
          operation: payload.model,
          detail: "OpenAI-compatible response body was not valid JSON.",
          cause,
        }),
    });

    const parsed = yield* Effect.try({
      try: () => JSON.parse(responseText) as Record<string, unknown>,
      catch: (error) =>
        new OpenAICompatibleTextGenerationRequestError({
          operation: payload.model,
          detail: "OpenAI-compatible response body was not valid JSON.",
          cause: error,
        }),
    });

    return parsed;
  });

const decodeChatOutput = Effect.gen(function* <A>(
  operation: string,
  schema: Schema.Schema<A>,
  raw: Record<string, unknown>,
): Effect.Effect<A, OpenAICompatibleTextGenerationResponseError | OpenAICompatibleTextGenerationOutputError> {
  const decoded = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(raw) as A,
    catch: (value) =>
      new OpenAICompatibleTextGenerationOutputError({
        operation,
        detail: `Decoded value does not match the requested schema.`,
        cause: value instanceof Error ? value : undefined,
      }),
  });

  return decoded;
});

const processTextGeneratorResult = Effect.gen(function* <A>(
  operation: string,
  schema: Schema.Schema<A>,
  raw: Record<string, unknown>,
): Effect.Effect<A, TextGenerationError> {
  const decoded = yield* decodeChatOutput(operation, schema, raw).pipe(
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

  return decoded as A;
});

export const makeOpenAICompatibleTextGeneration = (input: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
}): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: (commitInput) =>
      Effect.gen(function* () {
        const prompt = buildCommitMessagePrompt({
          repositoryName: commitInput.repositoryName,
          diffs: commitInput.diffs,
          branch: commitInput.branch,
        });

        const raw = yield* callChatCompletions(input, {
          model: commitInput.modelSelection?.model ?? input.defaultModel,
          messages: [
            {
              role: "user",
              content: prompt.prompt,
            },
          ],
        });

        const decoded = yield* processTextGeneratorResult(
          "generateCommitMessage",
          prompt.outputSchema,
          raw,
        );

        return {
          message: sanitizeCommitSubject((decoded as Record<string, unknown>).message as string),
        };
      }).pipe(
        Effect.mapError(
          (cause) =>
            cause instanceof TextGenerationError
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
          title: prInput.baseTitle,
          branch: prInput.branch,
          diff: prInput.diff,
          repositoryName: prInput.repositoryName,
          isFirstCommit: prInput.isFirstCommit,
          description: prInput.description,
        });

        const raw = yield* callChatCompletions(input, {
          model: prInput.modelSelection?.model ?? input.defaultModel,
          messages: [{ role: "user", content: prompt.prompt }],
        });

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
        Effect.mapError(
          (cause) =>
            cause instanceof TextGenerationError
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
          repositoryName: branchInput.repositoryName,
          diffs: branchInput.diffs,
          branch: branchInput.branch,
        });

        const raw = yield* callChatCompletions(input, {
          model: branchInput.modelSelection?.model ?? input.defaultModel,
          messages: [{ role: "user", content: prompt.prompt }],
        });

        const decoded = yield* processTextGeneratorResult("generateBranchName", prompt.outputSchema, raw);

        return {
          branch: sanitizeBranchFragment((decoded as Record<string, unknown>).branch as string),
        };
      }).pipe(
        Effect.mapError(
          (cause) =>
            cause instanceof TextGenerationError
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
          attachments: titleInput.attachments,
        });

        const raw = yield* callChatCompletions(input, {
          model: titleInput.modelSelection.model ?? input.defaultModel,
          messages: [{ role: "user", content: prompt.prompt }],
        });

        const decoded = yield* processTextGeneratorResult("generateThreadTitle", prompt.outputSchema, raw);

        return {
          title: sanitizeThreadTitle((decoded as Record<string, unknown>).title as string),
        };
      }).pipe(
        Effect.mapError(
          (cause) =>
            cause instanceof TextGenerationError
              ? cause
              : new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
        ),
      ),
  });
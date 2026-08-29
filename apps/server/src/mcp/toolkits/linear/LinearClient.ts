import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpBody } from "effect/unstable/http";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import { LinearApiError, LinearNotConfiguredError } from "./LinearApiError.ts";

export const LINEAR_API_KEY_SECRET_NAME = "linear-api-key";
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

const GraphqlEnvelope = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
        path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
      }),
    ),
  ),
});

const decodeGraphqlEnvelope = Effect.fn("Linear.decodeGraphqlEnvelope")(function* (raw: string) {
  const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GraphqlEnvelope))(
    raw,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new LinearApiError({
          operation: "decode",
          detail: `Linear GraphQL response was not valid JSON: ${cause.message}`,
          cause,
        }),
    ),
  );
  return parsed as {
    readonly data: unknown;
    readonly errors?: ReadonlyArray<{ readonly message: string }>;
  };
});

function executeGraphql(
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  apiKey: string,
  httpClient: HttpClient.HttpClient,
): Effect.Effect<unknown, LinearApiError> {
  return Effect.gen(function* () {
    const request = HttpClientRequest.post(LINEAR_GRAPHQL_ENDPOINT).pipe(
      HttpClientRequest.setHeader("Authorization", apiKey),
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.setBody(HttpBody.jsonUnsafe({ query, variables })),
    );

    const response = yield* httpClient.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new LinearApiError({
            operation,
            detail: "Linear GraphQL endpoint returned a failed response.",
            cause,
          }),
      ),
    );

    if (response.status === 401) {
      return yield* new LinearApiError({
        operation,
        detail: "The Linear API key was rejected (HTTP 401). Check that the key is valid.",
      });
    }

    if (response.status !== 200) {
      const text = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new LinearApiError({
              operation,
              detail: `HTTP ${response.status}`,
              cause,
            }),
        ),
      );
      return yield* new LinearApiError({
        operation,
        detail: `HTTP ${response.status}: ${text.trim().length > 0 ? text.trim() : String(response.status)}`,
      });
    }

    const responseText = yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          new LinearApiError({
            operation,
            detail: "Linear GraphQL response body could not be read.",
            cause,
          }),
      ),
    );

    const envelope = yield* decodeGraphqlEnvelope(responseText);

    if (envelope.errors && envelope.errors.length > 0) {
      return yield* new LinearApiError({
        operation,
        detail: `Linear GraphQL error: ${envelope.errors.map((error) => error.message).join("; ")}`,
      });
    }

    if (envelope.data === undefined) {
      return yield* new LinearApiError({
        operation,
        detail: "Linear GraphQL response contained no data.",
      });
    }

    return envelope.data;
  });
}

/**
 * Thin typed client over Linear's GraphQL API.
 *
 * Credentials are resolved from the environment secret store rather than the
 * per-thread MCP invocation scope: the API key is environment-owned and shared
 * across every agent session, so it is read here at call time.
 */
export class LinearClient extends Context.Service<
  LinearClient,
  {
    readonly execute: <S extends Schema.Schema<any>>(
      operation: string,
      query: string,
      variables: Record<string, unknown>,
      schema: S,
    ) => Effect.Effect<S["Type"], LinearApiError | LinearNotConfiguredError, S["DecodingServices"]>;
  }
>()("helmcode/mcp/toolkits/linear/LinearClient") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  const readApiKey = (): Effect.Effect<string, LinearNotConfiguredError> =>
    Effect.gen(function* () {
      const secret = yield* secretStore.get(LINEAR_API_KEY_SECRET_NAME).pipe(
        Effect.mapError(
          (cause) =>
            new LinearNotConfiguredError({
              detail: `Failed to read the Linear API key: ${cause.message}`,
            }),
        ),
      );
      if (Option.isNone(secret)) {
        return yield* new LinearNotConfiguredError({
          detail: "No Linear API key is configured. Add one in Helm Code Settings → Connections.",
        });
      }
      const key = new TextDecoder().decode(secret.value).trim();
      if (key.length === 0) {
        return yield* new LinearNotConfiguredError({
          detail: "The configured Linear API key is empty.",
        });
      }
      return key;
    });

  return LinearClient.of({
    execute: <S extends Schema.Schema<any>>(
      operation: string,
      query: string,
      variables: Record<string, unknown>,
      schema: S,
    ): Effect.Effect<S["Type"], LinearApiError | LinearNotConfiguredError, S["DecodingServices"]> =>
      Effect.gen(function* () {
        const apiKey = yield* readApiKey();
        const data = yield* executeGraphql(operation, query, variables, apiKey, httpClient);
        const decoded = yield* Schema.decodeUnknownEffect(schema)(data).pipe(
          Effect.mapError(
            (cause) =>
              new LinearApiError({
                operation,
                detail: `Linear response did not match the expected shape: ${cause.message}`,
                cause,
              }),
          ),
        );
        return decoded;
      }),
  });
});

export const layer = Layer.effect(LinearClient, make);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import { LinearApiError, LinearNotConfiguredError } from "./LinearApiError.ts";
import {
  LINEAR_API_KEY_SECRET_NAME,
  LinearClient,
  layer as linearClientLayer,
} from "./LinearClient.ts";

const makeTestLayer = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  linearClientLayer.pipe(
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, respond(request))),
        ),
      ),
    ),
    Layer.provideMerge(
      ServerSecretStore.layer.pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "helmcode-linear-client-test-",
          }),
        ),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const configureKey = (key: string) =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    yield* secretStore.set(LINEAR_API_KEY_SECRET_NAME, new TextEncoder().encode(key));
  });

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status === 200 ? { data } : data), {
    status,
    headers: { "content-type": "application/json" },
  });

const IssueResult = Schema.Struct({
  issue: Schema.Struct({ id: Schema.String, identifier: Schema.String }),
});

const getIssueExecute = (client: LinearClient["Service"]) =>
  client.execute(
    "get-issue",
    `query ViewIssue($identifier: String!) { issue(identifier: $identifier) { id } }`,
    { identifier: "LIN-123" },
    IssueResult,
  );

it.effect("fails with LinearNotConfiguredError when no API key is stored", () =>
  Effect.gen(function* () {
    const client = yield* LinearClient;
    const error = yield* Effect.flip(getIssueExecute(client));
    assert.instanceOf(error, LinearNotConfiguredError);
    assert.include(error.message, "No Linear API key is configured");
  }).pipe(Effect.provide(makeTestLayer(() => jsonResponse(null))), Effect.scoped),
);

it.effect("fails with LinearNotConfiguredError when the stored API key is empty", () =>
  Effect.gen(function* () {
    yield* configureKey("   ");
    const client = yield* LinearClient;
    const error = yield* Effect.flip(getIssueExecute(client));
    assert.instanceOf(error, LinearNotConfiguredError);
    assert.include(error.message, "empty");
  }).pipe(Effect.provide(makeTestLayer(() => jsonResponse(null))), Effect.scoped),
);

it.effect("returns a LinearApiError when the API key is rejected with 401", () =>
  Effect.gen(function* () {
    yield* configureKey("invalid-key");
    const client = yield* LinearClient;
    const error = yield* Effect.flip(getIssueExecute(client));
    assert.instanceOf(error, LinearApiError);
    assert.include(error.message, "401");
  }).pipe(Effect.provide(makeTestLayer(() => jsonResponse(null, 401))), Effect.scoped),
);

it.effect("surfaces GraphQL errors as LinearApiError", () =>
  Effect.gen(function* () {
    yield* configureKey("test-key");
    const client = yield* LinearClient;
    const error = yield* Effect.flip(getIssueExecute(client));
    assert.instanceOf(error, LinearApiError);
    assert.include(error.message, "GraphQL error");
    assert.include(error.message, "Not authorized");
  }).pipe(
    Effect.provide(
      makeTestLayer(
        () =>
          new Response(JSON.stringify({ errors: [{ message: "Not authorized" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("decodes a successful GraphQL response into the expected schema", () =>
  Effect.gen(function* () {
    yield* configureKey("test-key");
    const client = yield* LinearClient;
    const result = yield* getIssueExecute(client);
    assert.deepEqual(result, {
      issue: { id: "uuid-1", identifier: "LIN-123" },
    });
  }).pipe(
    Effect.provide(
      makeTestLayer(() => jsonResponse({ issue: { id: "uuid-1", identifier: "LIN-123" } })),
    ),
    Effect.scoped,
  ),
);

it.effect("reports a mismatch between the response and the expected schema", () =>
  Effect.gen(function* () {
    yield* configureKey("test-key");
    const client = yield* LinearClient;
    const error = yield* Effect.flip(getIssueExecute(client));
    assert.instanceOf(error, LinearApiError);
    assert.include(error.message, "did not match the expected shape");
  }).pipe(Effect.provide(makeTestLayer(() => jsonResponse({ issue: { id: 42 } }))), Effect.scoped),
);

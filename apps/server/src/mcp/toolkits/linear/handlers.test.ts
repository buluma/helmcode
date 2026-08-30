import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import { extractIdentifier, LinearToolkitHandlers } from "./handlers.ts";
import { LINEAR_API_KEY_SECRET_NAME, layer as linearClientLayer } from "./LinearClient.ts";

type CapturedRequest = {
  readonly query: string;
  readonly variables: Record<string, unknown>;
};

const makeClientLayer = (
  respond: (request: CapturedRequest) => unknown,
  requests: CapturedRequest[],
) =>
  linearClientLayer.pipe(
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            (() => {
              const raw =
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "";
              const parsed = JSON.parse(raw) as {
                readonly query?: string;
                readonly variables?: Record<string, unknown>;
              };
              const captured: CapturedRequest = {
                query: parsed.query ?? "",
                variables: parsed.variables ?? {},
              };
              requests.push(captured);
              return HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify({ data: respond(captured) }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              );
            })(),
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      ServerSecretStore.layer.pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "helmcode-linear-handlers-test-",
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

const fullIssue = (id: string, identifier: string) => ({
  id,
  identifier,
  url: `https://linear.app/acme/issue/${identifier}/slug`,
  title: "Some title",
  description: null,
  priority: 2,
  state: { name: "In Progress", type: "started" },
  assignee: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const writeRef = (identifier: string, title: string) => ({
  id: "uuid-1",
  identifier,
  url: `https://linear.app/acme/issue/${identifier}/slug`,
  title,
});

describe("extractIdentifier", () => {
  it("returns the identifier verbatim when provided", () => {
    assert.equal(extractIdentifier({ identifier: "LIN-123" }), "LIN-123");
  });

  it("parses the identifier from a Linear issue URL", () => {
    assert.equal(
      extractIdentifier({ url: "https://linear.app/acme/issue/LIN-123/my-issue" }),
      "LIN-123",
    );
    assert.equal(extractIdentifier({ url: "https://linear.app/acme/issue/ENG-42" }), "ENG-42");
  });

  it("returns an empty string when no identifier can be derived", () => {
    assert.equal(extractIdentifier({ url: "https://example.com/not-a-linear-issue" }), "");
  });
});

describe("linear_get_issue", () => {
  it.effect("resolves the issue through the id argument that Linear accepts", () => {
    const requests: CapturedRequest[] = [];
    return Effect.gen(function* () {
      yield* configureKey("test-key");
      const result = yield* LinearToolkitHandlers.linear_get_issue({ identifier: "LIN-123" });
      assert.deepEqual(result, { issue: fullIssue("uuid-1", "LIN-123") });
      assert.match(requests[0]!.query, /issue\(id: \$identifier\)/);
      assert.isFalse(/issue\(identifier:/.test(requests[0]!.query));
    }).pipe(
      Effect.provide(makeClientLayer(() => ({ issue: fullIssue("uuid-1", "LIN-123") }), requests)),
      Effect.scoped,
    );
  });
});

describe("linear_search_issues", () => {
  it.effect(
    "matches identifiers with a team+number filter instead of the unsupported identifier field",
    () => {
      const requests: CapturedRequest[] = [];
      return Effect.gen(function* () {
        yield* configureKey("test-key");
        const result = yield* LinearToolkitHandlers.linear_search_issues({ query: "SHA-162" });
        assert.equal(result.issues.nodes.length, 1);

        const filter = requests[0]!.variables.filter as {
          readonly or?: ReadonlyArray<Record<string, unknown>>;
          readonly team?: { readonly key?: { readonly eq?: string } };
          readonly number?: { readonly eq?: number };
        };
        assert.deepEqual(filter.team, { key: { eq: "SHA" } });
        assert.deepEqual(filter.number, { eq: 162 });
        assert.isUndefined(filter.or);
      }).pipe(
        Effect.provide(
          makeClientLayer(
            () => ({ issues: { nodes: [fullIssue("uuid-1", "SHA-162")] } }),
            requests,
          ),
        ),
        Effect.scoped,
      );
    },
  );

  it.effect("normalizes the team key casing in identifier matches", () => {
    const requests: CapturedRequest[] = [];
    return Effect.gen(function* () {
      yield* configureKey("test-key");
      yield* LinearToolkitHandlers.linear_search_issues({ query: "sha-7" });
      const filter = requests[0]!.variables.filter as {
        readonly team?: { readonly key?: { readonly eq?: string } };
        readonly number?: { readonly eq?: number };
      };
      assert.equal(filter.team?.key?.eq, "SHA");
      assert.deepEqual(filter.number, { eq: 7 });
    }).pipe(
      Effect.provide(makeClientLayer(() => ({ issues: { nodes: [] } }), requests)),
      Effect.scoped,
    );
  });

  it.effect("keeps free-text queries limited to title and description", () => {
    const requests: CapturedRequest[] = [];
    return Effect.gen(function* () {
      yield* configureKey("test-key");
      yield* LinearToolkitHandlers.linear_search_issues({ query: "save the whales" });
      const filter = requests[0]!.variables.filter as {
        readonly or?: ReadonlyArray<Record<string, unknown>>;
      };
      assert.equal(filter.or?.length, 2);
      assert.deepEqual(filter.or?.[1], { description: { containsIgnoreCase: "save the whales" } });
    }).pipe(
      Effect.provide(makeClientLayer(() => ({ issues: { nodes: [] } }), requests)),
      Effect.scoped,
    );
  });
});

describe("linear_create_issue", () => {
  it.effect("maps the issueCreate response onto the flat issue shape", () => {
    const requests: CapturedRequest[] = [];
    return Effect.gen(function* () {
      yield* configureKey("test-key");
      const result = yield* LinearToolkitHandlers.linear_create_issue({
        teamKey: "SHA",
        title: "A test",
      });
      assert.deepEqual(result, { issue: writeRef("SHA-164", "A test") });
      assert.equal(requests.length, 2);
      assert.equal(requests[0]!.variables.key, "SHA");
      assert.equal((requests[1]!.variables.input as { title: string }).title, "A test");
      assert.equal((requests[1]!.variables.input as { teamId: string }).teamId, "team-1");
    }).pipe(
      Effect.provide(
        makeClientLayer(
          (request) =>
            request.query.includes("ResolveTeam")
              ? { teams: { nodes: [{ id: "team-1" }] } }
              : { issueCreate: { issue: writeRef("SHA-164", "A test") } },
          requests,
        ),
      ),
      Effect.scoped,
    );
  });
});

describe("linear_update_issue", () => {
  it.effect(
    "resolves the issue id then maps the issueUpdate response onto the flat issue shape",
    () => {
      const requests: CapturedRequest[] = [];
      return Effect.gen(function* () {
        yield* configureKey("test-key");
        const result = yield* LinearToolkitHandlers.linear_update_issue({
          identifier: "LIN-123",
          title: "New title",
        });
        assert.deepEqual(result, { issue: writeRef("LIN-123", "New title") });
        assert.equal(requests.length, 2);
        assert.match(requests[0]!.query, /issue\(id: \$identifier\)/);
        assert.equal(requests[1]!.variables.id, "uuid-1");
      }).pipe(
        Effect.provide(
          makeClientLayer(
            (request) =>
              request.query.includes("issueUpdate")
                ? { issueUpdate: { issue: writeRef("LIN-123", "New title") } }
                : { issue: { id: "uuid-1", team: { id: "team-1" } } },
            requests,
          ),
        ),
        Effect.scoped,
      );
    },
  );

  it.effect(
    "maps a status name onto the workflow state id using the team id typed as an ID",
    () => {
      const requests: CapturedRequest[] = [];
      return Effect.gen(function* () {
        yield* configureKey("test-key");
        const result = yield* LinearToolkitHandlers.linear_update_issue({
          identifier: "LIN-123",
          title: "New title",
          status: "In Progress",
        });
        assert.deepEqual(result, { issue: writeRef("LIN-123", "New title") });
        assert.equal(requests.length, 3);
        assert.match(requests[0]!.query, /issue\(id: \$identifier\)/);
        assert.match(requests[1]!.query, /workflowStates/);
        assert.match(requests[1]!.query, /\$teamId: ID!/);
        assert.deepEqual(requests[1]!.variables, {
          teamId: "team-1",
          name: "In Progress",
        });
        assert.deepEqual(requests[2]!.variables.id, "uuid-1");
        assert.deepEqual(requests[2]!.variables.input, {
          title: "New title",
          stateId: "state-1",
        });
      }).pipe(
        Effect.provide(
          makeClientLayer((request) => {
            if (request.query.includes("issueUpdate")) {
              return { issueUpdate: { issue: writeRef("LIN-123", "New title") } };
            }
            if (request.query.includes("workflowStates")) {
              return { workflowStates: { nodes: [{ id: "state-1" }] } };
            }
            return { issue: { id: "uuid-1", team: { id: "team-1" } } };
          }, requests),
        ),
        Effect.scoped,
      );
    },
  );
});

describe("linear_comment", () => {
  it.effect(
    "resolves the issue id then maps the commentCreate response onto the flat comment shape",
    () => {
      const requests: CapturedRequest[] = [];
      return Effect.gen(function* () {
        yield* configureKey("test-key");
        const result = yield* LinearToolkitHandlers.linear_comment({
          identifier: "LIN-123",
          body: "Looks good.",
        });
        assert.deepEqual(result, {
          comment: {
            id: "c1",
            url: "https://linear.app/acme/issue/LIN-123",
            body: "Looks good.",
          },
        });
        assert.equal(requests.length, 2);
        assert.equal(requests[1]!.variables.issueId, "uuid-1");
      }).pipe(
        Effect.provide(
          makeClientLayer(
            (request) =>
              request.query.includes("commentCreate")
                ? {
                    commentCreate: {
                      comment: {
                        id: "c1",
                        url: "https://linear.app/acme/issue/LIN-123",
                        body: "Looks good.",
                      },
                    },
                  }
                : { issue: { id: "uuid-1", team: { id: "team-1" } } },
            requests,
          ),
        ),
        Effect.scoped,
      );
    },
  );
});

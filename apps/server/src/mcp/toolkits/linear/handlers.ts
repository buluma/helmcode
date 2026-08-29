import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LinearApiError } from "./LinearApiError.ts";
import { LinearClient } from "./LinearClient.ts";
import {
  LinearCommentInput,
  LinearCreateIssueInput,
  LinearGetIssueInput,
  LinearGetIssueResult,
  LinearSearchIssuesInput,
  LinearSearchIssuesResult,
  LinearToolkit,
  LinearUpdateIssueInput,
  LinearUpdateIssueResult,
  LinearCommentResult,
  LinearCreateIssueResult,
  type LinearIssueRefInput,
  type LinearIssueState,
} from "./tools.ts";

const IssueFragment = `
  id
  identifier
  url
  title
  description
  priority
  state { name type }
  assignee { name email }
  createdAt
  updatedAt
`;

const IssueIdOnly = Schema.Struct({
  issue: Schema.Struct({ id: Schema.String }),
});

export const extractIdentifier = (input: LinearIssueRefInput): string => {
  if (input.identifier) return input.identifier;
  if (input.url) {
    const match = /\/issue\/([A-Za-z0-9]+-\d+)(?:\/|$)/u.exec(input.url);
    if (match?.[1]) return match[1];
  }
  return input.identifier ?? "";
};

/**
 * Resolves an issue reference (identifier or URL) to the Linear UUID id needed
 * for mutations. Reads may use the identifier directly, but `issueUpdate` and
 * `commentCreate` require the UUID, so we always resolve through a lookup.
 */
const resolveIssueId = Effect.fn("Linear.resolveIssueId")(function* (
  client: LinearClient["Service"],
  input: LinearIssueRefInput,
) {
  const identifier = extractIdentifier(input);
  if (identifier.length === 0) {
    return yield* new LinearApiError({
      operation: "resolve-issue",
      detail: "Could not identify a Linear issue from the provided reference.",
    });
  }
  const data = yield* client.execute(
    "get-issue-id",
    `query ViewIssue($identifier: String!) { issue(identifier: $identifier) { id } }`,
    { identifier },
    IssueIdOnly,
  );
  return data.issue.id;
});

const mapIssue = (issue: LinearIssueState) => issue;

const handlers = {
  linear_get_issue: (input: LinearGetIssueInput) =>
    Effect.gen(function* () {
      const client = yield* LinearClient;
      const identifier = extractIdentifier(input);
      const data = yield* client.execute(
        "get-issue",
        `query ViewIssue($identifier: String!) { issue(identifier: $identifier) { ${IssueFragment} } }`,
        { identifier },
        LinearGetIssueResult,
      );
      return { issue: mapIssue(data.issue) };
    }),
  linear_search_issues: (input: LinearSearchIssuesInput) =>
    Effect.gen(function* () {
      const client = yield* LinearClient;
      const limit = input.limit ?? 25;
      const filter: Record<string, unknown> = {};
      const clauses: Record<string, unknown> = {};
      if (input.statuses && input.statuses.length > 0) {
        filter.state = { name: { in: input.statuses } };
      }
      if (input.query && input.query.length > 0) {
        const contains = { containsIgnoreCase: input.query };
        clauses.or = [{ title: contains }, { description: contains }, { identifier: contains }];
      }
      const data = yield* client.execute(
        "search-issues",
        `query SearchIssues($filter: IssueFilter, $first: Int) {
          issues(filter: $filter, first: $first, orderBy: updatedAt) {
            nodes { ${IssueFragment} }
          }
        }`,
        {
          filter: {
            ...(Object.keys(filter).length > 0 ? filter : {}),
            ...(Object.keys(clauses).length > 0 ? clauses : {}),
          },
          first: limit,
        },
        LinearSearchIssuesResult,
      );
      return { issues: { nodes: data.issues.nodes.map(mapIssue) } };
    }),
  linear_create_issue: (input: LinearCreateIssueInput) =>
    Effect.gen(function* () {
      const client = yield* LinearClient;
      const inputPayload: Record<string, unknown> = {
        teamId: input.teamKey,
        title: input.title,
      };
      if (input.description !== undefined) inputPayload.description = input.description;
      if (input.priority !== undefined) inputPayload.priority = input.priority;
      const data = yield* client.execute(
        "create-issue",
        `mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) { issue { id identifier url title } }
        }`,
        { input: inputPayload },
        LinearCreateIssueResult,
      );
      return data;
    }),
  linear_update_issue: (input: LinearUpdateIssueInput) =>
    Effect.gen(function* () {
      const client = yield* LinearClient;
      const id = yield* resolveIssueId(client, input);
      const inputPayload: Record<string, unknown> = {};
      if (input.title !== undefined) inputPayload.title = input.title;
      if (input.description !== undefined) inputPayload.description = input.description;
      if (input.priority !== undefined) inputPayload.priority = input.priority;
      if (input.status !== undefined) {
        const state = yield* client.execute(
          "resolve-state",
          `query ViewState($name: String!) { workflowStates(filter: { name: { eq: $name } }, first: 1) { nodes { id } } }`,
          { name: input.status },
          Schema.Struct({
            workflowStates: Schema.Struct({
              nodes: Schema.Array(Schema.Struct({ id: Schema.String })),
            }),
          }),
        );
        const stateId = state.workflowStates.nodes[0]?.id;
        if (!stateId) {
          return yield* new LinearApiError({
            operation: "update-issue",
            detail: `No Linear workflow state named "${input.status}" was found.`,
          });
        }
        inputPayload.stateId = stateId;
      }
      const data = yield* client.execute(
        "update-issue",
        `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { issue { id identifier url title } }
        }`,
        { id, input: inputPayload },
        LinearUpdateIssueResult,
      );
      return data;
    }),
  linear_comment: (input: LinearCommentInput) =>
    Effect.gen(function* () {
      const client = yield* LinearClient;
      const id = yield* resolveIssueId(client, input);
      const data = yield* client.execute(
        "comment",
        `mutation CreateComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            comment { id url body }
          }
        }`,
        { issueId: id, body: input.body },
        LinearCommentResult,
      );
      return data;
    }),
} satisfies Parameters<typeof LinearToolkit.toLayer>[0];

export const LinearToolkitHandlersLive = LinearToolkit.toLayer(handlers);

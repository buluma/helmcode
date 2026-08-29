import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { LinearClient } from "./LinearClient.ts";
import { LinearError } from "./LinearApiError.ts";

const dependencies = [LinearClient];

const trimNonEmpty = (maxLength: number) =>
  Schema.String.check(Schema.isTrimmed())
    .check(Schema.isNonEmpty({ description: "Required value." }))
    .check(Schema.isMaxLength(maxLength));

const LinearIssueState = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  priority: Schema.Int,
  state: Schema.Struct({
    name: Schema.String,
    type: Schema.String,
  }),
  assignee: Schema.NullOr(
    Schema.Struct({
      name: Schema.NullOr(Schema.String),
      email: Schema.NullOr(Schema.String),
    }),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type LinearIssueState = typeof LinearIssueState.Type;

const LinearIssueResult = Schema.Struct({ issue: LinearIssueState });
const LinearSearchResult = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(LinearIssueState),
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: Schema.NullOr(Schema.String),
    }),
  }),
});

const Identifier = trimNonEmpty(32).annotate({
  description:
    "A Linear issue identifier such as LIN-123. Either this or the linear issue URL may be provided.",
});
const IssueUrl = trimNonEmpty(2048).annotate({
  description:
    "A Linear issue URL such as https://linear.app/acme/issue/LIN-123/my-issue. Either this or the identifier may be provided.",
});

const issueRefInput = Schema.Struct({
  identifier: Schema.optional(Identifier),
  url: Schema.optional(IssueUrl),
}).check(
  Schema.makeFilter((input) => {
    const hasIdentifier = input.identifier !== undefined;
    const hasUrl = input.url !== undefined;
    if (hasIdentifier === hasUrl) return "Provide exactly one of identifier or url.";
    return true;
  }),
);
export type LinearIssueRefInput = typeof issueRefInput.Type;

export const LinearGetIssueInput = issueRefInput;
export type LinearGetIssueInput = typeof LinearGetIssueInput.Type;
export const LinearGetIssueResult = Schema.Struct({ issue: LinearIssueState });

export const LinearSearchIssuesInput = Schema.Struct({
  query: Schema.optional(
    Schema.String.check(Schema.isTrimmed()).annotate({
      description: "A free-text search query matching issue title, description, and identifier.",
    }),
  ),
  statuses: Schema.optional(
    Schema.Array(trimNonEmpty(64)).annotate({
      description: "Optional state names to filter by (for example ['In Progress', 'Todo']).",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(50)).annotate({
      description: "Maximum number of issues to return. Defaults to 25.",
    }),
  ),
});
export type LinearSearchIssuesInput = typeof LinearSearchIssuesInput.Type;
export const LinearSearchIssuesResult = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(LinearIssueState),
  }),
});

export const LinearCreateIssueInput = Schema.Struct({
  teamKey: trimNonEmpty(16).annotate({
    description: "The Linear team key to create the issue in, for example ENG.",
  }),
  title: Schema.String.check(Schema.isTrimmed())
    .check(Schema.isNonEmpty({ description: "Required value." }))
    .check(Schema.isMaxLength(300))
    .annotate({ description: "Issue title." }),
  description: Schema.optional(
    Schema.String.check(Schema.isMaxLength(50_000)).annotate({
      description: "Optional issue description/body as markdown.",
    }),
  ),
  priority: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(4))
      .annotate({
        description: "Optional priority 0-4, where 0 is urgent, 1 high, 2 medium, 3 low, 4 none.",
      }),
  ),
});
export type LinearCreateIssueInput = typeof LinearCreateIssueInput.Type;
export const LinearCreateIssueResult = Schema.Struct({
  issue: Schema.Struct({
    id: Schema.String,
    identifier: Schema.String,
    url: Schema.String,
    title: Schema.String,
  }),
});

export const LinearUpdateIssueInput = Schema.Struct({
  ...issueRefInput.fields,
  title: Schema.optional(
    Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()).annotate({
      description: "New issue title.",
    }),
  ),
  description: Schema.optional(
    Schema.String.check(Schema.isMaxLength(50_000)).annotate({
      description: "New issue description/body as markdown.",
    }),
  ),
  status: Schema.optional(
    trimNonEmpty(64).annotate({
      description: "New state name to move the issue to, for example In Progress.",
    }),
  ),
  priority: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(4))
      .annotate({ description: "Priority 0-4 (0 urgent ... 4 none)." }),
  ),
}).check(
  Schema.makeFilter(
    (input) =>
      input.title !== undefined ||
      input.description !== undefined ||
      input.status !== undefined ||
      input.priority !== undefined ||
      "Provide at least one field to update.",
  ),
);

export type LinearUpdateIssueInput = typeof LinearUpdateIssueInput.Type;

export const LinearUpdateIssueResult = Schema.Struct({
  issue: Schema.Struct({
    id: Schema.String,
    identifier: Schema.String,
    url: Schema.String,
    title: Schema.String,
  }),
});

export const LinearCommentInput = Schema.Struct({
  ...issueRefInput.fields,
  body: Schema.String.check(Schema.isTrimmed())
    .check(Schema.isNonEmpty({ description: "Required value." }))
    .check(Schema.isMaxLength(50_000))
    .annotate({ description: "Comment body as markdown." }),
});
export type LinearCommentInput = typeof LinearCommentInput.Type;
export const LinearCommentResult = Schema.Struct({
  comment: Schema.Struct({
    id: Schema.String,
    url: Schema.String,
    body: Schema.String,
  }),
});

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

export const LinearGetIssueTool = readonlyTool(
  Tool.make("linear_get_issue", {
    description:
      "Fetch a single Linear issue by identifier (LIN-123) or URL. Returns the title, description, priority, state, assignee, and timestamps.",
    parameters: LinearGetIssueInput,
    success: LinearGetIssueResult,
    failure: LinearError,
    dependencies,
  }).annotate(Tool.Title, "Get Linear issue"),
);

export const LinearSearchIssuesTool = readonlyTool(
  Tool.make("linear_search_issues", {
    description:
      "Search Linear issues by free text and/or status. Returns matching issues with their identifier, title, state, priority, and assignee.",
    parameters: LinearSearchIssuesInput,
    success: LinearSearchIssuesResult,
    failure: LinearError,
    dependencies,
  }).annotate(Tool.Title, "Search Linear issues"),
);

export const LinearCreateIssueTool = Tool.make("linear_create_issue", {
  description:
    "Create a new Linear issue in a team. Provide a teamKey, title, and optional description, priority.",
  parameters: LinearCreateIssueInput,
  success: LinearCreateIssueResult,
  failure: LinearError,
  dependencies,
})
  .annotate(Tool.Title, "Create Linear issue")
  .annotate(Tool.Destructive, true);

export const LinearUpdateIssueTool = Tool.make("linear_update_issue", {
  description:
    "Update an existing Linear issue by identifier or URL. Can change title, description, status, or priority.",
  parameters: LinearUpdateIssueInput,
  success: LinearUpdateIssueResult,
  failure: LinearError,
  dependencies,
})
  .annotate(Tool.Title, "Update Linear issue")
  .annotate(Tool.Destructive, false);

export const LinearCommentTool = Tool.make("linear_comment", {
  description: "Post a comment on an existing Linear issue by identifier or URL.",
  parameters: LinearCommentInput,
  success: LinearCommentResult,
  failure: LinearError,
  dependencies,
})
  .annotate(Tool.Title, "Comment on Linear issue")
  .annotate(Tool.Destructive, false);

export const LinearToolkit = Toolkit.make(
  LinearGetIssueTool,
  LinearSearchIssuesTool,
  LinearCreateIssueTool,
  LinearUpdateIssueTool,
  LinearCommentTool,
);

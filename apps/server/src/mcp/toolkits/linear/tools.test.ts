import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import {
  LinearCommentInput,
  LinearCreateIssueInput,
  LinearGetIssueInput,
  LinearToolkit,
  LinearUpdateIssueInput,
} from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exports object schemas with described parameters for every tool", () => {
  for (const tool of Object.values(LinearToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

describe("issue reference validation", () => {
  it.effect("requires exactly one of identifier or url", () =>
    Effect.gen(function* () {
      const neither = yield* Effect.flip(Schema.decodeUnknownEffect(LinearGetIssueInput)({}));
      assert.include(String(neither), "exactly one");

      const both = yield* Effect.flip(
        Schema.decodeUnknownEffect(LinearGetIssueInput)({
          identifier: "LIN-123",
          url: "https://linear.app/acme/issue/LIN-123/my-issue",
        }),
      );
      assert.include(String(both), "exactly one");

      const identifierOnly = yield* Schema.decodeUnknownEffect(LinearGetIssueInput)({
        identifier: "LIN-123",
      });
      assert.deepEqual(identifierOnly, { identifier: "LIN-123" });
    }),
  );
});

describe("update issue input validation", () => {
  it.effect("requires at least one field to change", () =>
    Effect.gen(function* () {
      const onlyRef = yield* Effect.flip(
        Schema.decodeUnknownEffect(LinearUpdateIssueInput)({ identifier: "LIN-123" }),
      );
      assert.include(String(onlyRef), "at least one field");

      const withChange = yield* Schema.decodeUnknownEffect(LinearUpdateIssueInput)({
        identifier: "LIN-123",
        title: "A new title",
      });
      assert.deepEqual(withChange.title, "A new title");
    }),
  );

  it.effect("rejects both identifier and url together", () =>
    Effect.gen(function* () {
      const both = yield* Effect.flip(
        Schema.decodeUnknownEffect(LinearUpdateIssueInput)({
          identifier: "LIN-123",
          url: "https://linear.app/acme/issue/LIN-123/my-issue",
          title: "A new title",
        }),
      );
      assert.include(String(both), "exactly one");
    }),
  );

  it.effect("rejects priorities outside the 0-4 range", () =>
    Effect.gen(function* () {
      const tooHigh = yield* Effect.flip(
        Schema.decodeUnknownEffect(LinearUpdateIssueInput)({
          identifier: "LIN-123",
          priority: 9,
        }),
      );
      assert.isTrue(String(tooHigh).length > 0);
    }),
  );
});

describe("comment input validation", () => {
  it.effect("requires exactly one issue reference", () =>
    Effect.gen(function* () {
      const both = yield* Effect.flip(
        Schema.decodeUnknownEffect(LinearCommentInput)({
          identifier: "LIN-123",
          url: "https://linear.app/acme/issue/LIN-123/my-issue",
          body: "Looks good.",
        }),
      );
      assert.include(String(both), "exactly one");

      const valid = yield* Schema.decodeUnknownEffect(LinearCommentInput)({
        identifier: "LIN-123",
        body: "Looks good.",
      });
      assert.deepEqual(valid.body, "Looks good.");
    }),
  );
});

describe("create issue input validation", () => {
  it.effect("requires a team key and a non-empty title", () =>
    Effect.gen(function* () {
      const missingTitle = yield* Effect.flip(
        Schema.decodeUnknownEffect(LinearCreateIssueInput)({ teamKey: "ENG" }),
      );
      assert.isTrue(String(missingTitle).length > 0);

      const valid = yield* Schema.decodeUnknownEffect(LinearCreateIssueInput)({
        teamKey: "ENG",
        title: "Build a thing",
      });
      assert.deepEqual(valid.teamKey, "ENG");
    }),
  );
});

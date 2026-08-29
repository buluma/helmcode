import { assert, describe, it } from "@effect/vitest";

import { extractIdentifier } from "./handlers.ts";

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

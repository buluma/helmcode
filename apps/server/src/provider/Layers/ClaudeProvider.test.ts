import { ProviderInstanceId } from "@helmcode/contracts";
import { createModelSelection } from "@helmcode/shared/model";
import { describe, expect, it } from "@effect/vitest";

import {
  isClaudeUltracodeEffort,
  isLegacyClaudeModel,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
} from "./ClaudeProvider.ts";

const INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

describe("isLegacyClaudeModel", () => {
  it("treats the current model family as not legacy", () => {
    expect(isLegacyClaudeModel("claude-opus-5")).toBe(false);
    expect(isLegacyClaudeModel("claude-sonnet-5")).toBe(false);
    expect(isLegacyClaudeModel("claude-fable-5")).toBe(false);
  });

  it("treats anything outside the current family as legacy", () => {
    expect(isLegacyClaudeModel("claude-opus-4-6")).toBe(true);
    expect(isLegacyClaudeModel("claude-sonnet-4-6")).toBe(true);
    expect(isLegacyClaudeModel("unknown-model")).toBe(true);
  });
});

describe("isClaudeUltracodeEffort", () => {
  it("is true only for the ultracode effort", () => {
    expect(isClaudeUltracodeEffort("ultracode")).toBe(true);
    expect(isClaudeUltracodeEffort("high")).toBe(false);
    expect(isClaudeUltracodeEffort(null)).toBe(false);
    expect(isClaudeUltracodeEffort(undefined)).toBe(false);
  });
});

describe("normalizeClaudeCliEffort", () => {
  it("drops the prompt-prefix ultrathink mode and empty efforts", () => {
    expect(normalizeClaudeCliEffort("ultrathink", "claude-opus-5")).toBeUndefined();
    expect(normalizeClaudeCliEffort(null, "claude-opus-5")).toBeUndefined();
    expect(normalizeClaudeCliEffort(undefined, "claude-opus-5")).toBeUndefined();
  });

  it("maps the Claude Code ultracode setting to xhigh", () => {
    expect(normalizeClaudeCliEffort("ultracode", "claude-opus-5")).toBe("xhigh");
  });

  it("promotes xhigh to max on models outside the current xhigh-capable set", () => {
    expect(normalizeClaudeCliEffort("xhigh", "claude-opus-4-6")).toBe("max");
  });

  it("leaves xhigh as-is on current models that support it directly", () => {
    expect(normalizeClaudeCliEffort("xhigh", "claude-fable-5")).toBe("xhigh");
    expect(normalizeClaudeCliEffort("xhigh", "claude-opus-5")).toBe("xhigh");
    expect(normalizeClaudeCliEffort("xhigh", "claude-opus-4-8")).toBe("xhigh");
    expect(normalizeClaudeCliEffort("xhigh", "claude-sonnet-5")).toBe("xhigh");
  });

  it("downgrades max to high specifically for claude-sonnet-4-6", () => {
    expect(normalizeClaudeCliEffort("max", "claude-sonnet-4-6")).toBe("high");
  });

  it("passes through max unchanged for every other model", () => {
    expect(normalizeClaudeCliEffort("max", "claude-opus-5")).toBe("max");
  });

  it("passes through any other effort value unchanged", () => {
    expect(normalizeClaudeCliEffort("medium", "claude-opus-5")).toBe("medium");
  });
});

describe("resolveClaudeApiModelId", () => {
  it("suffixes the model id with [1m] when the 1m context window is selected", () => {
    const selection = createModelSelection(INSTANCE_ID, "claude-sonnet-5", [
      { id: "contextWindow", value: "1m" },
    ]);
    expect(resolveClaudeApiModelId(selection)).toBe("claude-sonnet-5[1m]");
  });

  it("returns the bare model id when no non-default context window is selected", () => {
    const selection = createModelSelection(INSTANCE_ID, "claude-sonnet-5");
    expect(resolveClaudeApiModelId(selection)).toBe("claude-sonnet-5");
  });
});

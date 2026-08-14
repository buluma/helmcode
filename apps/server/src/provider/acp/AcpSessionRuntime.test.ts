import { describe, expect, it } from "@effect/vitest";

import {
  assistantItemId,
  configOptionCurrentValueMatches,
  shouldEmitToolCallUpdate,
  updateModeState,
} from "./AcpSessionRuntime.ts";
import type { AcpSessionModeState, AcpToolCallState } from "./AcpRuntimeModel.ts";

function toolCall(overrides: Partial<AcpToolCallState> = {}): AcpToolCallState {
  return {
    toolCallId: "call-1",
    data: {},
    ...overrides,
  };
}

describe("updateModeState", () => {
  const modeState: AcpSessionModeState = {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ],
  };

  it("switches to a known mode id", () => {
    expect(updateModeState(modeState, "plan")).toEqual({
      ...modeState,
      currentModeId: "plan",
    });
  });

  it("trims whitespace around the mode id before matching", () => {
    expect(updateModeState(modeState, "  plan  ")).toEqual({
      ...modeState,
      currentModeId: "plan",
    });
  });

  it("leaves state unchanged for an unknown mode id", () => {
    expect(updateModeState(modeState, "nonexistent")).toBe(modeState);
  });

  it("leaves state unchanged for a blank mode id", () => {
    expect(updateModeState(modeState, "   ")).toBe(modeState);
  });
});

describe("shouldEmitToolCallUpdate", () => {
  it("always emits a terminal (completed/failed) status", () => {
    expect(shouldEmitToolCallUpdate(undefined, toolCall({ status: "completed" }))).toBe(true);
    expect(
      shouldEmitToolCallUpdate(toolCall({ status: "inProgress" }), toolCall({ status: "failed" })),
    ).toBe(true);
  });

  it("suppresses a non-terminal update with no detail", () => {
    expect(shouldEmitToolCallUpdate(undefined, toolCall({ status: "pending" }))).toBe(false);
  });

  it("emits the first non-terminal update once detail appears", () => {
    expect(
      shouldEmitToolCallUpdate(undefined, toolCall({ status: "inProgress", detail: "reading" })),
    ).toBe(true);
  });

  it("suppresses a repeat with identical title and detail", () => {
    const previous = toolCall({ status: "inProgress", title: "Read", detail: "reading file.ts" });
    const next = toolCall({ status: "inProgress", title: "Read", detail: "reading file.ts" });
    expect(shouldEmitToolCallUpdate(previous, next)).toBe(false);
  });

  it("emits again when the detail changes", () => {
    const previous = toolCall({ status: "inProgress", title: "Read", detail: "reading file.ts" });
    const next = toolCall({ status: "inProgress", title: "Read", detail: "reading file2.ts" });
    expect(shouldEmitToolCallUpdate(previous, next)).toBe(true);
  });

  it("emits again when the title changes", () => {
    const previous = toolCall({ status: "inProgress", title: "Read", detail: "reading file.ts" });
    const next = toolCall({ status: "inProgress", title: "Write", detail: "reading file.ts" });
    expect(shouldEmitToolCallUpdate(previous, next)).toBe(true);
  });
});

describe("configOptionCurrentValueMatches", () => {
  it("matches boolean options by strict equality", () => {
    const option = {
      type: "boolean" as const,
      currentValue: true,
      id: "auto-approve",
      name: "Auto approve",
    };
    expect(configOptionCurrentValueMatches(option, true)).toBe(true);
    expect(configOptionCurrentValueMatches(option, false)).toBe(false);
  });

  it("matches select options by trimmed string equality", () => {
    const option = {
      type: "select" as const,
      currentValue: " plan ",
      options: [],
      id: "mode",
      name: "Mode",
    };
    expect(configOptionCurrentValueMatches(option, "plan")).toBe(true);
    expect(configOptionCurrentValueMatches(option, "other")).toBe(false);
  });

  it("stringifies a boolean probe value before comparing against a select option", () => {
    // Loose by design: a select option's currentValue is always a string, so
    // matching against a boolean probe value coerces via String() rather
    // than failing outright.
    const option = {
      type: "select" as const,
      currentValue: "true",
      options: [],
      id: "mode",
      name: "Mode",
    };
    expect(configOptionCurrentValueMatches(option, true)).toBe(true);
  });
});

describe("assistantItemId", () => {
  it("is stable for the same inputs and distinct across segments", () => {
    const first = assistantItemId("session-1", "runtime-1", 0);
    const second = assistantItemId("session-1", "runtime-1", 1);
    expect(first).toBe(assistantItemId("session-1", "runtime-1", 0));
    expect(first).not.toBe(second);
  });
});

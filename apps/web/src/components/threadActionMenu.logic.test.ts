import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  isPinned: false,
  isSettled: false,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  hasSchedule: false,
  isSchedulePaused: false,
  supports: {
    settlement: true,
    snooze: true,
    scheduling: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems", () => {
  it("hides lifecycle items when the environment lacks the capabilities", () => {
    expect(
      ids({
        ...baseState,
        supports: {
          settlement: false,
          snooze: false,
          scheduling: false,
          pinning: false,
          titleRegeneration: false,
        },
      }),
    ).toEqual([
      "rename",
      "mark-unread",
      "copy-path",
      "copy-thread-id",
      "project-settings",
      "delete",
    ]);
  });

  it("places project settings right before delete", () => {
    const items = buildThreadActionMenuItems(baseState);
    const deleteIndex = items.findIndex((item) => item.id === "delete");
    expect(items[deleteIndex - 1]).toMatchObject({
      id: "project-settings",
      label: "Project settings",
      icon: "settings",
    });
  });

  it("includes branch items only for threads with a branch", () => {
    const withBranch = ids({ ...baseState, branch: "feat/menu" });
    expect(withBranch).toContain("new-thread-on-branch");
    expect(withBranch).toContain("copy-branch");
    expect(ids(baseState)).not.toContain("new-thread-on-branch");
    expect(ids(baseState)).not.toContain("copy-branch");
  });

  it("flips lifecycle labels with thread state", () => {
    expect(ids({ ...baseState, isPinned: true, isSettled: true, isSnoozed: true })).toEqual(
      expect.arrayContaining(["unpin", "unsettle", "unsnooze"]),
    );
    expect(ids(baseState)).toEqual(expect.arrayContaining(["pin", "settle", "snooze"]));
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = buildThreadActionMenuItems({ ...baseState, canSnoozeNow: false }).find(
      (item) => item.id === "snooze",
    );
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour"]);
  });

  it("disables title regeneration while one is in flight", () => {
    const item = buildThreadActionMenuItems({ ...baseState, isRegeneratingTitle: true }).find(
      (candidate) => candidate.id === "regenerate-title",
    );
    expect(item).toMatchObject({ label: "Regenerating…", disabled: true });
  });

  it("marks delete as destructive and keeps it last", () => {
    const items = buildThreadActionMenuItems({ ...baseState, branch: "main" });
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });

  it("offers Schedule… when the thread has no schedule", () => {
    const items = ids(baseState);
    expect(items).toContain("schedule");
    expect(items).not.toContain("pause-schedule");
    expect(items).not.toContain("resume-schedule");
    expect(items).not.toContain("cancel-schedule");
  });

  it("offers pause + cancel for an active schedule", () => {
    const items = ids({ ...baseState, hasSchedule: true, isSchedulePaused: false });
    expect(items).toContain("pause-schedule");
    expect(items).toContain("cancel-schedule");
    expect(items).not.toContain("schedule");
    expect(items).not.toContain("resume-schedule");
  });

  it("offers resume + cancel for a paused schedule", () => {
    const items = ids({ ...baseState, hasSchedule: true, isSchedulePaused: true });
    expect(items).toContain("resume-schedule");
    expect(items).toContain("cancel-schedule");
    expect(items).not.toContain("schedule");
    expect(items).not.toContain("pause-schedule");
  });

  it("hides all schedule items when the environment lacks scheduling support", () => {
    const items = ids({
      ...baseState,
      hasSchedule: true,
      supports: { ...baseState.supports, scheduling: false },
    });
    expect(items).not.toContain("schedule");
    expect(items).not.toContain("pause-schedule");
    expect(items).not.toContain("resume-schedule");
    expect(items).not.toContain("cancel-schedule");
  });
});

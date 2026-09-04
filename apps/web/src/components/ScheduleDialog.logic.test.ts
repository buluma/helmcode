import { describe, expect, it } from "vite-plus/test";

import { computeNextRunAt, PRESETS } from "./ScheduleDialog.logic";

describe("PRESETS", () => {
  it("exposes the three quick presets from the plan", () => {
    expect(PRESETS.map((preset) => preset.label)).toEqual([
      "Every hour",
      "Daily at 9am",
      "Weekly Monday 9am",
    ]);
  });

  it("each preset resolves to a schedule config that computeNextRunAt accepts", () => {
    const now = new Date("2026-09-04T12:00:00.000Z"); // Friday
    for (const preset of PRESETS) {
      const nextRunAt = computeNextRunAt(
        preset.mode,
        preset.intervalMinutes ?? 60,
        preset.cron ?? "",
        now,
      );
      expect(new Date(nextRunAt).getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe("computeNextRunAt", () => {
  it("interval mode adds N minutes from now", () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    const nextRunAt = computeNextRunAt("interval", 60, "", now);
    expect(nextRunAt).toBe("2026-09-04T13:00:00.000Z");
  });

  it("interval mode floors to at least 1 minute for non-positive input", () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(computeNextRunAt("interval", 0, "", now)).toBe("2026-09-04T12:01:00.000Z");
    expect(computeNextRunAt("interval", -5, "", now)).toBe("2026-09-04T12:01:00.000Z");
  });

  it("HOURLY cron with no BYMINUTE defaults to :00, rolling to the next hour", () => {
    const now = new Date("2026-09-04T12:34:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=HOURLY", now);
    expect(nextRunAt).toBe("2026-09-04T13:00:00.000Z");
  });

  it("HOURLY cron respects BYMINUTE, ignoring BYHOUR", () => {
    const now = new Date("2026-09-04T12:10:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=HOURLY;BYHOUR=9;BYMINUTE=30", now);
    expect(nextRunAt).toBe("2026-09-04T12:30:00.000Z");

    const wrapped = computeNextRunAt(
      "cron",
      60,
      "FREQ=HOURLY;BYHOUR=9;BYMINUTE=30",
      new Date("2026-09-04T12:45:00.000Z"),
    );
    expect(wrapped).toBe("2026-09-04T13:30:00.000Z");
  });

  it("DAILY cron rolls to today's target UTC time when it hasn't passed yet", () => {
    const now = new Date("2026-09-04T06:00:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", now);
    expect(nextRunAt).toBe("2026-09-04T09:00:00.000Z");
  });

  it("DAILY cron rolls to tomorrow when today's target UTC time already passed", () => {
    const now = new Date("2026-09-04T10:00:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", now);
    expect(nextRunAt).toBe("2026-09-05T09:00:00.000Z");
  });

  it("WEEKLY cron with BYDAY rolls forward to the next occurrence of that weekday", () => {
    // 2026-09-04 is a Friday.
    const now = new Date("2026-09-04T12:00:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", now);
    // Next Monday is 2026-09-07.
    expect(nextRunAt).toBe("2026-09-07T09:00:00.000Z");
  });

  it("WEEKLY cron on the target weekday rolls to next week once the time has passed", () => {
    // 2026-09-07 is a Monday.
    const now = new Date("2026-09-07T10:00:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", now);
    expect(nextRunAt).toBe("2026-09-14T09:00:00.000Z");
  });

  it("WEEKLY cron on the target weekday, before the time, fires today", () => {
    // 2026-09-07 is a Monday.
    const now = new Date("2026-09-07T06:00:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", now);
    expect(nextRunAt).toBe("2026-09-07T09:00:00.000Z");
  });

  it("WEEKLY cron without BYDAY defaults to Monday", () => {
    const now = new Date("2026-09-04T12:00:00.000Z"); // Friday
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0", now);
    expect(nextRunAt).toBe("2026-09-07T09:00:00.000Z");
  });

  it("MONTHLY cron advances a calendar month once the target time has passed", () => {
    const now = new Date("2026-09-04T10:00:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=MONTHLY;BYHOUR=9;BYMINUTE=0", now);
    expect(nextRunAt).toBe("2026-10-04T09:00:00.000Z");
  });

  it("MONTHLY cron clamps a Jan 31 target to Feb 28 in a non-leap year", () => {
    // 2026 is not a leap year.
    const now = new Date("2026-01-31T10:00:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=MONTHLY;BYHOUR=9;BYMINUTE=0", now);
    expect(nextRunAt).toBe("2026-02-28T09:00:00.000Z");
  });

  it("MONTHLY cron clamps a Jan 31 target to Feb 29 in a leap year", () => {
    // 2028 is a leap year.
    const now = new Date("2028-01-31T10:00:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=MONTHLY;BYHOUR=9;BYMINUTE=0", now);
    expect(nextRunAt).toBe("2028-02-29T09:00:00.000Z");
  });

  it("with no recognizable FREQ, treats it like a daily run at the current UTC time", () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "", now);
    // No FREQ match means the DAILY/MONTHLY branch applies: the "target
    // time" defaults to now's own UTC hour/minute, which counts as already
    // passed, so it rolls to the same time tomorrow.
    expect(nextRunAt).toBe("2026-09-05T12:00:00.000Z");
  });

  it("parses cron case-insensitively", () => {
    const now = new Date("2026-09-04T06:00:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "freq=daily;byhour=9;byminute=0", now);
    expect(nextRunAt).toBe("2026-09-04T09:00:00.000Z");
  });

  it("is unaffected by the local timezone (computes purely in UTC)", () => {
    const now = new Date("2026-09-04T10:00:00.000Z");
    const nextRunAt = computeNextRunAt("cron", 60, "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", now);
    // Regardless of process.env.TZ, BYHOUR=9 means 09:00 UTC.
    expect(nextRunAt.endsWith("T09:00:00.000Z")).toBe(true);
  });
});

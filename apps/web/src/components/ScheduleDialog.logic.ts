// Pure schedule-preview logic for ScheduleDialog, split out so it can be unit
// tested without the component's atom/settings dependencies.

export type ScheduleMode = "interval" | "cron";

export interface SchedulePreset {
  readonly label: string;
  readonly mode: ScheduleMode;
  readonly intervalMinutes?: number;
  readonly cron?: string;
}

export const PRESETS: ReadonlyArray<SchedulePreset> = [
  { label: "Every hour", mode: "interval", intervalMinutes: 60 },
  { label: "Daily at 9am", mode: "cron", cron: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" },
  { label: "Weekly Monday 9am", mode: "cron", cron: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0" },
];

const WEEKDAY_TO_JS_DAY: Record<string, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 0,
};

/**
 * Preview the next run time for an interval- or cron-based schedule, from
 * `now`. Mirrors the server-supported RRULE subset in the server's
 * `ScheduleReactor.computeNextRunAt` (FREQ=DAILY|WEEKLY|MONTHLY|HOURLY with
 * optional BYHOUR/BYMINUTE/BYDAY); the server recomputes authoritatively on
 * each fire, this is only a client-side estimate for the dialog's preview.
 */
export function computeNextRunAt(
  mode: ScheduleMode,
  intervalMinutes: number,
  cron: string,
  now: Date = new Date(),
): string {
  if (mode === "interval") {
    const ms = Math.max(1, intervalMinutes) * 60_000;
    return new Date(now.getTime() + ms).toISOString();
  }
  const upper = cron.toUpperCase();
  const freq = /FREQ=(DAILY|WEEKLY|MONTHLY|HOURLY)/.exec(upper)?.[1];
  if (freq === "HOURLY") {
    // "Every hour at :BYMINUTE" (default :00), not a flat +1h from now.
    const targetMinute = Number(/BYMINUTE=(\d+)/.exec(upper)?.[1] ?? 0);
    const next = new Date(now);
    next.setUTCMinutes(targetMinute, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setUTCHours(next.getUTCHours() + 1);
    }
    return next.toISOString();
  }
  // Read/write in UTC (not local time) to match the server's
  // ScheduleReactor.computeNextRunAt, which uses DateTime.getPartUtc.
  const byHour = Number(/BYHOUR=(\d+)/.exec(upper)?.[1] ?? now.getUTCHours());
  const byMinute = Number(/BYMINUTE=(\d+)/.exec(upper)?.[1] ?? now.getUTCMinutes());
  const next = new Date(now);
  next.setUTCMinutes(byMinute, 0, 0);
  next.setUTCHours(byHour);

  if (freq === "WEEKLY") {
    const weekday = /BYDAY=(MO|TU|WE|TH|FR|SA|SU)/.exec(upper)?.[1];
    const targetDay = weekday === undefined ? 1 : (WEEKDAY_TO_JS_DAY[weekday] ?? 1);
    const currentDay = now.getUTCDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead < 0) daysAhead += 7;
    if (daysAhead === 0 && next.getTime() <= now.getTime()) daysAhead = 7;
    next.setUTCDate(next.getUTCDate() + daysAhead);
  } else if (next.getTime() <= now.getTime()) {
    // DAILY advances a day; MONTHLY advances a calendar month, clamped to
    // the target month's last day (mirrors DateTime.add's month-end
    // clamping on the server — e.g. Jan 31 + 1 month lands on Feb 28/29,
    // not rolling over into March like a plain setUTCMonth would).
    if (freq === "MONTHLY") {
      const day = next.getUTCDate();
      next.setUTCMonth(next.getUTCMonth() + 2, 0);
      if (day < next.getUTCDate()) {
        next.setUTCDate(day);
      }
    } else {
      next.setUTCDate(next.getUTCDate() + 1);
    }
  }
  return next.toISOString();
}

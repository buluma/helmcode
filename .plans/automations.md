# Helm Code Automations — Implementation Plan

## Overview

Build a scheduled task system that auto-starts turns on threads at configured
intervals/cron times, modeled after Codex Automations. The design follows Helm
Code's existing CQRS architecture: new commands, events, projector fields, and a
`ScheduleReactor` that maintains an in-memory timer heap.

## Design Decisions

**Thread-scoped, not project-scoped.** Schedules attach to threads (like
snooze), not projects. A schedule is "send this prompt to this thread on a
cadence."

**Prompt-driven.** Each scheduled run sends a user message to the thread and
starts a turn — same as a manual `thread.turn.start`. The agent picks up context
from the existing thread history (same-thread model).

**No new aggregate.** Schedules are optional fields on
`OrchestrationThread`/`OrchestrationThreadShell` (like `snoozedUntil`), not a
separate aggregate. This keeps the event count low and avoids a new subscription
stream.

**Server-side timers, not client-side.** Unlike snooze (which clients poll),
schedules fire from the server's `ScheduleReactor`. This ensures they fire even
when no client is connected.

---

## Phase 1: Contracts & Schema

### 1a. New schemas in `packages/contracts/src/orchestration.ts`

```typescript
// Schedule configuration — persisted on the thread
const ThreadSchedule = Schema.Struct({
  enabled: Schema.Boolean,
  // ISO 8601 RRULE string (e.g., "FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
  // or null for one-shot interval
  cron: Schema.NullOr(TrimmedNonEmptyString),
  // Interval in milliseconds (for simple "every N minutes" schedules)
  intervalMs: Schema.NullOr(Schema.Number),
  // The prompt to send on each scheduled run
  prompt: TrimmedNonEmptyString,
  // When the next run should fire
  nextRunAt: IsoDateTime,
  // When the schedule was created
  createdAt: IsoDateTime,
  // Optional: model override for scheduled runs
  modelSelection: Schema.optional(ModelSelection),
});
```

### 1b. New commands (add to `DispatchableClientOrchestrationCommand`)

- `thread.schedule.create` — Create/update a schedule on a thread
- `thread.schedule.cancel` — Remove a schedule from a thread

### 1c. New event types (add to `OrchestrationEventType`)

- `"thread.scheduled"` — Schedule was created/updated
- `"thread.unscheduled"` — Schedule was cancelled

### 1d. Thread & Shell schema updates

Add optional fields to `OrchestrationThread` and `OrchestrationThreadShell`:

```typescript
schedule: Schema.optional(Schema.NullOr(ThreadSchedule)),
```

### Files to modify:

- `packages/contracts/src/orchestration.ts` — schemas, unions, payloads

---

## Phase 2: Server Backend

### 2a. Decider (`apps/server/src/orchestration/decider.ts`)

Add cases for the two new commands:

- **`thread.schedule.create`**: Validate thread exists, not archived. Validate
  schedule config (at least one of `cron` or `intervalMs`; `prompt` non-empty;
  `nextRunAt` in the future). Emit `thread.scheduled` event.
- **`thread.schedule.cancel`**: Validate thread exists. Emit
  `thread.unscheduled` event. Idempotent (cancel of no-schedule is a no-op).

### 2b. Projector (`apps/server/src/orchestration/projector.ts`)

Add cases for the two new events:

- **`thread.scheduled`**: Set `thread.schedule = payload.schedule` on the
  matching thread.
- **`thread.unscheduled`**: Set `thread.schedule = null`.

### 2c. DB Migration (`apps/server/src/persistence/Migrations/043_ProjectionThreadsSchedule.ts`)

```sql
ALTER TABLE projection_threads ADD COLUMN schedule TEXT;
```

Follows the exact pattern of migration 034 (snoozed).

### 2d. ScheduleReactor (`apps/server/src/orchestration/Services/ScheduleReactor.ts`)

A new reactor that:

1. **On startup**: Reads all threads with non-null `schedule` from the
   projection, loads them into an in-memory timer heap (sorted by `nextRunAt`).
2. **On `thread.scheduled` event**: Add/update the entry in the heap.
3. **On `thread.unscheduled` event**: Remove from the heap.
4. **On timer fire**: For the due thread:
   - Generate a user message ID (UUID)
   - Dispatch `thread.turn.start` command with the schedule's prompt as the
     message text
   - Compute the next `nextRunAt` based on `cron`/`intervalMs` and update via
     `thread.schedule.create` (re-emission)
   - If the thread has an active session, skip this fire and reschedule
5. **On shutdown**: Clear all timers.

Implementation uses `Effect.sleep` + `Effect.fork` for timers (no external cron
library). Each scheduled thread gets its own fiber that sleeps until
`nextRunAt`, then fires and reschedules.

### Files to create:

- `apps/server/src/orchestration/Services/ScheduleReactor.ts`
- `apps/server/src/orchestration/Layers/ScheduleReactor.ts`
- `apps/server/src/persistence/Migrations/043_ProjectionThreadsSchedule.ts`

### Files to modify:

- `apps/server/src/orchestration/decider.ts` — new command cases
- `apps/server/src/orchestration/projector.ts` — new event cases
- `apps/server/src/persistence/Migrations.ts` — register migration 043
- `apps/server/src/server.ts` — wire `ScheduleReactorLive` into the reactor
  merge
- `apps/server/src/orchestration/Services/OrchestrationReactor.ts` — add
  schedule reactor startup

---

## Phase 3: Client Runtime

### 3a. Command dispatchers (`packages/client-runtime/src/operations/commands.ts`)

Add `scheduleThread()` and `cancelThreadSchedule()` functions that dispatch the
new commands over WebSocket. Follow the existing `snoozeThread()` /
`unsnoozeThread()` pattern.

### 3b. Thread commands atom (`packages/client-runtime/src/state/threadCommands.ts`)

Add `scheduleThread` and `cancelThreadSchedule` to the atom command set, with
capability gating.

### 3c. Thread state (`packages/client-runtime/src/state/threads.ts`)

The `schedule` field on `OrchestrationThreadShell` flows through automatically
via the shell subscription — no special handling needed since it's an optional
field on the existing shell type.

### Files to modify:

- `packages/client-runtime/src/operations/commands.ts`
- `packages/client-runtime/src/state/threadCommands.ts`

---

## Phase 4: Web UI

### 4a. Sidebar schedule indicator (`apps/web/src/components/Sidebar.tsx`)

Add a small clock/schedule icon on thread rows that have an active schedule,
similar to how `backgroundLiveness` shows "working"/"monitoring". Show next run
time on hover.

### 4b. Thread action menu (`apps/web/src/components/threadActionMenu.logic.ts`)

Add "Schedule..." and "Cancel schedule" menu items alongside existing
settle/snooze/pin actions.

### 4c. Schedule dialog (`apps/web/src/components/ScheduleDialog.tsx`)

A modal dialog with:

- Prompt textarea (the message to send on each run)
- Schedule type toggle: Interval (every N minutes/hours/days) or Cron (RRULE
  input)
- Quick presets: Every hour, Daily at 9am, Weekly Monday 9am
- Model selection (optional override)
- "Next run" preview
- Save / Cancel buttons

### 4d. Schedule management view

For v1, the schedule is managed per-thread via the action menu and dialog. No
separate "Scheduled" inbox view (that can come in v2).

### Files to create:

- `apps/web/src/components/ScheduleDialog.tsx`

### Files to modify:

- `apps/web/src/components/Sidebar.tsx` — schedule indicator
- `apps/web/src/components/threadActionMenu.logic.ts` — menu items

---

## Phase 5: Mobile & Desktop

### Desktop

The desktop app wraps the web app, so the web UI changes propagate
automatically. No separate work needed.

### Mobile (React Native)

Add the schedule action to the thread long-press menu. The schedule dialog needs
a React Native equivalent. Can be deferred to a follow-up if needed.

---

## Migration & Backward Compatibility

- New fields are `Schema.optional(...)` on both `OrchestrationThread` and
  `OrchestrationThreadShell`, so older clients/servers decode safely (field
  absent = no schedule).
- The DB migration uses `ALTER TABLE ... ADD COLUMN` with nullable `TEXT`,
  following the established pattern.
- The `ScheduleReactor` only runs on the server — no client changes required for
  firing.
- Event schema is additive (new event types in the `OrchestrationEventType`
  literals union).

---

## What's NOT in scope (v1)

- Event-based triggers (GitHub PR, Gmail, Slack) — future
- Standalone (fresh thread) automations — future
- "Scheduled" inbox/management view — future
- Manual "Run now" button — future
- Skills integration — future
- Admin controls for disabling schedules — future

---

## Summary of changes by layer

| Layer            | Files                                                                     | Change                                         |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Contracts        | `packages/contracts/src/orchestration.ts`                                 | New schemas, commands, events, union additions |
| Server decider   | `apps/server/src/orchestration/decider.ts`                                | 2 new command cases                            |
| Server projector | `apps/server/src/orchestration/projector.ts`                              | 2 new event cases                              |
| Server migration | `apps/server/src/persistence/Migrations/043_*.ts`                         | New migration                                  |
| Server reactor   | `apps/server/src/orchestration/Services/ScheduleReactor.ts`               | New file: timer heap + fire logic              |
| Server wiring    | `apps/server/src/server.ts`, `OrchestrationReactor.ts`                    | Wire reactor                                   |
| Client runtime   | `packages/client-runtime/src/operations/commands.ts`, `threadCommands.ts` | 2 new command dispatchers                      |
| Web UI           | `Sidebar.tsx`, `threadActionMenu.logic.ts`, `ScheduleDialog.tsx`          | Schedule indicator, menu items, dialog         |
| Mobile           | Thread long-press menu                                                    | Deferred                                       |

## Codex Automations Reference

For comparison, Codex Automations (official name: "Scheduled tasks") provide:

- **Two types**: Standalone (fresh thread each run) and Thread (same thread,
  context preserved)
- **Time-based scheduling**: RRULE format, minute intervals,
  daily/weekly/monthly
- **Event triggers** (Aug 2026): Gmail, Slack, GitHub PR activity
- **Full agent capabilities**: write code, create PRs, run tests, use
  plugins/MCP
- **Skills integration**: `$skill-name` syntax in prompts
- **Same-thread context**: Agent resumes the same conversation, accumulating
  understanding across runs
- **GA since March 2026**, top-level feature April 2026

Our v1 covers the "thread-type, time-based" subset of this, which is the core
value. Event triggers, skills, and standalone automations are natural
follow-ups.

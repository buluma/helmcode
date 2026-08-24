#!/usr/bin/env node
/**
 * tool-call-failures - Dump recent tool-call activity across every project
 * from the local state.sqlite, optionally filtered to failures only.
 *
 * Reads projection_thread_activities (kind in tool.started/tool.updated/
 * tool.completed), joined through projection_threads to projection_projects
 * so each row is attributable to a project. Opened read-only: this never
 * writes to state.sqlite.
 *
 * Usage:
 *   node scripts/tool-call-failures.ts [--all] [--limit N] [--db PATH] [--json]
 *
 * By default only failures are shown (tone = "error", which covers
 * task.updated failures and tool.completed rows with status
 * "failed"/"declined"). Pass --all to include every tool call.
 */
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

interface ActivityRow {
  project_title: string;
  project_root: string;
  thread_title: string;
  thread_id: string;
  turn_id: string | null;
  tone: string;
  kind: string;
  summary: string;
  payload_json: string;
  created_at: string;
}

const { values } = NodeUtil.parseArgs({
  options: {
    all: { type: "boolean", default: false },
    limit: { type: "string", default: "100" },
    db: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const limit = Number.parseInt(values.limit ?? "100", 10);

const write = (line: string) => Effect.sync(() => process.stdout.write(`${line}\n`));

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const dbPath =
    values.db ?? path.join(NodeOS.homedir(), ".helmcode", "userdata", "state.sqlite");

  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });

  const toneFilter = values.all
    ? ""
    : `AND (activity.tone = 'error'
          OR json_extract(activity.payload_json, '$.status') IN ('failed', 'declined'))`;

  const rows = db
    .prepare(
      `
      SELECT
        project.title AS project_title,
        project.workspace_root AS project_root,
        thread.title AS thread_title,
        activity.thread_id,
        activity.turn_id,
        activity.tone,
        activity.kind,
        activity.summary,
        activity.payload_json,
        activity.created_at
      FROM projection_thread_activities AS activity
      JOIN projection_threads AS thread ON thread.thread_id = activity.thread_id
      JOIN projection_projects AS project ON project.project_id = thread.project_id
      WHERE activity.kind IN ('tool.started', 'tool.updated', 'tool.completed')
      ${toneFilter}
      ORDER BY activity.created_at DESC
      LIMIT ?
      `,
    )
    .all(limit) as Array<ActivityRow>;

  db.close();

  if (values.json) {
    yield* write(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    yield* write(
      values.all
        ? "No tool calls found."
        : "No tool call failures found. Pass --all to see every call.",
    );
  }

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as { status?: string; detail?: string };
    // Fall back to payload.status: rows written before tone tracked
    // status still say tone="tool" even when the tool call failed.
    const failed =
      row.tone === "error" || payload.status === "failed" || payload.status === "declined";
    const flag = failed ? "FAIL" : "ok  ";
    const location = `${row.project_title} > ${row.thread_title}`;
    yield* write(
      `[${flag}] ${row.created_at}  ${location}  ${row.kind}  ${row.summary}` +
        (payload.status ? `  status=${payload.status}` : ""),
    );
    if (payload.detail) {
      yield* write(`       ${payload.detail.slice(0, 200)}`);
    }
  }
});

if (import.meta.main) {
  program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}

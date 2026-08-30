import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionTurnsStopReasonCost", (it) => {
  it.effect("adds the nullable stop reason and cost columns to turn projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_turns)
      `;
      const stopReason = columns.find((column) => column.name === "stop_reason");
      const totalCostUsd = columns.find((column) => column.name === "total_cost_usd");

      assert.equal(stopReason?.name, "stop_reason");
      assert.equal(stopReason?.notnull, 0);
      assert.equal(totalCostUsd?.name, "total_cost_usd");
      assert.equal(totalCostUsd?.notnull, 0);
    }),
  );
});

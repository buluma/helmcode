import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("stop_reason")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN stop_reason TEXT
    `;
  }

  if (!columnNames.has("total_cost_usd")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN total_cost_usd REAL
    `;
  }
});

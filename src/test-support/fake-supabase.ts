/**
 * A stand-in for the Supabase client in the handful of tests that drive a
 * server-side flow end to end with the network mocked out (Darshan's brief,
 * ground rule 5: "No email and no Xero calls from tests. Mock both.").
 *
 * It answers each query from a per-table function and records every write, so
 * a test can assert both what the code read and what it stored. It deliberately
 * does **not** evaluate filters: the answer is whatever the table function says,
 * and the filters a query carried are handed to it, so a test can also assert
 * that a read named its tenant (§23).
 */

export type FakeQuery = {
  table: string;
  op: "select" | "update" | "insert" | "upsert" | "delete";
  columns?: string;
  values?: unknown;
  filters: Array<[string, string, unknown]>;
};

export type FakeAnswer = { data: unknown; error: { message: string; code?: string } | null };

export type TableHandler = (query: FakeQuery) => FakeAnswer | unknown;

export function fakeSupabase(tables: Record<string, TableHandler> = {}) {
  const queries: FakeQuery[] = [];

  function answer(query: FakeQuery): FakeAnswer {
    queries.push(query);
    const handler = tables[query.table];
    const result = handler ? handler(query) : { data: query.op === "select" ? [] : null, error: null };
    return result && typeof result === "object" && "data" in (result as object) && "error" in (result as object)
      ? (result as FakeAnswer)
      : { data: result ?? null, error: null };
  }

  function builder(table: string) {
    const query: FakeQuery = { table, op: "select", filters: [] };
    let single: "maybe" | "one" | null = null;

    const settle = (): FakeAnswer => {
      const result = answer(query);
      if (!single) return result;
      const rows = Array.isArray(result.data) ? result.data : result.data == null ? [] : [result.data];
      return { data: rows[0] ?? null, error: result.error };
    };

    const chain: Record<string, unknown> = {};
    const filter = (operator: string) => (column: string, value: unknown) => {
      query.filters.push([column, operator, value]);
      return chain;
    };
    Object.assign(chain, {
      select(columns?: string) {
        if (query.op === "select") query.columns = columns;
        return chain;
      },
      update(values: unknown) { query.op = "update"; query.values = values; return chain; },
      insert(values: unknown) { query.op = "insert"; query.values = values; return chain; },
      upsert(values: unknown) { query.op = "upsert"; query.values = values; return chain; },
      delete() { query.op = "delete"; return chain; },
      eq: filter("eq"), neq: filter("neq"), in: filter("in"), is: filter("is"),
      gt: filter("gt"), gte: filter("gte"), lt: filter("lt"), lte: filter("lte"),
      not: (column: string, operator: string, value: unknown) => {
        query.filters.push([column, `not.${operator}`, value]);
        return chain;
      },
      order: () => chain, limit: () => chain, range: () => chain, returns: () => chain,
      maybeSingle() { single = "maybe"; return chain; },
      single() { single = "one"; return chain; },
      then(resolve: (value: FakeAnswer) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          return Promise.resolve(settle()).then(resolve, reject);
        } catch (error) {
          return reject ? Promise.resolve(reject(error)) : Promise.reject(error);
        }
      },
    });
    return chain;
  }

  return {
    client: { from: (table: string) => builder(table) } as unknown,
    queries,
    /** The writes made to one table, in order. */
    writes(table: string) {
      return queries.filter((query) => query.table === table && query.op !== "select");
    },
  };
}

/** Whether a recorded query filtered on `column = value`. */
export function filteredOn(query: FakeQuery, column: string, value: unknown): boolean {
  return query.filters.some(([c, op, v]) => c === column && op === "eq" && v === value);
}

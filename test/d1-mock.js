import { DatabaseSync } from "node:sqlite";

export function createMockDb() {
  const db = new DatabaseSync(":memory:");
  return {
    async exec(sql) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async all() {
              return { results: db.prepare(sql).all(...params), success: true };
            },
            async first() {
              return db.prepare(sql).get(...params) ?? null;
            },
            async run() {
              const info = db.prepare(sql).run(...params);
              return { success: true, meta: { changes: Number(info.changes || 0) } };
            },
          };
        },
      };
    },
  };
}

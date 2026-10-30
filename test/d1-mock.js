import { DatabaseSync } from "node:sqlite";

function statementFor(db, sql, params) {
  return {
    bind(...next) {
      return statementFor(db, sql, next);
    },
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
}

export function adaptDb(db) {
  return {
    async exec(sql) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    prepare(sql) {
      return statementFor(db, sql, []);
    },
  };
}

export function createMockDb() {
  return adaptDb(new DatabaseSync(":memory:"));
}

export function createRawDb() {
  return new DatabaseSync(":memory:");
}

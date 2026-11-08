import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'

// node:sqlite is prefix-only, so load it through require to keep the bundler out of it
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

type Db = InstanceType<typeof DatabaseSync>

class Stmt {
  constructor(
    private readonly db: Db,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params)
  }
  exec() {
    const results = this.db.prepare(this.sql).all(...(this.params as never[]))
    return { results, success: true, meta: {} }
  }
  async all() {
    return this.exec()
  }
  async run() {
    return this.exec()
  }
  async first() {
    return (this.exec().results[0] as unknown) ?? null
  }
}

/** Just enough of D1Database for the indexer: prepare/bind/all/run/first and atomic batch(). */
export class FakeD1 {
  readonly db: Db = new DatabaseSync(':memory:')
  calls = 0
  constructor() {
    const dir = new URL('../migrations/', import.meta.url)
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) this.db.exec(readFileSync(new URL(f, dir), 'utf8'))
  }
  prepare(sql: string) {
    return new Stmt(this.db, sql)
  }
  async batch(stmts: Stmt[]) {
    this.calls++
    this.db.exec('BEGIN')
    try {
      const out = stmts.map((s) => s.exec())
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  query<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[]
  }
}

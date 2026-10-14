import type { Database } from 'bun:sqlite'

/** Widen the old CHECK without changing job ids, child rows, indexes or the
 * AUTOINCREMENT high-water mark. Keeping a distinct runtime also prevents an
 * older runner from silently executing a Claude job with Codex after rollback.
 * Must run outside another transaction, before preparing any job statements. */
export function migratePrimaryCoreRuntime(db: Database): void {
  const oldCheck = /CHECK\s*\(\s*runtime\s+IN\s*\(\s*'claude'\s*,\s*'codex'\s*\)\s*\)/i
  const schema = () => db.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='jobs'",
  ).get()?.sql
  if (!oldCheck.test(schema() ?? '')) return
  const foreignKeys = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()!.foreign_keys
  const legacyAlter = db.query<{ legacy_alter_table: number }, []>('PRAGMA legacy_alter_table').get()!.legacy_alter_table
  db.exec('PRAGMA foreign_keys=OFF')
  db.exec('PRAGMA legacy_alter_table=ON')
  try {
    db.transaction(() => {
      // Another gateway may have migrated while this connection waited.
      const before = schema()
      if (!before || !oldCheck.test(before)) return
      const dependencies = db.query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_schema WHERE tbl_name='jobs' AND type IN ('index','trigger') AND sql IS NOT NULL",
      ).all()
      const sequence = db.query<{ seq: number }, []>(
        "SELECT seq FROM sqlite_sequence WHERE name='jobs'",
      ).get()?.seq
      const columns = db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all()
        .map(column => '"' + column.name.replaceAll('"', '""') + '"').join(',')
      const expanded = before.replace(oldCheck, "CHECK (runtime IN ('claude', 'codex', 'claude-code'))")
        .replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"jobs"|`jobs`|\[jobs\]|jobs)\s*\(/i, 'CREATE TABLE jobs_core_next (')
      if (expanded === before || !expanded.startsWith('CREATE TABLE jobs_core_next (')) {
        throw new Error('jobs runtime migration could not identify its table')
      }
      db.exec(expanded)
      db.exec(`INSERT INTO jobs_core_next (${columns}) SELECT ${columns} FROM jobs`)
      db.exec('DROP TABLE jobs')
      db.exec('ALTER TABLE jobs_core_next RENAME TO jobs')
      for (const dependency of dependencies) db.exec(dependency.sql)
      if (sequence !== undefined) {
        db.run("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='jobs'", [sequence])
        db.run("INSERT INTO sqlite_sequence(name,seq) SELECT 'jobs',? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='jobs')", [sequence])
      }
      if (db.query('PRAGMA foreign_key_check').all().length > 0) {
        throw new Error('jobs runtime migration failed foreign-key verification')
      }
    }).immediate()
  } finally {
    db.exec(`PRAGMA legacy_alter_table=${legacyAlter}`)
    db.exec(`PRAGMA foreign_keys=${foreignKeys}`)
  }
}

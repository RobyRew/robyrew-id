import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Local SQLite (Node's built-in driver, so the image needs no native build).
// It holds the sign-in sessions and a MIRROR of the Logto users: Logto stays the
// source of truth for username, name, avatar and customData; the mirror exists so
// the public /@handle pages and the availability check never call Logto.

export type Db = DatabaseSync

/** One entry per schema version; PRAGMA user_version records how many ran. */
const MIGRATIONS: string[] = [
  `CREATE TABLE profiles (
     id TEXT PRIMARY KEY,                -- Logto user id (sub)
     username TEXT,                      -- as stored in Logto; may break the handle rule
     name TEXT,
     avatar TEXT,
     suspended INTEGER NOT NULL DEFAULT 0,
     handle_changed_at INTEGER,          -- ms, from customData.robyrewId.handleChangedAt
     previous_handles TEXT NOT NULL DEFAULT '[]',
     synced_at INTEGER NOT NULL
   );
   CREATE TABLE handles (
     handle TEXT PRIMARY KEY,            -- lowercased
     profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('current', 'previous'))
   );
   CREATE INDEX handles_profile ON handles(profile_id);`,
]

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v]!)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  return db
}

/** Runs `fn` in a transaction (node:sqlite has no helper for it). */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

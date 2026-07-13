/**
 * src/storage/db.ts
 *
 * SQLite connection singleton for AI Conversation Vault.
 *
 * Design decisions:
 * - Singleton pattern: one Database instance per extension lifetime.
 *   better-sqlite3's synchronous API makes connection pooling unnecessary
 *   and a singleton avoids WAL checkpoint conflicts.
 * - WAL mode: Write-Ahead Logging dramatically improves concurrent read
 *   performance and prevents "database is locked" errors during reads.
 * - The DB file location is resolved from VS Code settings at init time.
 *   If the user changes the path, they need to reload the window — we do
 *   NOT support hot path-switching as it would require draining in-flight
 *   operations.
 * - fs.mkdirSync ensures the parent directory exists before SQLite tries
 *   to create the file — SQLite will error if the directory is missing.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runMigrations, getLatestVersion } from './migrations';

/** The single shared database connection. Null until initialise() is called. */
let _db: Database.Database | null = null;

/**
 * Initialises the database connection and runs all pending migrations.
 *
 * Must be called exactly once from extension.ts activate().
 * Subsequent calls are idempotent (returns the existing connection).
 *
 * @param overridePath - Optional path override (used in tests to point at :memory: or a temp file)
 * @returns The initialised Database instance
 * @throws If the database file cannot be created or migrations fail
 */
export function initialiseDb(overridePath?: string): Database.Database {
  if (_db) {
    return _db;
  }

  const dbPath = overridePath ?? path.join(os.homedir(), '.ai-vault', 'vault.db');

  // Ensure parent directory exists (SQLite won't create it automatically)
  const parentDir = path.dirname(dbPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
    console.log(`[ChatVault] Created storage directory: ${parentDir}`);
  }

  console.log(`[ChatVault] Opening database at: ${dbPath}`);

  _db = new Database(dbPath, {
    // Verbose logging in development — set to undefined in production builds
    // via webpack DefinePlugin or process.env.NODE_ENV checks
    verbose: process.env.NODE_ENV === 'development'
      ? (message?: unknown, ...additionalArgs: unknown[]) => {
          console.debug('[ChatVault SQL]', message, ...additionalArgs);
        }
      : undefined,
  });

  // ── Performance & reliability PRAGMAs ────────────────────────────────────
  // WAL mode: readers don't block writers, writers don't block readers.
  // This is the recommended mode for any app with concurrent read/write.
  _db.pragma('journal_mode = WAL');

  // NORMAL synchronisation: fsync on WAL checkpoints, not every write.
  // Safe for application data (VS Code itself uses NORMAL for its DBs).
  _db.pragma('synchronous = NORMAL');

  // Foreign key enforcement must be enabled per-connection in SQLite.
  // Without this, the REFERENCES constraint in messages.conversation_id is ignored.
  _db.pragma('foreign_keys = ON');

  // 64 MB page cache — reduces disk I/O for large conversation histories.
  // Value is in pages; SQLite's default page size is 4096 bytes.
  // 64MB / 4096 = 16384 pages
  _db.pragma('cache_size = -65536'); // Negative = kibibytes: 64MB

  // ── Run pending schema migrations ────────────────────────────────────────
  runMigrations(_db);

  const latestVersion = getLatestVersion();
  console.log(`[ChatVault] Database ready at schema version ${latestVersion}`);

  return _db;
}

/**
 * Returns the active database connection.
 *
 * @throws If called before initialiseDb() — this is a programming error
 *         and should never happen in a correctly initialised extension.
 */
export function getDb(): Database.Database {
  if (!_db) {
    throw new Error(
      '[ChatVault] Database accessed before initialisation. ' +
      'Call initialiseDb() in extension activate() first.'
    );
  }
  return _db;
}

/**
 * Closes the database connection cleanly.
 *
 * Must be called from extension deactivate() to flush the WAL and release
 * the file lock. Failure to close can leave a WAL file on disk (harmless
 * but messy).
 */
export function closeDb(): void {
  if (_db) {
    // Checkpoint the WAL back into the main database file before closing.
    // This keeps the .db file up to date even if the -wal file is deleted.
    try {
      _db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
      console.warn('[ChatVault] WAL checkpoint failed on close:', e);
    }
    _db.close();
    _db = null;
    console.log('[ChatVault] Database connection closed');
  }
}

/**
 * Returns the absolute path to the database file currently in use.
 * Useful for "Open database location" commands in the UI.
 */
export function getDbPath(): string {
  return _db?.name ?? path.join(os.homedir(), '.ai-vault', 'vault.db');
}

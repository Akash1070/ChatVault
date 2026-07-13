/**
 * src/storage/migrations.ts
 *
 * Versioned schema migration engine for AI Conversation Vault.
 *
 * Design decisions:
 * - Each migration is a pure function that receives the db handle and applies
 *   exactly one schema change. Migrations are idempotent by design (IF NOT EXISTS).
 * - Migration version is stored in SQLite's built-in PRAGMA user_version.
 *   This avoids needing a separate migrations table and is always readable even
 *   if the schema is corrupted.
 * - Migrations run in a single transaction so a partial failure leaves the DB
 *   in its previous valid state.
 * - Adding new migrations: append to the MIGRATIONS array with the next integer key.
 *   Never modify existing migrations — only add new ones.
 *
 * Schema overview:
 *   conversations — one row per captured AI chat session
 *   messages      — one row per message turn (user/assistant/system)
 */

import Database from 'better-sqlite3';

/** A single versioned migration step. */
interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

/**
 * All schema migrations in ascending version order.
 * The key insight: version N migration brings the schema FROM version N-1 TO N.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema: conversations and messages tables',
    up: (db: Database.Database) => {
      // ─── conversations table ─────────────────────────────────────────────
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          -- Primary key: UUID v4, generated client-side for offline-first safety
          id TEXT PRIMARY KEY NOT NULL,

          -- Auto-generated from the first user message (truncated to 120 chars)
          title TEXT NOT NULL DEFAULT 'Untitled Conversation',

          -- Absolute path to the workspace folder open at capture time.
          -- NULL if no folder was open (e.g. single-file editing).
          project_path TEXT,

          -- ISO 8601 timestamps stored as TEXT for portability.
          -- SQLite has no native datetime type; TEXT ISO 8601 is the convention.
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,

          -- JSON-encoded string array: ["typescript", "auth", "refactor"]
          -- Stored as TEXT because SQLite lacks a native array type.
          -- Always parse/stringify through conversationRepo.ts — never raw SQL.
          tags TEXT NOT NULL DEFAULT '[]',

          -- Boolean stored as INTEGER (0/1) — SQLite convention
          is_starred INTEGER NOT NULL DEFAULT 0,

          -- Which IDE captured this conversation
          source_ide TEXT NOT NULL DEFAULT 'vscode'
            CHECK (source_ide IN ('vscode', 'cursor', 'windsurf', 'unknown')),

          -- Soft delete: NULL = active, ISO 8601 timestamp = deleted
          deleted_at TEXT
        );
      `);

      // Index for the most common list query: active conversations by project, ordered by time
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_conversations_project_path
          ON conversations (project_path, created_at DESC)
          WHERE deleted_at IS NULL;
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_conversations_starred
          ON conversations (is_starred, updated_at DESC)
          WHERE deleted_at IS NULL;
      `);

      // ─── messages table ──────────────────────────────────────────────────
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          -- UUID v4
          id TEXT PRIMARY KEY NOT NULL,

          -- FK to conversations.id — CASCADE so deleting a conversation
          -- automatically removes all its messages (hard delete path).
          conversation_id TEXT NOT NULL
            REFERENCES conversations(id) ON DELETE CASCADE,

          -- The speaker role for this turn
          role TEXT NOT NULL
            CHECK (role IN ('user', 'assistant', 'system')),

          -- Full message content — no length limit at the DB layer.
          -- Large content is fine for SQLite; it stores TEXT as a blob.
          content TEXT NOT NULL,

          -- ISO 8601 timestamp of when this message was recorded
          created_at TEXT NOT NULL,

          -- Approximate token count — useful for context window management (V2).
          -- NULL if not yet calculated.
          token_count INTEGER
        );
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
          ON messages (conversation_id, created_at ASC);
      `);

      // ─── Full-Text Search virtual table ──────────────────────────────────
      // FTS5 provides fast, ranked full-text search over message content.
      // This is used as the primary search path; Fuse.js is the in-memory
      // fallback for small result sets and fuzzy matching.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
          USING fts5(
            content,             -- The searchable content
            conversation_id UNINDEXED, -- FK, not indexed for FTS
            content='messages',  -- External content table
            content_rowid='rowid'
          );
      `);

      // Triggers to keep the FTS index in sync with the messages table
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_ai
          AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts (rowid, content, conversation_id)
              VALUES (new.rowid, new.content, new.conversation_id);
          END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_ad
          AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts (messages_fts, rowid, content, conversation_id)
              VALUES ('delete', old.rowid, old.content, old.conversation_id);
          END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_au
          AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts (messages_fts, rowid, content, conversation_id)
              VALUES ('delete', old.rowid, old.content, old.conversation_id);
            INSERT INTO messages_fts (rowid, content, conversation_id)
              VALUES (new.rowid, new.content, new.conversation_id);
          END;
      `);
    },
  },
  {
    version: 2,
    description: 'Add notes column to conversations for user annotations',
    up: (db: Database.Database) => {
      // ALTER TABLE in SQLite only supports ADD COLUMN — safe to run idempotently
      // by checking if the column already exists first.
      const cols = db
        .prepare("PRAGMA table_info('conversations')")
        .all() as Array<{ name: string }>;

      const hasNotes = cols.some((c) => c.name === 'notes');
      if (!hasNotes) {
        db.exec(`
          ALTER TABLE conversations ADD COLUMN notes TEXT DEFAULT NULL;
        `);
      }
    },
  },
  {
    version: 3,
    description: 'Add message_count computed cache column for faster list queries',
    up: (db: Database.Database) => {
      const cols = db
        .prepare("PRAGMA table_info('conversations')")
        .all() as Array<{ name: string }>;

      const hasCount = cols.some((c) => c.name === 'message_count');
      if (!hasCount) {
        db.exec(`
          ALTER TABLE conversations ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
        `);
      }

      db.exec(`
        UPDATE conversations
          SET message_count = (
            SELECT COUNT(*) FROM messages WHERE messages.conversation_id = conversations.id
          );
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_count_ai
          AFTER INSERT ON messages BEGIN
            UPDATE conversations
              SET message_count = message_count + 1, updated_at = datetime('now')
              WHERE id = new.conversation_id;
          END;
      `);

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_count_ad
          AFTER DELETE ON messages BEGIN
            UPDATE conversations
              SET message_count = MAX(0, message_count - 1)
              WHERE id = old.conversation_id;
          END;
      `);
    },
  },
  {
    version: 4,
    description: 'Add kv_store table for persistent key-value pairs (sync cursor, etc.)',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS kv_store (
          key   TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
      `);
    },
  },
];

/**
 * Reads the current schema version from the database.
 * SQLite PRAGMA user_version starts at 0 for new databases.
 */
function getCurrentVersion(db: Database.Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/**
 * Sets the schema version. Must be called after successful migration.
 * Note: PRAGMA user_version cannot be used in a prepared statement with
 * parameters (SQLite limitation) — we must interpolate directly.
 */
function setVersion(db: Database.Database, version: number): void {
  // Integer interpolation is safe here — version is always a number we control
  db.exec(`PRAGMA user_version = ${version};`);
}

/**
 * Runs all pending migrations against the database.
 * Called by db.ts on every initialisation — safe to call repeatedly.
 *
 * Each migration runs inside its own transaction for atomicity.
 * If any migration throws, the transaction rolls back and the version
 * does NOT advance, ensuring the DB stays in a consistent state.
 */
export function runMigrations(db: Database.Database): void {
  const currentVersion = getCurrentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    return; // Already up to date
  }

  console.log(
    `[ChatVault] Running ${pending.length} migration(s) (current version: ${currentVersion})`
  );

  for (const migration of pending) {
    console.log(
      `[ChatVault] Applying migration v${migration.version}: ${migration.description}`
    );

    // Wrap each migration in a transaction for atomicity
    const applyMigration = db.transaction(() => {
      migration.up(db);
      setVersion(db, migration.version);
    });

    applyMigration();

    console.log(`[ChatVault] Migration v${migration.version} applied successfully`);
  }
}

/** Returns the highest known schema version (latest migration). */
export function getLatestVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}

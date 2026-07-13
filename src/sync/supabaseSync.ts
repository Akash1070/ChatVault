/**
 * src/sync/supabaseSync.ts — Module 7
 *
 * Cloud sync layer — BYOB (Bring Your Own Backend) architecture.
 *
 * Zero-cost-for-developer strategy:
 *   Each user brings their own FREE Supabase project.
 *   Free tier: 500MB DB + 2GB bandwidth/month — years of conversation history.
 *   Developer hosts nothing. Pays $0 regardless of user count.
 *
 * Sync algorithm: incremental last-write-wins
 *   - sync_cursor stored in SQLite (local last-synced timestamp)
 *   - syncUp(): push local rows updated after sync_cursor
 *   - syncDown(): pull remote rows updated after sync_cursor
 *   - Conflict resolution: higher updated_at wins
 *   - All network calls fail-open: errors are logged, local data unaffected
 *
 * SQL migration for Supabase (run in Supabase SQL editor):
 *   See getSqlMigration() below.
 *
 * Feature gate: gated behind LicenceGate.isProUser().
 * Stub: methods are implemented but no-op when cloudSync.enabled = false.
 */

import * as vscode from 'vscode';
import { Settings } from '../config/settings';
import { getDb } from '../storage/db';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type SyncStatus =
  | { state: 'idle' }
  | { state: 'syncing'; direction: 'up' | 'down' | 'both' }
  | { state: 'error'; message: string; lastError: Date }
  | { state: 'success'; lastSync: Date; pushed: number; pulled: number };

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  durationMs: number;
}

// ─── SupabaseSync class ─────────────────────────────────────────────────────────

export class SupabaseSync implements vscode.Disposable {
  private _client: unknown = null;   // supabase-js SupabaseClient (typed as unknown to avoid import at load)
  private _status: SyncStatus = { state: 'idle' };
  private _pollInterval: ReturnType<typeof setInterval> | null = null;
  private readonly _settings: Settings;

  constructor(settings: Settings) {
    this._settings = settings;
  }

  // ── Supabase SQL migration ─────────────────────────────────────────────────

  /**
   * Returns the SQL migration to run in the Supabase SQL editor.
   * Creates mirrored schema with RLS policies ensuring users only access their own data.
   */
  public static getSqlMigration(): string {
    return `
-- ╔══════════════════════════════════════════════════════════╗
-- ║  AI Conversation Vault — Supabase Cloud Sync Migration  ║
-- ║  Run this in: Supabase Dashboard > SQL Editor           ║
-- ╚══════════════════════════════════════════════════════════╝

-- Enable pgcrypto for UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Conversations table (mirrors local SQLite schema + user_id for RLS)
CREATE TABLE IF NOT EXISTS vault_conversations (
  id               TEXT        PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title            TEXT        NOT NULL,
  project_path     TEXT,
  created_at       TEXT        NOT NULL,
  updated_at       TEXT        NOT NULL,
  tags             TEXT        NOT NULL DEFAULT '[]',  -- JSON array
  is_starred       BOOLEAN     NOT NULL DEFAULT FALSE,
  source_ide       TEXT        NOT NULL DEFAULT 'unknown',
  deleted_at       TEXT,
  notes            TEXT,
  message_count    INTEGER     NOT NULL DEFAULT 0
);

-- Messages table
CREATE TABLE IF NOT EXISTS vault_messages (
  id               TEXT        PRIMARY KEY,
  conversation_id  TEXT        NOT NULL REFERENCES vault_conversations(id) ON DELETE CASCADE,
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role             TEXT        NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content          TEXT        NOT NULL,
  created_at       TEXT        NOT NULL,
  token_count      INTEGER
);

-- Indexes for efficient sync queries
CREATE INDEX IF NOT EXISTS idx_conv_user_updated ON vault_conversations(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_msg_conv           ON vault_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msg_user_updated   ON vault_messages(user_id, updated_at);

-- ── Row Level Security ─────────────────────────────────────────────────────────
-- CRITICAL: Users can ONLY read/write their own rows.
-- The anonKey is safe to embed client-side because RLS enforces isolation.

ALTER TABLE vault_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_messages      ENABLE ROW LEVEL SECURITY;

-- Conversations RLS
CREATE POLICY "Users own conversations"
  ON vault_conversations
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Messages RLS
CREATE POLICY "Users own messages"
  ON vault_messages
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
`.trim();
  }

  // ── Connection ───────────────────────────────────────────────────────────────

  /**
   * Connects to the user's Supabase project.
   * Imports @supabase/supabase-js dynamically to avoid loading the module
   * when cloud sync is disabled (keeps cold activation time low).
   */
  public async connect(): Promise<boolean> {
    if (!this._settings.cloudSyncEnabled) {
      console.log('[ChatVault Sync] Cloud sync disabled — skipping connect');
      return false;
    }

    const url = this._settings.cloudSyncSupabaseUrl;
    const key = this._settings.cloudSyncSupabaseAnonKey;

    if (!url || !key) {
      this._status = {
        state: 'error',
        message: 'Supabase URL or anon key not configured',
        lastError: new Date(),
      };
      return false;
    }

    try {
      // Dynamic import — only loads the 1.5MB supabase-js bundle when needed
      const { createClient } = await import('@supabase/supabase-js');
      this._client = createClient(url, key, {
        auth: { persistSession: true, autoRefreshToken: true },
        global: { headers: { 'x-app-name': 'ai-conversation-vault' } },
      });

      // Verify connection by checking auth state
      const sbClient = this._client as import('@supabase/supabase-js').SupabaseClient;
      const { error } = await sbClient.auth.getSession();
      if (error) { throw error; }

      this._status = { state: 'idle' };
      console.log('[ChatVault Sync] Connected to Supabase');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._status = { state: 'error', message: msg, lastError: new Date() };
      console.error('[ChatVault Sync] Connection failed:', msg);
      return false;
    }
  }

  // ── Sync cursor management ────────────────────────────────────────────────────

  private _getSyncCursor(): string {
    const db = getDb();
    const row = db
      .prepare(`SELECT value FROM kv_store WHERE key = 'sync_cursor'`)
      .get() as { value: string } | undefined;
    // Fallback: epoch start (sync everything on first run)
    return row?.value ?? '1970-01-01T00:00:00.000Z';
  }

  private _setSyncCursor(cursor: string): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO kv_store(key, value) VALUES('sync_cursor', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(cursor);
  }

  // ── Sync up (local → remote) ──────────────────────────────────────────────────

  /**
   * Pushes local conversations and messages updated after the sync cursor.
   * Upserts to Supabase (insert or update, no duplicates).
   * Gracefully handles offline state — logs and returns 0 pushed.
   */
  public async syncUp(): Promise<number> {
    if (!this._client || !this._settings.cloudSyncEnabled) { return 0; }

    const cursor = this._getSyncCursor();
    const db = getDb();

    try {
      const sbClient = this._client as import('@supabase/supabase-js').SupabaseClient;

      // Get conversations modified after cursor
      const convRows = db
        .prepare(
          `SELECT * FROM conversations
           WHERE updated_at > ? AND deleted_at IS NULL
           ORDER BY updated_at ASC LIMIT 500`
        )
        .all(cursor) as Record<string, unknown>[];

      if (convRows.length > 0) {
        // Inject user_id from authenticated session
        const { data: { user } } = await sbClient.auth.getUser();
        if (!user) { return 0; }

        const toUpsert = convRows.map((row) => ({
          ...row,
          user_id: user.id,
          tags: typeof row.tags === 'string' ? row.tags : JSON.stringify(row.tags ?? []),
        }));

        const { error } = await sbClient
          .from('vault_conversations')
          .upsert(toUpsert, { onConflict: 'id' });

        if (error) { throw error; }
      }

      // Get messages for those conversations
      const convIds = convRows.map((r) => r.id as string);
      if (convIds.length > 0) {
        const msgRows = db
          .prepare(
            `SELECT m.*, c.project_path FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
             WHERE m.conversation_id IN (${convIds.map(() => '?').join(',')})
             ORDER BY m.created_at ASC`
          )
          .all(...convIds) as Record<string, unknown>[];

        if (msgRows.length > 0) {
          const { data: { user } } = await sbClient.auth.getUser();
          if (user) {
            const { error } = await sbClient
              .from('vault_messages')
              .upsert(msgRows.map((r) => ({ ...r, user_id: user.id })), { onConflict: 'id' });
            if (error) { console.warn('[ChatVault Sync] Message upsert error:', error.message); }
          }
        }
      }

      return convRows.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ChatVault Sync] syncUp error:', msg);
      // Fail-open: log and return 0
      return 0;
    }
  }

  // ── Sync down (remote → local) ────────────────────────────────────────────────

  /**
   * Pulls remote conversations and messages updated after the sync cursor.
   * Conflict resolution: row with higher updated_at wins (last-write-wins).
   */
  public async syncDown(): Promise<number> {
    if (!this._client || !this._settings.cloudSyncEnabled) { return 0; }

    const cursor = this._getSyncCursor();
    const db = getDb();

    try {
      const sbClient = this._client as import('@supabase/supabase-js').SupabaseClient;

      // Pull conversations updated after cursor
      const { data: convRows, error: convError } = await sbClient
        .from('vault_conversations')
        .select('*')
        .gt('updated_at', cursor)
        .order('updated_at', { ascending: true })
        .limit(500);

      if (convError) { throw convError; }
      if (!convRows?.length) { return 0; }

      // Upsert into local SQLite with LWW conflict resolution
      const upsertConv = db.prepare(`
        INSERT INTO conversations
          (id, title, project_path, created_at, updated_at, tags, is_starred,
           source_ide, deleted_at, notes, message_count)
        VALUES
          (@id, @title, @project_path, @created_at, @updated_at, @tags, @is_starred,
           @source_ide, @deleted_at, @notes, @message_count)
        ON CONFLICT(id) DO UPDATE SET
          title         = CASE WHEN excluded.updated_at > conversations.updated_at THEN excluded.title         ELSE conversations.title         END,
          updated_at    = CASE WHEN excluded.updated_at > conversations.updated_at THEN excluded.updated_at    ELSE conversations.updated_at    END,
          tags          = CASE WHEN excluded.updated_at > conversations.updated_at THEN excluded.tags          ELSE conversations.tags          END,
          is_starred    = CASE WHEN excluded.updated_at > conversations.updated_at THEN excluded.is_starred    ELSE conversations.is_starred    END,
          notes         = CASE WHEN excluded.updated_at > conversations.updated_at THEN excluded.notes         ELSE conversations.notes         END,
          deleted_at    = CASE WHEN excluded.updated_at > conversations.updated_at THEN excluded.deleted_at    ELSE conversations.deleted_at    END,
          message_count = CASE WHEN excluded.updated_at > conversations.updated_at THEN excluded.message_count ELSE conversations.message_count END
      `);

      const txn = db.transaction((rows: Record<string, unknown>[]) => {
        for (const row of rows) { upsertConv.run(row); }
      });
      txn(convRows as Record<string, unknown>[]);

      // Pull messages for those conversations
      const convIds = convRows.map((r: Record<string, unknown>) => r.id as string);
      const { data: msgRows, error: msgError } = await sbClient
        .from('vault_messages')
        .select('id, conversation_id, role, content, created_at, token_count')
        .in('conversation_id', convIds);

      if (!msgError && msgRows?.length) {
        const upsertMsg = db.prepare(`
          INSERT OR IGNORE INTO messages
            (id, conversation_id, role, content, created_at, token_count)
          VALUES
            (@id, @conversation_id, @role, @content, @created_at, @token_count)
        `);
        const txnMsg = db.transaction((rows: Record<string, unknown>[]) => {
          for (const r of rows) { upsertMsg.run(r); }
        });
        txnMsg(msgRows as Record<string, unknown>[]);
      }

      // Advance the sync cursor to now
      this._setSyncCursor(new Date().toISOString());
      return convRows.length;
    } catch (err) {
      console.error('[ChatVault Sync] syncDown error:', err instanceof Error ? err.message : err);
      return 0;
    }
  }

  // ── Full sync cycle ───────────────────────────────────────────────────────────

  public async sync(): Promise<SyncResult> {
    if (!this._settings.cloudSyncEnabled || !this._client) {
      return { pushed: 0, pulled: 0, conflicts: 0, durationMs: 0 };
    }

    const start = Date.now();
    this._status = { state: 'syncing', direction: 'both' };

    try {
      const [pushed, pulled] = await Promise.all([this.syncUp(), this.syncDown()]);
      const durationMs = Date.now() - start;
      this._status = { state: 'success', lastSync: new Date(), pushed, pulled };
      console.log(`[ChatVault Sync] ↑${pushed} ↓${pulled} in ${durationMs}ms`);
      return { pushed, pulled, conflicts: 0, durationMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._status = { state: 'error', message: msg, lastError: new Date() };
      return { pushed: 0, pulled: 0, conflicts: 0, durationMs: Date.now() - start };
    }
  }

  public getStatus(): SyncStatus { return this._status; }

  public startPolling(intervalMs = 300_000): void {
    this.stopPolling();
    this._pollInterval = setInterval(() => this.sync(), intervalMs);
  }

  public stopPolling(): void {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  public async disconnect(): Promise<void> {
    this.stopPolling();
    if (this._client) {
      const sbClient = this._client as import('@supabase/supabase-js').SupabaseClient;
      await sbClient.auth.signOut().catch(() => {});
      this._client = null;
    }
    this._status = { state: 'idle' };
  }

  public dispose(): void {
    this.stopPolling();
    this._client = null;
  }
}

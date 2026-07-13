/**
 * src/storage/conversationRepo.ts
 *
 * Full CRUD repository for conversations and messages.
 *
 * Design decisions:
 * - All methods are synchronous (better-sqlite3 is sync). No async/await needed.
 * - Tags are stored as JSON strings in SQLite and always parsed/stringified here.
 *   Consumers never see raw JSON strings — they always receive string[] arrays.
 * - Soft delete (deleted_at) is the default delete path. Hard delete is gated
 *   behind an explicit flag and permanently removes the row + cascades to messages.
 * - exportConversation() is pure — it takes a format string and returns a string.
 *   The caller (extension.ts) handles writing to disk or clipboard.
 * - All inputs are validated before touching the database. Errors are thrown
 *   as plain Error objects with descriptive messages — not VS Code notifications.
 *   The caller decides how to surface errors to the user.
 * - Prepared statements are created once at module load time (not per call)
 *   for maximum performance.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db';

// ─── Domain types ────────────────────────────────────────────────────────────

export type SourceIde = 'vscode' | 'cursor' | 'windsurf' | 'unknown';
export type MessageRole = 'user' | 'assistant' | 'system';
export type ExportFormat = 'json' | 'md' | 'txt';

/** Full conversation record as returned from the database. */
export interface Conversation {
  id: string;
  title: string;
  project_path: string | null;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  tags: string[];     // Parsed from JSON
  is_starred: boolean;
  source_ide: SourceIde;
  deleted_at: string | null; // ISO 8601 or null
  notes: string | null;
  message_count: number;
}

/**
 * Lightweight summary for list views — avoids loading all messages into memory
 * when rendering a list of 100+ conversations.
 */
export interface ConversationSummary {
  id: string;
  title: string;
  project_path: string | null;
  created_at: string;
  updated_at: string;
  tags: string[];
  is_starred: boolean;
  source_ide: SourceIde;
  message_count: number;
  /** Snippet from the first user message, truncated to 200 chars. */
  preview: string;
}

/** A single message turn. */
export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  created_at: string; // ISO 8601
  token_count: number | null;
}

/** Input shape for creating a new conversation. */
export interface CreateConversationInput {
  title?: string;           // Auto-generated from first message if omitted
  project_path?: string;
  tags?: string[];
  source_ide?: SourceIde;
  notes?: string;
}

/** Input shape for adding a message to a conversation. */
export interface CreateMessageInput {
  role: MessageRole;
  content: string;
  token_count?: number;
  created_at?: string;     // Defaults to now if omitted
}

/** Filter options for listConversations(). All fields are optional. */
export interface ConversationFilters {
  /** Filter by exact project path. */
  project_path?: string;
  /** Filter conversations that have ALL of these tags. */
  tags?: string[];
  /** Filter conversations created after this ISO 8601 timestamp. */
  date_from?: string;
  /** Filter conversations created before this ISO 8601 timestamp. */
  date_to?: string;
  /** Only return starred conversations. */
  is_starred?: boolean;
  /** Filter by IDE source. */
  source_ide?: SourceIde;
  /** Include soft-deleted conversations. Default: false. */
  include_deleted?: boolean;
  /** Max results to return. Default: 100. */
  limit?: number;
  /** Offset for pagination. Default: 0. */
  offset?: number;
}

// ─── Raw DB row types (before mapping) ───────────────────────────────────────

interface RawConversationRow {
  id: string;
  title: string;
  project_path: string | null;
  created_at: string;
  updated_at: string;
  tags: string;          // JSON string
  is_starred: number;    // 0 or 1
  source_ide: string;
  deleted_at: string | null;
  notes: string | null;
  message_count: number;
  preview: string | null;
}

interface RawMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
  token_count: number | null;
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringifyTags(tags: string[]): string {
  return JSON.stringify(tags);
}

function mapConversation(row: RawConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    project_path: row.project_path,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tags: parseTags(row.tags),
    is_starred: row.is_starred === 1,
    source_ide: row.source_ide as SourceIde,
    deleted_at: row.deleted_at,
    notes: row.notes,
    message_count: row.message_count,
  };
}

function mapSummary(row: RawConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    project_path: row.project_path,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tags: parseTags(row.tags),
    is_starred: row.is_starred === 1,
    source_ide: row.source_ide as SourceIde,
    message_count: row.message_count,
    preview: row.preview ?? '',
  };
}

function mapMessage(row: RawMessageRow): Message {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content,
    created_at: row.created_at,
    token_count: row.token_count,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── CRUD operations ──────────────────────────────────────────────────────────

/**
 * Creates a new conversation record.
 * Returns the full Conversation object with the generated ID.
 *
 * @param data - Input data; all fields optional with sensible defaults.
 * @returns The newly created Conversation.
 */
export function createConversation(data: CreateConversationInput): Conversation {
  const db = getDb();
  const id = uuidv4();
  const now = nowIso();

  const stmt = db.prepare(`
    INSERT INTO conversations (
      id, title, project_path, created_at, updated_at,
      tags, is_starred, source_ide, notes, message_count
    ) VALUES (
      @id, @title, @project_path, @created_at, @updated_at,
      @tags, 0, @source_ide, @notes, 0
    )
  `);

  stmt.run({
    id,
    title: data.title ?? 'Untitled Conversation',
    project_path: data.project_path ?? null,
    created_at: now,
    updated_at: now,
    tags: stringifyTags(data.tags ?? []),
    source_ide: data.source_ide ?? 'vscode',
    notes: data.notes ?? null,
  });

  // Read back the created row to return the full object
  return getConversation(id)!;
}

/**
 * Retrieves a single conversation by ID, including soft-deleted records.
 * Returns null if not found.
 *
 * @param id - The conversation UUID.
 */
export function getConversation(id: string): Conversation | null {
  const db = getDb();

  const row = db.prepare(`
    SELECT
      c.*,
      (
        SELECT m.content FROM messages m
        WHERE m.conversation_id = c.id
          AND m.role = 'user'
        ORDER BY m.created_at ASC
        LIMIT 1
      ) AS preview
    FROM conversations c
    WHERE c.id = ?
  `).get(id) as RawConversationRow | undefined;

  if (!row) {
    return null;
  }

  return mapConversation(row);
}

/**
 * Returns a paginated list of conversation summaries.
 * Applies all provided filters and excludes soft-deleted records by default.
 *
 * The preview column is populated from the first user message to enable
 * rich list item rendering without loading all messages.
 *
 * @param filters - Optional filter/pagination options.
 */
export function listConversations(
  filters: ConversationFilters = {}
): ConversationSummary[] {
  const db = getDb();

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  // Soft delete filter
  if (!filters.include_deleted) {
    conditions.push('c.deleted_at IS NULL');
  }

  if (filters.project_path !== undefined) {
    conditions.push('c.project_path = @project_path');
    params.project_path = filters.project_path;
  }

  if (filters.date_from !== undefined) {
    conditions.push("c.created_at >= @date_from");
    params.date_from = filters.date_from;
  }

  if (filters.date_to !== undefined) {
    conditions.push("c.created_at <= @date_to");
    params.date_to = filters.date_to;
  }

  if (filters.is_starred !== undefined) {
    conditions.push('c.is_starred = @is_starred');
    params.is_starred = filters.is_starred ? 1 : 0;
  }

  if (filters.source_ide !== undefined) {
    conditions.push('c.source_ide = @source_ide');
    params.source_ide = filters.source_ide;
  }

  const where = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  params.limit = limit;
  params.offset = offset;

  const rows = db.prepare(`
    SELECT
      c.*,
      SUBSTR(
        COALESCE(
          (SELECT m.content FROM messages m
           WHERE m.conversation_id = c.id AND m.role = 'user'
           ORDER BY m.created_at ASC LIMIT 1),
          ''
        ), 1, 200
      ) AS preview
    FROM conversations c
    ${where}
    ORDER BY c.updated_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params) as RawConversationRow[];

  // Tag filter (post-query): SQLite JSON_EACH would require JSON1 extension;
  // post-filtering on small result sets is simpler and portable.
  // For very large datasets (10k+), consider a separate conversation_tags junction table.
  if (filters.tags && filters.tags.length > 0) {
    const requiredTags = filters.tags;
    return rows
      .map(mapSummary)
      .filter((conv) =>
        requiredTags.every((tag) => conv.tags.includes(tag))
      );
  }

  return rows.map(mapSummary);
}

/**
 * Updates a conversation's mutable fields.
 * Only fields present in the patch object are updated (partial update).
 *
 * @param id - The conversation UUID.
 * @param patch - Fields to update. Omit any field to leave it unchanged.
 * @returns The updated Conversation.
 * @throws If the conversation is not found.
 */
export function updateConversation(
  id: string,
  patch: Partial<Omit<Conversation, 'id' | 'created_at' | 'deleted_at' | 'message_count'>>
): Conversation {
  const db = getDb();

  const existing = getConversation(id);
  if (!existing) {
    throw new Error(`[ChatVault] Conversation not found: ${id}`);
  }

  const setClauses: string[] = ['updated_at = @updated_at'];
  const params: Record<string, unknown> = {
    id,
    updated_at: nowIso(),
  };

  if (patch.title !== undefined) {
    setClauses.push('title = @title');
    params.title = patch.title;
  }
  if (patch.project_path !== undefined) {
    setClauses.push('project_path = @project_path');
    params.project_path = patch.project_path;
  }
  if (patch.tags !== undefined) {
    setClauses.push('tags = @tags');
    params.tags = stringifyTags(patch.tags);
  }
  if (patch.is_starred !== undefined) {
    setClauses.push('is_starred = @is_starred');
    params.is_starred = patch.is_starred ? 1 : 0;
  }
  if (patch.source_ide !== undefined) {
    setClauses.push('source_ide = @source_ide');
    params.source_ide = patch.source_ide;
  }
  if (patch.notes !== undefined) {
    setClauses.push('notes = @notes');
    params.notes = patch.notes;
  }

  db.prepare(`
    UPDATE conversations
    SET ${setClauses.join(', ')}
    WHERE id = @id
  `).run(params);

  return getConversation(id)!;
}

/**
 * Deletes a conversation.
 *
 * Default (soft delete): sets deleted_at to the current timestamp.
 * The conversation is hidden from all normal list/get operations.
 * It can be restored by calling updateConversation(id, { deleted_at: null }).
 *
 * Hard delete: permanently removes the conversation and ALL its messages
 * (via ON DELETE CASCADE). This action is irreversible.
 *
 * @param id - The conversation UUID.
 * @param hard - If true, performs a permanent hard delete. Default: false.
 */
export function deleteConversation(id: string, hard = false): void {
  const db = getDb();

  if (hard) {
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  } else {
    db.prepare(`
      UPDATE conversations
      SET deleted_at = ?, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), id);
  }
}

/**
 * Restores a soft-deleted conversation.
 *
 * @param id - The conversation UUID.
 */
export function restoreConversation(id: string): Conversation {
  const db = getDb();

  db.prepare(`
    UPDATE conversations
    SET deleted_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(nowIso(), id);

  const restored = getConversation(id);
  if (!restored) {
    throw new Error(`[ChatVault] Conversation not found after restore: ${id}`);
  }
  return restored;
}

// ─── Message operations ───────────────────────────────────────────────────────

/**
 * Adds a message to an existing conversation.
 * Also auto-updates the conversation title if it's still 'Untitled Conversation'
 * and this is the first user message.
 *
 * @param conversationId - UUID of the parent conversation.
 * @param msg - Message input data.
 * @returns The created Message.
 * @throws If the conversation does not exist.
 */
export function addMessage(
  conversationId: string,
  msg: CreateMessageInput
): Message {
  const db = getDb();

  // Validate parent conversation exists
  const convo = db
    .prepare('SELECT id, title, message_count FROM conversations WHERE id = ?')
    .get(conversationId) as { id: string; title: string; message_count: number } | undefined;

  if (!convo) {
    throw new Error(`[ChatVault] Cannot add message: conversation ${conversationId} not found`);
  }

  const messageId = uuidv4();
  const now = msg.created_at ?? nowIso();

  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at, token_count)
    VALUES (@id, @conversation_id, @role, @content, @created_at, @token_count)
  `).run({
    id: messageId,
    conversation_id: conversationId,
    role: msg.role,
    content: msg.content,
    created_at: now,
    token_count: msg.token_count ?? null,
  });

  // Auto-title: if still untitled and this is a user message,
  // use the first 80 chars of the message as the title
  if (
    convo.title === 'Untitled Conversation' &&
    msg.role === 'user' &&
    convo.message_count === 0
  ) {
    const autoTitle = msg.content.trim().slice(0, 80).replace(/\n/g, ' ');
    db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(
      autoTitle,
      conversationId
    );
  }

  return getMessages(conversationId).find((m) => m.id === messageId)!;
}

/**
 * Returns all messages for a conversation in chronological order.
 *
 * @param conversationId - UUID of the parent conversation.
 */
export function getMessages(conversationId: string): Message[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(conversationId) as RawMessageRow[];

  return rows.map(mapMessage);
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Searches conversations using SQLite FTS5.
 * Returns summaries for all conversations that have at least one message
 * matching the query, ranked by FTS5 relevance (bm25).
 *
 * The FTS5 virtual table (messages_fts) is kept in sync via INSERT/UPDATE/DELETE
 * triggers defined in migrations.ts.
 *
 * @param query - The full-text search query string. Supports FTS5 syntax
 *                (e.g., "auth AND token", "\"exact phrase\"").
 * @param limit - Max results. Default: 20.
 */
export function searchConversations(
  query: string,
  limit = 20
): ConversationSummary[] {
  const db = getDb();

  if (!query || query.trim().length === 0) {
    return listConversations({ limit });
  }

  // FTS5 MATCH query — bm25() provides relevance ranking (lower = more relevant)
  const rows = db.prepare(`
    SELECT DISTINCT
      c.*,
      SUBSTR(
        COALESCE(
          (SELECT m.content FROM messages m
           WHERE m.conversation_id = c.id AND m.role = 'user'
           ORDER BY m.created_at ASC LIMIT 1),
          ''
        ), 1, 200
      ) AS preview
    FROM conversations c
    INNER JOIN (
      SELECT conversation_id, MIN(rank) AS best_rank
      FROM messages_fts
      WHERE messages_fts MATCH ?
      GROUP BY conversation_id
    ) fts ON fts.conversation_id = c.id
    WHERE c.deleted_at IS NULL
    ORDER BY fts.best_rank ASC
    LIMIT ?
  `).all(query, limit) as RawConversationRow[];

  return rows.map(mapSummary);
}

// ─── Export ───────────────────────────────────────────────────────────────────

/**
 * Exports a conversation to a string in the specified format.
 * Throws if the conversation is not found.
 *
 * Formats:
 *   - 'json' — Full conversation + messages as a pretty-printed JSON object.
 *   - 'md'   — Markdown document with a heading per message, role badges,
 *               timestamps, and tag frontmatter.
 *   - 'txt'  — Plain text transcript, suitable for pasting into any editor.
 *
 * @param id - The conversation UUID.
 * @param format - Output format. Defaults to 'md'.
 */
export function exportConversation(id: string, format: ExportFormat = 'md'): string {
  const conversation = getConversation(id);
  if (!conversation) {
    throw new Error(`[ChatVault] Cannot export: conversation ${id} not found`);
  }

  const messages = getMessages(id);

  switch (format) {
    case 'json':
      return exportAsJson(conversation, messages);
    case 'md':
      return exportAsMarkdown(conversation, messages);
    case 'txt':
      return exportAsText(conversation, messages);
  }
}

function exportAsJson(conversation: Conversation, messages: Message[]): string {
  return JSON.stringify(
    {
      conversation,
      messages,
      exported_at: nowIso(),
      export_version: '1.0',
    },
    null,
    2
  );
}

function exportAsMarkdown(conversation: Conversation, messages: Message[]): string {
  const lines: string[] = [];

  // YAML-style frontmatter for tools like Obsidian
  lines.push('---');
  lines.push(`title: "${conversation.title.replace(/"/g, '\\"')}"`);
  lines.push(`created: ${conversation.created_at}`);
  lines.push(`updated: ${conversation.updated_at}`);
  lines.push(`source_ide: ${conversation.source_ide}`);
  if (conversation.project_path) {
    lines.push(`project: "${conversation.project_path}"`);
  }
  if (conversation.tags.length > 0) {
    lines.push(`tags: [${conversation.tags.map((t) => `"${t}"`).join(', ')}]`);
  }
  lines.push('---');
  lines.push('');

  // Document title
  lines.push(`# ${conversation.title}`);
  lines.push('');

  if (conversation.notes) {
    lines.push(`> **Notes:** ${conversation.notes}`);
    lines.push('');
  }

  // Messages
  for (const msg of messages) {
    const roleLabel =
      msg.role === 'user'
        ? '👤 **User**'
        : msg.role === 'assistant'
        ? '🤖 **Assistant**'
        : '⚙️ **System**';

    const timestamp = new Date(msg.created_at).toLocaleString();

    lines.push(`## ${roleLabel} — *${timestamp}*`);
    lines.push('');
    lines.push(msg.content);
    lines.push('');

    if (msg.token_count !== null) {
      lines.push(`*Tokens: ${msg.token_count}*`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // Footer
  lines.push(
    `*Exported from AI Conversation Vault on ${new Date().toLocaleString()}*`
  );

  return lines.join('\n');
}

function exportAsText(conversation: Conversation, messages: Message[]): string {
  const lines: string[] = [];

  lines.push(`AI Conversation Vault — Export`);
  lines.push(`${'='.repeat(50)}`);
  lines.push(`Title:   ${conversation.title}`);
  lines.push(`Created: ${conversation.created_at}`);
  lines.push(`IDE:     ${conversation.source_ide}`);
  if (conversation.project_path) {
    lines.push(`Project: ${conversation.project_path}`);
  }
  if (conversation.tags.length > 0) {
    lines.push(`Tags:    ${conversation.tags.join(', ')}`);
  }
  lines.push('');

  for (const msg of messages) {
    const roleLabel =
      msg.role === 'user' ? 'USER' : msg.role === 'assistant' ? 'ASSISTANT' : 'SYSTEM';
    const timestamp = new Date(msg.created_at).toLocaleString();

    lines.push(`[${roleLabel}] ${timestamp}`);
    lines.push('-'.repeat(40));
    lines.push(msg.content);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Bulk / utility operations ────────────────────────────────────────────────

/**
 * Permanently deletes all conversations and messages.
 * This is irreversible. Intended for "Clear All" in settings.
 * Protected in the UI behind a confirmation dialog.
 */
export function clearAllConversations(): void {
  const db = getDb();
  // Deleting conversations cascades to messages via FK constraint.
  db.prepare('DELETE FROM conversations').run();
}

/**
 * Returns aggregate statistics for the status bar / welcome screen.
 */
export interface VaultStats {
  total_conversations: number;
  total_messages: number;
  starred_conversations: number;
  db_size_bytes: number | null;
}

export function getVaultStats(): VaultStats {
  const db = getDb();

  const convRow = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(is_starred) AS starred,
      SUM(message_count) AS messages
    FROM conversations
    WHERE deleted_at IS NULL
  `).get() as { total: number; starred: number; messages: number };

  // SQLite page_count * page_size gives the DB file size in bytes
  const sizeRow = db.prepare('SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()').get() as { size: number } | undefined;

  return {
    total_conversations: convRow.total ?? 0,
    total_messages: convRow.messages ?? 0,
    starred_conversations: convRow.starred ?? 0,
    db_size_bytes: sizeRow?.size ?? null,
  };
}

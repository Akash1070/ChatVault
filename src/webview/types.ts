/**
 * src/webview/types.ts
 *
 * Shared domain types used ONLY in the webview (browser context).
 * These are manually mirrored from src/storage/conversationRepo.ts.
 *
 * WHY a separate file instead of importing from conversationRepo.ts directly:
 *   The webview tsconfig has rootDir = src/webview. TypeScript strict mode
 *   disallows importing files outside rootDir. Since conversationRepo.ts lives
 *   in src/storage (Node.js context), it cannot be imported into the webview.
 *
 * Tradeoff: we have two copies of these types. We accept this to maintain the
 * clean separation between the Node.js extension host context and the browser
 * webview context. The types are stable and rarely change.
 *
 * If types drift: the postMessage protocol will still work (JSON serialisation
 * is duck-typed), but TypeScript type checking in the webview will be wrong.
 * To prevent drift: add a comment referencing the canonical source.
 */

/** Mirror of src/storage/conversationRepo.ts: SourceIde */
export type SourceIde = 'vscode' | 'cursor' | 'windsurf' | 'unknown';

/** Mirror of src/storage/conversationRepo.ts: MessageRole */
export type MessageRole = 'user' | 'assistant' | 'system';

/** Mirror of src/storage/conversationRepo.ts: ExportFormat */
export type ExportFormat = 'json' | 'md' | 'txt';

/** Mirror of src/storage/conversationRepo.ts: Conversation */
export interface Conversation {
  id: string;
  title: string;
  project_path: string | null;
  created_at: string;
  updated_at: string;
  tags: string[];
  is_starred: boolean;
  source_ide: SourceIde;
  deleted_at: string | null;
  notes: string | null;
  message_count: number;
}

/** Mirror of src/storage/conversationRepo.ts: ConversationSummary */
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
  preview: string;
}

/** Mirror of src/storage/conversationRepo.ts: Message */
export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  token_count: number | null;
}

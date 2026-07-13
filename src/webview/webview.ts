/**
 * src/webview/webview.ts
 *
 * VS Code message bridge — the ONLY communication channel between the
 * sandboxed webview (React app) and the extension host (Node.js).
 *
 * Architecture:
 *   Extension host sends messages TO webview via panel.webview.postMessage()
 *   Webview sends messages TO extension host via vscode.postMessage()
 *   (acquireVsCodeApi is the webview's handle to the VS Code messaging API)
 *
 * Message protocol:
 *   All messages are typed objects: { type: string, payload: unknown }
 *   Types are defined in the shared MessageType enum below.
 *   The extension host and webview must stay in sync on these types.
 *
 * This file runs in the BROWSER context (webview sandbox).
 * It has access to window, document, and acquireVsCodeApi().
 * It does NOT have access to Node.js APIs, vscode module, or the filesystem.
 */

// acquireVsCodeApi() is injected into the webview window by VS Code at runtime.
// TypeScript has no knowledge of it without an explicit ambient declaration.
declare function acquireVsCodeApi<T = unknown>(): {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState<S>(state: S): S;
};

// Acquire once — calling it more than once per webview lifetime throws.
const vscode = acquireVsCodeApi();


// ─── Message types (must mirror extension host) ───────────────────────────────

export type MessageType =
  // Extension → Webview
  | 'CONVERSATIONS_LOADED'       // Initial list load
  | 'CONVERSATION_SELECTED'      // A conversation + its messages
  | 'CONVERSATION_CREATED'       // New conversation added
  | 'CONVERSATION_UPDATED'       // An existing conversation was patched
  | 'CONVERSATION_DELETED'       // Soft/hard delete confirmation
  | 'NEW_CONVERSATION'           // A new conversation captured in background
  | 'SEARCH_RESULTS'             // Results from a search query
  | 'EXPORT_RESULT'              // Export string (to display/copy)
  | 'STATS_LOADED'               // Vault statistics
  | 'PLAN_STATUS'                // Free/premium plan status
  | 'ERROR'                      // An error occurred in the extension host
  // Webview → Extension
  | 'LOAD_CONVERSATIONS'         // Request conversation list (with filters)
  | 'SELECT_CONVERSATION'        // Request full conversation + messages
  | 'CREATE_CONVERSATION'        // Request to create a new conversation
  | 'UPDATE_CONVERSATION'        // Request to update/patch a conversation
  | 'DELETE_CONVERSATION'        // Request soft delete
  | 'HARD_DELETE_CONVERSATION'   // Request permanent delete
  | 'RESTORE_CONVERSATION'       // Request restore from soft delete
  | 'SEARCH'                     // Search query
  | 'EXPORT_CONVERSATION'        // Request export in a format
  | 'LOAD_STATS'                 // Request vault stats
  | 'LOAD_PLAN_STATUS'           // Request current plan/licence info
  | 'OPEN_SETTINGS'              // Open the extension settings page
  | 'OPEN_DB_FOLDER';            // Open the database folder in explorer

export interface VaultMessage<T = unknown> {
  type: MessageType;
  payload: T;
}

// ─── Message sender ───────────────────────────────────────────────────────────

/**
 * Sends a typed message from the webview to the extension host.
 * The extension host listens via webview.onDidReceiveMessage.
 */
export function sendMessage<T>(type: MessageType, payload: T): void {
  vscode.postMessage({ type, payload } satisfies VaultMessage<T>);
}

// ─── Message receiver ─────────────────────────────────────────────────────────

type MessageHandler<T = unknown> = (payload: T) => void;
const handlers = new Map<MessageType, MessageHandler[]>();

/**
 * Registers a handler for a specific message type from the extension host.
 * Multiple handlers can be registered for the same type (e.g., for composing
 * different React subtrees that each react to CONVERSATIONS_LOADED).
 *
 * Returns an unsubscribe function for cleanup in useEffect().
 */
export function onMessage<T>(
  type: MessageType,
  handler: MessageHandler<T>
): () => void {
  const existing = handlers.get(type) ?? [];
  existing.push(handler as MessageHandler);
  handlers.set(type, existing);

  return () => {
    const current = handlers.get(type) ?? [];
    handlers.set(
      type,
      current.filter((h) => h !== handler)
    );
  };
}

// Wire up the global message listener — runs once at module load time.
window.addEventListener('message', (event: MessageEvent<VaultMessage>) => {
  const { type, payload } = event.data;
  const registered = handlers.get(type as MessageType);
  if (registered) {
    for (const handler of registered) {
      handler(payload);
    }
  }
});

// ─── State persistence ────────────────────────────────────────────────────────

/**
 * Persist lightweight UI state (selected conversation id, search query, etc.)
 * across webview visibility changes. VS Code may hide/show the webview panel
 * without destroying it, but state is lost on full destruction.
 *
 * vscode.getState() / setState() is the VS Code API for webview state persistence.
 */
export interface WebviewState {
  selectedConversationId: string | null;
  searchQuery: string;
  activeFilter: 'all' | 'starred' | 'project';
}

const DEFAULT_STATE: WebviewState = {
  selectedConversationId: null,
  searchQuery: '',
  activeFilter: 'all',
};

export function getPersistedState(): WebviewState {
  const saved = vscode.getState() as WebviewState | undefined;
  return saved ?? DEFAULT_STATE;
}

export function persistState(state: Partial<WebviewState>): void {
  const current = getPersistedState();
  vscode.setState({ ...current, ...state });
}

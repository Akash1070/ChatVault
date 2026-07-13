/**
 * src/extension.ts — AI Conversation Vault Extension Entry Point
 *
 * activate() wiring order:
 *   1. Settings (reads config, fires change events)
 *   2. Database (SQLite init + migrations — synchronous)
 *   3. LicenceGate (background validation, 14-day trial)
 *   4. SearchEngine (build Fuse.js index)
 *   5. CaptureManager (commands + chat participant)
 *   6. SupabaseSync (connect + poll, only if enabled)
 *   7. SidebarProvider (WebviewViewProvider)
 *   8. CaptureManager → SidebarProvider event bridge
 *   9. Settings → revalidate licence on key change
 *  10. Status bar item
 *  11. Welcome message on first install
 *
 * deactivate() closes DB cleanly (WAL checkpoint).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { initialiseDb, closeDb, getDb } from './storage/db';
import {
  listConversations,
  getConversation,
  getMessages,
  updateConversation,
  deleteConversation,
  restoreConversation,
  exportConversation,
  getVaultStats,
  clearAllConversations,
  ConversationFilters,
} from './storage/conversationRepo';
import { Settings } from './config/settings';
import { SearchEngine } from './search/searchEngine';
import { CaptureManager } from './capture/captureManager';
import { LicenceGate, ProFeature } from './monetise/licenceGate';
import { SupabaseSync } from './sync/supabaseSync';

// ─── Module-level singletons ──────────────────────────────────────────────────
// These are assigned in activate() and cleaned up in deactivate().
let _settings: Settings | null = null;
let _searchEngine: SearchEngine | null = null;
let _captureManager: CaptureManager | null = null;
let _licenceGate: LicenceGate | null = null;
let _supabaseSync: SupabaseSync | null = null;

// ─── WebviewViewProvider ─────────────────────────────────────────────────────

class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly VIEW_ID = 'chatVault.sidebar';
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public get view() { return this._view; }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'dist'),
        vscode.Uri.joinPath(this._extensionUri, 'media'),
      ],
    };
    webviewView.webview.html = this._buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: { type: string; payload: unknown }) => {
      this._handleMessage(msg.type, msg.payload as Record<string, unknown>, webviewView.webview);
    });
  }

  public postMessage(type: string, payload: unknown): void {
    this._view?.webview.postMessage({ type, payload });
  }

  private _handleMessage(
    type: string,
    p: Record<string, unknown>,
    webview: vscode.Webview
  ): void {
    const send = (t: string, data: unknown) => webview.postMessage({ type: t, payload: data });

    try {
      switch (type) {
        case 'LOAD_CONVERSATIONS': {
          const filters: ConversationFilters = {
            limit: (p?.limit as number | undefined) ?? _settings?.maxConversationsShown ?? 100,
            is_starred: p?.filter === 'starred' ? true : undefined,
            project_path:
              p?.filter === 'project'
                ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
                : undefined,
          };
          send('CONVERSATIONS_LOADED', listConversations(filters));
          break;
        }

        case 'SELECT_CONVERSATION': {
          const id = p.id as string;
          const conversation = getConversation(id);
          if (!conversation) { send('ERROR', `Not found: ${id}`); return; }
          send('CONVERSATION_SELECTED', { conversation, messages: getMessages(id) });
          break;
        }

        case 'UPDATE_CONVERSATION': {
          const id = p.id as string;
          const patch = p.patch as Parameters<typeof updateConversation>[1];
          const updated = updateConversation(id, patch);
          send('CONVERSATION_UPDATED', updated);
          _searchEngine?.invalidate(id);
          break;
        }

        case 'DELETE_CONVERSATION': {
          const id = p.id as string;
          const hard = (p.hard as boolean | undefined) ?? false;
          deleteConversation(id, hard);
          send('CONVERSATION_DELETED', id);
          _searchEngine?.invalidate(id);
          this._sendStats(webview);
          break;
        }

        case 'RESTORE_CONVERSATION': {
          const id = p.id as string;
          send('CONVERSATION_UPDATED', restoreConversation(id));
          break;
        }

        case 'SEARCH': {
          const query = p.query as string;
          const filters = (p.filters ?? {}) as ConversationFilters;
          const results = _searchEngine
            ? _searchEngine.search({ query, filters, limit: 50 })
            : listConversations({ limit: 50 });
          send('SEARCH_RESULTS', results);
          break;
        }

        case 'EXPORT_CONVERSATION': {
          const id = p.id as string;
          const fmt = (p.format as 'json' | 'md' | 'txt') ?? 'md';
          const content = exportConversation(id, fmt);
          const tmpPath = path.join(os.tmpdir(), `chatvault-${Date.now()}.${fmt}`);
          fs.writeFileSync(tmpPath, content, 'utf8');
          vscode.workspace.openTextDocument(tmpPath).then((doc) =>
            vscode.window.showTextDocument(doc)
          );
          send('EXPORT_RESULT', { success: true, path: tmpPath });
          break;
        }

        case 'LOAD_STATS': {
          const stats = getVaultStats();
          send('STATS_LOADED', {
            total: stats.total_conversations,
            starred: stats.starred_conversations,
          });
          break;
        }

        case 'LOAD_PLAN_STATUS':
          send('PLAN_STATUS', _licenceGate?.getPlanLabel() ?? '🆓 Free');
          break;

        case 'OPEN_SETTINGS':
          vscode.commands.executeCommand('workbench.action.openSettings', 'chatVault');
          break;

        case 'OPEN_DB_FOLDER':
          vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(path.dirname(getDb().name))
          );
          break;

        case 'CREATE_CONVERSATION':
          vscode.commands.executeCommand('chatVault.saveConversation');
          break;

      case 'TRIGGER_SYNC':
          if (_supabaseSync) {
            _supabaseSync.sync().then(() => send('SYNC_STATUS', _supabaseSync!.getStatus()));
          }
          break;

        default:
          console.warn('[ChatVault] Unknown webview message:', type);
      }
    } catch (err) {
      send('ERROR', err instanceof Error ? err.message : String(err));
      console.error('[ChatVault] Error in webview handler:', type, err);
    }
  }

  private _sendStats(webview: vscode.Webview): void {
    const stats = getVaultStats();
    webview.postMessage({
      type: 'STATS_LOADED',
      payload: { total: stats.total_conversations, starred: stats.starred_conversations },
    });
  }

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = _generateNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'webview.js')
    );

    const templatePath = path.join(
      this._extensionUri.fsPath, 'dist', 'webview', 'index.html'
    );

    let html: string;
    try {
      html = fs.readFileSync(templatePath, 'utf8');
    } catch {
      return `<!DOCTYPE html><html><body style="color:white;padding:20px;">
        <p>ChatVault: run <code>npm run compile</code> to build.</p>
      </body></html>`;
    }

    return html
      .replace(/\$\{cspSource\}/g, webview.cspSource)
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{webviewUri\}/g, scriptUri.toString());
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── activate() ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  console.log('[ChatVault] Activating…');

  // ── 1. Settings ──────────────────────────────────────────────────────────
  _settings = new Settings();
  context.subscriptions.push(_settings);

  // ── 2. Database ──────────────────────────────────────────────────────────
  try {
    initialiseDb(_settings.storagePath);
  } catch (err) {
    vscode.window.showErrorMessage(
      `ChatVault: DB init failed — ${err instanceof Error ? err.message : err}`
    );
    return;
  }

  // ── 3. Licence gate ───────────────────────────────────────────────────────
  _licenceGate = new LicenceGate(context, _settings);
  context.subscriptions.push(_licenceGate);
  _licenceGate.initialise(); // Background — non-blocking

  // Revalidate when user changes licence key
  _settings.onChanged((evt) => {
    if (evt.affectedKeys.includes('licenceKey')) {
      _licenceGate?.revalidate();
    }
  });

  // ── 4. Search engine ──────────────────────────────────────────────────────
  _searchEngine = SearchEngine.getInstance(_settings);
  _searchEngine.buildIndex();

  // ── 5. Capture manager ────────────────────────────────────────────────────
  _captureManager = new CaptureManager(_settings);
  context.subscriptions.push(_captureManager);

  // ── 6. Supabase sync (only if enabled) ─────────────────────────────────
  if (_settings.cloudSyncEnabled) {
    if (_licenceGate.isProUser()) {
      _supabaseSync = new SupabaseSync(_settings);
      context.subscriptions.push(_supabaseSync);
      _supabaseSync.connect().then((connected) => {
        if (connected) {
          _supabaseSync!.sync();
          _supabaseSync!.startPolling();
        }
      });
    } else {
      _licenceGate.showUpgradePrompt(ProFeature.CLOUD_SYNC);
    }
  }

  // ── 7. Sidebar WebView provider ──────────────────────────────────────────
  const provider = new SidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.VIEW_ID,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── 8. Capture → Sidebar event bridge ────────────────────────────────────
  _captureManager.registerAll(context);

  _captureManager.onConversationSaved((evt) => {
    // Push the new conversation to the webview in real-time
    provider.postMessage('NEW_CONVERSATION', evt.conversation);
    _searchEngine?.invalidate(evt.conversation.id);
  });

  // ── 9. Extra commands wired to provider ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('chatVault.openVault', () => {
      vscode.commands.executeCommand(`${SidebarProvider.VIEW_ID}.focus`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chatVault.searchConversations', async () => {
      const conversations = listConversations({ limit: 200 });
      const items = conversations.map((c) => ({
        label: c.title,
        description: c.source_ide,
        detail: c.preview || undefined,
        id: c.id,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        title: 'ChatVault — Search',
        placeHolder: 'Type to filter…',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (selected) {
        await vscode.commands.executeCommand(`${SidebarProvider.VIEW_ID}.focus`);
        setTimeout(() => {
          provider.postMessage('CONVERSATION_SELECTED', {
            conversation: getConversation(selected.id),
            messages: getMessages(selected.id),
          });
        }, 300);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chatVault.clearDatabase', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'ChatVault: This will PERMANENTLY delete all conversations. Cannot be undone.',
        { modal: true },
        'Delete Everything'
      );
      if (confirm === 'Delete Everything') {
        clearAllConversations();
        _searchEngine?.buildIndex();
        provider.postMessage('CONVERSATIONS_LOADED', []);
        provider.postMessage('STATS_LOADED', { total: 0, starred: 0 });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('chatVault.exportConversation', async () => {
      const conversations = listConversations({ limit: 200 });
      if (conversations.length === 0) {
        vscode.window.showInformationMessage('ChatVault: No conversations to export.');
        return;
      }
      const selected = await vscode.window.showQuickPick(
        conversations.map((c) => ({ label: c.title, id: c.id })),
        { title: 'Export Conversation', placeHolder: 'Select one…' }
      );
      if (!selected) { return; }
      const fmt = await vscode.window.showQuickPick(
        ['Markdown (.md)', 'JSON (.json)', 'Plain text (.txt)'],
        { title: 'Export Format' }
      );
      if (!fmt) { return; }
      const format: 'json' | 'md' | 'txt' = fmt.startsWith('Markdown')
        ? 'md' : fmt.startsWith('JSON') ? 'json' : 'txt';
      const content = exportConversation(selected.id, format);
      const tmpPath = path.join(os.tmpdir(), `chatvault-export-${Date.now()}.${format}`);
      fs.writeFileSync(tmpPath, content, 'utf8');
      const doc = await vscode.workspace.openTextDocument(tmpPath);
      await vscode.window.showTextDocument(doc);
    })
  );

  // ── 10. Status bar item ───────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'chatVault.openVault';
  statusBar.text = '$(history) ChatVault';
  statusBar.tooltip = 'Open AI Conversation Vault';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── 11. First-run welcome message ────────────────────────────────────────
  const seen = context.globalState.get<boolean>('chatVault.welcomeShown');
  if (!seen) {
    vscode.window
      .showInformationMessage(
        '👋 Welcome to AI Conversation Vault! Press Ctrl+Shift+S to save your first conversation.',
        'Open Vault', 'View Docs'
      )
      .then((action) => {
        if (action === 'Open Vault') {
          vscode.commands.executeCommand('chatVault.openVault');
        } else if (action === 'View Docs') {
          vscode.env.openExternal(vscode.Uri.parse('https://github.com/yourusername/ai-conversation-vault#readme'));
        }
      });
    context.globalState.update('chatVault.welcomeShown', true);
  }

  console.log('[ChatVault] Activated ✅');
}

// ─── deactivate() ─────────────────────────────────────────────────────────────

export function deactivate(): void {
  console.log('[ChatVault] Deactivating…');
  _searchEngine?.destroy();
  _supabaseSync?.disconnect();
  closeDb();
}

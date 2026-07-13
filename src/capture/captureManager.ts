/**
 * src/capture/captureManager.ts — Module 3
 *
 * Capture strategies by IDE:
 * VS Code + Copilot → vscode.chat participant (Strategy A, automatic)
 * Windsurf          → vscode.lm API (same path as A)
 * Cursor            → Clipboard paste + role parser (Strategy C)
 * Any IDE fallback  → 'chatVault.saveConversation' command (Strategy B)
 *
 * Deduplication: SHA-256(conversationId|role|content[0..64]|minuteBucket)
 * stored in a session-scoped Set. Same message within the same minute is dropped.
 *
 * Real-time updates: fires typed EventEmitter events. The SidebarProvider
 * subscribes and pushes webview.postMessage() without polling.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
  createConversation,
  addMessage,
  getConversation,
  SourceIde,
  Conversation,
  Message,
} from '../storage/conversationRepo';
import { detectSourceIde, parseConversationText, getCaptureGuidance } from './cursorAdapter';
import { Settings } from '../config/settings';
import { LocalFileParser } from './localFileParser';

// ─── Event payloads ────────────────────────────────────────────────────────────

export interface ConversationSavedEvent {
  conversation: Conversation;
  messageCount: number;
}

export interface MessageAddedEvent {
  conversationId: string;
  message: Message;
}

// ─── Deduplication ─────────────────────────────────────────────────────────────

const _dedupSet = new Set<string>();

function isDuplicate(conversationId: string, role: string, content: string): boolean {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = crypto
    .createHash('sha256')
    .update(`${conversationId}|${role}|${content.slice(0, 64)}|${minuteBucket}`)
    .digest('hex');
  if (_dedupSet.has(key)) { return true; }
  _dedupSet.add(key);
  return false;
}

// ─── CaptureManager ────────────────────────────────────────────────────────────

export class CaptureManager implements vscode.Disposable {
  private readonly _onConversationSaved = new vscode.EventEmitter<ConversationSavedEvent>();
  public readonly onConversationSaved = this._onConversationSaved.event;

  private readonly _onMessageAdded = new vscode.EventEmitter<MessageAddedEvent>();
  public readonly onMessageAdded = this._onMessageAdded.event;

  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _settings: Settings;
  private readonly _localParser: LocalFileParser;
  private _pollTimer?: NodeJS.Timeout;

  constructor(settings: Settings) {
    this._settings = settings;
    this._localParser = new LocalFileParser();
  }

  public registerAll(context: vscode.ExtensionContext): void {
    this._registerChatParticipant(context);
    this._registerManualCommand(context);
    this._registerClipboardCommand(context);
    this._registerToggleCommand(context);
    this._startPolling();
  }

  private _startPolling() {
    // Poll every 5 minutes
    this._pollTimer = setInterval(async () => {
      if (!this._settings.autoCapture) return;
      const logs = await this._localParser.pollLogs();
      for (const log of logs) {
        const messages = parseConversationText(log.content);
        if (messages.length > 0) {
          this.captureMessages(messages, { sourceIde: log.ide, title: 'Auto-captured Log' });
        }
      }
    }, 5 * 60 * 1000);

    // Initial poll
    setTimeout(async () => {
      if (!this._settings.autoCapture) return;
      const logs = await this._localParser.pollLogs();
      for (const log of logs) {
        const messages = parseConversationText(log.content);
        if (messages.length > 0) {
          this.captureMessages(messages, { sourceIde: log.ide, title: 'Auto-captured Log' });
        }
      }
    }, 5000);
  }


  // ── A: VS Code Chat Participant (VS Code 1.90+ / Windsurf) ─────────────────

  private _registerChatParticipant(context: vscode.ExtensionContext): void {
    if (typeof vscode.chat === 'undefined') {
      console.log('[ChatVault] vscode.chat not available — skipping participant.');
      return;
    }
    try {
      const p = vscode.chat.createChatParticipant(
        'chatVault.capture',
        this._handleChatRequest.bind(this)
      );
      p.iconPath = new vscode.ThemeIcon('history');
      p.followupProvider = {
        provideFollowups(): vscode.ChatFollowup[] {
          return [{ prompt: 'save this conversation', label: '💾 Save to vault', command: 'save' }];
        },
      };
      this._disposables.push(p);
      context.subscriptions.push(p);
    } catch (err) {
      console.warn('[ChatVault] Chat participant registration failed:', err);
    }
  }

  private async _handleChatRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> {
    if (token.isCancellationRequested) { return {}; }

    const cmd = request.command ?? 'help';
    const prompt = request.prompt.trim();

    if (cmd === 'save' || prompt.toLowerCase().startsWith('save')) {
      const rawContent = cmd === 'save' ? prompt : prompt.slice(4).trim();

      // If no inline content, reconstruct from chat history
      const messages = rawContent
        ? parseConversationText(rawContent)
        : this._fromHistory(chatContext);

      if (messages.length === 0) {
        stream.markdown(
          '**ChatVault**: No content to save.\n\n' +
          'Usage: `@chatVault save\nUser: ...\nAI: ...`'
        );
        return {};
      }

      return this._persistAndRespond(messages, stream);
    }

    if (cmd === 'list') {
      stream.markdown('**ChatVault**: Click the vault icon in the Activity Bar to browse conversations.');
      return {};
    }

    // Help
    stream.markdown(
      '## 🔐 AI Conversation Vault\n\n' +
      '| Command | Description |\n|---------|-------------|\n' +
      '| `@chatVault /save <text>` | Save inline conversation |\n' +
      '| `@chatVault /list` | Open vault sidebar |\n\n' +
      getCaptureGuidance()
    );
    return {};
  }

  private async _persistAndRespond(
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    stream: vscode.ChatResponseStream
  ): Promise<vscode.ChatResult> {
    try {
      const convo = createConversation({
        project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        source_ide: detectSourceIde(),
      });
      let count = 0;
      for (const m of messages) {
        if (!isDuplicate(convo.id, m.role, m.content)) {
          const saved = addMessage(convo.id, m);
          this._onMessageAdded.fire({ conversationId: convo.id, message: saved });
          count++;
        }
      }
      const full = getConversation(convo.id)!;
      this._onConversationSaved.fire({ conversation: full, messageCount: count });
      stream.markdown(`**ChatVault** ✅ Saved *"${full.title}"* — ${count} messages`);
      return { metadata: { status: 'ok', id: convo.id } };
    } catch (err) {
      stream.markdown(`**ChatVault** ❌ ${err instanceof Error ? err.message : err}`);
      return {};
    }
  }

  private _fromHistory(
    ctx: vscode.ChatContext
  ): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
    const out: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    for (const turn of ctx.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        out.push({ role: 'user', content: turn.prompt });
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .filter((p): p is vscode.ChatResponseMarkdownPart =>
            p instanceof vscode.ChatResponseMarkdownPart
          )
          .map((p) => p.value.value)
          .join('');
        if (text.trim()) { out.push({ role: 'assistant', content: text }); }
      }
    }
    return out;
  }

  // ── B: Manual multi-step command (all IDEs) ─────────────────────────────────

  private _registerManualCommand(context: vscode.ExtensionContext): void {
    const cmd = vscode.commands.registerCommand(
      'chatVault.saveConversation',
      () => this._runManualFlow()
    );
    this._disposables.push(cmd);
    context.subscriptions.push(cmd);
  }

  private async _runManualFlow(): Promise<void> {
    const title = await vscode.window.showInputBox({
      title: 'Save Conversation (1/3) — Title',
      placeHolder: 'Auto-titled if blank',
      ignoreFocusOut: true,
    });
    if (title === undefined) { return; }

    const rawContent = await vscode.window.showInputBox({
      title: 'Save Conversation (2/3) — Paste Content',
      prompt: 'Prefix turns with "User:" / "AI:" or "Assistant:"',
      placeHolder: 'User: How do I fix this?\nAI: Try using...',
      ignoreFocusOut: true,
    });
    if (rawContent === undefined) { return; }

    const tagsRaw = await vscode.window.showInputBox({
      title: 'Save Conversation (3/3) — Tags (optional)',
      placeHolder: 'typescript, auth, debugging',
      ignoreFocusOut: true,
    });
    if (tagsRaw === undefined) { return; }

    const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
    const messages = parseConversationText(rawContent);

    if (messages.length === 0) {
      vscode.window.showWarningMessage('ChatVault: No messages parsed. Use "User: ..." / "AI: ..." format.');
      return;
    }

    const convo = createConversation({
      title: title.trim() || undefined,
      project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      tags,
      source_ide: detectSourceIde(),
    });

    let count = 0;
    for (const m of messages) {
      if (!isDuplicate(convo.id, m.role, m.content)) {
        const saved = addMessage(convo.id, m);
        this._onMessageAdded.fire({ conversationId: convo.id, message: saved });
        count++;
      }
    }

    const full = getConversation(convo.id)!;
    this._onConversationSaved.fire({ conversation: full, messageCount: count });

    const action = await vscode.window.showInformationMessage(
      `✅ Saved "${full.title}" — ${count} messages`,
      'Open Vault'
    );
    if (action === 'Open Vault') {
      vscode.commands.executeCommand('chatVault.openVault');
    }
  }

  // ── C: Clipboard capture (Cursor / no-chat-API IDEs) ───────────────────────

  private _registerClipboardCommand(context: vscode.ExtensionContext): void {
    const cmd = vscode.commands.registerCommand(
      'chatVault.captureFromClipboard',
      async () => {
        const text = await vscode.env.clipboard.readText();
        if (!text?.trim()) {
          vscode.window.showWarningMessage('ChatVault: Clipboard is empty. Copy your AI chat first.');
          return;
        }

        const messages = parseConversationText(text);

        if (messages.length === 0) {
          const pick = await vscode.window.showInformationMessage(
            `ChatVault: ${text.length} chars in clipboard but no User:/AI: markers. Save as a note?`,
            'Save Note', 'Cancel'
          );
          if (pick !== 'Save Note') { return; }
          const convo = createConversation({
            project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            source_ide: detectSourceIde(),
          });
          const saved = addMessage(convo.id, { role: 'user', content: text });
          this._onMessageAdded.fire({ conversationId: convo.id, message: saved });
          this._onConversationSaved.fire({ conversation: getConversation(convo.id)!, messageCount: 1 });
          vscode.window.showInformationMessage('✅ Clipboard saved as note');
          return;
        }

        // Ask for optional title + tags
        const title = await vscode.window.showInputBox({
          title: `Clipboard: ${messages.length} messages detected — Title (optional)`,
          placeHolder: 'Auto-titled from first message',
          ignoreFocusOut: true,
        });
        if (title === undefined) { return; }

        const tagsRaw = await vscode.window.showInputBox({
          title: 'Tags (optional, comma-separated)',
          ignoreFocusOut: true,
        });
        if (tagsRaw === undefined) { return; }

        const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
        const convo = createConversation({
          title: title.trim() || undefined,
          project_path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          tags,
          source_ide: detectSourceIde(),
        });

        let count = 0;
        for (const m of messages) {
          if (!isDuplicate(convo.id, m.role, m.content)) {
            const saved = addMessage(convo.id, m);
            this._onMessageAdded.fire({ conversationId: convo.id, message: saved });
            count++;
          }
        }
        const full = getConversation(convo.id)!;
        this._onConversationSaved.fire({ conversation: full, messageCount: count });
        vscode.window.showInformationMessage(`✅ Saved "${full.title}" — ${count} messages from clipboard`);
      }
    );
    this._disposables.push(cmd);
    context.subscriptions.push(cmd);
  }

  // ── D: Toggle auto-capture ──────────────────────────────────────────────────

  private _registerToggleCommand(context: vscode.ExtensionContext): void {
    const cmd = vscode.commands.registerCommand('chatVault.toggleAutoCapture', async () => {
      const current = this._settings.autoCapture;
      await vscode.workspace
        .getConfiguration('chatVault')
        .update('autoCapture', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `ChatVault: Auto-capture ${!current ? 'enabled ✅' : 'disabled ⏸'}`
      );
    });
    this._disposables.push(cmd);
    context.subscriptions.push(cmd);
  }

  // ── Public programmatic API ─────────────────────────────────────────────────

  public captureMessages(
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    opts: { title?: string; projectPath?: string; tags?: string[]; sourceIde?: SourceIde } = {}
  ): Conversation {
    const convo = createConversation({
      title: opts.title,
      project_path: opts.projectPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      tags: opts.tags,
      source_ide: opts.sourceIde ?? detectSourceIde(),
    });
    for (const m of messages) {
      if (!isDuplicate(convo.id, m.role, m.content)) {
        const saved = addMessage(convo.id, m);
        this._onMessageAdded.fire({ conversationId: convo.id, message: saved });
      }
    }
    const full = getConversation(convo.id)!;
    this._onConversationSaved.fire({ conversation: full, messageCount: messages.length });
    return full;
  }

  public dispose(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
    }
    this._onConversationSaved.dispose();
    this._onMessageAdded.dispose();
    this._disposables.forEach((d) => d.dispose());
    _dedupSet.clear();
  }
}

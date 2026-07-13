import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initSqlJs from 'sql.js';
import { SourceIde } from '../storage/conversationRepo';

export interface ExtractedChat {
  ide: SourceIde;
  title: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  timestamp: number;
}

/**
 * Reads AI chat history directly from IDE SQLite workspace databases.
 *
 * Cursor, Windsurf, and VS Code all store their state (including chat history)
 * in SQLite .vscdb files inside the user's AppData/workspaceStorage folder.
 * The tables and keys differ slightly between IDEs.
 *
 * We use sql.js (WASM) to read these files without needing native bindings.
 */
export class LocalFileParser {
  private lastPollTime = Date.now() - 1000 * 60 * 60 * 24 * 7; // Look back 7 days on first run
  private SQL: any = null;

  private async getSql(): Promise<any> {
    if (!this.SQL) {
      this.SQL = await initSqlJs({
        locateFile: (file: string) => path.join(__dirname, file),
      });
    }
    return this.SQL;
  }

  private getAppDataPath(): string {
    if (process.platform === 'win32') {
      return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    } else if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support');
    } else {
      return path.join(os.homedir(), '.config');
    }
  }

  /**
   * Opens a .vscdb SQLite file and extracts AI chat messages from it.
   * These databases have an ItemTable with key-value pairs.
   * Chat data is JSON stored under specific keys.
   */
  private async extractFromVscDb(
    dbPath: string,
    ide: SourceIde
  ): Promise<ExtractedChat[]> {
    const results: ExtractedChat[] = [];
    const SQL = await this.getSql();

    let db: any;
    try {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
    } catch {
      return results; // File locked or unreadable
    }

    try {
      // VS Code / Cursor / Windsurf all use ItemTable for workspace state
      // Chat history keys vary — we search broadly
      const chatKeys = [
        '%chat%',
        '%aichat%',
        '%copilot%',
        '%conversation%',
        '%aiService%',
        '%workbench.panel.chat%',
        '%workbench.panel.aichat%',
      ];

      for (const keyPattern of chatKeys) {
        try {
          const stmt = db.prepare(
            `SELECT key, value FROM ItemTable WHERE key LIKE ? LIMIT 50`
          );
          stmt.bind([keyPattern]);
          while (stmt.step()) {
            const row = stmt.getAsObject();
            const key = row['key'] as string;
            const value = row['value'] as string | Uint8Array;

            // Values can be blobs or strings
            const rawStr = value instanceof Uint8Array
              ? new TextDecoder('utf-8', { fatal: false }).decode(value)
              : String(value ?? '');

            const chats = this.parseVscDbChatValue(rawStr, key, ide, dbPath);
            results.push(...chats);
          }
          stmt.free();
        } catch {
          // Key pattern not found in this DB, skip
        }
      }
    } finally {
      db.close();
    }

    return results;
  }

  /**
   * Parses a raw JSON string from a vscdb ItemTable value into chat messages.
   * Different IDE versions store data in slightly different JSON shapes.
   */
  private parseVscDbChatValue(
    raw: string,
    _key: string,
    ide: SourceIde,
    dbPath: string
  ): ExtractedChat[] {
    if (!raw || raw.length < 20) return [];

    // Try to find any JSON in the string (values are sometimes prefixed with binary headers)
    const jsonStart = raw.indexOf('{');
    const jsonArrStart = raw.indexOf('[');
    const start = jsonStart === -1 ? jsonArrStart
      : jsonArrStart === -1 ? jsonStart
      : Math.min(jsonStart, jsonArrStart);

    if (start === -1) return [];

    let parsed: any;
    try {
      parsed = JSON.parse(raw.slice(start));
    } catch {
      return [];
    }

    const results: ExtractedChat[] = [];
    const stat = fs.statSync(dbPath);

    // Handle array of conversations
    const items = Array.isArray(parsed) ? parsed : [parsed];

    for (const item of items) {
      const messages = this.extractMessagesFromObject(item);
      if (messages.length > 0) {
        const firstUser = messages.find(m => m.role === 'user');
        const title = firstUser
          ? firstUser.content.slice(0, 80).replace(/\n/g, ' ')
          : `Conversation from ${ide}`;

        results.push({
          ide,
          title,
          messages,
          timestamp: stat.mtimeMs,
        });
      }
    }

    return results;
  }

  /**
   * Recursively extracts chat messages from an arbitrary JSON object.
   * Handles the many different schemas used by Cursor, VS Code Copilot, Windsurf, etc.
   */
  private extractMessagesFromObject(
    obj: any
  ): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
    if (!obj || typeof obj !== 'object') return [];

    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];

    // Pattern 1: { messages: [{ role, content }] }  — OpenAI-style
    if (Array.isArray(obj.messages)) {
      for (const m of obj.messages) {
        const role = this.normalizeRole(m?.role ?? m?.speaker ?? '');
        const content = this.extractContent(m);
        if (role && content) {
          messages.push({ role, content });
        }
      }
      if (messages.length > 0) return messages;
    }

    // Pattern 2: { turns: [{ query, response }] }  — Cursor style
    if (Array.isArray(obj.turns)) {
      for (const t of obj.turns) {
        if (t?.query) messages.push({ role: 'user', content: String(t.query) });
        if (t?.response) messages.push({ role: 'assistant', content: String(t.response) });
      }
      if (messages.length > 0) return messages;
    }

    // Pattern 3: { requests: [{ message, response }] }
    if (Array.isArray(obj.requests)) {
      for (const r of obj.requests) {
        const userText = r?.message?.text ?? r?.prompt ?? r?.query ?? '';
        const assistantText = r?.response?.value ?? r?.response ?? r?.answer ?? '';
        if (userText) messages.push({ role: 'user', content: String(userText) });
        if (assistantText) messages.push({ role: 'assistant', content: String(assistantText) });
      }
      if (messages.length > 0) return messages;
    }

    // Pattern 4: { exchanges: [...] } or { history: [...] }
    for (const key of ['exchanges', 'history', 'chatHistory', 'conversation']) {
      if (Array.isArray(obj[key])) {
        for (const item of obj[key]) {
          const nested = this.extractMessagesFromObject(item);
          messages.push(...nested);
        }
        if (messages.length > 0) return messages;
      }
    }

    // Pattern 5: Direct role/content at top level
    const role = this.normalizeRole(obj?.role ?? obj?.speaker ?? '');
    const content = this.extractContent(obj);
    if (role && content) {
      return [{ role, content }];
    }

    return [];
  }

  private normalizeRole(raw: string): 'user' | 'assistant' | 'system' | null {
    const r = String(raw ?? '').toLowerCase().trim();
    if (!r) return null;
    if (r === 'user' || r === 'human' || r === 'you') return 'user';
    if (r === 'assistant' || r === 'ai' || r === 'bot' || r === 'cursor' || r === 'copilot') return 'assistant';
    if (r === 'system') return 'system';
    return null;
  }

  private extractContent(obj: any): string {
    if (!obj) return '';
    // Try various content field names
    for (const key of ['content', 'text', 'value', 'body', 'message', 'markdown']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
    // Nested value object: { value: { value: string } }
    if (obj.value && typeof obj.value === 'object') {
      return this.extractContent(obj.value);
    }
    return '';
  }

  /**
   * Main polling entry point. Scans all IDE workspace storage directories
   * for recently modified .vscdb files and extracts chat history from them.
   */
  public async pollLogs(): Promise<ExtractedChat[]> {
    const results: ExtractedChat[] = [];
    const now = Date.now();

    const ideConfigs: Array<{ ideName: string; ide: SourceIde }> = [
      { ideName: 'Cursor', ide: 'cursor' },
      { ideName: 'Windsurf', ide: 'windsurf' },
      { ideName: 'Code', ide: 'vscode' },         // VS Code on Windows
      { ideName: 'Code - Insiders', ide: 'vscode' },
    ];

    for (const { ideName, ide } of ideConfigs) {
      const wsStoragePath = path.join(
        this.getAppDataPath(),
        ideName,
        'User',
        'workspaceStorage'
      );

      if (!fs.existsSync(wsStoragePath)) continue;

      let workspaces: string[];
      try {
        workspaces = fs.readdirSync(wsStoragePath);
      } catch {
        continue;
      }

      for (const ws of workspaces) {
        const dbPath = path.join(wsStoragePath, ws, 'state.vscdb');
        if (!fs.existsSync(dbPath)) continue;

        let stat: fs.Stats;
        try {
          stat = fs.statSync(dbPath);
        } catch {
          continue;
        }

        // Only re-process files modified since last poll
        if (stat.mtimeMs <= this.lastPollTime) continue;

        try {
          const chats = await this.extractFromVscDb(dbPath, ide);
          results.push(...chats);
        } catch (e) {
          console.warn(`[ChatVault] Failed to parse ${dbPath}:`, e);
        }
      }
    }

    // Also check Antigravity brain logs (the AI assistant used to build this!)
    try {
      const agPath = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
      if (fs.existsSync(agPath)) {
        const conversations = fs.readdirSync(agPath);
        for (const convo of conversations) {
          const logPath = path.join(
            agPath, convo, '.system_generated', 'logs', 'overview.txt'
          );
          if (!fs.existsSync(logPath)) continue;

          const stat = fs.statSync(logPath);
          if (stat.mtimeMs <= this.lastPollTime) continue;

          const raw = fs.readFileSync(logPath, 'utf8');
          const messages = this.parseOverviewTxt(raw);
          if (messages.length > 0) {
            const title = messages.find(m => m.role === 'user')?.content.slice(0, 80) ?? 'Antigravity Session';
            results.push({
              ide: 'unknown',
              title,
              messages,
              timestamp: stat.mtimeMs,
            });
          }
        }
      }
    } catch (e) {
      console.warn('[ChatVault] Failed to poll Antigravity logs:', e);
    }

    this.lastPollTime = now;
    return results;
  }

  /**
   * Parses Antigravity overview.txt log format.
   * Handles both JSON-lines format and legacy line-prefixed format.
   */
  private parseOverviewTxt(
    raw: string
  ): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    const lines = raw.split('\n');

    // Try parsing as JSON lines first
    const jsonMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    let hasJsonLines = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const obj = JSON.parse(trimmed);
          let role: 'user' | 'assistant' | 'system' | null = null;
          if (obj.source === 'USER_EXPLICIT' || obj.source === 'USER' || obj.type === 'USER_INPUT') {
            role = 'user';
          } else if (obj.source === 'MODEL' || obj.type === 'PLANNER_RESPONSE' || obj.type === 'PLANNER_RETRY') {
            role = 'assistant';
          }

          let content = typeof obj.content === 'string' ? obj.content.trim() : '';
          if (role && content) {
            if (role === 'user') {
              const userReqMatch = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
              if (userReqMatch) {
                content = userReqMatch[1].trim();
              }
            }
            if (content) {
              jsonMessages.push({ role, content });
              hasJsonLines = true;
            }
          }
        } catch {
          // Ignore parse errors on individual lines
        }
      }
    }

    if (hasJsonLines && jsonMessages.length > 0) {
      return jsonMessages;
    }

    // Fallback to legacy format parsing
    let current: { role: 'user' | 'assistant' | 'system'; lines: string[] } | null = null;
    for (const line of lines) {
      if (line.startsWith('USER:')) {
        if (current) messages.push({ role: current.role, content: current.lines.join('\n').trim() });
        current = { role: 'user', lines: [line.slice(5).trim()] };
      } else if (line.startsWith('MODEL:') || line.startsWith('ASSISTANT:')) {
        if (current) messages.push({ role: current.role, content: current.lines.join('\n').trim() });
        current = { role: 'assistant', lines: [line.replace(/^(MODEL|ASSISTANT):/, '').trim()] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    if (current) messages.push({ role: current.role, content: current.lines.join('\n').trim() });

    return messages.filter(m => m.content.length > 0);
  }
}

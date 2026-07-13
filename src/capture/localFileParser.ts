import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Intentionally empty or remove import
import { SourceIde } from '../storage/conversationRepo';

export interface ExtractedChat {
  ide: SourceIde;
  content: string;
  timestamp: number;
}

export class LocalFileParser {
  private lastPollTime = Date.now() - 1000 * 60 * 60 * 24; // start by looking back 24h

  private getAppDataPath(): string {
    if (process.platform === 'win32') {
      return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    } else if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support');
    } else {
      return path.join(os.homedir(), '.config');
    }
  }

  public async pollLogs(): Promise<ExtractedChat[]> {
    const results: ExtractedChat[] = [];
    const now = Date.now();

    // 1. Cursor
    try {
      const cursorPath = path.join(this.getAppDataPath(), 'Cursor', 'User', 'workspaceStorage');
      if (fs.existsSync(cursorPath)) {
        const workspaces = fs.readdirSync(cursorPath);
        for (const ws of workspaces) {
          const dbPath = path.join(cursorPath, ws, 'state.vscdb');
          if (fs.existsSync(dbPath)) {
            const stat = fs.statSync(dbPath);
            if (stat.mtimeMs > this.lastPollTime) {
              const content = fs.readFileSync(dbPath, 'utf8');
              const extracted = this.extractTextBlocks(content);
              for (const text of extracted) {
                // If it looks like a conversation and has chatdata
                if (text.includes('workbench.panel.aichat') || (text.includes('User:') && text.includes('AI:'))) {
                  results.push({ ide: 'cursor', content: text, timestamp: stat.mtimeMs });
                }
              }
            }
          }
        }
      }
    } catch(e) {
      console.warn('[ChatVault] Failed to poll Cursor logs:', e);
    }

    // 2. Windsurf
    try {
      const windsurfPath = path.join(this.getAppDataPath(), 'Windsurf', 'User', 'workspaceStorage');
      if (fs.existsSync(windsurfPath)) {
        const workspaces = fs.readdirSync(windsurfPath);
        for (const ws of workspaces) {
          const dbPath = path.join(windsurfPath, ws, 'state.vscdb');
          if (fs.existsSync(dbPath)) {
            const stat = fs.statSync(dbPath);
            if (stat.mtimeMs > this.lastPollTime) {
              const content = fs.readFileSync(dbPath, 'utf8');
              const extracted = this.extractTextBlocks(content);
              for (const text of extracted) {
                if (text.includes('User:') && text.includes('AI:')) {
                  results.push({ ide: 'windsurf', content: text, timestamp: stat.mtimeMs });
                }
              }
            }
          }
        }
      }
    } catch(e) {
      console.warn('[ChatVault] Failed to poll Windsurf logs:', e);
    }

    // 3. Antigravity
    try {
      const agPath = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
      if (fs.existsSync(agPath)) {
        const conversations = fs.readdirSync(agPath);
        for (const convo of conversations) {
          const logPath = path.join(agPath, convo, '.system_generated', 'logs', 'overview.txt');
          if (fs.existsSync(logPath)) {
            const stat = fs.statSync(logPath);
            if (stat.mtimeMs > this.lastPollTime) {
              const content = fs.readFileSync(logPath, 'utf8');
              // Transform Antigravity's "USER:" and "MODEL:" into something our parser recognizes
              const normalized = content.replace(/USER:/g, 'User:').replace(/MODEL:/g, 'AI:');
              results.push({ ide: 'unknown', content: normalized, timestamp: stat.mtimeMs }); // 'unknown' will be treated as Antigravity internally or we can just map it to something
            }
          }
        }
      }
    } catch(e) {
      console.warn('[ChatVault] Failed to poll Antigravity logs:', e);
    }

    this.lastPollTime = now;
    return results;
  }

  private extractTextBlocks(bufferStr: string): string[] {
    const regex = /[\x20-\x7E]{50,}/g;
    const matches = bufferStr.match(regex);
    return matches || [];
  }
}

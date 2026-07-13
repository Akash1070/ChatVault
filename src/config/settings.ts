/**
 * src/config/settings.ts — Module 6
 *
 * Typed settings wrapper around vscode.workspace.getConfiguration('chatVault').
 *
 * Design:
 * - All VS Code config access is funnelled through the Settings class.
 * - Settings class fires typed EventEmitter events on change.
 * - Validation runs on construction and on every change event.
 * - Invalid settings surface as VS Code warning messages, never silent failures.
 * - Implements Disposable so the change listener is cleaned up on deactivate.
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export type SearchStrategy = 'auto' | 'fuse' | 'fts5';
export type ViewerMode = 'split' | 'replace';

export interface SettingsSnapshot {
  storagePath: string;
  autoCapture: boolean;
  searchStrategy: SearchStrategy;
  searchIndexThreshold: number;
  cloudSyncEnabled: boolean;
  cloudSyncSupabaseUrl: string;
  cloudSyncSupabaseAnonKey: string;
  uiViewerMode: ViewerMode;
  licenceKey: string;
  defaultExportFormat: 'json' | 'md' | 'txt';
  maxConversationsShown: number;
}

export interface SettingsChangedEvent {
  previous: SettingsSnapshot;
  current: SettingsSnapshot;
  affectedKeys: (keyof SettingsSnapshot)[];
}

const SECTION = 'chatVault';

export class Settings implements vscode.Disposable {
  private _current: SettingsSnapshot;

  private readonly _onChanged = new vscode.EventEmitter<SettingsChangedEvent>();
  /** Fires when any setting changes, with before/after snapshots. */
  public readonly onChanged = this._onChanged.event;

  private readonly _configListener: vscode.Disposable;

  constructor() {
    this._current = this._read();
    this._validate(this._current);

    this._configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SECTION)) {
        const previous = this._current;
        this._current = this._read();
        this._validate(this._current);

        const affectedKeys = this._diff(previous, this._current);
        this._onChanged.fire({ previous, current: this._current, affectedKeys });
      }
    });
  }

  // ─── Typed getters ───────────────────────────────────────────────────────────

  get storagePath(): string { return this._current.storagePath; }
  get autoCapture(): boolean { return this._current.autoCapture; }
  get searchStrategy(): SearchStrategy { return this._current.searchStrategy; }
  get searchIndexThreshold(): number { return this._current.searchIndexThreshold; }
  get cloudSyncEnabled(): boolean { return this._current.cloudSyncEnabled; }
  get cloudSyncSupabaseUrl(): string { return this._current.cloudSyncSupabaseUrl; }
  get cloudSyncSupabaseAnonKey(): string { return this._current.cloudSyncSupabaseAnonKey; }
  get uiViewerMode(): ViewerMode { return this._current.uiViewerMode; }
  get licenceKey(): string { return this._current.licenceKey; }
  get defaultExportFormat(): 'json' | 'md' | 'txt' { return this._current.defaultExportFormat; }
  get maxConversationsShown(): number { return this._current.maxConversationsShown; }

  /** Returns a point-in-time snapshot of all settings. */
  public snapshot(): SettingsSnapshot { return { ...this._current }; }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private _read(): SettingsSnapshot {
    const cfg = vscode.workspace.getConfiguration(SECTION);

    const rawPath = cfg.get<string>('storagePath', '').trim();
    const storagePath = rawPath || path.join(os.homedir(), '.ai-vault', 'vault.db');

    const rawSearchStrategy = cfg.get<string>('searchStrategy', 'auto');
    const searchStrategy = (['auto', 'fuse', 'fts5'] as const).includes(
      rawSearchStrategy as SearchStrategy
    )
      ? (rawSearchStrategy as SearchStrategy)
      : 'auto';

    const rawViewerMode = cfg.get<string>('ui.viewerMode', 'replace');
    const uiViewerMode = (['split', 'replace'] as const).includes(rawViewerMode as ViewerMode)
      ? (rawViewerMode as ViewerMode)
      : 'replace';

    const rawExportFormat = cfg.get<string>('defaultExportFormat', 'md');
    const defaultExportFormat = (['json', 'md', 'txt'] as const).includes(
      rawExportFormat as 'json' | 'md' | 'txt'
    )
      ? (rawExportFormat as 'json' | 'md' | 'txt')
      : 'md';

    return {
      storagePath,
      autoCapture: cfg.get<boolean>('autoCapture', true),
      searchStrategy,
      searchIndexThreshold: Math.max(50, cfg.get<number>('searchIndexThreshold', 500)),
      cloudSyncEnabled: cfg.get<boolean>('cloudSync.enabled', false),
      cloudSyncSupabaseUrl: cfg.get<string>('cloudSync.supabaseUrl', '').trim(),
      cloudSyncSupabaseAnonKey: cfg.get<string>('cloudSync.supabaseAnonKey', '').trim(),
      uiViewerMode,
      licenceKey: cfg.get<string>('licence.key', '').trim(),
      defaultExportFormat,
      maxConversationsShown: Math.max(10, Math.min(1000, cfg.get<number>('maxConversationsShown', 100))),
    };
  }

  private _validate(snap: SettingsSnapshot): void {
    // Validate Supabase URL if cloud sync is enabled
    if (snap.cloudSyncEnabled) {
      if (!snap.cloudSyncSupabaseUrl) {
        vscode.window.showWarningMessage(
          'ChatVault: Cloud sync is enabled but chatVault.cloudSync.supabaseUrl is not set. ' +
          'Sync will not work until a valid URL is provided.'
        );
      } else {
        try {
          const url = new URL(snap.cloudSyncSupabaseUrl);
          if (!['https:', 'http:'].includes(url.protocol)) {
            throw new Error('Not https');
          }
        } catch {
          vscode.window.showWarningMessage(
            `ChatVault: chatVault.cloudSync.supabaseUrl "${snap.cloudSyncSupabaseUrl}" is not a valid URL.`
          );
        }
      }

      if (!snap.cloudSyncSupabaseAnonKey) {
        vscode.window.showWarningMessage(
          'ChatVault: Cloud sync is enabled but chatVault.cloudSync.supabaseAnonKey is not set.'
        );
      }
    }
  }

  private _diff(prev: SettingsSnapshot, curr: SettingsSnapshot): (keyof SettingsSnapshot)[] {
    return (Object.keys(curr) as (keyof SettingsSnapshot)[]).filter(
      (k) => prev[k] !== curr[k]
    );
  }

  public dispose(): void {
    this._configListener.dispose();
    this._onChanged.dispose();
  }
}

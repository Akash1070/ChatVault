/**
 * src/search/searchEngine.ts — Module 5
 *
 * Two-tier search engine with automatic strategy selection:
 *
 * Strategy AUTO (default):
 *   ≤ 500 conversations → Fuse.js (in-memory, fuzzy, instant)
 *   > 500 conversations → SQLite FTS5 (disk-based, scalable, ranked)
 *   Threshold configurable via aiVault.searchIndexThreshold setting.
 *
 * Result ranking:
 *   Base: Fuse.js score (0 = perfect) or FTS5 bm25 rank
 *   Starred conversations: 1.5× score boost
 *   Recent (last 7 days): 1.2× score boost
 *
 * Singleton: SearchEngine.getInstance() returns the shared instance.
 * Call buildIndex() after activate, invalidate(id) after each write.
 */

import Fuse, { IFuseOptions, FuseResult } from 'fuse.js';
import {
  listConversations,
  searchConversations as ftsSearch,
  ConversationSummary,
  ConversationFilters,
} from '../storage/conversationRepo';
import { Settings } from '../config/settings';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type SearchStrategy = 'auto' | 'fuse' | 'fts5';

export interface SearchResultItem extends ConversationSummary {
  /** Normalised relevance score: 0.0 = perfect match, 1.0 = no match. */
  score: number;
  /** The strategy that produced this result. */
  source: 'fts5' | 'fuzzy';
}

export interface SearchOptions {
  query: string;
  filters?: ConversationFilters;
  limit?: number;
}

// ─── Fuse.js index configuration ───────────────────────────────────────────────

const FUSE_OPTIONS: IFuseOptions<ConversationSummary> = {
  keys: [
    { name: 'title',   weight: 0.55 },
    { name: 'preview', weight: 0.25 },
    { name: 'tags',    weight: 0.20 },
  ],
  threshold: 0.38,          // 0 = exact, 1 = anything
  includeScore: true,
  includeMatches: true,
  minMatchCharLength: 2,
  shouldSort: true,
  findAllMatches: false,
  ignoreLocation: true,     // Match anywhere in the string, not just the start
  useExtendedSearch: false,
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Ranking helpers ────────────────────────────────────────────────────────────

function applyBoosts(item: ConversationSummary, baseScore: number): number {
  let score = baseScore;
  // Starred boost: multiply the "goodness" (1 - score) by 1.5
  if (item.is_starred) {
    score = 1 - (1 - score) * 1.5;
    score = Math.max(0, score);
  }
  // Recency boost
  const age = Date.now() - new Date(item.updated_at).getTime();
  if (age < SEVEN_DAYS_MS) {
    score = 1 - (1 - score) * 1.2;
    score = Math.max(0, score);
  }
  return score;
}

// ─── SearchEngine singleton ─────────────────────────────────────────────────────

export class SearchEngine {
  private static _instance: SearchEngine | null = null;

  private _fuse: Fuse<ConversationSummary> | null = null;
  private _indexedItems: ConversationSummary[] = [];
  private _indexedAt: number = 0;
  private readonly _settings: Settings;

  private constructor(settings: Settings) {
    this._settings = settings;
  }

  /** Returns the singleton instance. Must call buildIndex() before first search. */
  public static getInstance(settings: Settings): SearchEngine {
    if (!SearchEngine._instance) {
      SearchEngine._instance = new SearchEngine(settings);
    }
    return SearchEngine._instance;
  }

  // ── Index management ────────────────────────────────────────────────────────

  /**
   * Builds (or rebuilds) the Fuse.js in-memory index.
   * Loads up to 2000 conversations from SQLite to keep memory bounded.
   * Called once on activate, and after any conversation write if using 'fuse' strategy.
   */
  public buildIndex(): void {
    const items = listConversations({ limit: 2000 });
    this._indexedItems = items;
    this._fuse = new Fuse(items, FUSE_OPTIONS);
    this._indexedAt = Date.now();
    console.log(`[ChatVault Search] Index built: ${items.length} conversations`);
  }

  /**
   * Invalidates a single conversation in the index after it is created/updated/deleted.
   * For Fuse.js: rebuilds the full index (in-memory, fast for ≤500 items).
   * For FTS5: no-op (SQLite triggers keep the FTS index in sync automatically).
   */
  public invalidate(_conversationId: string): void {
    const strategy = this._resolveStrategy();
    if (strategy === 'fuse') {
      // Rebuild is cheap for small vaults
      this.buildIndex();
    }
    // FTS5: SQLite triggers handle index updates automatically
  }

  /**
   * Completely destroys the index and clears the singleton.
   * Call from extension deactivate().
   */
  public destroy(): void {
    this._fuse = null;
    this._indexedItems = [];
    SearchEngine._instance = null;
    console.log('[ChatVault Search] Index destroyed');
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  /**
   * Runs a search using the auto-selected strategy.
   *
   * Empty query → returns recent conversations (up to limit), sorted by updated_at.
   * Non-empty query → full-text + fuzzy search with ranking boosts applied.
   *
   * Structured filters are applied after the search:
   *   - tags: intersection (conversation must have ALL specified tags)
   *   - project_path, source_ide, is_starred, date_from, date_to: exact match / range
   *
   * @param options.query - The search string (empty = return recent)
   * @param options.filters - Optional structured filters to combine with text search
   * @param options.limit - Max results to return (default: 30)
   */
  public search(options: SearchOptions): SearchResultItem[] {
    const { query, filters = {}, limit = 30 } = options;
    const trimmed = query.trim();

    if (!trimmed) {
      return this._recentConversations(filters, limit);
    }

    const strategy = this._resolveStrategy();
    const results = strategy === 'fts5'
      ? this._searchFts5(trimmed, limit * 2) // Fetch extra, filter will reduce
      : this._searchFuse(trimmed, limit * 2);

    return this._applyFilters(results, filters).slice(0, limit);
  }

  // ── Strategy resolution ─────────────────────────────────────────────────────

  private _resolveStrategy(): 'fuse' | 'fts5' {
    const setting = this._settings.searchStrategy;
    if (setting === 'fuse') { return 'fuse'; }
    if (setting === 'fts5') { return 'fts5'; }
    // 'auto': choose based on vault size
    return this._indexedItems.length > this._settings.searchIndexThreshold
      ? 'fts5'
      : 'fuse';
  }

  // ── Fuse.js search ──────────────────────────────────────────────────────────

  private _searchFuse(query: string, limit: number): SearchResultItem[] {
    if (!this._fuse) {
      this.buildIndex();
    }

    const raw: FuseResult<ConversationSummary>[] = this._fuse!.search(query, { limit });

    return raw.map((r): SearchResultItem => {
      const baseScore = r.score ?? 0.5;
      return {
        ...r.item,
        score: applyBoosts(r.item, baseScore),
        source: 'fuzzy',
      };
    }).sort((a, b) => a.score - b.score); // Lower score = better
  }

  // ── FTS5 search ─────────────────────────────────────────────────────────────

  private _searchFts5(query: string, limit: number): SearchResultItem[] {
    // Remove characters that have special meaning in FTS5 MATCH syntax (e.g. quotes, asterisks, brackets)
    // to prevent syntax errors and potential memory exhaustion.
    const safeQuery = query
      .replace(/["^*:()\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!safeQuery) {
      return [];
    }

    let results: ConversationSummary[] = [];

    try {
      results = ftsSearch(safeQuery, limit);
    } catch {
      // FTS5 MATCH can fail on malformed queries (unmatched quotes, etc.)
      // Silently fall back to Fuse.js
      console.warn('[ChatVault Search] FTS5 failed, falling back to Fuse.js');
      return this._searchFuse(query, limit);
    }

    return results.map((item, index): SearchResultItem => {
      // FTS5 returns results in bm25 rank order. Convert rank-position to [0, 1] score.
      const positionScore = index / Math.max(results.length, 1);
      return {
        ...item,
        score: applyBoosts(item, positionScore),
        source: 'fts5',
      };
    });
  }

  // ── Recent conversations (empty query) ──────────────────────────────────────

  private _recentConversations(
    filters: ConversationFilters,
    limit: number
  ): SearchResultItem[] {
    const items = listConversations({ ...filters, limit });
    return items.map((item): SearchResultItem => ({
      ...item,
      score: applyBoosts(item, 0.5),
      source: 'fts5',
    }));
  }

  // ── Post-search filter application ─────────────────────────────────────────

  private _applyFilters(
    results: SearchResultItem[],
    filters: ConversationFilters
  ): SearchResultItem[] {
    return results.filter((item) => {
      if (filters.project_path && item.project_path !== filters.project_path) {
        return false;
      }
      if (filters.source_ide && item.source_ide !== filters.source_ide) {
        return false;
      }
      if (filters.is_starred !== undefined && item.is_starred !== filters.is_starred) {
        return false;
      }
      if (filters.date_from && item.created_at < filters.date_from) {
        return false;
      }
      if (filters.date_to && item.created_at > filters.date_to) {
        return false;
      }
      if (filters.tags && filters.tags.length > 0) {
        if (!filters.tags.every((tag) => item.tags.includes(tag))) {
          return false;
        }
      }
      return true;
    });
  }

  /** Returns index metadata for debugging / status bar display. */
  public getStatus(): { strategy: string; indexSize: number; indexAge: number } {
    return {
      strategy: this._resolveStrategy(),
      indexSize: this._indexedItems.length,
      indexAge: this._indexedAt ? Date.now() - this._indexedAt : -1,
    };
  }
}

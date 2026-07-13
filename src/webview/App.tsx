/**
 * src/webview/App.tsx
 *
 * Root React component for the AI Conversation Vault webview sidebar.
 *
 * State management: local React state with useReducer.
 * We do NOT use Redux or Zustand — the webview is a simple
 * master/detail UI that does not need a complex state machine.
 * All server state (conversations, messages) is fetched via postMessage
 * and stored in local component state.
 *
 * Panels:
 *   LIST view  — search bar, filter tabs, conversation list
 *   VIEWER view — full conversation with messages, notes, export actions
 */

import React, { useEffect, useReducer, useCallback, useRef } from 'react';
import { ConversationList } from './components/ConversationList';
import { ConversationViewer } from './components/ConversationViewer';
import { SearchBar } from './components/SearchBar';
import { EmptyState } from './components/EmptyState';
import {
  sendMessage,
  onMessage,
  getPersistedState,
  persistState,
} from './webview';
import type { ConversationSummary, Conversation, Message } from './types';

// ─── State ────────────────────────────────────────────────────────────────────

type ActiveFilter = 'all' | 'starred' | 'project';
type ViewMode = 'list' | 'viewer';

interface AppState {
  viewMode: ViewMode;
  conversations: ConversationSummary[];
  selectedConversation: Conversation | null;
  messages: Message[];
  searchQuery: string;
  activeFilter: ActiveFilter;
  isLoading: boolean;
  error: string | null;
  planLabel: string;
  isPro: boolean;
  stats: { total: number; starred: number } | null;
}

type AppAction =
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'CONVERSATIONS_LOADED'; payload: ConversationSummary[] }
  | { type: 'NEW_CONVERSATION'; payload: ConversationSummary }
  | { type: 'CONVERSATION_SELECTED'; payload: { conversation: Conversation; messages: Message[] } }
  | { type: 'CONVERSATION_UPDATED'; payload: Conversation }
  | { type: 'CONVERSATION_DELETED'; payload: string }
  | { type: 'SET_SEARCH_QUERY'; payload: string }
  | { type: 'SET_FILTER'; payload: ActiveFilter }
  | { type: 'GO_BACK' }
  | { type: 'SET_PLAN'; payload: { isPro: boolean; label: string } }
  | { type: 'SET_STATS'; payload: { total: number; starred: number } };

const initialState: AppState = {
  viewMode: 'list',
  conversations: [],
  selectedConversation: null,
  messages: [],
  searchQuery: getPersistedState().searchQuery,
  activeFilter: getPersistedState().activeFilter,
  isLoading: true,
  error: null,
  planLabel: '🔒 Free',
  isPro: true,
  stats: null,
};

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };

    case 'SET_ERROR':
      return { ...state, error: action.payload, isLoading: false };

    case 'CONVERSATIONS_LOADED':
      return {
        ...state,
        conversations: action.payload,
        isLoading: false,
        error: null,
      };

    case 'NEW_CONVERSATION':
      // Ensure we don't add duplicates based on ID
      if (state.conversations.find((c) => c.id === action.payload.id)) {
        return state;
      }
      return {
        ...state,
        conversations: [action.payload, ...state.conversations],
      };

    case 'CONVERSATION_SELECTED':
      return {
        ...state,
        viewMode: 'viewer',
        selectedConversation: action.payload.conversation,
        messages: action.payload.messages,
        isLoading: false,
      };

    case 'CONVERSATION_UPDATED': {
      const updated = action.payload;
      return {
        ...state,
        selectedConversation:
          state.selectedConversation?.id === updated.id ? updated : state.selectedConversation,
        conversations: state.conversations.map((c) =>
          c.id === updated.id
            ? {
                ...c,
                title: updated.title,
                tags: updated.tags,
                is_starred: updated.is_starred,
                notes: updated.notes,
                updated_at: updated.updated_at,
              }
            : c
        ),
      };
    }

    case 'CONVERSATION_DELETED':
      return {
        ...state,
        viewMode: 'list',
        selectedConversation: null,
        messages: [],
        conversations: state.conversations.filter((c) => c.id !== action.payload),
      };

    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload };

    case 'SET_FILTER':
      return { ...state, activeFilter: action.payload };

    case 'GO_BACK':
      return {
        ...state,
        viewMode: 'list',
        selectedConversation: null,
        messages: [],
      };

    case 'SET_PLAN':
      return { ...state, planLabel: action.payload.label, isPro: action.payload.isPro };

    case 'SET_STATS':
      return { ...state, stats: action.payload };

    default:
      return state;
  }
}

// ─── Root component ───────────────────────────────────────────────────────────

export default function App(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Wire up message handlers from extension host ─────────────────────────
  useEffect(() => {
    const unsubs = [
      onMessage<ConversationSummary[]>('CONVERSATIONS_LOADED', (payload) => {
        dispatch({ type: 'CONVERSATIONS_LOADED', payload });
      }),

      onMessage<ConversationSummary>('NEW_CONVERSATION', (payload) => {
        dispatch({ type: 'NEW_CONVERSATION', payload });
      }),

      onMessage<{ conversation: Conversation; messages: Message[] }>(
        'CONVERSATION_SELECTED',
        (payload) => {
          dispatch({ type: 'CONVERSATION_SELECTED', payload });
        }
      ),

      onMessage<ConversationSummary[]>('SEARCH_RESULTS', (payload) => {
        dispatch({ type: 'CONVERSATIONS_LOADED', payload });
      }),

      onMessage<Conversation>('CONVERSATION_UPDATED', (payload) => {
        dispatch({ type: 'CONVERSATION_UPDATED', payload });
      }),

      onMessage<string>('CONVERSATION_DELETED', (id) => {
        dispatch({ type: 'CONVERSATION_DELETED', payload: id });
      }),

      onMessage<{ isPro: boolean; label: string }>('PLAN_STATUS', (payload) => {
        dispatch({ type: 'SET_PLAN', payload });
      }),

      onMessage<{ total: number; starred: number }>('STATS_LOADED', (stats) => {
        dispatch({ type: 'SET_STATS', payload: stats });
      }),

      onMessage<string>('ERROR', (msg) => {
        dispatch({ type: 'SET_ERROR', payload: msg });
      }),
    ];

    // Initial data load
    sendMessage('LOAD_CONVERSATIONS', { limit: 100 });
    sendMessage('LOAD_PLAN_STATUS', null);
    sendMessage('LOAD_STATS', null);

    return () => unsubs.forEach((fn) => fn());
  }, []);

  // ── Debounced search ─────────────────────────────────────────────────────
  const handleSearchChange = useCallback((query: string) => {
    dispatch({ type: 'SET_SEARCH_QUERY', payload: query });
    persistState({ searchQuery: query });

    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }

    searchTimerRef.current = setTimeout(() => {
      if (query.trim()) {
        sendMessage('SEARCH', { query });
      } else {
        sendMessage('LOAD_CONVERSATIONS', { limit: 100, filter: state.activeFilter });
      }
    }, 300);
  }, [state.activeFilter]);

  // ── Filter change ────────────────────────────────────────────────────────
  const handleFilterChange = useCallback((filter: ActiveFilter) => {
    dispatch({ type: 'SET_FILTER', payload: filter });
    persistState({ activeFilter: filter });
    sendMessage('LOAD_CONVERSATIONS', { limit: 100, filter });
  }, []);

  // ── Select conversation ──────────────────────────────────────────────────
  const handleSelectConversation = useCallback((id: string) => {
    dispatch({ type: 'SET_LOADING', payload: true });
    persistState({ selectedConversationId: id });
    sendMessage('SELECT_CONVERSATION', { id });
  }, []);

  // ── Back to list ─────────────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    dispatch({ type: 'GO_BACK' });
    persistState({ selectedConversationId: null });
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="cv-root">
      {/* Header — always visible */}
      <header className="cv-header">
        <div className="cv-logo">
          <span className="cv-logo-icon">🔐</span>
          <span className="cv-logo-title">ChatVault</span>
          <span className="cv-logo-badge">MVP</span>
        </div>
        <SearchBar
          value={state.searchQuery}
          onChange={handleSearchChange}
          placeholder="Search conversations…"
        />
      </header>

      {/* Filter tabs — only shown in list mode */}
      {state.viewMode === 'list' && (
        <nav className="cv-filters">
          {(['all', 'starred', 'project'] as const).map((f) => (
            <button
              key={f}
              className={`cv-filter-tab${state.activeFilter === f ? ' active' : ''}`}
              onClick={() => handleFilterChange(f)}
            >
              {f === 'all' && '📋 All'}
              {f === 'starred' && '⭐ Starred'}
              {f === 'project' && '📁 Project'}
            </button>
          ))}
        </nav>
      )}

      {/* Main content */}
      <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {state.viewMode === 'list' ? (
          <>
            {state.isLoading ? (
              <div className="cv-spinner" />
            ) : state.error ? (
              <div className="cv-error">
                <div className="cv-error-icon">⚠️</div>
                <div className="cv-error-text">{state.error}</div>
              </div>
            ) : state.conversations.length === 0 ? (
              <EmptyState
                hasSearch={state.searchQuery.length > 0}
                onSaveClick={() => sendMessage('CREATE_CONVERSATION', null)}
              />
            ) : (
              <div className="cv-list-wrap">
                <ConversationList
                  conversations={state.conversations}
                  onSelect={handleSelectConversation}
                  selectedId={state.selectedConversation?.id ?? null}
                />
              </div>
            )}
          </>
        ) : (
          state.selectedConversation && (
            <ConversationViewer
              conversation={state.selectedConversation}
              messages={state.messages}
              isLoading={state.isLoading}
              onBack={handleBack}
              onUpdate={(patch) => {
                sendMessage('UPDATE_CONVERSATION', {
                  id: state.selectedConversation!.id,
                  patch,
                });
              }}
              onDelete={(hard) => {
                sendMessage(
                  hard ? 'HARD_DELETE_CONVERSATION' : 'DELETE_CONVERSATION',
                  { id: state.selectedConversation!.id }
                );
              }}
              onExport={(format) => {
                sendMessage('EXPORT_CONVERSATION', {
                  id: state.selectedConversation!.id,
                  format,
                });
              }}
            />
          )
        )}
      </main>

      {/* Status bar */}
      <footer className="cv-status-bar">
        <span className="cv-status-text">
          {state.stats
            ? `${state.stats.total} conversations`
            : 'Loading…'}
        </span>
        <span
          className="cv-status-plan"
          onClick={() => sendMessage('OPEN_SETTINGS', null)}
          title="Click to open settings"
        >
          {state.planLabel}
        </span>
      </footer>

      {!state.isPro && (
        <div className="cv-paywall-overlay">
          <div className="cv-paywall-card">
            <div className="cv-paywall-icon">🔐</div>
            <h2>Upgrade to ChatVault Pro</h2>
            <p>Your 30-day Free Trial has expired.</p>
            <div className="cv-paywall-desc">
              Subscribe to ChatVault Pro for <strong>$10/month</strong> to continue saving and searching your AI conversation history.
            </div>
            <button
              className="cv-paywall-btn-primary"
              onClick={() => sendMessage('OPEN_UPGRADE_URL', null)}
            >
              Upgrade to Pro 🚀
            </button>
            <button
              className="cv-paywall-btn-secondary"
              onClick={() => sendMessage('OPEN_SETTINGS', null)}
            >
              Enter Licence Key
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

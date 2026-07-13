/**
 * src/webview/components/ConversationViewer.tsx
 *
 * Full conversation detail view. Shows all messages with role styling,
 * inline notes editing, export button group, and star/delete actions.
 *
 * This component is purely presentational — all state mutations go through
 * the callback props which send postMessages to the extension host.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { Conversation, Message } from '../types';

type ExportFormat = 'json' | 'md' | 'txt';

interface ConversationViewerProps {
  conversation: Conversation;
  messages: Message[];
  isLoading: boolean;
  onBack: () => void;
  onUpdate: (patch: Partial<Conversation>) => void;
  onDelete: (hard: boolean) => void;
  onExport: (format: ExportFormat) => void;
}

export function ConversationViewer({
  conversation,
  messages,
  isLoading,
  onBack,
  onUpdate,
  onDelete,
  onExport,
}: ConversationViewerProps): JSX.Element {
  const [notes, setNotes] = useState(conversation.notes ?? '');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(conversation.title);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Sync notes + title when a different conversation is selected
  useEffect(() => {
    setNotes(conversation.notes ?? '');
    setTitleDraft(conversation.title);
    setIsEditingTitle(false);
  }, [conversation.id]);

  // Focus title input when editing starts
  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.select();
    }
  }, [isEditingTitle]);

  // Debounced notes save — saves 800ms after the user stops typing
  const handleNotesChange = useCallback(
    (value: string) => {
      setNotes(value);
      if (notesTimerRef.current) {
        clearTimeout(notesTimerRef.current);
      }
      notesTimerRef.current = setTimeout(() => {
        onUpdate({ notes: value });
      }, 800);
    },
    [onUpdate]
  );

  const handleTitleSave = useCallback(() => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== conversation.title) {
      onUpdate({ title: trimmed });
    } else {
      setTitleDraft(conversation.title);
    }
    setIsEditingTitle(false);
  }, [titleDraft, conversation.title, onUpdate]);

  const handleStarToggle = useCallback(() => {
    onUpdate({ is_starred: !conversation.is_starred });
  }, [conversation.is_starred, onUpdate]);

  const handleDelete = useCallback(() => {
    // Soft delete — user can restore from settings
    onDelete(false);
  }, [onDelete]);

  return (
    <div className="cv-viewer">
      {/* ── Header ── */}
      <header className="cv-viewer-header">
        <button className="cv-btn-back" onClick={onBack} title="Back to list">
          ← Back
        </button>

        {isEditingTitle ? (
          <input
            ref={titleInputRef}
            className="cv-search-input"
            style={{ flex: 1, fontSize: '13px', fontWeight: 600 }}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { handleTitleSave(); }
              if (e.key === 'Escape') {
                setTitleDraft(conversation.title);
                setIsEditingTitle(false);
              }
            }}
          />
        ) : (
          <h1
            className="cv-viewer-title"
            title="Click to edit title"
            onClick={() => setIsEditingTitle(true)}
            style={{ cursor: 'text' }}
          >
            {conversation.title}
          </h1>
        )}

        <div className="cv-viewer-actions">
          {/* Star */}
          <button
            className={`cv-icon-btn${conversation.is_starred ? ' starred' : ''}`}
            onClick={handleStarToggle}
            title={conversation.is_starred ? 'Unstar' : 'Star'}
          >
            {conversation.is_starred ? '★' : '☆'}
          </button>

          {/* Export dropdown */}
          <div style={{ position: 'relative' }}>
            <button
              className="cv-icon-btn"
              onClick={() => setShowExportMenu((prev) => !prev)}
              title="Export conversation"
            >
              ↗
            </button>
            {showExportMenu && (
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '30px',
                  background: 'var(--cv-surface)',
                  border: '1px solid var(--cv-border)',
                  borderRadius: 'var(--r-md)',
                  padding: '4px',
                  zIndex: 100,
                  minWidth: '120px',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                }}
              >
                {(['md', 'json', 'txt'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    className="cv-filter-tab"
                    style={{ width: '100%', justifyContent: 'flex-start', borderRadius: 'var(--r-sm)' }}
                    onClick={() => {
                      onExport(fmt);
                      setShowExportMenu(false);
                    }}
                  >
                    {fmt === 'md' && '📝 Markdown'}
                    {fmt === 'json' && '{ } JSON'}
                    {fmt === 'txt' && '📄 Plain text'}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Delete */}
          <button
            className="cv-icon-btn danger"
            onClick={handleDelete}
            title="Delete conversation"
          >
            🗑
          </button>
        </div>
      </header>

      {/* ── Meta row ── */}
      <div className="cv-viewer-meta">
        <span className="cv-viewer-date">
          {new Date(conversation.created_at).toLocaleString()}
        </span>
        <span className="cv-ide-badge">{conversation.source_ide}</span>
        {conversation.project_path && (
          <span className="cv-tag" style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            📁 {conversation.project_path.split('/').pop() ?? conversation.project_path}
          </span>
        )}
        {conversation.tags.map((tag) => (
          <span key={tag} className="cv-tag">{tag}</span>
        ))}
      </div>

      {/* ── Messages ── */}
      <div className="cv-viewer-messages cv-viewer-content">
        {isLoading ? (
          <div className="cv-spinner" />
        ) : messages.length === 0 ? (
          <div className="cv-empty" style={{ height: 'auto', paddingTop: '40px' }}>
            <div className="cv-empty-icon" style={{ fontSize: '24px' }}>💬</div>
            <div className="cv-empty-subtitle">No messages in this conversation.</div>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))
        )}
      </div>

      {/* ── Notes panel ── */}
      <div className="cv-notes-panel">
        <div className="cv-notes-label">📌 Notes</div>
        <textarea
          className="cv-notes-textarea"
          value={notes}
          onChange={(e) => handleNotesChange(e.target.value)}
          placeholder="Add personal notes or annotations about this conversation…"
          rows={3}
        />
      </div>
    </div>
  );
}

// ── Message bubble sub-component ──────────────────────────────────────────────

interface MessageBubbleProps {
  message: Message;
}

function MessageBubble({ message }: MessageBubbleProps): JSX.Element {
  const roleLabel =
    message.role === 'user'
      ? '👤 You'
      : message.role === 'assistant'
      ? '🤖 AI'
      : '⚙️ System';

  const time = new Date(message.created_at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`cv-message ${message.role}`}>
      <div className={`cv-message-role ${message.role}`}>
        <span>{roleLabel}</span>
        <span className="cv-message-role-time">{time}</span>
      </div>
      <div className="cv-message-content">{message.content}</div>
      {message.token_count !== null && (
        <div className="cv-message-token-count">
          {message.token_count.toLocaleString()} tokens
        </div>
      )}
    </div>
  );
}

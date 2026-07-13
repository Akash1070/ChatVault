/**
 * src/webview/components/ConversationList.tsx
 *
 * Renders the list of ConversationSummary items in the sidebar.
 * Each item shows: title, preview snippet, tags, IDE badge, date, message count.
 * Uses CSS classes from styles.css — no inline styles except unavoidable dynamic values.
 */

import React, { memo } from 'react';
import type { ConversationSummary } from '../types';

interface ConversationListProps {
  conversations: ConversationSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
}: ConversationListProps): JSX.Element {
  return (
    <>
      {conversations.map((conv) => (
        <ConversationListItem
          key={conv.id}
          conversation={conv}
          isSelected={conv.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

interface ConversationListItemProps {
  conversation: ConversationSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

const ConversationListItem = memo(function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
}: ConversationListItemProps): JSX.Element {
  const relativeDate = formatRelativeDate(conversation.updated_at);

  return (
    <div
      className={`cv-list-item${isSelected ? ' selected' : ''}`}
      onClick={() => onSelect(conversation.id)}
      role="button"
      tabIndex={0}
      aria-selected={isSelected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onSelect(conversation.id);
        }
      }}
    >
      {/* Title row */}
      <div className="cv-list-item-header">
        <span className="cv-list-item-title">{conversation.title}</span>
        {conversation.is_starred && (
          <span className="cv-list-item-star" title="Starred">★</span>
        )}
      </div>

      {/* Preview snippet */}
      {conversation.preview && (
        <div className="cv-list-item-preview">{conversation.preview}</div>
      )}

      {/* Tags */}
      {conversation.tags.length > 0 && (
        <div className="cv-tags">
          {conversation.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="cv-tag">
              {tag}
            </span>
          ))}
          {conversation.tags.length > 4 && (
            <span className="cv-tag" style={{ opacity: 0.6 }}>
              +{conversation.tags.length - 4}
            </span>
          )}
        </div>
      )}

      {/* Footer: date, message count, IDE */}
      <div className="cv-list-item-footer">
        <span className="cv-list-item-date">{relativeDate}</span>
        <span className="cv-list-item-count">
          💬 {conversation.message_count}
        </span>
        <span className="cv-ide-badge">{conversation.source_ide}</span>
      </div>
    </div>
  );
});

/**
 * Formats an ISO 8601 timestamp as a human-readable relative date.
 * Examples: "just now", "5m ago", "2h ago", "Yesterday", "Jul 10"
 */
function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60)  { return 'just now'; }
  if (diffMin < 60)  { return `${diffMin}m ago`; }
  if (diffHr < 24)   { return `${diffHr}h ago`; }
  if (diffDay === 1) { return 'Yesterday'; }
  if (diffDay < 7)   { return `${diffDay}d ago`; }

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

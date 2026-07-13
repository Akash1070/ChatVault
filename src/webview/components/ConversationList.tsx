import React, { memo, useState } from 'react';
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
  // Track collapsed state of project groups (expanded by default)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const toggleGroup = (groupName: string) => {
    setCollapsedGroups(prev => ({
      ...prev,
      [groupName]: !prev[groupName]
    }));
  };

  // Group conversations
  const groups: Record<string, { conversations: ConversationSummary[]; mostRecentTime: number }> = {};
  for (const conv of conversations) {
    const projName = getProjectName(conv.project_path);
    if (!groups[projName]) {
      groups[projName] = {
        conversations: [],
        mostRecentTime: 0,
      };
    }
    groups[projName].conversations.push(conv);
    const convTime = new Date(conv.updated_at).getTime();
    if (convTime > groups[projName].mostRecentTime) {
      groups[projName].mostRecentTime = convTime;
    }
  }

  // Sort groups by most recent time descending
  const sortedGroupNames = Object.keys(groups).sort((a, b) => {
    return groups[b].mostRecentTime - groups[a].mostRecentTime;
  });

  // For each group, sort conversations by updated_at descending
  for (const projName of sortedGroupNames) {
    groups[projName].conversations.sort((a, b) => {
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }

  return (
    <>
      {sortedGroupNames.map((projName) => {
        const group = groups[projName];
        const isCollapsed = !!collapsedGroups[projName];
        return (
          <div key={projName} className="cv-project-group">
            <div
              className="cv-project-header"
              onClick={() => toggleGroup(projName)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  toggleGroup(projName);
                }
              }}
            >
              <div className="cv-project-header-left">
                <span>📁</span>
                <span>{projName}</span>
                <span className="cv-project-badge">{group.conversations.length}</span>
              </div>
              <span className={`cv-project-chevron${isCollapsed ? ' collapsed' : ''}`}>▼</span>
            </div>

            {!isCollapsed && (
              <div className="cv-project-conversations">
                {group.conversations.map((conv) => (
                  <ConversationListItem
                    key={conv.id}
                    conversation={conv}
                    isSelected={conv.id === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function getProjectName(projectPath: string | null): string {
  if (!projectPath) return 'General';
  const parts = projectPath.split(/[/\\]/);
  const cleanParts = parts.filter(Boolean);
  if (cleanParts.length === 0) return 'General';
  return cleanParts[cleanParts.length - 1];
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

/**
 * src/webview/components/EmptyState.tsx
 * Shown when the vault has no conversations or a search yields no results.
 */

import React from 'react';

interface EmptyStateProps {
  hasSearch: boolean;
  onSaveClick: () => void;
}

export function EmptyState({ hasSearch, onSaveClick }: EmptyStateProps): JSX.Element {
  if (hasSearch) {
    return (
      <div className="cv-empty">
        <div className="cv-empty-icon">🔍</div>
        <div className="cv-empty-title">No results</div>
        <div className="cv-empty-subtitle">
          Try different keywords or clear the search.
        </div>
      </div>
    );
  }

  return (
    <div className="cv-empty">
      <div className="cv-empty-icon">🔐</div>
      <div className="cv-empty-title">Vault is empty</div>
      <div className="cv-empty-subtitle">
        Save your first AI conversation to start building your knowledge base.
      </div>
      <button className="cv-empty-shortcut" onClick={onSaveClick}>
        <span>⊕</span>
        <span>Save conversation</span>
        <span style={{ opacity: 0.6, fontSize: '10px' }}>Ctrl+Shift+S</span>
      </button>
    </div>
  );
}

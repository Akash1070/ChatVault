/**
 * src/webview/components/SearchBar.tsx
 * Controlled search input with a magnifying glass icon.
 */

import React from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchBar({ value, onChange, placeholder }: SearchBarProps): JSX.Element {
  return (
    <div className="cv-search-wrap">
      <span className="cv-search-icon">⌕</span>
      <input
        type="text"
        className="cv-search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Search…'}
        spellCheck={false}
        autoComplete="off"
        aria-label="Search conversations"
      />
    </div>
  );
}

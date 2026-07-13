/**
 * src/capture/cursorAdapter.ts — Module 3
 *
 * IDE detection and Cursor-specific parsing utilities.
 *
 * Cursor IDE situation:
 *   - Cursor is a VS Code fork — extensions run inside it normally
 *   - vscode.env.appName = "Cursor"
 *   - Cursor's AI chat (AI pane) is NOT exposed via vscode.chat API
 *   - Strategy: user copies chat from Cursor → runs 'chatVault.captureFromClipboard'
 *   - The parseConversationText() function handles Cursor's output format
 *
 * Windsurf IDE situation:
 *   - Windsurf exposes vscode.lm API — works with Strategy A (chat participant)
 *   - vscode.env.appName = "Windsurf"
 *
 * Parsing strategy for pasted text:
 *   Detects role markers case-insensitively. Multi-line messages are supported.
 *   Handles: "User:", "You:", "Human:", "AI:", "Assistant:", "Claude:", "GPT:", "System:"
 */

import * as vscode from 'vscode';
import { SourceIde } from '../storage/conversationRepo';

// ─── IDE Detection ─────────────────────────────────────────────────────────────

/**
 * Detects the current IDE by inspecting vscode.env.appName.
 * This is the safest, officially supported method.
 */
export function detectSourceIde(): SourceIde {
  const name = vscode.env.appName.toLowerCase();
  if (name.includes('cursor')) { return 'cursor'; }
  if (name.includes('windsurf')) { return 'windsurf'; }
  if (name.includes('visual studio code') || name.includes('vscode')) { return 'vscode'; }
  return 'unknown';
}

/** Returns a human-readable label for the current IDE. */
export function getIdeLabel(): string {
  switch (detectSourceIde()) {
    case 'cursor': return 'Cursor';
    case 'windsurf': return 'Windsurf';
    case 'vscode': return 'VS Code';
    default: return vscode.env.appName;
  }
}

/**
 * Returns contextual guidance text for the current IDE.
 * Shown in the webview empty state and capture prompts.
 */
export function getCaptureGuidance(): string {
  switch (detectSourceIde()) {
    case 'cursor':
      return (
        '**In Cursor:** Copy your AI chat conversation (Ctrl+A in the chat pane), ' +
        'then run **ChatVault: Capture from Clipboard** (Ctrl+Shift+C). ' +
        'Or press Ctrl+Shift+S to paste manually.'
      );
    case 'windsurf':
      return (
        '**In Windsurf:** Type `@chatVault save` in the Cascade chat panel to save. ' +
        'Or copy and run **ChatVault: Capture from Clipboard**.'
      );
    default:
      return (
        '**In VS Code:** Type `@chatVault save` in Copilot Chat. ' +
        'Or press **Ctrl+Shift+S** to paste a conversation manually.'
      );
  }
}

/** Returns true if the current IDE exposes the vscode.chat participant API. */
export function supportsVsCodeChatApi(): boolean {
  return typeof vscode.chat !== 'undefined';
}

// ─── Conversation Text Parser ─────────────────────────────────────────────────

type ParsedRole = 'user' | 'assistant' | 'system';

interface ParsedMessage {
  role: ParsedRole;
  content: string;
}

/**
 * Role marker patterns — matched case-insensitively at the start of a line.
 *
 * Handles output formats from:
 *   - Cursor AI pane    ("You:" / "AI:")
 *   - GitHub Copilot    ("User:" / "GitHub Copilot:")
 *   - Claude.ai copy    ("Human:" / "Claude:")
 *   - ChatGPT copy      ("User:" / "ChatGPT:" / "GPT-4:")
 *   - Generic           ("User:" / "Assistant:" / "System:")
 */
const USER_MARKERS = /^(user|you|human|me):\s*/i;
const ASSISTANT_MARKERS = /^(ai|assistant|claude|gpt|gpt-4|gpt-3\.5|chatgpt|copilot|github copilot|windsurf|cascade):\s*/i;
const SYSTEM_MARKERS = /^system:\s*/i;

/**
 * Parses a raw conversation string into structured message objects.
 *
 * Algorithm:
 *   1. Split by newline
 *   2. For each line, check if it starts with a known role marker
 *   3. If so, flush the previous message and start a new one with the detected role
 *   4. Otherwise, append to the current message buffer
 *   5. Flush the last message
 *
 * Multi-line messages are fully supported — blank lines within a message are preserved.
 *
 * @param raw - The raw pasted conversation text
 * @returns Array of parsed message objects. Empty array if no role markers found.
 */
export function parseConversationText(raw: string): ParsedMessage[] {
  if (!raw?.trim()) { return []; }

  const messages: ParsedMessage[] = [];
  let currentRole: ParsedRole | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentRole && currentLines.length > 0) {
      const content = currentLines.join('\n').trim();
      if (content) {
        messages.push({ role: currentRole, content });
      }
    }
    currentLines = [];
  };

  for (const line of raw.split('\n')) {
    if (USER_MARKERS.test(line)) {
      flush();
      currentRole = 'user';
      currentLines.push(line.replace(USER_MARKERS, '').trim());
    } else if (ASSISTANT_MARKERS.test(line)) {
      flush();
      currentRole = 'assistant';
      currentLines.push(line.replace(ASSISTANT_MARKERS, '').trim());
    } else if (SYSTEM_MARKERS.test(line)) {
      flush();
      currentRole = 'system';
      currentLines.push(line.replace(SYSTEM_MARKERS, '').trim());
    } else {
      // Continuation line — append if we have an active role
      if (currentRole !== null) {
        currentLines.push(line);
      }
    }
  }

  flush();
  return messages;
}

/**
 * Attempts to detect if a raw text block looks like a conversation.
 * Returns true if at least one role marker is found.
 * Useful for deciding whether to offer the paste-capture flow.
 */
export function looksLikeConversation(raw: string): boolean {
  const lines = raw.split('\n');
  return lines.some(
    (line) =>
      USER_MARKERS.test(line) ||
      ASSISTANT_MARKERS.test(line) ||
      SYSTEM_MARKERS.test(line)
  );
}

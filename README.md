# ChatVault — AI Conversation Manager for VS Code & Cursor

![ChatVault Logo](https://raw.githubusercontent.com/Akash1070/ChatVault/main/media/icon.png)

> Capture, persist, search, and manage every AI chat session across IDE sessions. Works with GitHub Copilot, Cursor, and Windsurf!

## Why ChatVault?
AI chat in IDEs is ephemeral — conversations vanish when you close the window, there's no central log, no global search, and no way to revisit the exact prompts that worked. ChatVault solves this by capturing and persisting your AI conversations across sessions in a lightning-fast local database, complete with hybrid search and cross-device syncing.

---

## ⚡ How to Use ChatVault (The Right Way)

### 1. Opening the Vault
- Look at your left-hand activity bar in VS Code / Cursor and click the **Purple Vault Icon**.
- Alternatively, press `F1` (or `Ctrl+Shift+P`) and run **"ChatVault: Open Vault"**.
- This sidebar is your central hub. It shows all your past conversations, starred items, and your database statistics.

### 2. Capturing a Conversation
Because different AI tools (Copilot, Cursor, Windsurf) have different API restrictions, ChatVault provides a universal manual capture fallback:
- **Manual Capture:** Highlight any AI chat log (or copy it to your clipboard), press `F1`, and run **"ChatVault: Manual Capture"**. A text editor will open for you to paste and modify the log. Once you close it, it saves instantly!
- *(Note: We are actively working on auto-capture APIs for specific IDEs like Cursor and Windsurf as their extension APIs open up!)*

### 3. Searching Your Vault
Stop scrolling endlessly to find that one prompt you used last month:
- Use the **Search Bar** at the top of the ChatVault sidebar.
- Our hybrid search engine uses **Fuzzy Matching** (for titles) and **SQLite FTS5** (for full-text deep search inside the chat messages). It's instant, even with 10,000+ chats.

### 4. Exporting & Sharing
- Want to send a chat to a coworker? Press `F1` and run **"ChatVault: Export Conversation"**. 
- You can export as `.md` (Markdown), `.json`, or `.txt`.

---

## 💎 ChatVault PRO & Cloud Sync

ChatVault is **100% free** for local, offline use (unlimited chats). 
If you want to sync your chats across multiple computers (e.g., your work laptop and home desktop), you can unlock **ChatVault Pro**.

1. **Get a Pro License:** Head to our [Checkout Page](https://checkout.dodopayments.com/buy/pdt_0Nj6BTTgXLju7iS7Q1pfp) to grab a one-time license.
2. **Activate:** Open the VS Code Settings (`Ctrl+,`), search for "ChatVault", and paste your License Key into the **Licence Key** field.
3. **Set Up Sync (BYOB):** ChatVault uses a "Bring Your Own Backend" (BYOB) approach. Create a completely **free** Supabase project, get your API URL and Anon Key, and drop them into the ChatVault settings. 
4. Your chats will now silently sync in the background across all your devices using an incremental last-write-wins algorithm!

---

## 🛠 Features at a Glance
- 🚀 **Universal Capture:** Save any chat from any AI coding assistant.
- 💾 **Local-First Storage:** SQLite (WAL mode) database. Your data never leaves your machine unless you enable Cloud Sync.
- 🔍 **Hybrid Search:** Instant Fuzzy & FTS5 ranked search.
- ☁️ **BYOB Cloud Sync (Pro):** Sync across devices using a free Supabase project ($0 server costs).
- 🎨 **Beautiful UI:** Built with React and a modern, sleek aesthetic.

---

**Publisher:** Akash Kumar Jha  
**License:** MIT

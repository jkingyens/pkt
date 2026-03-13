# ✳️ Wildcard

**Wildcard** is a modern authoring environment built directly into your browser. It is a local-first, AI-powered workspace designed to turn the web from a collection of silos into a personal canvas for building, organizing, and automating your knowledge.

---

## 🏗 The Wildcard Philosophy

In the traditional web, data lives in tabs and servers. In Wildcard, your browser becomes a creative workspace where you can:
- **Clip** anything from the web into organized collections.
- **Build** interactive "Stacks" that connect your research, media, and data.
- **Script** complex behaviors using natural language, powered by AI and WebAssembly.

---

## 📚 Core Concepts

### Stacks
A **Stack** is your project. It's a collection of cards, data, and logic focused on a single topic—be it a research project, a personal database, or a custom tool for your browser.

### Cards & Pages
- **Pages**: Snapshots or live links to web content, organized within your stack.
- **Media**: Clips, recordings, and images that form the visual foundation of your cards.
- **Data**: Every stack includes a local SQLite database, giving you the power of structured data without the complexity of a server.

### Functions (AI-Powered Logic)
Wildcard uses **AI-generated WebAssembly functions** for scripting. Instead of writing complex code, you describe the logic you want in natural language (e.g., *"Find all my bookmarks about 'space' and summarize their titles"*). Gemini generates the code, compiles it to Wasm, and executes it securely in your browser.

---

## 🚀 Key Features

- **Personal SQLite Collections** — Manage multiple, namespaced SQLite databases using [sql.js](https://github.com/sql-js/sql.js).
- **AI-Powered Authoring** — Describe your goal, and Wildcard builds the logic for you.
- **Fluid Capture** — A built-in clipper to bring any part of the web into your Stacks.
- **WIT Bridging** — Secure, type-safe access to Chrome host APIs (Bookmarks, Tabs) from your scripts.
- **Full Privacy** — Your data stays in your browser. Safe, local-first, and private by design.

---

## 🛠 Project Architecture

```
.
├── manifest.json     # Extension heart
├── background/       # Service worker (The "Engine" - handles SQL & Wasm)
├── sidebar/          # The Workspace (UI, CSS, and interaction controllers)
├── src/
│   └── sqlite-manager.js # Database management core
├── icons/            # Extension visuals
├── vendor/           # Powering tools (sql.js, etc.)
└── zig/              # Script execution assets
```

---

## ⚡️ Quick Start

### Installation
1. Clone this repository.
2. Go to `chrome://extensions/` in Google Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extension directory.

### Setup Your AI Assistant
1. Open the Wildcard sidebar.
2. Click the ⚙️ (Settings) icon.
3. Add your **Gemini API Key**.
4. Select a model (e.g., `gemini-1.5-pro`) and click **Save Settings**.

---

## 🔒 Security & Privacy

- **Local-First**: Your databases live in `chrome.storage.local`.
- **Wasm Sandbox**: All AI-generated scripts run in a strictly isolated environment.
- **Privacy**: No browsing data or database content ever leaves your machine. AI prompts only contain the necessary context for code generation.

---

## License
MIT

# ✳️ Wildcard CX 

WildcardCX is a powerful, AI-optional SQLite workspace for Chrome. It combines traditional database management with a Wasm-based execution environment using WebAssembly and sandboxed, AI-generated modules.

## 🚀 Key Features

- **AI-Generated Wasm Functions** — Describe the logic you want in natural language, and Gemini will generate optimized logic, compile it to Wasm, and execute it directly in your browser.
- **SQLite Collections** — Create, manage, and persist multiple namesacked SQLite databases using [sql.js](https://github.com/sql-js/sql.js).
- **WIT Bridging** — Type-safe communication between Wasm modules and Chrome host APIs (like Bookmarks) using WebAssembly Interface Type (WIT) definitions.
- **Project Overlays (Packets)** — Group URLs and Wasm modules into logical "Packets" that can be restored and executed in a single click.
- **Entry Inspection** — Browse schemas and click individual row IDs to see full entry previews.
- **Full Privacy** — All processing happens locally. No data ever leaves your device (except for the AI prompts sent to Gemini).

---

## 🛠 Project Architecture

```
.
├── manifest.json     # Extension configuration
├── background/       # Service worker (handles SQL management & Wasm execution)
├── sidebar/          # UI (Sidebar, CSS, and UI controllers)
├── src/
│   └── sqlite-manager.js # Shared SQLite management logic
├── icons/            # Extension icons
├── vendor/           # Third-party dependencies
└── zig/              # Sandboxed execution assets/scripts
```

---

## ⚡️ Getting Started

### Prerequisites
- Google Chrome

### Installation
1. Clone the repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the root directory of this repository.

### Initial Setup
1. Open the **WildcardCX** sidebar from the extension bar.
2. Click the ⚙️ (Settings) icon.
3. Enter your **Gemini API Key**.
4. Click **Fetch Models** and select a model (e.g., `gemini-1.5-pro`).
5. Click **Save Settings**.

---

## 🏗 Developing Wasm Functions

WildcardCX uses an AI-First development flow:

1. Click **✨ Generate WASM** in a Packet view.
2. Describe your goal (e.g., "Find all bookmarks with 'coding' in the title and extract their URLs").
3. WildcardCX fetches your current database schema and WIT definitions to provide the AI with full context.
4. The AI generates optimized code which is compiled in-browser and executed.
5. Results and logs are displayed in an interactive modal.

---

## 🔒 Security & Privacy

- **Local-First**: Your databases are stored in `chrome.storage.local`. They are never synced to a cloud unless you manually export them.
- **Wasm Sandbox**: All generated code runs in a isolated WebAssembly environment via a Service Worker.
- **CSP**: The extension uses a strict Content Security Policy (`wasm-unsafe-eval`) to allow local Wasm compilation while preventing remote script execution.

---

## License
MIT

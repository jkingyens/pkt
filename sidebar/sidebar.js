/**
 * Sidebar UI Controller
 * Manages collection list and nested detail view with schema/entry management
 */
import { compileZigCode } from './zig-compiler.js';

// Real-world SQLite schemas from popular open source apps
const SCHEMA_PRESETS = {
    buku: `-- buku: command-line bookmark manager
-- https://github.com/jarun/buku
CREATE TABLE bookmarks (
  id        INTEGER PRIMARY KEY,
  URL       TEXT NOT NULL UNIQUE,
  metadata  TEXT DEFAULT '',
  tags      TEXT DEFAULT ',',
  desc      TEXT DEFAULT '',
  flags     INTEGER DEFAULT 0
);

CREATE TABLE tag (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);`,

    newsboat: `-- newsboat: terminal RSS/Atom feed reader
-- https://github.com/newsboat/newsboat
CREATE TABLE rss_feed (
  rssurl       TEXT NOT NULL PRIMARY KEY,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  lastmodified INTEGER NOT NULL DEFAULT 0,
  is_rtl       INTEGER NOT NULL DEFAULT 0,
  etag         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE rss_item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guid        TEXT NOT NULL,
  title       TEXT NOT NULL,
  author      TEXT NOT NULL,
  url         TEXT NOT NULL,
  feedurl     TEXT NOT NULL,
  pubdate     INTEGER NOT NULL,
  content     TEXT NOT NULL,
  unread      INTEGER NOT NULL DEFAULT 1,
  enclosure_url  TEXT,
  enclosure_type TEXT,
  enqueued    INTEGER NOT NULL DEFAULT 0,
  flags       TEXT,
  deleted     INTEGER NOT NULL DEFAULT 0,
  base        TEXT DEFAULT NULL
);`,

    zotero: `-- zotero: reference manager (simplified core tables)
-- https://github.com/zotero/zotero
CREATE TABLE items (
  itemID        INTEGER PRIMARY KEY,
  itemTypeID    INTEGER NOT NULL,
  dateAdded     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dateModified  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  clientDateModified TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  libraryID     INTEGER NOT NULL,
  key           TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0,
  synced        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE creators (
  creatorID   INTEGER PRIMARY KEY,
  firstName   TEXT DEFAULT '',
  lastName    TEXT DEFAULT '',
  fieldMode   INTEGER DEFAULT 0
);

CREATE TABLE itemCreators (
  itemID      INTEGER NOT NULL,
  creatorID   INTEGER NOT NULL,
  creatorTypeID INTEGER NOT NULL DEFAULT 1,
  orderIndex  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (itemID, creatorID, creatorTypeID)
);

CREATE TABLE tags (
  tagID   INTEGER PRIMARY KEY,
  name    TEXT NOT NULL COLLATE NOCASE
);

CREATE TABLE itemTags (
  itemID  INTEGER NOT NULL,
  tagID   INTEGER NOT NULL,
  type    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (itemID, tagID)
);`,

    taskwarrior: `-- taskwarrior: command-line task manager (export schema)
-- https://github.com/GothenburgBitFactory/taskwarrior
CREATE TABLE tasks (
  uuid        TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'pending',
  description TEXT NOT NULL,
  entry       TEXT,
  modified    TEXT,
  due         TEXT,
  until       TEXT,
  wait        TEXT,
  scheduled   TEXT,
  start       TEXT,
  end         TEXT,
  priority    TEXT,
  project     TEXT,
  recur       TEXT,
  mask        TEXT,
  imask       INTEGER,
  parent      TEXT,
  urgency     REAL DEFAULT 0.0
);

CREATE TABLE task_tags (
  task_uuid  TEXT NOT NULL,
  tag        TEXT NOT NULL,
  PRIMARY KEY (task_uuid, tag)
);

CREATE TABLE task_annotations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_uuid  TEXT NOT NULL,
  entry      TEXT NOT NULL,
  description TEXT NOT NULL
);`,

    miniflux: `-- miniflux: minimalist feed reader (simplified)
-- https://github.com/miniflux/v2
CREATE TABLE feeds (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL,
  feed_url           TEXT NOT NULL,
  site_url           TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL DEFAULT '',
  checked_at         TEXT,
  next_check_at      TEXT,
  etag_header        TEXT NOT NULL DEFAULT '',
  last_modified_header TEXT NOT NULL DEFAULT '',
  parsing_error_msg  TEXT NOT NULL DEFAULT '',
  parsing_error_count INTEGER NOT NULL DEFAULT 0,
  scraper_rules      TEXT NOT NULL DEFAULT '',
  rewrite_rules      TEXT NOT NULL DEFAULT '',
  crawler            INTEGER NOT NULL DEFAULT 0,
  category_id        INTEGER,
  username           TEXT NOT NULL DEFAULT '',
  password           TEXT NOT NULL DEFAULT '',
  disabled           INTEGER NOT NULL DEFAULT 0,
  hide_globally      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  feed_id     INTEGER NOT NULL,
  hash        TEXT NOT NULL,
  published_at TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  comments_url TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'unread',
  starred     INTEGER NOT NULL DEFAULT 0,
  reading_time INTEGER NOT NULL DEFAULT 0
);`
};

const DEFAULT_SYSTEM_INSTRUCTION = `You are an expert Zig developer. 
Your task is to write a Zig file that will be compiled to WebAssembly (Wasm) as a WASI executable.
It will run in a host environment with these WIT interfaces available:
{{WITS_CONTEXT}}

### INSTRUCTIONS:
1. Output ONLY the raw Zig (.zig) source code. No markdown formatting, no explanations, no HTML tags.
2. The module MUST export a 'run' function: 'pub export fn run() i32 { ... }'
3. The module MUST define a dummy 'main' function to satisfy WASI: 'pub fn main() void {}'
4. You can import host functions using extern block syntax. The module name corresponds to the WIT interface.
   Example:
   extern "chrome:bookmarks/bookmarks" fn get_tree() i32;
   extern "user:sqlite/sqlite" fn execute(db: i32, sql: i32, params: i32) i32;

5. Use the standard library if needed via \`const std = @import("std");\`.
6. CRITICAL ZIG SYNTAX: When defining pointers to structs or arrays (e.g. for WIT lists or strings), you MUST use valid Zig pointer syntax like \`[*]const T\` or \`*const T\`. NEVER use \`[*const T]\` as that is invalid syntax.
7. CRITICAL ZIG BUILTINS: You MUST use modern Zig 0.11+ builtins. 
   - DO NOT use \`@intToPtr(T, addr)\`. Use \`@as(T, @ptrFromInt(addr))\` instead.
   - DO NOT use \`@ptrFromInt(T, addr)\` with two arguments. \`@ptrFromInt\` takes EXACTLY ONE argument.
   - DO NOT use \`@ptrCast(T, ptr)\` with two arguments. \`@ptrCast\` takes EXACTLY ONE argument.
   - DO NOT use \`@intCast(T, int)\` with two arguments. \`@intCast\` takes EXACTLY ONE argument.
   - DO NOT use \`@ptrToInt(ptr)\`. Use \`@intFromPtr(ptr)\` instead.
8. CRITICAL ZIG TYPES: \`usize\`, \`u8\`, \`u32\`, \`bool\`, etc are primitive built-in types in Zig. DO NOT redefine them (e.g. do NOT write \`const usize = ...\`).
9. CRITICAL EXTERN STRUCTS: An \`extern struct\` can ONLY contain extern-compatible types. If you need a union inside an \`extern struct\`, it MUST be declared as an \`extern union\`. NEVER use a plain \`union\` inside an \`extern struct\`.
10. CRITICAL STRUCT DECLARATIONS: In Zig, structs are assigned to constants. You MUST declare them as \`const MyStruct = struct { ... };\` or \`const MyStruct = extern struct { ... };\`. NEVER use C-style declarations like \`struct MyStruct { ... }\` or \`extern struct MyStruct { ... }\`.
11. CRITICAL CASTING: Whenever you need to cast a pointer returned by an allocator or an \`anyopaque\` pointer (like from WIT list data_ptr), DO NOT use \`@ptrCast\` or \`@intCast\`. Instead use the \`@as(T, ...)\` builtin. Example: To cast an opaque ptr to a typed ptr: \`const typed_ptr = @as(*const MyStruct, @ptrCast(opaque_ptr));\`
12. CRITICAL ZIG POINTERS: Zig DOES NOT HAVE A \`*mut\` KEYWORD. Pointers to mutable data are written as \`*T\`. Pointers to constant data are \`*const T\`. NEVER write \`*mut T\` like in Rust!
13. CRITICAL HOST FUNCTIONS: DO NOT invent your own signatures for host functions. If the template or instructions say \`extern "chrome:bookmarks/bookmarks" fn get_tree() i32;\`, you MUST USE IT EXACTLY AS PROVIDED. Do not add arguments to it!
14. CRITICAL EXTERN BLOCKS: Zig DOES NOT support Rust-style \`extern "module" { fn f(); }\` blocks. You must declare EACH extern function individually like \`extern "module" fn f() void;\`.
15. CRITICAL UNUSED VARIABLES: Zig is extremely strict about unused variables. 
   - DO NOT discard a parameter using \`_ = param;\` if you use it anywhere else in the function. 
   - BAD: \`_ = x; return x + 1;\` (This causes a "pointless discard" error).
   - GOOD: \`_ = x; return 1;\` OR just \`return x + 1;\`.
   - ONLY discard a parameter if it is TRULY NEVER used. Doing both is a fatal error.
16. CRITICAL HOST POINTERS: Host functions return \`i32\`. To use this as a pointer address in Zig, you MUST cast it to \`usize\` first. 
    - EXAMPLE: \`const addr = @as(usize, @intCast(get_tree())); const ptr = @as(*const Result, @ptrFromInt(addr));\`
17. CRITICAL MEMORY ALLOCATION: The host needs to allocate memory in your WASM module to return strings and lists. You MUST export an allocation function exactly named \`cabi_realloc\`.
    - COPY THIS CODE EXACTLY:
    pub export fn cabi_realloc(ptr: ?*anyopaque, old_size: usize, align_val: usize, new_size: usize) ?*anyopaque {
        _ = align_val;
        if (new_size == 0) return null;
        const mem = std.heap.page_allocator.alloc(u8, new_size) catch @panic("OOM");
        if (ptr) |p| {
            const old_ptr = @as([*]u8, @ptrCast(p));
            const copy_len = if (old_size < new_size) old_size else new_size;
            @memcpy(mem[0..copy_len], old_ptr[0..copy_len]);
        }
        return mem.ptr;
    }

18. CRITICAL COMPILER LIMITATION: Our Zig environment does NOT support the \`mod\` instruction for floating-point numbers. 
    - AVOID using \`std.math.mod\` or the \`%\` operator with \`f32\` or \`f64\` types. 
    - This will cause a compilation error: "TODO: Implement wasm inst: mod".
    - Workaround: Use integer operations wherever possible.
19. RANDOMNESS: To get truly random results, DO NOT use a hardcoded seed like \`42\`.
    - We support the WASI \`random_get\` and \`clock_time_get\` interfaces.
    - RECOMMENDED SEEDING:
    var seed: u64 = 0;
    _ = std.os.wasi.random_get(@ptrCast(&seed), 8);
    var prng = std.rand.DefaultPrng.init(seed);
    const rand = prng.random();
20. STANDARD LIBRARY OUTPUT: While \`std.debug.print\` and \`std.log\` are now supported via WASI stubs, they are slower than the host \`log\` function.
    - PREFER using the host \`log\` function for your debug messages: \`extern "env" fn log(ptr: [*]const u8, len: i32) void;\`
    - If you must use \`std.debug.print\`, ensure you include the newline character \`\\n\` to flush the buffer correctly.
21. COMPTIME FORMAT STRINGS: Functions like \`std.debug.print\`, \`std.fmt.allocPrint\`, and \`std.fmt.format\` require the format string to be known at compile-time (comptime).
    - NEVER pass a runtime-known variable as the first argument to these functions. 
    - The format string MUST be a string literal.
    - BAD: \`std.debug.print(my_string, .{});\`
    - GOOD: \`std.debug.print("{s}\\n", .{my_string});\` or \`std.debug.print("Count: {d}\\n", .{count});\`
22. ERROR HANDLING: Zig is extremely strict about return values that can be errors.
    - YOU MUST NOT discard an error silently.
    - BAD: \`std.os.wasi.random_get(&seed, 8);\u0060 (Compilation error: "error is discarded")
    - GOOD: \`_ = std.os.wasi.random_get(&seed, 8);\u0060 (If you don't care about the error)
    - BETTER: \`try std.os.wasi.random_get(&seed, 8);\u0060 (If the function can return an error)
    - ALSO GOOD: \`std.os.wasi.random_get(&seed, 8) catch |err| { ... };\`
23. DATABASE CONTEXT: You have access to the following SQLite collections and their schemas:
{{DATABASE_CONTEXT}}
    - Use this context to identify correct collection and table names for your queries. 
    - DO NOT guess or invent table names (like "links"). Use ONLY what is provided above.

### EXAMPLE TEMPLATE:
const std = @import("std");

extern "env" fn log(ptr: [*]const u8, len: i32) void;
extern "chrome:bookmarks/bookmarks" fn get_tree() i32;

pub export fn run() i32 {
  var success: bool = true;
  return if (success) 0 else 1;
}

pub fn main() void {}
`;

class SidebarUI {
    constructor() {
        this.listView = document.getElementById('listView');
        this.detailView = document.getElementById('detailView');
        this.packetDetailView = document.getElementById('packetDetailView');
        this.constructorView = document.getElementById('constructorView');
        this.schemaConstructorView = document.getElementById('schemaConstructorView');
        this.settingsView = document.getElementById('settingsView');

        // List view elements
        this.collectionsList = document.getElementById('collectionsList');
        this.template = document.getElementById('collectionTemplate');
        this.settingsBtn = document.getElementById('settingsBtn');

        // Settings view elements
        this.geminiApiKeyInput = document.getElementById('geminiApiKeyInput');
        this.geminiModelSelect = document.getElementById('geminiModelSelect');
        this.fetchModelsBtn = document.getElementById('fetchModelsBtn');
        this.modelFetchStatus = document.getElementById('modelFetchStatus');
        this.settingsBackBtn = document.getElementById('settingsBackBtn');
        this.saveSettingsBtn = document.getElementById('saveSettingsBtn');
        this.geminiSystemPromptInput = document.getElementById('geminiSystemPromptInput');
        this.restoreDefaultPromptBtn = document.getElementById('restoreDefaultPromptBtn');

        // Detail view elements
        this.detailTitle = document.getElementById('detailTitle');
        this.schemaContent = document.getElementById('schemaContent');
        this.entriesContent = document.getElementById('entriesContent');
        this.entryCount = document.getElementById('entryCount');

        // Constructor view elements
        this.constructorList = document.getElementById('constructorList');

        // Schema constructor elements
        this.schemaRepoNameInput = document.getElementById('schemaRepoNameInput');
        this.schemaRepoSqlInput = document.getElementById('schemaRepoSqlInput');

        // Schema picker elements
        this.schemaPickerOverlay = document.getElementById('schemaPickerOverlay');
        this.schemaPickerList = document.getElementById('schemaPickerList');

        // Schema SQL viewer elements
        this.schemaSqlViewerOverlay = document.getElementById('schemaSqlViewerOverlay');
        this.schemaSqlViewerTitle = document.getElementById('schemaSqlViewerTitle');
        this.schemaSqlViewerContent = document.getElementById('schemaSqlViewerContent');

        // Modal elements
        this.schemaModal = document.getElementById('schemaModal');
        this.schemaTextarea = document.getElementById('schemaTextarea');
        // Packet detail view elements
        this.packetDetailTitle = document.getElementById('packetDetailTitle');
        this.packetLinkList = document.getElementById('packetLinkList');
        this.packetDetailCount = document.getElementById('packetDetailCount');

        // Wits view elements
        this.witsView = document.getElementById('witsView');
        this.witsList = document.getElementById('witsList');
        this.witItemTemplate = document.getElementById('witItemTemplate');

        // Wit editor elements
        this.witEditorView = document.getElementById('witEditorView');
        this.witNameInput = document.getElementById('witNameInput');
        this.witContentInput = document.getElementById('witContentInput');
        this.witEditorTitle = document.getElementById('witEditorTitle');

        // AI prompt modal elements
        this.aiPromptModal = document.getElementById('aiPromptModal');
        this.aiPromptTextarea = document.getElementById('aiPromptTextarea');
        this.aiStatus = document.getElementById('aiStatus');
        this.aiStatusText = document.getElementById('aiStatusText');
        this.aiGenerateBtn = document.getElementById('aiGenerateBtn');
        this.aiGenerateWasmBtn = document.getElementById('aiGenerateWasmBtn');

        // WASM Result Modal elements
        this.wasmResultModal = document.getElementById('wasmResultModal');
        this.wasmLogContent = document.getElementById('wasmLogContent');
        this.wasmResultValue = document.getElementById('wasmResultValue');
        this.wasmResultCloseBtn = document.getElementById('wasmResultCloseBtn');
        this.wasmResultOkBtn = document.getElementById('wasmResultOkBtn');

        // Close listeners
        this.wasmResultCloseBtn.onclick = () => this.wasmResultModal.classList.add('hidden');
        this.wasmResultOkBtn.onclick = () => this.wasmResultModal.classList.add('hidden');

        // Entry Preview Modal elements
        this.entryPreviewModal = document.getElementById('entryPreviewModal');
        this.entryPreviewTitle = document.getElementById('entryPreviewTitle');
        this.entryDataTable = document.getElementById('entryDataTable');
        this.entryPreviewCloseBtn = document.getElementById('entryPreviewCloseBtn');
        this.entryPreviewOkBtn = document.getElementById('entryPreviewOkBtn');

        // State
        this.currentCollection = null;
        this.currentSchema = [];
        this.constructorItems = []; // Array of { type: 'link'|'wasm', ... }
        this.activePacketGroupId = null;
        this.dragSrcIndex = null;
        this.geminiApiKey = '';
        this.geminiModel = '';
        this.geminiSystemPrompt = '';

        this.setupEventListeners();
        this.setupMessageListener();
        this.loadCollections();
        this.loadSettings();
        this.checkActivePacket(); // check if we opened inside a packet group
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((message) => {
            if (message.type === 'packetFocused') {
                this.showPacketDetailView(message.packet);
            }
        });
    }

    async checkActivePacket() {
        try {
            const resp = await this.sendMessage({ action: 'getActivePacket' });
            if (resp.success && resp.packet) {
                // Ensure the packet object includes the groupId from the response context (or we might need to get it specially)
                // The service worker getActivePacket returns { id, name, urls } but not groupId. 
                // Wait, I see I handled getActivePacket in SW to just return packet details. 
                // I need the groupId to support opening tabs in it.
                // Re-reading SW: getActivePacket returns { id, name, urls }. It usually finds it via tab.groupId. 
                // I should probably fetch the current tab's groupId here or update SW.
                // Actually the SW `getActivePacket` finds the group ID active tab is in. 
                // Let's assume the user is in that group. I'll get the current tab here to be sure.
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && tab.groupId !== -1) {
                    resp.packet.groupId = tab.groupId;
                    this.showPacketDetailView(resp.packet);
                }
            }
        } catch (e) {
            console.error('Failed to check active packet:', e);
        }
    }

    setupEventListeners() {
        // List view
        document.getElementById('createBtn').addEventListener('click', () => this.createCollection());
        document.getElementById('importBtn').addEventListener('click', () => this.importDatabase());
        this.settingsBtn.addEventListener('click', () => this.showSettingsView());

        // Settings view
        this.settingsBackBtn.addEventListener('click', () => this.showListView());
        this.saveSettingsBtn.addEventListener('click', () => this.saveSettings());
        this.fetchModelsBtn.addEventListener('click', () => this.fetchAvailableModels());
        this.restoreDefaultPromptBtn.addEventListener('click', () => this.restoreDefaultPrompt());

        // Detail view
        document.getElementById('backBtn').addEventListener('click', () => this.showListView());
        document.getElementById('editSchemaBtn').addEventListener('click', () => this.openSchemaModal());
        document.getElementById('detailExportBtn').addEventListener('click', () => this.exportCollection(this.currentCollection));
        document.getElementById('detailSaveBtn').addEventListener('click', () => this.saveCheckpoint(this.currentCollection));
        document.getElementById('detailDeleteBtn').addEventListener('click', () => this.deleteCollection(this.currentCollection));

        // Packet detail view
        document.getElementById('packetDetailBackBtn').addEventListener('click', () => this.showDetailView('packets'));

        // Constructor view (packets)
        document.getElementById('constructorBackBtn').addEventListener('click', () => this.showDetailView('packets'));
        document.getElementById('addCurrentTabBtn').addEventListener('click', () => this.addCurrentTab());
        document.getElementById('addWasmBtn').addEventListener('click', () => document.getElementById('wasmFileInput').click());
        document.getElementById('wasmFileInput').addEventListener('change', (e) => this.handleWasmFileSelect(e));
        document.getElementById('savePacketBtn').addEventListener('click', () => this.savePacket());
        document.getElementById('discardPacketBtn').addEventListener('click', () => this.discardPacket());

        // Schema constructor view
        document.getElementById('schemaConstructorBackBtn').addEventListener('click', () => this.showDetailView('schemas'));
        document.getElementById('saveSchemaRepoBtn').addEventListener('click', () => this.saveSchemaToRepo());
        document.getElementById('discardSchemaRepoBtn').addEventListener('click', () => this.discardSchemaConstructor());

        // Schema picker
        document.getElementById('fromRepoBtn').addEventListener('click', () => this.openSchemaPicker());
        document.getElementById('schemaPickerCloseBtn').addEventListener('click', () => this.closeSchemaPicker());
        this.schemaPickerOverlay.addEventListener('click', (e) => {
            if (e.target === this.schemaPickerOverlay) this.closeSchemaPicker();
        });

        // Schema SQL viewer
        document.getElementById('schemaSqlViewerCloseBtn').addEventListener('click', () => this.closeSchemaSqlViewer());
        this.schemaSqlViewerOverlay.addEventListener('click', (e) => {
            if (e.target === this.schemaSqlViewerOverlay) this.closeSchemaSqlViewer();
        });

        // Modal
        document.getElementById('modalSaveBtn').addEventListener('click', () => this.saveSchema());
        document.getElementById('modalCancelBtn').addEventListener('click', () => this.closeSchemaModal());
        document.getElementById('modalCloseBtn').addEventListener('click', () => this.closeSchemaModal());
        this.schemaModal.addEventListener('click', (e) => {
            if (e.target === this.schemaModal) this.closeSchemaModal();
        });

        // Preset schema buttons
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = SCHEMA_PRESETS[btn.dataset.preset];
                if (preset) {
                    this.schemaTextarea.value = preset;
                    this.schemaTextarea.focus();
                }
            });
        });


        // WITS views
        document.getElementById('addWitBtn').addEventListener('click', () => this.showWitEditorView());
        document.getElementById('witsBackBtn').addEventListener('click', () => this.showListView());
        document.getElementById('witEditorBackBtn').addEventListener('click', () => this.showWitsView());
        document.getElementById('witSaveBtn').addEventListener('click', () => this.saveWit());
        document.getElementById('witDeleteBtn').addEventListener('click', () => this.deleteWit());

        // AI Prompt Modal
        document.getElementById('aiGenerateWasmBtn').addEventListener('click', () => this.openAiPromptModal());
        document.getElementById('aiModalCloseBtn').addEventListener('click', () => this.closeAiPromptModal());
        document.getElementById('aiCancelBtn').addEventListener('click', () => this.closeAiPromptModal());
        this.aiGenerateBtn.addEventListener('click', () => this.generateWasmWithAi());

        // Entry Preview Modal
        this.entryPreviewCloseBtn.addEventListener('click', () => this.entryPreviewModal.classList.add('hidden'));
        this.entryPreviewOkBtn.addEventListener('click', () => this.entryPreviewModal.classList.add('hidden'));
        this.entryPreviewModal.addEventListener('click', (e) => {
            if (e.target === this.entryPreviewModal) this.entryPreviewModal.classList.add('hidden');
        });
    }

    // ===== NAVIGATION =====

    hideAllViews() {
        this.listView.classList.remove('active');
        this.detailView.classList.remove('active');
        this.packetDetailView.classList.remove('active');
        this.constructorView.classList.remove('active');
        this.schemaConstructorView.classList.remove('active');
        this.witsView.classList.remove('active');
        this.witEditorView.classList.remove('active');
        this.settingsView.classList.remove('active');
    }

    showListView() {
        this.hideAllViews();
        this.listView.classList.add('active');
        this.currentCollection = null;
        this.loadCollections();
    }

    showDetailView(collectionName) {
        this.hideAllViews();
        this.currentCollection = collectionName;
        this.detailTitle.textContent = collectionName;
        this.detailView.classList.add('active');
        this.loadCollectionDetail(collectionName);
    }

    showWitsView() {
        this.hideAllViews();
        this.currentCollection = 'wits';
        this.witsView.classList.add('active');
        this.loadWits();
    }

    async loadWits() {
        this.witsList.innerHTML = '<p class="hint">Loading...</p>';
        try {
            const db = await this.sendMessage({ action: 'executeSQL', name: 'wits', sql: 'SELECT rowid, name, wit FROM wits ORDER BY name' });
            if (db.success) {
                this.renderWits(db.result);
            } else {
                this.witsList.innerHTML = `<p class="hint error">Failed to load wits: ${db.error}</p>`;
            }
        } catch (e) {
            console.error(e);
            this.witsList.innerHTML = '<p class="hint error">Error loading wits</p>';
        }
    }

    renderWits(rows) {
        this.witsList.innerHTML = '';
        if (!rows || rows.length === 0) {
            this.witsList.innerHTML = '<p class="hint">No WIT definitions found.</p>';
            return;
        }

        if (rows[0] && Array.isArray(rows[0].values)) {
            // result format from exec usually: [{columns:..., values:[...]}]
            // But my executeSQL implementation calls db.exec which returns this format.
            // Wait, handleMessage for executeSQL returns: { success: true, result, columns }
            // Wait, let's check service worker executeSQL.
            // It calls db.exec. db.exec returns [{columns, values}].
            // So rows is that array.
            const values = rows[0].values;
            values.forEach(([id, name, wit]) => {
                const clone = this.witItemTemplate.content.cloneNode(true);
                clone.querySelector('.collection-name').textContent = name;
                clone.querySelector('.collection-item').addEventListener('click', () => {
                    this.showWitEditorView({ id, name, wit });
                });
                this.witsList.appendChild(clone);
            });
        }
    }

    showWitEditorView(wit = null) {
        this.hideAllViews();
        this.witEditorView.classList.add('active');

        if (wit) {
            this.currentWitId = wit.id;
            this.witEditorTitle.textContent = 'Edit WIT';
            this.witNameInput.value = wit.name;
            this.witNameInput.disabled = (wit.name === 'chrome:bookmarks'); // System WITs read-only name?
            this.witContentInput.value = wit.wit;
            this.witNameInput.dataset.originalName = wit.name;
        } else {
            this.currentWitId = null;
            this.witEditorTitle.textContent = 'New WIT';
            this.witNameInput.value = '';
            this.witNameInput.disabled = false;
            this.witContentInput.value = '';
            delete this.witNameInput.dataset.originalName;
        }
    }

    async saveWit() {
        const name = this.witNameInput.value.trim();
        const wit = this.witContentInput.value;

        if (!name) return alert('Name is required');

        const btn = document.getElementById('witSaveBtn');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Saving...';

        try {
            let sql;
            let params;
            if (this.currentWitId) {
                sql = "UPDATE wits SET name = ?, wit = ? WHERE rowid = ?";
                params = [name, wit, this.currentWitId];
            } else {
                sql = "INSERT INTO wits (name, wit) VALUES (?, ?)";
                params = [name, wit];
            }

            // We need a way to execute with params. 'executeSQL' in SW calls db.exec(sql). Use proper escaping or add bind support?
            // SW executeSQL: db.exec(request.sql).
            // It doesn't support params! This is dangerous if names have quotes.
            // I should update SW to support bind params or handle escaping here.
            // For now, I'll escape single quotes.
            const esc = str => str.replace(/'/g, "''");
            if (this.currentWitId) {
                sql = `UPDATE wits SET name = '${esc(name)}', wit = '${esc(wit)}' WHERE rowid = ${this.currentWitId}`;
            } else {
                sql = `INSERT INTO wits(name, wit) VALUES('${esc(name)}', '${esc(wit)}')`;
            }

            const resp = await this.sendMessage({ action: 'executeSQL', name: 'wits', sql });
            if (resp.success) {
                // Checkpoint
                await this.sendMessage({ action: 'saveCheckpoint', name: 'wits', prefix: 'db_' });
                this.showWitsView();
            } else {
                alert('Failed to save: ' + resp.error);
            }
        } catch (e) {
            console.error(e);
            alert('Error saving WIT');
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }

    async deleteWit() {
        if (!this.currentWitId) return;
        const name = this.witNameInput.value;
        if (name === 'chrome:bookmarks') return alert('Cannot delete system WIT');

        if (!confirm(`Delete WIT "${name}" ? `)) return;

        try {
            const sql = `DELETE FROM wits WHERE rowid = ${this.currentWitId}`;
            const resp = await this.sendMessage({ action: 'executeSQL', name: 'wits', sql });
            if (resp.success) {
                await this.sendMessage({ action: 'saveCheckpoint', name: 'wits', prefix: 'db_' });
                this.showWitsView();
            } else {
                alert('Failed to delete: ' + resp.error);
            }
        } catch (e) { console.error(e); alert('Error deleting'); }
    }

    showPacketDetailView(packet) {
        this.currentPacket = packet;
        this.activePacketGroupId = packet.groupId || null;
        this.packetDetailTitle.textContent = packet.name;
        this.packetDetailCount.textContent = packet.urls.length;

        // Render card link list
        this.packetLinkList.innerHTML = '';
        if (packet.urls.length === 0) {
            this.packetLinkList.innerHTML = '<p class="hint">No items in this packet.</p>';
        } else {
            // packet.urls is now 'items' (mixed array). Keep variable name 'url'/packet.urls for compatibility but treat as items.
            packet.urls.forEach(item => {
                // Normalize item
                let type = 'link';
                let content = item;
                if (typeof item === 'object') {
                    type = item.type || 'link';
                    content = item.url || item.data; // url for link, data for wasm
                }

                if (type === 'link') {
                    const url = typeof item === 'string' ? item : item.url;
                    const card = document.createElement('div');
                    card.className = 'packet-link-card';
                    card.draggable = false;

                    let hostname;
                    try {
                        hostname = new URL(url).hostname;
                    } catch (e) { hostname = 'Unknown'; }

                    const faviconUrl = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;

                    card.innerHTML = `
                        <img src="${faviconUrl}" class="packet-link-favicon" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iI2NjYyIgZD0iTTEyIDJDNi40OCAyIDIgNi40OCAyIDEyczQuNDggMTAgMTAgMTAgMTAtNC40OCAxMC0xMFMxNy41MiAyIDEyIDJ6bS0xIDE3LjkyVjE5aC0ydjMtLjA4QzUuNjEgMTguNTMgMi41IDE1LjEyIDIuNSAxMWMwLS45OC4xOC0xLjkyLjUtMi44bDMuNTUgMy41NVYxOS45MnpNMjEgMTEuMzhWMTJjMCA0LjQxLTMuNiA4LTggOGgtMXYtMmgtMmwtMy0zVjlsMy0zIDIuMSAyLjFjLjIxLS42My42OC0xLjExIDEuNC0xLjExLjgzIDAgMS41LjY3IDEuNSAxLjV2My41aDN2LTNoMS42MWwuMzktLjM5YzIuMDEgMS4xMSAzLjUgMy4zNSAzLjUgNS44OHoiLz48L3N2Zz4='">
                        <div class="packet-link-info">
                            <div class="packet-link-hostname">${this.escapeHtml(hostname)}</div>
                            <div class="packet-link-url">${this.escapeHtml(url)}</div>
                        </div>
                    `;

                    card.addEventListener('click', async () => {
                        const resp = await this.sendMessage({ action: 'openTabInGroup', url, groupId: this.activePacketGroupId, packetId: packet.id });
                        if (resp && resp.success && resp.newGroupId) {
                            this.activePacketGroupId = resp.newGroupId;
                        }
                    });

                    this.packetLinkList.appendChild(card);
                } else if (type === 'wasm') {
                    const card = document.createElement('div');
                    card.className = 'packet-link-card wasm';
                    card.draggable = false;
                    card.title = 'Click to run main()';

                    card.innerHTML = `
                        <span style="font-size:16px;">🧩</span>
                        <div class="packet-link-info">
                            <div class="packet-link-hostname">WASM Module</div>
                            <div class="packet-link-url">${this.escapeHtml(item.name)}</div>
                            ${item.prompt ? `<div class="wasm-prompt">Prompt: "${this.escapeHtml(item.prompt)}"</div>` : ''}
                        </div>
                        <span class="packet-link-arrow">▶</span>
                    `;

                    card.addEventListener('click', async () => {
                        const originalHtml = card.innerHTML;
                        card.style.opacity = '0.7';
                        try {
                            // If it's a Zig module that hasn't been compiled yet, compile now
                            if (item.zigCode && !item.data) {
                                if (typeof compileZigCode === 'undefined') {
                                    throw new Error('Zig compiler not loaded');
                                }
                                this.showNotification('Compiling WASM...', 'info');
                                const wasmBytes = await compileZigCode(item.zigCode);
                                item.data = this.arrayBufferToBase64(wasmBytes);
                                // Save the binary back to the collection so we don't compile next time
                                await this.saveItemBinaryToPacket(item);
                            }

                            const resp = await this.sendMessage({ action: 'runWasmPacketItem', item });
                            this.showWasmResults(resp.logs, resp.result, resp.success, resp.error);
                        } catch (e) {
                            console.error('WASM Execution Error:', e);
                            this.showNotification('WASM Execution Error: ' + e.message, 'error');
                        } finally {
                            card.style.opacity = '1';
                        }
                    });

                    this.packetLinkList.appendChild(card);
                }
            });
        }

        // Switch view
        this.hideAllViews();
        this.packetDetailView.classList.add('active');
    }

    showConstructorView() {
        this.constructorItems = [];
        this.dragSrcIndex = null;
        // Reset save button in case it was left disabled from a previous save
        const saveBtn = document.getElementById('savePacketBtn');
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Packet';
        this.renderConstructorItems();
        this.hideAllViews();
        this.constructorView.classList.add('active');
    }

    showSchemaConstructorView() {
        this.schemaRepoNameInput.value = '';
        this.schemaRepoSqlInput.value = '';
        const saveBtn = document.getElementById('saveSchemaRepoBtn');
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Schema';
        this.hideAllViews();
        this.schemaConstructorView.classList.add('active');
        this.schemaRepoNameInput.focus();
    }

    // ===== COLLECTION LIST =====

    async loadCollections() {
        try {
            const response = await this.sendMessage({ action: 'listCollections' });
            if (response.success) {
                this.renderCollections(response.collections);
            }
        } catch (error) {
            console.error('Failed to load collections:', error);
        }
    }

    renderCollections(collections) {
        if (collections.length === 0) {
            this.collectionsList.innerHTML = `
              <div class="empty-state">
                <div class="empty-icon">🗄️</div>
                <p>No collections yet</p>
                <p class="hint">Create a new collection or import an existing database</p>
              </div>`;
            return;
        }

        this.collectionsList.innerHTML = '';

        // System collections first (wits, then packets, then schemas), then alphabetical
        const sorted = collections.sort((a, b) => {
            if (a === 'wits') return -1;
            if (b === 'wits') return 1;
            if (a === 'packets') return -1;
            if (b === 'packets') return 1;
            if (a === 'schemas') return -1;
            if (b === 'schemas') return 1;
            return a.localeCompare(b);
        });

        sorted.forEach(name => {
            const item = this.createCollectionItem(name);
            this.collectionsList.appendChild(item);
        });
    }

    createCollectionItem(name) {
        const clone = this.template.content.cloneNode(true);

        const nameEl = clone.querySelector('.collection-name');
        nameEl.textContent = name;
        nameEl.setAttribute('data-name', name);

        if (name === 'packets' || name === 'schemas' || name === 'wits') {
            clone.querySelector('.collection-item').classList.add('system-collection');
            const deleteBtn = clone.querySelector('.delete-btn');
            if (deleteBtn) {
                deleteBtn.disabled = true;
                deleteBtn.title = `Cannot delete system collection "${name}"`;
            }
        }

        // Click on header/name area → navigate to detail
        const item = clone.querySelector('.collection-item');
        const header = clone.querySelector('.collection-header');
        header.addEventListener('click', (e) => {
            // Don't navigate if delete button was clicked
            if (!e.target.closest('.delete-btn')) {
                if (name === 'wits') {
                    this.showWitsView();
                } else {
                    this.showDetailView(name);
                }
            }
        });

        clone.querySelector('.export-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.exportCollection(name);
        });
        clone.querySelector('.save-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.saveCheckpoint(name);
        });
        clone.querySelector('.restore-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.restoreCheckpoint(name);
        });
        clone.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteCollection(name);
        });

        return clone;
    }

    // ===== DETAIL VIEW =====

    async loadCollectionDetail(name) {
        this.schemaContent.innerHTML = '<p class="hint">Loading…</p>';
        this.entriesContent.innerHTML = '<p class="hint">Loading…</p>';
        this.entryCount.textContent = '0';

        try {
            const schemaResp = await this.sendMessage({ action: 'getSchema', name });
            if (schemaResp.success) {
                this.currentSchema = schemaResp.schema;
                this.renderSchema(schemaResp.schema);

                const detailDeleteBtn = document.getElementById('detailDeleteBtn');

                // Special handling for system collections
                if (name === 'packets') {
                    document.getElementById('editSchemaBtn').style.display = 'none';
                    detailDeleteBtn.disabled = true;
                    detailDeleteBtn.style.opacity = '0.5';
                    detailDeleteBtn.style.cursor = 'not-allowed';
                    detailDeleteBtn.title = 'Cannot delete system collection "packets"';
                    this.schemaContent.innerHTML = '<p class="hint">🔒 System collection. Schema is locked.</p>';
                    await this.loadPackets();
                } else if (name === 'schemas') {
                    document.getElementById('editSchemaBtn').style.display = 'none';
                    detailDeleteBtn.disabled = true;
                    detailDeleteBtn.style.opacity = '0.5';
                    detailDeleteBtn.style.cursor = 'not-allowed';
                    detailDeleteBtn.title = 'Cannot delete system collection "schemas"';
                    this.schemaContent.innerHTML = '<p class="hint">🔒 System collection. Schema is locked.</p>';
                    await this.loadSchemas();
                } else {
                    document.getElementById('editSchemaBtn').style.display = 'inline-flex';

                    detailDeleteBtn.disabled = false;
                    detailDeleteBtn.style.opacity = '';
                    detailDeleteBtn.style.cursor = '';
                    detailDeleteBtn.title = 'Delete Collection';

                    // Load entries for each table
                    await this.loadEntries(name, schemaResp.schema);
                }
            }
        } catch (error) {
            console.error('Failed to load collection detail:', error);
            this.schemaContent.innerHTML = '<p class="hint">Failed to load schema.</p>';
        }
    }

    renderSchema(schema) {
        if (!schema.length) {
            this.schemaContent.innerHTML = '<p class="hint">No tables defined yet. Click ✏️ Edit to add a schema.</p>';
            return;
        }

        this.schemaContent.innerHTML = schema.map(({ name, sql }) => `
          <div class="schema-table">
            <div class="schema-table-name">📋 ${name}</div>
            <pre class="schema-sql">${this.escapeHtml(sql)}</pre>
          </div>
        `).join('');
    }

    async loadEntries(collectionName, schema) {
        if (!schema.length) {
            this.entriesContent.innerHTML = '<p class="hint">Define a schema first to see entries.</p>';
            this.entryCount.textContent = '0';
            return;
        }

        try {
            // Load entries for all tables
            let totalCount = 0;
            let html = '';

            for (const { name: tableName } of schema) {
                const resp = await this.sendMessage({
                    action: 'getEntries',
                    name: collectionName,
                    tableName
                });

                if (resp.success) {
                    totalCount += resp.entries.length;
                    if (schema.length > 1) {
                        html += `<div class="schema-table-name" style="margin-bottom:4px;font-size:12px;">📋 ${tableName}</div>`;
                    }
                    if (resp.entries.length === 0) {
                        html += '<p class="hint" style="margin-bottom:8px;">No entries yet.</p>';
                    } else {
                        html += resp.entries.map(id => `
                          <div class="entry-row" data-id="${id}" data-table="${tableName}">
                            <span class="entry-id">#</span>
                            <span class="entry-label">${id}</span>
                          </div>`).join('');
                    }
                }
            }

            this.entryCount.textContent = totalCount;
            this.entriesContent.innerHTML = html || '<p class="hint">No entries yet.</p>';

            // Add click listeners to entries
            this.entriesContent.querySelectorAll('.entry-row').forEach(row => {
                row.addEventListener('click', () => {
                    this.showEntryPreview(collectionName, row.dataset.table, row.dataset.id);
                });
            });
        } catch (error) {
            console.error('Failed to load entries:', error);
            this.entriesContent.innerHTML = '<p class="hint">Failed to load entries.</p>';
        }
    }

    async loadPackets() {
        this.entryCount.textContent = '...';
        this.entriesContent.innerHTML = '<p class="hint">Loading packets...</p>';

        try {
            const response = await this.sendMessage({
                action: 'executeSQL',
                name: 'packets',
                sql: `SELECT rowid, name, urls, created FROM packets ORDER BY created DESC`
            });

            if (response.success && response.result.length > 0) {
                const rows = response.result[0].values;
                this.entryCount.textContent = rows.length;

                // Build header with Add Packet button
                const addBtn = document.createElement('button');
                addBtn.className = 'btn btn-primary btn-sm';
                addBtn.style.marginBottom = '12px';
                addBtn.innerHTML = '＋ Add Packet';
                addBtn.addEventListener('click', () => this.showConstructorView());

                if (rows.length === 0) {
                    this.entriesContent.innerHTML = '';
                    this.entriesContent.appendChild(addBtn);
                    this.entriesContent.insertAdjacentHTML('beforeend', '<p class="hint">No packets yet. Click above to create one.</p>');
                    return;
                }

                const html = rows.map(([rowid, name, urlsJson, created]) => {
                    let itemCount = 0;
                    try {
                        const items = JSON.parse(urlsJson);
                        itemCount = items.length;
                    } catch (e) { }

                    const time = new Date(created).toLocaleString();

                    return `
                    <div class="packet-card">
                        <div class="packet-info">
                            <span class="packet-name">${this.escapeHtml(name)} <span class="packet-url-count">${itemCount} Items</span></span>
                            <span class="packet-meta">Created ${time}</span>
                        </div>
                        <div class="packet-card-actions">
                            <button class="play-btn" title="Open Packet" data-id="${rowid}">▶</button>
                            <button class="packet-delete-btn" title="Delete Packet" data-id="${rowid}">🗑</button>
                        </div>
                    </div>`;
                }).join('');

                this.entriesContent.innerHTML = '';
                this.entriesContent.appendChild(addBtn);
                this.entriesContent.insertAdjacentHTML('beforeend', `<div class="packet-list">${html}</div>`);

                // Add play + delete handlers
                this.entriesContent.querySelectorAll('.play-btn').forEach((btn, idx) => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();

                        // Show details immediately
                        const [rowid, name, urlsJson] = rows[idx];
                        this.showPacketDetailView({
                            id: rowid,
                            name: name,
                            urls: JSON.parse(urlsJson)
                        });

                        const originalText = btn.textContent;
                        btn.textContent = '⏳';
                        try {
                            await this.sendMessage({ action: 'playPacket', id: btn.dataset.id });
                            btn.textContent = '✅';
                            setTimeout(() => btn.textContent = originalText, 1500);
                        } catch (error) {
                            console.error('Play failed:', error);
                            btn.textContent = '❌';
                            this.showNotification('Failed to open packet', 'error');
                            setTimeout(() => btn.textContent = originalText, 1500);
                        }
                    });
                });

                this.entriesContent.querySelectorAll('.packet-delete-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (!confirm('Delete this packet?')) return;
                        try {
                            const resp = await this.sendMessage({ action: 'deletePacket', id: btn.dataset.id });
                            if (!resp || !resp.success) throw new Error(resp?.error || 'Delete failed');
                            await this.loadPackets();
                        } catch (err) {
                            console.error('Delete packet failed:', err);
                            this.showNotification('Failed to delete packet: ' + err.message, 'error');
                        }
                    });
                });
            } else {
                this.entryCount.textContent = '0';
                this.entriesContent.innerHTML = '';
                const addBtn = document.createElement('button');
                addBtn.className = 'btn btn-primary btn-sm';
                addBtn.style.marginBottom = '12px';
                addBtn.innerHTML = '＋ Add Packet';
                addBtn.addEventListener('click', () => this.showConstructorView());
                this.entriesContent.appendChild(addBtn);
                this.entriesContent.insertAdjacentHTML('beforeend', '<p class="hint">No packets yet. Click above to create one.</p>');
            }
        } catch (error) {
            console.error('Failed to load packets:', error);
            this.entriesContent.innerHTML = '<p class="hint">Failed to load packets.</p>';
        }
    }

    // ===== SCHEMAS COLLECTION =====

    async loadSchemas() {
        this.entryCount.textContent = '...';
        this.entriesContent.innerHTML = '<p class="hint">Loading schemas...</p>';

        try {
            const resp = await this.sendMessage({ action: 'listSchemas' });
            if (!resp.success) throw new Error(resp.error || 'Failed to load schemas');

            const schemas = resp.schemas;
            this.entryCount.textContent = schemas.length + 1; // +1 for built-in

            const addBtn = document.createElement('button');
            addBtn.className = 'btn btn-primary btn-sm';
            addBtn.style.marginBottom = '12px';
            addBtn.innerHTML = '\uff0b Add Schema';
            addBtn.addEventListener('click', () => this.showSchemaConstructorView());

            this.entriesContent.innerHTML = '';
            this.entriesContent.appendChild(addBtn);

            // Always show the built-in packets schema
            const BUILTIN_PACKETS_SQL =
                `CREATE TABLE IF NOT EXISTS packets (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  urls    TEXT NOT NULL,  -- JSON array of URL strings
  created TEXT NOT NULL DEFAULT (datetime('now'))
);`;
            const builtinCard = document.createElement('div');
            builtinCard.className = 'schema-repo-card schema-repo-card--builtin';
            builtinCard.innerHTML = `
                <div class="schema-repo-card-info">
                    <div class="schema-repo-card-name">
                        packet <span class="schema-builtin-badge">built-in</span>
                    </div>
                    <div class="schema-repo-card-preview">${this.escapeHtml(BUILTIN_PACKETS_SQL.replace(/\s+/g, ' ').trim().slice(0, 80))}…</div>
                </div>
                <button class="schema-view-sql-btn">View SQL</button>`;
            builtinCard.querySelector('.schema-view-sql-btn').addEventListener('click', () => {
                this.showSchemaSqlViewer('packet', BUILTIN_PACKETS_SQL);
            });
            this.entriesContent.appendChild(builtinCard);

            if (schemas.length === 0) {
                this.entriesContent.insertAdjacentHTML('beforeend', '<p class="hint">No custom schemas yet. Click above to add one.</p>');
                return;
            }

            schemas.forEach(({ id, name, sql }) => {
                const preview = sql.replace(/\s+/g, ' ').trim().slice(0, 80);
                const card = document.createElement('div');
                card.className = 'schema-repo-card';
                card.innerHTML = `
                    <div class="schema-repo-card-info">
                        <div class="schema-repo-card-name">${this.escapeHtml(name)}</div>
                        <div class="schema-repo-card-preview">${this.escapeHtml(preview)}…</div>
                    </div>
                    <div class="packet-card-actions">
                        <button class="schema-view-sql-btn">View SQL</button>
                        <button class="schema-repo-delete-btn" title="Delete Schema" data-id="${id}">🗑</button>
                    </div>`;

                card.querySelector('.schema-view-sql-btn').addEventListener('click', () => {
                    this.showSchemaSqlViewer(name, sql);
                });

                card.querySelector('.schema-repo-delete-btn').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete schema "${name}"?`)) return;
                    try {
                        const delResp = await this.sendMessage({ action: 'deleteSchema', id });
                        if (!delResp || !delResp.success) throw new Error(delResp?.error || 'Delete failed');
                        await this.loadSchemas();
                    } catch (err) {
                        console.error('Delete schema failed:', err);
                        this.showNotification('Failed to delete schema: ' + err.message, 'error');
                    }
                });

                this.entriesContent.appendChild(card);
            });
        } catch (error) {
            console.error('Failed to load schemas:', error);
            this.entriesContent.innerHTML = '<p class=\"hint\">Failed to load schemas.</p>';
        }
    }

    async saveSchemaToRepo() {
        const name = this.schemaRepoNameInput.value.trim();
        const sql = this.schemaRepoSqlInput.value.trim();
        if (!name) {
            this.schemaRepoNameInput.focus();
            this.showNotification('Please enter a schema name', 'error');
            return;
        }
        if (!sql) {
            this.schemaRepoSqlInput.focus();
            this.showNotification('Please enter the SQL', 'error');
            return;
        }
        try {
            const saveBtn = document.getElementById('saveSchemaRepoBtn');
            saveBtn.disabled = true;
            saveBtn.textContent = '\u23f3 Saving\u2026';
            const resp = await this.sendMessage({ action: 'saveSchema', name, sql });
            if (!resp || !resp.success) throw new Error(resp?.error || 'Save failed');
            this.showDetailView('schemas');
        } catch (err) {
            console.error('saveSchemaToRepo failed:', err);
            this.showNotification('Failed to save schema: ' + err.message, 'error');
            const saveBtn = document.getElementById('saveSchemaRepoBtn');
            saveBtn.disabled = false;
            saveBtn.textContent = '\ud83d\udcbe Save Schema';
        }
    }

    discardSchemaConstructor() {
        const hasContent = this.schemaRepoNameInput.value.trim() || this.schemaRepoSqlInput.value.trim();
        if (hasContent && !confirm('Discard this schema?')) return;
        this.showDetailView('schemas');
    }

    async openSchemaPicker() {
        try {
            const resp = await this.sendMessage({ action: 'listSchemas' });
            if (!resp.success) throw new Error(resp.error || 'Failed to load schemas');

            const schemas = resp.schemas;
            this.schemaPickerList.innerHTML = '';

            if (schemas.length === 0) {
                this.schemaPickerList.innerHTML = '<p class="schema-picker-empty">No schemas saved yet.<br>Add schemas via the 📂 Schemas collection.</p>';
            } else {
                schemas.forEach(({ id, name, sql }) => {
                    const preview = sql.replace(/\s+/g, ' ').trim().slice(0, 100);
                    const item = document.createElement('div');
                    item.className = 'schema-picker-item';
                    item.innerHTML = `
                        <div class="schema-picker-item-name">${this.escapeHtml(name)}</div>
                        <div class="schema-picker-item-preview">${this.escapeHtml(preview)}\u2026</div>`;
                    item.addEventListener('click', () => {
                        this.schemaTextarea.value = sql;
                        this.closeSchemaPicker();
                    });
                    this.schemaPickerList.appendChild(item);
                });
            }

            this.schemaPickerOverlay.classList.remove('hidden');
        } catch (err) {
            console.error('openSchemaPicker failed:', err);
            this.showNotification('Failed to load schema repository', 'error');
        }
    }

    closeSchemaPicker() {
        this.schemaPickerOverlay.classList.add('hidden');
    }

    showSchemaSqlViewer(name, sql) {
        this.schemaSqlViewerTitle.textContent = name;
        this.schemaSqlViewerContent.textContent = sql;
        this.schemaSqlViewerOverlay.classList.remove('hidden');
    }

    closeSchemaSqlViewer() {
        this.schemaSqlViewerOverlay.classList.add('hidden');
    }

    // ===== PACKET CONSTRUCTOR =====


    async addCurrentTab() {
        try {
            const resp = await this.sendMessage({ action: 'getCurrentTab' });
            if (!resp.success) throw new Error(resp.error || 'Could not get current tab');
            const { title, url } = resp.tab;
            // Avoid duplicates (checking URLs only)
            if (this.constructorItems.some(item => item.type === 'link' && item.url === url)) {
                this.showNotification('Tab already added', 'error');
                return;
            }
            this.constructorItems.push({ type: 'link', title: title || url, url });
            this.renderConstructorItems();
        } catch (err) {
            console.error('addCurrentTab failed:', err);
            this.showNotification('Could not get current tab', 'error');
        }
    }

    async handleWasmFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const arrayBuffer = await file.arrayBuffer();
            const binaryString = new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '');
            const base64 = btoa(binaryString);

            this.constructorItems.push({
                type: 'wasm',
                name: file.name,
                data: base64
            });
            this.renderConstructorItems();
            this.showNotification(`Added ${file.name}`, 'success');
        } catch (err) {
            console.error('Failed to read WASM file:', err);
            this.showNotification('Failed to read WASM file', 'error');
        }

        // Reset input so same file can be selected again if removed
        event.target.value = '';
    }

    renderConstructorItems() {
        if (this.constructorItems.length === 0) {
            this.constructorList.innerHTML = '<p class="hint constructor-empty">No tabs added yet. Click "Add Current Tab" to start.</p>';
            return;
        }

        this.constructorList.innerHTML = '';
        this.constructorItems.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'constructor-card';
            card.draggable = true;
            card.dataset.index = index;

            if (item.type === 'wasm') {
                card.classList.add('wasm');
                card.innerHTML = `
                    <span class="drag-handle" title="Drag to reorder">⠿</span>
                    <div class="constructor-card-info">
                        <div class="constructor-card-title">
                            <span class="type-badge wasm">WASM</span>
                            ${this.escapeHtml(item.name)}
                        </div>
                        <div class="constructor-card-url" style="color:var(--text-muted);">${item.zigCode ? 'Generated Zig Code' : 'Binary Module'}</div>
                    </div>
                    <button class="constructor-remove-btn" title="Remove" data-index="${index}">🗑</button>`;
            } else {
                // Link
                card.innerHTML = `
                    <span class="drag-handle" title="Drag to reorder">⠿</span>
                    <div class="constructor-card-info">
                        <div class="constructor-card-title">
                            <span class="type-badge web">WEB</span>
                            ${this.escapeHtml(item.title)}
                        </div>
                        <div class="constructor-card-url">${this.escapeHtml(item.url)}</div>
                    </div>
                    <button class="constructor-remove-btn" title="Remove" data-index="${index}">🗑</button>`;
            }

            // Drag events
            card.addEventListener('dragstart', (e) => {
                this.dragSrcIndex = index;
                card.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });
            card.addEventListener('dragend', () => card.classList.remove('dragging'));
            card.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                card.classList.add('drag-over');
            });
            card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
            card.addEventListener('drop', (e) => {
                e.preventDefault();
                card.classList.remove('drag-over');
                const targetIndex = parseInt(card.dataset.index);
                if (this.dragSrcIndex !== null && this.dragSrcIndex !== targetIndex) {
                    const moved = this.constructorItems.splice(this.dragSrcIndex, 1)[0];
                    this.constructorItems.splice(targetIndex, 0, moved);
                    this.dragSrcIndex = null;
                    this.renderConstructorItems();
                }
            });

            // Remove button
            card.querySelector('.constructor-remove-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.constructorItems.splice(index, 1);
                this.renderConstructorItems();
            });

            this.constructorList.appendChild(card);
        });
    }

    async savePacket() {
        if (this.constructorItems.length === 0) {
            this.showNotification('Add at least one item first', 'error');
            return;
        }
        const name = window.prompt('Name this packet:');
        if (!name || !name.trim()) return; // user cancelled or left blank

        // Pass the whole items array (urls field in name only now)
        const items = this.constructorItems;
        try {
            const saveBtn = document.getElementById('savePacketBtn');
            saveBtn.disabled = true;
            saveBtn.textContent = '⏳ Saving…';
            const resp = await this.sendMessage({ action: 'savePacket', name: name.trim(), urls: items });
            if (!resp || !resp.success) {
                throw new Error(resp?.error || 'Save failed');
            }
            this.showDetailView('packets');
        } catch (err) {
            console.error('savePacket failed:', err);
            this.showNotification('Failed to save packet: ' + err.message, 'error');
            const saveBtn = document.getElementById('savePacketBtn');
            saveBtn.disabled = false;
            saveBtn.textContent = '💾 Save Packet';
        }
    }

    async saveItemBinaryToPacket(item) {
        if (!this.currentPacket) return;
        try {
            // Update the items array in the database
            await this.sendMessage({
                action: 'savePacket',
                name: this.currentPacket.name,
                urls: this.currentPacket.urls
            });
            console.log('Stored compiled binary for', item.name);
        } catch (err) {
            console.error('Failed to save updated packet with binary:', err);
        }
    }

    discardPacket() {
        if (this.constructorItems.length > 0) {
            if (!confirm('Discard this packet?')) return;
        }
        this.showDetailView('packets');
    }

    // ===== SCHEMA MODAL =====

    openSchemaModal() {
        // Pre-fill with existing schema SQL if available
        if (this.currentSchema.length > 0) {
            this.schemaTextarea.value = this.currentSchema.map(t => t.sql).join(';\n\n') + ';';
        } else {
            this.schemaTextarea.value = '';
        }
        this.schemaModal.classList.remove('hidden');
        this.schemaTextarea.focus();
    }

    closeSchemaModal() {
        this.schemaModal.classList.add('hidden');
    }

    async saveSchema() {
        const sql = this.schemaTextarea.value.trim();
        if (!sql) {
            this.showNotification('Please enter a CREATE TABLE statement', 'error');
            return;
        }

        // Validate that there's at least one CREATE TABLE statement
        if (!/CREATE\s+TABLE/i.test(sql)) {
            this.showNotification('No CREATE TABLE statement found', 'error');
            return;
        }

        try {
            const response = await this.sendMessage({
                action: 'setSchema',
                name: this.currentCollection,
                createSQL: sql
            });

            if (response.success) {
                this.closeSchemaModal();
                this.showNotification(`Schema saved for "${this.currentCollection}"`, 'success');
                this.loadCollectionDetail(this.currentCollection);
            } else {
                this.showNotification(`Error: ${response.error}`, 'error');
            }
        } catch (error) {
            this.showNotification('Failed to save schema', 'error');
        }
    }

    // ===== COLLECTION ACTIONS =====

    async createCollection() {
        const name = prompt('Enter collection name:');
        if (!name || !name.trim()) return;

        try {
            const response = await this.sendMessage({ action: 'createCollection', name: name.trim() });
            if (response.success) {
                this.loadCollections();
                this.showNotification(`Collection "${name}" created`, 'success');
            }
        } catch (error) {
            this.showNotification('Failed to create collection', 'error');
        }
    }

    async importDatabase() {
        try {
            const [fileHandle] = await window.showOpenFilePicker({
                types: [{
                    description: 'SQLite Database',
                    accept: { 'application/x-sqlite3': ['.db', '.sqlite', '.sqlite3'] }
                }]
            });

            const file = await fileHandle.getFile();
            const name = prompt('Enter collection name:', file.name.replace(/\.(db|sqlite|sqlite3)$/, ''));
            if (!name || !name.trim()) return;

            const arrayBuffer = await file.arrayBuffer();
            // Convert to plain Array so it survives chrome.runtime.sendMessage serialization
            const data = Array.from(new Uint8Array(arrayBuffer));
            const response = await this.sendMessage({
                action: 'importFromBlob',
                name: name.trim(),
                data
            });

            if (response.success) {
                this.loadCollections();
                this.showNotification(`Database imported as "${name}"`, 'success');
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Import failed:', error);
                this.showNotification('Failed to import database', 'error');
            }
        }
    }

    async exportCollection(name) {
        try {
            const response = await this.sendMessage({ action: 'exportToBlob', name });
            if (response.success) {
                const uint8Array = new Uint8Array(response.data);
                const blob = new Blob([uint8Array], { type: 'application/x-sqlite3' });

                const fileHandle = await window.showSaveFilePicker({
                    suggestedName: `${name}.db`,
                    types: [{ description: 'SQLite Database', accept: { 'application/x-sqlite3': ['.db'] } }]
                });

                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();

                this.showNotification(`Collection "${name}" exported`, 'success');
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Export failed:', error);
                this.showNotification('Failed to export collection', 'error');
            }
        }
    }

    async saveCheckpoint(name) {
        try {
            const response = await this.sendMessage({ action: 'saveCheckpoint', name });
            if (response.success) {
                this.showNotification(`Checkpoint saved for "${name}"`, 'success');
            }
        } catch (error) {
            this.showNotification('Failed to save checkpoint', 'error');
        }
    }

    async restoreCheckpoint(name) {
        if (!confirm(`Restore "${name}" to last checkpoint? Current changes will be lost.`)) return;

        try {
            const response = await this.sendMessage({ action: 'restoreCheckpoint', name });
            if (response.success) {
                if (response.restored) {
                    this.showNotification(`Collection "${name}" restored`, 'success');
                    if (this.currentCollection === name) {
                        this.loadCollectionDetail(name);
                    }
                } else {
                    this.showNotification('No checkpoint found', 'error');
                }
            }
        } catch (error) {
            this.showNotification('Failed to restore checkpoint', 'error');
        }
    }

    async deleteCollection(name) {
        if (!confirm(`Delete collection "${name}"? This cannot be undone.`)) return;

        try {
            const response = await this.sendMessage({ action: 'deleteCollection', name });
            if (response.success) {
                this.showNotification(`Collection "${name}" deleted`, 'success');
                if (this.currentCollection === name) {
                    this.showListView();
                } else {
                    this.loadCollections();
                }
            }
        } catch (error) {
            this.showNotification('Failed to delete collection', 'error');
        }
    }

    // ===== UTILITIES =====

    sendMessage(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, response => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(response);
                }
            });
        });
    }

    async showEntryPreview(collection, table, rowId) {
        try {
            this.entryDataTable.innerHTML = '<tr><td colspan="2" class="hint">Loading...</td></tr>';
            this.entryPreviewTitle.textContent = `Entry Preview: ${table} #${rowId}`;
            this.entryPreviewModal.classList.remove('hidden');

            const resp = await this.sendMessage({
                action: 'getEntry',
                name: collection,
                tableName: table,
                rowId
            });

            if (resp.success && resp.row) {
                let html = '';
                for (const [key, value] of Object.entries(resp.row)) {
                    html += `
                        <tr>
                            <th>${this.escapeHtml(key)}</th>
                            <td>${this.escapeHtml(String(value))}</td>
                        </tr>
                    `;
                }
                this.entryDataTable.innerHTML = html;
            } else {
                this.entryDataTable.innerHTML = `<tr><td colspan="2" class="hint">Error: ${resp.error || 'Entry not found'}</td></tr>`;
            }
        } catch (error) {
            console.error('Failed to show entry preview:', error);
            this.entryDataTable.innerHTML = '<tr><td colspan="2" class="hint">Failed to load entry details.</td></tr>';
        }
    }

    escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    showNotification(message, type = 'info') {
        console.log(`[${type.toUpperCase()}] ${message}`);

        const notification = document.createElement('div');
        notification.textContent = message;
        notification.style.cssText = `
          position: fixed; top: 16px; right: 16px;
          padding: 10px 16px;
          background: ${type === 'success' ? '#10b981' : '#ef4444'};
          color: white; border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          z-index: 1000; font-size: 13px;
          animation: slideIn 0.25s ease-out;
        `;

        document.body.appendChild(notification);
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.25s ease-out';
            setTimeout(() => notification.remove(), 250);
        }, 3000);
    }
    showSettingsView() {
        this.hideAllViews();
        this.geminiApiKeyInput.value = this.geminiApiKey;
        this.geminiSystemPromptInput.value = this.geminiSystemPrompt || DEFAULT_SYSTEM_INSTRUCTION;
        this.settingsView.classList.add('active');
        this.renderModelSelect();
    }

    renderModelSelect() {
        // Only keep the 'Select a model...' option if no models are fetched
        const models = JSON.parse(localStorage.getItem('geminiAvailableModels') || '[]');
        this.geminiModelSelect.innerHTML = '<option value="">Select a model...</option>';

        models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.name; // e.g. "models/gemini-1.5-pro"
            option.textContent = model.displayName || model.name;
            if (model.name === this.geminiModel) {
                option.selected = true;
            }
            this.geminiModelSelect.appendChild(option);
        });
    }

    async saveSettings() {
        const apiKey = this.geminiApiKeyInput.value.trim();
        const model = this.geminiModelSelect.value;
        const systemPrompt = this.geminiSystemPromptInput.value.trim();
        this.geminiApiKey = apiKey;
        this.geminiModel = model;
        this.geminiSystemPrompt = systemPrompt;
        await chrome.storage.local.set({
            geminiApiKey: apiKey,
            geminiModel: model,
            geminiSystemPrompt: systemPrompt
        });
        this.checkAiFeatureAvailability();
        this.showListView();
    }

    restoreDefaultPrompt() {
        if (confirm('Restore default system instructions? This will overwrite your current changes.')) {
            this.geminiSystemPromptInput.value = DEFAULT_SYSTEM_INSTRUCTION;
        }
    }

    async loadSettings() {
        const data = await chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'geminiSystemPrompt']);
        this.geminiApiKey = data.geminiApiKey || '';
        this.geminiModel = data.geminiModel || '';
        this.geminiSystemPrompt = data.geminiSystemPrompt || '';

        // Populate UI
        this.geminiApiKeyInput.value = this.geminiApiKey;
        this.geminiSystemPromptInput.value = this.geminiSystemPrompt || DEFAULT_SYSTEM_INSTRUCTION;
        this.renderModelSelect();
        this.geminiModelSelect.value = this.geminiModel;

        this.checkAiFeatureAvailability();
    }

    async fetchAvailableModels() {
        const apiKey = this.geminiApiKeyInput.value.trim();
        if (!apiKey) {
            this.modelFetchStatus.textContent = 'Please enter an API key first.';
            return;
        }

        this.modelFetchStatus.textContent = 'Fetching models...';
        this.fetchModelsBtn.disabled = true;

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
            const response = await fetch(url);

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error?.message || 'Failed to fetch models');
            }

            const data = await response.json();
            // Filter for models that support generateContent
            const models = (data.models || []).filter(m => m.supportedGenerationMethods.includes('generateContent'));

            localStorage.setItem('geminiAvailableModels', JSON.stringify(models));
            this.renderModelSelect();
            this.modelFetchStatus.textContent = `Found ${models.length} models.`;
        } catch (error) {
            console.error('Failed to fetch models:', error);
            this.modelFetchStatus.textContent = 'Error: ' + error.message;
        } finally {
            this.fetchModelsBtn.disabled = false;
        }
    }

    checkAiFeatureAvailability() {
        if (this.geminiApiKey) {
            this.aiGenerateWasmBtn.classList.remove('hidden');
        } else {
            this.aiGenerateWasmBtn.classList.add('hidden');
        }
    }

    openAiPromptModal() {
        this.aiPromptModal.classList.remove('hidden');
        this.aiPromptTextarea.value = '';
        this.aiPromptTextarea.focus();
        this.aiStatus.classList.add('hidden');
        this.aiGenerateBtn.disabled = false;
    }

    closeAiPromptModal() {
        this.aiPromptModal.classList.add('hidden');
    }

    async generateWasmWithAi() {
        const originalPrompt = this.aiPromptTextarea.value.trim();
        if (!originalPrompt) return;

        this.aiStatus.classList.remove('hidden');
        this.aiGenerateBtn.disabled = true;

        let currentPrompt = originalPrompt;
        let lastError = null;
        let lastCode = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                this.aiStatusText.textContent = `Calling Gemini (Attempt #${attempt})...`;
                const wits = await this.getWitsContext();
                const dbContext = await this.getDatabaseContext();

                // Augment prompt if this is a retry
                let finalPrompt = currentPrompt;
                if (attempt > 1 && lastError) {
                    finalPrompt = `${originalPrompt}\n\nIMPORTANT: Your previous attempt failed to compile. Please fix the errors below.\n\nPREVIOUS CODE:\n\`\`\`zig\n${lastCode}\n\`\`\`\n\nCOMPILER ERROR:\n${lastError}`;
                }

                const zigCode = await this.callGeminiApi(finalPrompt, wits, dbContext);
                lastCode = zigCode;

                // 3. Compile Zig to WASM (Validation)
                if (typeof compileZigCode === 'undefined') {
                    throw new Error('Zig compiler not loaded');
                }
                this.aiStatusText.textContent = `Validating (Attempt #${attempt})...`;
                const wasmBytes = await compileZigCode(zigCode, (status) => {
                    this.aiStatusText.textContent = `${status} (Attempt #${attempt})...`;
                });

                // Convert binary to base64 for storage
                const base64 = this.arrayBufferToBase64(wasmBytes);

                // Add to constructor as a Zig module with pre-compiled binary
                this.constructorItems.push({
                    type: 'wasm',
                    name: 'ai_generated.zig',
                    zigCode: zigCode,
                    data: base64,
                    prompt: originalPrompt
                });
                this.renderConstructorItems();

                this.showNotification('WASM logic generated, validated, and added to packet!', 'success');
                this.closeAiPromptModal();
                return; // Success!

            } catch (error) {
                lastError = error.message;
                console.error(`AI generation/validation failed (Attempt #${attempt}):`, error);

                if (attempt < 3) {
                    this.aiStatusText.textContent = `Error in #${attempt}. Retrying...`;
                    // Wait a moment before retrying
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    this.aiStatusText.textContent = 'Final effort failed: ' + error.message;
                    this.aiGenerateBtn.disabled = false;
                }
            }
        }
    }

    showWasmResults(logs, result, success, error) {
        this.wasmResultModal.classList.remove('hidden');

        if (success) {
            this.wasmResultValue.textContent = result;
            this.wasmResultValue.style.color = '#10b981';
        } else {
            this.wasmResultValue.textContent = 'Error: ' + error;
            this.wasmResultValue.style.color = '#ef4444';
        }

        if (logs && logs.length > 0) {
            this.wasmLogContent.textContent = logs.join('\n');
        } else {
            this.wasmLogContent.textContent = 'No logs produced.';
        }
    }

    async getDatabaseContext() {
        try {
            const collections = await this.sendMessage({ action: 'listCollections' });
            if (!collections.success) return 'No collections available.';

            let context = '';
            for (const name of collections.collections) {
                const schemaResp = await this.sendMessage({ action: 'getSchema', name });
                if (schemaResp.success) {
                    context += `\nCollection: "${name}"\n`;
                    for (const table of schemaResp.schema) {
                        context += `  Table: "${table.name}"\n`;
                        context += `    Schema: ${table.sql}\n`;
                    }
                }
            }
            return context || 'No tables found in any collection.';
        } catch (error) {
            console.error('Failed to get database context:', error);
            return 'Error fetching database context.';
        }
    }

    async getWitsContext() {
        const result = await chrome.runtime.sendMessage({
            action: 'executeSQL',
            name: 'wits',
            sql: "SELECT name, wit FROM wits"
        });

        if (result.success && result.result && result.result.length > 0) {
            return result.result[0].values.map(v => `WIT Name: ${v[0]}\nDefinition:\n${v[1]}`).join('\n\n');
        }
        return 'No WIT definitions available.';
    }

    async callGeminiApi(prompt, witsContext, dbContext = '') {
        const apiKey = this.geminiApiKey;
        const modelName = this.geminiModel;

        if (!apiKey) throw new Error('Gemini API key is required in settings');
        if (!modelName) throw new Error('No Gemini model selected in settings');

        const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;

        let systemInstruction = this.geminiSystemPrompt || DEFAULT_SYSTEM_INSTRUCTION;
        systemInstruction = systemInstruction.replace('{{WITS_CONTEXT}}', witsContext);
        systemInstruction = systemInstruction.replace('{{DATABASE_CONTEXT}}', dbContext);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                system_instruction: { parts: [{ text: systemInstruction }] }
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error?.message || 'Gemini API call failed');
        }

        const data = await response.json();
        let zigCode = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Remove markdown code blocks if any
        zigCode = zigCode.replace(/^```zig\n/, '').replace(/^```\n?/, '').replace(/\n```$/, '');

        return zigCode;
    }

    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }
}

// Initialize UI when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new SidebarUI();
});

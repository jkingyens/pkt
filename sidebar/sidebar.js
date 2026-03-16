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
        this.importBtn = document.getElementById('importBtn');

        // Settings view elements
        this.geminiApiKeyInput = document.getElementById('geminiApiKeyInput');
        this.geminiModelSelect = document.getElementById('geminiModelSelect');
        this.fetchModelsBtn = document.getElementById('fetchModelsBtn');
        this.modelFetchStatus = document.getElementById('modelFetchStatus');
        this.settingsBackBtn = document.getElementById('settingsBackBtn');
        this.geminiSystemPromptInput = document.getElementById('geminiSystemPromptInput');
        this.restoreDefaultPromptBtn = document.getElementById('restoreDefaultPromptBtn');
        this.themeLightCard = document.getElementById('themeLight');
        this.themeSystemCard = document.getElementById('themeSystem');
        this.themeDarkCard = document.getElementById('themeDark');
        this.networkAccessToggle = document.getElementById('networkAccessToggle');
        this.webAuthnToggle = document.getElementById('webAuthnToggle');
        this.lockScreen = document.getElementById('lockScreen');
        this.unlockBtn = document.getElementById('unlockBtn');

        this.terminalTabs = {}; // packetId -> tabId

        // Detail view elements
        this.detailTitle = document.getElementById('detailTitle');
        this.schemaContent = document.getElementById('schemaContent');
        this.entriesContent = document.getElementById('entriesContent');
        this.entryCount = document.getElementById('entryCount');
        this.addPacketFloatingBtn = document.getElementById('addPacketFloatingBtn');

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
        this.packetPageList = document.getElementById('packetPageList');
        this.packetStackList = document.getElementById('packetStackList');
        this.packetStackCount = document.getElementById('packetStackCount');
        this.packetDataCount = document.getElementById('packetDataCount');
        this.packetDataList = document.getElementById('packetDataList');
        this.mediaDropZone = document.getElementById('mediaDropZone');
        this.mediaAddOptions = document.getElementById('mediaAddOptions');
        this.mediaAudioRecordBtn = document.getElementById('mediaAudioRecordBtn');
        this.mediaTabAudioRecordBtn = document.getElementById('mediaTabAudioRecordBtn');
        this.mediaVideoRecordBtn = document.getElementById('mediaVideoRecordBtn');
        this.mediaTabVideoRecordBtn = document.getElementById('mediaTabVideoRecordBtn');
        this.addMediaDetailBtn = document.getElementById('addMediaDetailBtn');
        this.addPageDetailBtn = document.getElementById('addPageDetailBtn');
        this.addStackDetailBtn = document.getElementById('addStackDetailBtn');
        this.addPageFromTabBtn = document.getElementById('addPageFromTabBtn');
        this.addPageNewBtn = document.getElementById('addPageNewBtn');
        this.createNewStackBtn = document.getElementById('createNewStackBtn');
        this.editToggleBtn = document.getElementById('editToggleBtn');
        this.deletePacketDetailBtn = document.getElementById('deletePacketDetailBtn');
        this.terminalOpenBtn = document.getElementById('terminalOpenBtn');

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
        this.aiGenerateWasmDetailBtn = document.getElementById('aiGenerateWasmDetailBtn');

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

        // Status indicator elements
        this.statusIndicator = document.getElementById('statusIndicator');

        // State
        this.currentCollection = null;
        this.currentSchema = [];
        this.constructorItems = []; // Array of { type: 'page'|'wasm', ... }
        this.activePacketGroupId = null;
        this.dragSrcIndex = null;
        this.geminiApiKey = '';
        this.geminiModel = '';
        this.geminiSystemPrompt = '';
        this.theme = 'system';
        this.networkEnabled = true;
        this.activeUrl = null;
        this.processedMediaIds = new Set();
        this.isClipperManuallyCancelled = false;
        this.isAudioRecording = false;
        this.isTabAudioRecording = false;
        this.isVideoRecording = false;
        this.isTabVideoRecording = false;
        this.isClipperInvoked = false; // Manual activation state for activeTab
        this.isClipperIconProcessing = false; // Guard for rapid clicks
        this.activeCaptureTabId = null; // Track which tab has the capture indicator
        this.editMode = false;
        this.webAuthnEnabled = false;
        this.webAuthnCredentialId = null;
        this.isVerified = false;
        this.consecutiveFailures = 0;
        this.MAX_CONSECUTIVE_FAILURES = 3;
        this.pendingVideoClip = false;
        this.pendingVideoRegion = null;

        this.setupEventListeners();
        this.setupMessageHandlers();

        // Global window drag/drop handlers to prevent browser from opening dropped files
        window.addEventListener('dragover', (e) => e.preventDefault(), false);
        window.addEventListener('drop', (e) => e.preventDefault(), false);

        // Online status listeners
        window.addEventListener('online', () => this.updateOnlineStatus());
        window.addEventListener('offline', () => this.updateOnlineStatus());
        
        // Theme listener
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (this.theme === 'system') {
                this.applyTheme();
            }
        });
        
        // Polling fallback every 5s (sometimes extension side panels miss window events)
        setInterval(() => this.updateOnlineStatus(), 5000);

        // Consolidated initialization flow
        this.init();

        // Establish a persistent connection to the background script
        // This allows the service worker to detect when the sidebar is open
        this.connectToBackground();
    }

    async init() {
        try {
            // 1. Core setup (Settings and theme)
            await this.loadSettings();
            
            // 2. WebAuthn protection
            if (this.webAuthnEnabled && !this.isVerified) {
                this.showLockScreen();
                // We return here. verifyWebAuthn will call continueInit()
                return;
            }

            await this.continueInit();
        } catch (e) {
            console.error('[SidebarUI] Initialization failed:', e);
        }
    }

    async continueInit() {
        try {
            // 2. Load collections
            await this.loadCollections();
            this.updateOnlineStatus();

            // 3. Check for pending actions (highest priority)
            const { pendingAction } = await chrome.storage.local.get('pendingAction');
            if (pendingAction === 'newPacketWithTab') {
                await chrome.storage.local.remove('pendingAction');
                this.handleTriggerNewPacketWithTab();
                return; // Initialization complete, pending action took precedence
            }

            // 4. Fallback to active packet/tab group check
            await this.checkActivePacket();

            // 5. Sync terminal state
            await this.syncTerminalState();
        } catch (e) {
            console.error('[SidebarUI] continueInit failed:', e);
        }
    }

    connectToBackground() {
        try {
            this.port = chrome.runtime.connect({ name: 'sidebar' });
            this.port.onMessage.addListener((msg) => {
                if (msg.type === 'PROXY_KEY_DOWN') {
                    // Create a synthetic event that handleKeyDown expects
                    const syntheticEvent = {
                        key: msg.key,
                        shiftKey: msg.shiftKey,
                        altKey: msg.altKey,
                        ctrlKey: msg.ctrlKey,
                        metaKey: msg.metaKey,
                        preventDefault: () => { },
                        target: { tagName: 'PROXY' } // Avoid input check
                    };
                    this.handleKeyDown(syntheticEvent);
                } else if (msg.type === 'ITEM_NAVIGATED') {
                    // Background moved the focus (sidebar might be closed or unfocused)
                    if (this.currentPacket && String(this.currentPacket.id) === String(msg.packetId)) {
                        this.lastNavigatedIndex = msg.index;
                        const type = (typeof msg.item === 'object') ? (msg.item.type || 'page') : 'page';
                        if (type === 'page' || type === 'link') {
                            this.activeUrl = typeof msg.item === 'string' ? msg.item : msg.item.url;
                        } else if (type === 'media') {
                            this.activeUrl = chrome.runtime.getURL(`sidebar/media.html?id=${msg.item.mediaId}&type=${encodeURIComponent(msg.item.mimeType)}&name=${encodeURIComponent(msg.item.name)}`);
                        }
                        // Refresh view to show highlight
                        this.showPacketDetailView(this.currentPacket);
                    }
                } else if (msg.type === 'RUN_WASM_ITEM_SYNC') {
                    // Background already executed it, sidebar just needs to show results if open
                    if (this.currentPacket && msg.index !== undefined) {
                        this.lastNavigatedIndex = msg.index;
                        // Trigger UI refresh to show highlight on the function item
                        this.showPacketDetailView(this.currentPacket);
                    }
                } else if (msg.type === 'TERMINAL_STATE_CHANGED') {
                    this.terminalTabs = msg.terminalTabs;
                    this.updateTerminalUI();
                }
            });
            this.port.onDisconnect.addListener(() => {
                console.log('[Sidebar] Background connection lost. Reconnecting in 1s...');
                this.port = null;
                setTimeout(() => this.connectToBackground(), 1000);
            });
        } catch (e) {
            console.error('[Sidebar] Failed to connect to background:', e);
            setTimeout(() => this.connectToBackground(), 5000);
        }
    }

    setupMessageHandlers() {
        chrome.runtime.onMessage.addListener((message) => {
            if (message.type === 'packetFocused') {
                if (!message.packet) {
                    this.activeUrl = null;
                    // Only clear group ID if we're not currently looking at a specific packet detail
                    // This prevents switching to an un-grouped tab from breaking the "Sync Tab Order" command
                    if (!this.packetDetailView.classList.contains('active')) {
                        this.activePacketGroupId = null;
                    }
                    this.isClipperInvoked = false;
                    this.resetEditMode(); // Always reset edit mode when navigating to a non-packet tab
                    this.updateClipperState();
                    this.updateAddPageVisibility();
                    this.updateItemHighlights();
                    return;
                }

                this.activeUrl = message.packet.activeUrl || null;
                this.activePacketGroupId = message.packet.groupId || null;
                this.isClipperInvoked = false; // Reset invocation whenever tab focus changes
                
                // If already showing THIS packet, just update highlights surgically
                if (this.packetDetailView.classList.contains('active') && this.currentPacket && String(this.currentPacket.id) === String(message.packet.id)) {
                    this.updateItemHighlights();
                } else {
                    this.showPacketDetailView(message.packet);
                }
                
                // Sync navigation index
                this.lastNavigatedIndex = this.getActiveItemIndex();
                this.updateClipperState();
            } else if (message.type === 'UPDATE_ACTIVE_URL') {
                // Surgical update to avoid view switching/scrolling on navigation within packet
                if (this.packetDetailView.classList.contains('active') && this.currentPacket && String(this.currentPacket.id) === String(message.packetId)) {
                    this.activeUrl = message.url;
                    this.updateItemHighlights();
                    this.updateAddPageVisibility();
                    this.lastNavigatedIndex = this.getActiveItemIndex();
                }
            } else if (message.type === 'CLIPPER_ICON_CLICKED') {
                this.handleToolbarIconClicked(message.tab);
            } else if (message.action === 'triggerNewPacketWithTab') {
                this.handleTriggerNewPacketWithTab();
            } else if (message.type === 'CLIPPER_REGION_SELECTED') {
                this.handleClipperRegionSelected(message.region);
            } else if (message.type === 'CLIPPER_CANCELLED') {
                this.handleClipperCancelled();
            } else if (message.type === 'AUDIO_CLIP_FINISHED' || message.type === 'VIDEO_CLIP_FINISHED') {
                this.isRecording = false;
                this.isAudioRecording = false;
                this.isTabAudioRecording = false;
                this.isVideoRecording = false;
                this.isTabVideoRecording = false;
                this.updateRecordingUI();
                this.handleMediaClipFinished(message.mediaId, message.size, message.mimeType || (message.type === 'VIDEO_CLIP_FINISHED' ? 'video/webm' : 'audio/webm'));
            } else if (message.type === 'RECORDING_STARTED') {
                this.isRecording = true;
                if (message.isVideo) {
                    if (message.streamId) {
                        this.isTabVideoRecording = true;
                    } else {
                        this.isVideoRecording = true;
                    }
                } else {
                    if (message.streamId) {
                        this.isTabAudioRecording = true;
                    } else {
                        this.isAudioRecording = true;
                    }
                }
                this.updateRecordingUI();
            } else if (message.type === 'RECORDING_ERROR') {
                this.isRecording = false;
                this.isAudioRecording = false;
                this.isTabAudioRecording = false;
                this.isVideoRecording = false;
                this.isTabVideoRecording = false;
                this.updateRecordingUI();
                if (message.error && (message.error.includes('NotAllowedError') || message.error.includes('Permission dismissed'))) {
                    this.handlePermissionError();
                } else {
                    this.showNotification('Recording error: ' + message.error, 'error');
                }
            } else if (message.type === 'OFFSCREEN_LOG') {
                console.log('[Offscreen-Relay]', message.message);
            } else if (message.type === 'HOVER_ITEM_START') {
                this.updateHoverHighlight(message.url, true);
            } else if (message.type === 'HOVER_ITEM_END') {
                this.updateHoverHighlight(message.url, false);
            } else if (message.type === 'ACTIVATE_CLIPPER_OVERLAY') {
                this.pendingVideoClip = !!message.isVideo;
                chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
                    if (tab) {
                        chrome.tabs.sendMessage(tab.id, { type: 'SET_CLIPPER_ACTIVE', active: true, islandOnly: false }).catch(() => { });
                    }
                });
            }
        });
    }

    handleTriggerNewPacketWithTab(silent = false) {
        if (this.packetDetailView.classList.contains('active') && this.currentPacket) {
            this.addTabToCurrentPacket();
        } else {
            this.sendMessage({ action: 'getCurrentTab' }).then(resp => {
                if (resp.success) {
                    const { title, url } = resp.tab;
                    this.createAndShowNewPacket([{ type: 'page', title: title || url, url }]);
                } else if (!silent) {
                    this.showNotification('Could not get current tab', 'error');
                }
            });
        }
    }

    async handleToolbarIconClicked(tab) {
        if (this.isClipperIconProcessing) return;
        this.isClipperIconProcessing = true;

        try {
            if (this.isClipperInvoked) {
                // Toggle OFF
                this.isClipperInvoked = false;
                await this.updateClipperState();
            } else {
                // Determine if the current tab is already in a packet group
                const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                const groupId = tab.groupId;

                if (groupId !== -1 && activeGroups[groupId]) {
                    const packetId = activeGroups[groupId];
                    const isCorrectPacketShowing = this.packetDetailView.classList.contains('active') &&
                        this.currentPacket &&
                        this.currentPacket.id === packetId;

                    if (!isCorrectPacketShowing) {
                        // Step 1: Just bring the packet into focus
                        const resp = await this.sendMessage({ action: 'getPacket', id: packetId });
                        if (resp && resp.success && resp.packet) {
                            resp.packet.groupId = groupId;
                            resp.packet.activeUrl = tab.url;
                            this.showPacketDetailView(resp.packet);
                        }
                        this.isClipperInvoked = false; // Stay OFF
                    } else if (this.isMediaPage(tab.url)) {
                        // Step 2: Already showing, but it's a media page - stay OFF
                        this.showNotification('Media overlay not supported on this page type.', 'info');
                        this.isClipperInvoked = false;
                    } else {
                        // Step 2: Already showing, so Toggle ON
                        this.isClipperInvoked = true;
                        this.isClipperManuallyCancelled = false;
                    }
                } else {
                    // Tab is NOT in a packet! 
                    const isPacketDetailActive = this.packetDetailView.classList.contains('active');
                    const isConstructorActive = this.constructorView.classList.contains('active');
                    const isTabInConstructor = this.constructorItems.some(item => item.type === 'link' && item.url === tab.url);

                    if (this.isMediaPage(tab.url)) {
                        // Priority 0: Media page, do nothing (overlay doesn't work)
                        this.showNotification('Media overlay not supported on this page type.', 'info');
                        this.isClipperInvoked = false;
                    } else if (isPacketDetailActive && this.currentPacket) {
                        // Step 2: Packet is focused in detail view, so add directly and stay OFF
                        this.isClipperInvoked = false;
                        await this.addTabToCurrentPacket();
                    } else if (isConstructorActive && isTabInConstructor) {
                        // Step 2: Already in constructor with this tab, so Toggle ON
                        this.isClipperInvoked = true;
                        this.isClipperManuallyCancelled = false;
                    } else {
                        // Step 1: Navigate to constructor and add tab, but stay OFF
                        this.isClipperInvoked = false;
                        this.createAndShowNewPacket([{ type: 'page', title: tab.title || tab.url, url: tab.url }], tab.id);
                    }
                }
                await this.updateClipperState();
            }
        } finally {
            this.isClipperIconProcessing = false;
        }
    }

    async addTabToCurrentPacket() {
        if (!this.currentPacket) return;
        try {
            const resp = await this.sendMessage({ action: 'getCurrentTab' });
            if (!resp.success) throw new Error(resp.error || 'Could not get current tab');
            const { title, url, groupId } = resp.tab;

            // Rule 1: Only add tabs that are not inside existing tab groups
            if (groupId !== -1) {
                this.showNotification('Cannot add tab: It is already in a tab group', 'error');
                return;
            }

            // Rule 2: Only add tabs that are not already included in the packet
            if (this.currentPacket.urls.some(item => {
                const itemUrl = typeof item === 'string' ? item : item.url;
                return this.urlsMatch(itemUrl, url);
            })) {
                this.showNotification('Tab already in packet', 'error');
                return;
            }

            this.currentPacket.urls.push({ type: 'page', title: title || url, url });

            const saveResp = await this.sendMessage({
                action: 'savePacket',
                id: this.currentPacket.id,
                name: this.currentPacket.name,
                urls: this.currentPacket.urls
            });

            if (saveResp && saveResp.success) {
                // ADDITION: Join the packet's tab group immediately
                const joinResp = await this.sendMessage({
                    action: 'joinPacketGroup',
                    tabId: resp.tab.id,
                    packetId: this.currentPacket.id
                });

                if (joinResp && joinResp.success) {
                    this.activePacketGroupId = joinResp.groupId;
                }

                this.showNotification('Added to current packet and grouped', 'success');
                if (this.editMode) this.toggleEditMode();
                this.showPacketDetailView(this.currentPacket);
            } else {
                throw new Error(saveResp?.error || 'Failed to save packet');
            }
        } catch (err) {
            console.error('addTabToCurrentPacket failed:', err);
            this.showNotification('Could not add tab: ' + err.message, 'error');
        }
    }

    async addLocalPage() {
        if (!this.currentPacket) return;
        try {
            const name = 'New Slide';
            const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${name}</title>
    <style>
        :root {
            --primary: #4f46e5;
            --bg: #f8fafc;
            --surface: #ffffff;
            --text: #1e293b;
            --text-muted: #64748b;
            --border: #e2e8f0;
            --radius: 12px;
        }
        body.dark-mode {
            --bg: #0f172a;
            --surface: #1e293b;
            --text: #f1f5f9;
            --text-muted: #94a3b8;
            --border: #334155;
        }
        body { 
            margin: 0; 
            padding: 0; 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: var(--bg);
            color: var(--text);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            transition: background 0.3s;
        }
        #slide-container {
            width: 80%;
            max-width: 900px;
            aspect-ratio: 16 / 9;
            background: var(--surface);
            padding: 60px;
            border-radius: var(--radius);
            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            display: flex;
            flex-direction: column;
            position: relative;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        /* Layout: Title */
        #slide-container.layout-title {
            justify-content: center;
            text-align: center;
        }
        #slide-container.layout-title h1 { font-size: 64px; margin-bottom: 20px; }
        #slide-container.layout-title p { font-size: 24px; color: var(--text-muted); }
        #slide-container.layout-title .content-list { display: none; }

        /* Layout: Content */
        #slide-container.layout-content {
            justify-content: flex-start;
            text-align: left;
        }
        #slide-container.layout-content h1 { font-size: 42px; margin-bottom: 40px; border-bottom: 3px solid var(--primary); display: inline-block; padding-bottom: 10px; }
        #slide-container.layout-content p { display: none; }
        #slide-container.layout-content .content-list { 
            display: block; 
            font-size: 24px; 
            list-style: none; 
            padding: 0; 
        }
        .content-list li {
            margin-bottom: 15px;
            display: flex;
            align-items: flex-start;
        }
        .content-list li::before {
            content: "•";
            color: var(--primary);
            font-weight: bold;
            display: inline-block;
            width: 1em;
            margin-right: 0.5em;
        }

        [contenteditable="true"] {
            outline: none;
            cursor: text;
        }
        [contenteditable="true"]:hover {
            background: rgba(79, 70, 229, 0.05);
            border-radius: 4px;
        }

        #format-toggle {
            position: fixed;
            bottom: 30px;
            right: 30px;
            padding: 12px 24px;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 30px;
            cursor: pointer;
            font-weight: 600;
            box-shadow: 0 4px 15px rgba(79, 70, 229, 0.4);
            z-index: 1000;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        #format-toggle:hover { opacity: 0.9; transform: translateY(-2px); }
    </style>
</head>
<body>
    <script src="${chrome.runtime.getURL('sidebar/theme-init.js')}"></script>
    <div id="slide-container" class="layout-title">
        <h1 id="slide-title" contenteditable="true">Title Goes Here</h1>
        <p id="slide-subtitle" contenteditable="true">Click to edit subtitle...</p>
        <ul id="slide-list" class="content-list" contenteditable="true">
            <li>First bullet item</li>
            <li>Second bullet item</li>
        </ul>
    </div>

    <button id="format-toggle">
        <span>🔄</span>
        <span id="format-text">Switch to Content</span>
    </button>

    <script src="${chrome.runtime.getURL('sidebar/local-editor.js')}"></script>
</body>
</html>`;


            const encoder = new TextEncoder();
            const data = encoder.encode(htmlContent);

            // Generate a unique ID to prevent collisions between slides with the same initial content
            const uniqueId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
                .map(b => b.toString(16).padStart(2, '0')).join('');

            const saveResp = await this.sendMessage({
                action: 'saveMediaBlob',
                id: uniqueId,
                data: Array.from(new Uint8Array(data)),
                type: 'text/html'
            });


            if (saveResp.success) {
                const newItem = {
                    type: 'local',
                    name: name,
                    resourceId: saveResp.id
                };

                this.currentPacket.urls.push(newItem);
                await this.sendMessage({
                    action: 'savePacket',
                    id: this.currentPacket.id,
                    name: this.currentPacket.name,
                    urls: this.currentPacket.urls
                });

                this.showNotification('Local page created', 'success');
                this.showPacketDetailView(this.currentPacket);

                // Open the new page immediately
                const url = chrome.runtime.getURL(`sidebar/viewer.html?id=${saveResp.id}&name=${encodeURIComponent(name)}`);
                await this.sendMessage({ action: 'openTabInGroup', url, groupId: this.activePacketGroupId, packetId: this.currentPacket.id });
            } else {
                throw new Error(saveResp.error || 'Failed to save local page');
            }
        } catch (err) {
            console.error('addLocalPage failed:', err);
            this.showNotification('Could not add local page: ' + err.message, 'error');
        }
    }

    async createNewStack() {
        if (!this.currentPacket) return;
        const name = prompt('Enter a name for the new stack:', 'New Stack');
        if (!name) return;

        try {
            const dbName = `packet_${this.currentPacket.id}`;
            await this.sendMessage({ action: 'ensurePacketDatabase', packetId: this.currentPacket.id });
            
            const sql = `INSERT INTO stacks (name) VALUES ('${name.replace(/'/g, "''")}'); SELECT last_insert_rowid();`;
            const insertResp = await this.sendMessage({
                action: 'executeSQL',
                name: dbName,
                sql: sql
            });

            if (!insertResp.success) throw new Error(insertResp.error);

            // sql-wasm returns results for multiple queries in an array
            // The result of SELECT last_insert_rowid() should be in the last result object
            const results = insertResp.result;
            const lastIdResult = results[results.length - 1];
            const stackId = lastIdResult.values[0][0];
            
            console.log('[Sidebar] Created new stack with ID:', stackId);

            // Persist the new stack to the packet-specific database
            await this.sendMessage({ action: 'saveCheckpoint', name: dbName });

            const stackItem = { 
                type: 'stack', 
                stackId, 
                name, 
                packetId: this.currentPacket.id 
            };
            
            this.currentPacket.urls.push(stackItem);

            const saveResp = await this.sendMessage({
                action: 'savePacket',
                id: this.currentPacket.id,
                name: this.currentPacket.name,
                urls: this.currentPacket.urls
            });

            if (saveResp && saveResp.success) {
                this.showNotification('Stack created', 'success');
                this.showPacketDetailView(this.currentPacket);
                this.activatePacketItem(stackItem, this.currentPacket.urls.length - 1);
            } else {
                throw new Error(saveResp?.error || 'Failed to save packet');
            }
        } catch (err) {
            console.error('createNewStack failed:', err);
            this.showNotification('Could not create stack: ' + err.message, 'error');
        }
    }


    async syncActiveTab() {
        if (!this.currentPacket) return;
        
        // Small delay to let browser tab state settle
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
            const resp = await this.sendMessage({ action: 'getCurrentTab' });
            if (resp && resp.success && resp.tab) {
                this.activeUrl = resp.tab.url;
            } else {
                this.activeUrl = null;
            }
            this.updateItemHighlights();
            if (resp && resp.tab) {
                await this.updateAddPageVisibility(resp.tab);
            }
        } catch (e) {
            console.error('[Sidebar] syncActiveTab failed:', e);
            this.activeUrl = null;
            this.updateItemHighlights();
        }
    }

    /**
     * Surgical update of active classes without destroying DOM nodes.
     * Prevents the "two-click" issue caused by destructive innerHTML calls during focus.
     */
    updateItemHighlights() {
        if (!this.currentPacket) return;
        
        const allCards = document.querySelectorAll('.packet-page-card, .packet-media-card');
        
        // 1. Clear all highlights first
        allCards.forEach(card => card.classList.remove('active'));

        // 2. Focus Management: Clear focus from elements to prevent :focus styles
        // from persisting when moving between cards. 
        if (document.activeElement && 
           (document.activeElement.classList.contains('packet-page-card') || 
            document.activeElement.classList.contains('packet-media-card'))) {
            document.activeElement.blur();
        }

        // 3. Highlight the matching card
        const activeNorm = this.normalizeUrl(this.activeUrl);
        
        allCards.forEach(card => {
            const index = parseInt(card.getAttribute('data-index'), 10);
            const item = this.currentPacket.urls[index];
            if (!item) return;

            const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
            
            // Handle Page/Media/Local types based on activeUrl
            let itemUrl;
            if (type === 'page' || type === 'link') itemUrl = typeof item === 'string' ? item : item.url;
            else if (type === 'local') itemUrl = chrome.runtime.getURL(`sidebar/viewer.html?id=${item.resourceId}&name=${encodeURIComponent(item.name)}`);
            else if (type === 'media') itemUrl = chrome.runtime.getURL(`sidebar/media.html?id=${item.mediaId}&type=${encodeURIComponent(item.mimeType)}&name=${encodeURIComponent(item.name)}`);
            else if (type === 'stack') {
                const sid = item.stackId || item.id;
                if (sid) {
                    itemUrl = chrome.runtime.getURL(`sidebar/stack.html?id=${sid}&packetId=${this.currentPacket.id}&name=${encodeURIComponent(item.name)}`);
                }
            }
            
            if (itemUrl && activeNorm) {
                const itemNorm = this.normalizeUrl(itemUrl);
                if (itemNorm === activeNorm) {
                    card.classList.add('active');
                }
            }

            // Handle Wasm types based on lastNavigatedIndex
            if (type === 'wasm' && index === this.lastNavigatedIndex) {
                card.classList.add('active');
            }
        });
    }

    updateHoverHighlight(url, active) {
        if (!this.currentPacket) return;
        const norm = this.normalizeUrl(url);
        const allCards = document.querySelectorAll('.packet-page-card, .packet-media-card');

        allCards.forEach(card => {
            const index = parseInt(card.getAttribute('data-index'), 10);
            const item = this.currentPacket.urls[index];
            if (!item) return;

            const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
            let itemUrl;
            if (type === 'page' || type === 'link') itemUrl = typeof item === 'string' ? item : item.url;
            else if (type === 'local') itemUrl = chrome.runtime.getURL(`sidebar/viewer.html?id=${item.resourceId}&name=${encodeURIComponent(item.name)}`);
            else if (type === 'media') itemUrl = chrome.runtime.getURL(`sidebar/media.html?id=${item.mediaId}&type=${encodeURIComponent(item.mimeType)}&name=${encodeURIComponent(item.name)}`);
            else if (type === 'stack') {
                const sid = item.stackId; // Strictly use stackId
                if (sid) {
                    itemUrl = chrome.runtime.getURL(`sidebar/stack.html?id=${sid}&packetId=${this.currentPacket.id}&name=${encodeURIComponent(item.name)}`);
                }
            }

            if (itemUrl && norm === this.normalizeUrl(itemUrl)) {
                if (active) {
                    card.classList.add('hover-highlight');
                } else {
                    card.classList.remove('hover-highlight');
                }
            }
        });
    }

    async updateAddPageVisibility(tab) {
        if (!this.currentPacket || !this.addPageFromTabBtn) return;
        try {
            const currentTab = tab || (await this.sendMessage({ action: 'getCurrentTab' })).tab;
            if (currentTab) {
                const { url, groupId } = currentTab;
                const inGroup = groupId !== -1;
                const inPacket = this.currentPacket.urls.some(item => {
                    const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
                    let itemUrl;
                    if (type === 'page' || type === 'link') {
                        itemUrl = typeof item === 'string' ? item : item.url;
                    } else if (type === 'local') {
                        itemUrl = chrome.runtime.getURL(`sidebar/viewer.html?id=${item.resourceId}&name=${encodeURIComponent(item.name)}`);
                    }
                    return itemUrl && this.urlsMatch(itemUrl, url);
                });

                if (inGroup || inPacket) {
                    this.addPageFromTabBtn.style.display = 'none';
                } else {
                    this.addPageFromTabBtn.style.display = 'inline-flex';
                }
            }
        } catch (e) {
            console.error('updateAddPageVisibility failed:', e);
        }
    }


    async checkActivePacket() {
        try {
            const resp = await this.sendMessage({ action: 'getActivePacket' });
            if (resp.success && resp.packet) {
                // If the background found a packet associated with the active tab, show it!
                this.showPacketDetailView(resp.packet);
            }
        } catch (e) {
            console.error('Failed to check active packet:', e);
        }
    }

    setupEventListeners() {
        // List view
        document.getElementById('createBtn').addEventListener('click', () => this.createCollection());
        document.getElementById('importBtn').addEventListener('click', () => this.importDatabase());
        this.settingsBtn.addEventListener('click', async () => {
            await this.checkEmptyPacketGarbageCollector();
            this.showSettingsView();
        });

        // Settings view
        this.settingsBackBtn.addEventListener('click', () => this.showListView());
        this.geminiApiKeyInput.addEventListener('input', () => this.saveApiKey(true));
        this.geminiSystemPromptInput.addEventListener('input', () => this.savePrompt(true));
        this.fetchModelsBtn.addEventListener('click', () => this.fetchAvailableModels());
        this.themeLightCard.addEventListener('click', () => this.setTheme('light'));
        this.themeSystemCard.addEventListener('click', () => this.setTheme('system'));
        this.themeDarkCard.addEventListener('click', () => this.setTheme('dark'));
        this.geminiModelSelect.addEventListener('change', () => this.saveAutoSettings());
        this.networkAccessToggle.addEventListener('change', () => this.saveNetworkSettings());
        this.restoreDefaultPromptBtn.addEventListener('click', () => this.restoreDefaultPrompt());
        if (this.webAuthnToggle) this.webAuthnToggle.addEventListener('change', () => this.handleWebAuthnToggle());
        if (this.unlockBtn) this.unlockBtn.addEventListener('click', () => this.verifyWebAuthn());

        // Listen for Auth results
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.webAuthnResult) {
                this.handleAuthResult(changes.webAuthnResult.newValue);
            }
        });

        // Detail view
        document.getElementById('backBtn').addEventListener('click', () => this.showListView());
        if (this.addPacketFloatingBtn) {
            this.addPacketFloatingBtn.addEventListener('click', () => this.createAndShowNewPacket([]));
        }
        document.getElementById('editSchemaBtn').addEventListener('click', () => this.openSchemaModal());
        document.getElementById('detailExportBtn').addEventListener('click', () => this.exportCollection(this.currentCollection));
        document.getElementById('detailDeleteBtn').addEventListener('click', () => this.deleteCollection(this.currentCollection));

        // Packet detail view
        document.getElementById('packetDetailBackBtn').addEventListener('click', () => this.handlePacketDetailBack());
        document.getElementById('packetDetailCloseBtn').addEventListener('click', () => this.closePacketGroup());
        document.getElementById('packetDetailTitle').addEventListener('click', () => this.renameCurrentPacket());
        if (this.addMediaDetailBtn) {
            this.addMediaDetailBtn.addEventListener('click', () => {
                if (this.mediaAddOptions) {
                    this.mediaAddOptions.classList.toggle('hidden');
                    this.createNewStackBtn?.classList.toggle('hidden', !this.editMode);
                    this.addPageDetailBtn?.classList.toggle('hidden', !this.editMode);
                } else {
                    this.mediaDropZone.classList.toggle('hidden');
                }
            });
        }

        if (this.mediaAudioRecordBtn) {
            this.mediaAudioRecordBtn.addEventListener('click', async () => {
                if (this.isRecording) {
                    await this.sendMessage({ action: 'stopRecording' });
                } else {
                    try {
                        const resp = await this.sendMessage({ action: 'startMicRecording', video: false });
                        if (!resp || !resp.success) throw new Error(resp?.error || 'Failed to start');
                    } catch (err) {
                        this.handleRecordingError(err);
                    }
                }
            });
        }

        if (this.mediaTabAudioRecordBtn) {
            this.mediaTabAudioRecordBtn.addEventListener('click', async () => {
                if (this.isRecording) {
                    await this.sendMessage({ action: 'stopRecording' });
                } else {
                    try {
                        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                        if (!tab) throw new Error('No active tab found');
                        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
                        const resp = await this.sendMessage({ action: 'START_AUDIO_RECORDING', streamId });
                        if (!resp || !resp.success) throw new Error(resp?.error || 'Failed to start');
                    } catch (err) {
                        this.handleRecordingError(err);
                    }
                }
            });
        }

        if (this.mediaVideoRecordBtn) {
            this.mediaVideoRecordBtn.addEventListener('click', async () => {
                if (this.isRecording) {
                    await this.sendMessage({ action: 'stopRecording' });
                } else {
                    try {
                        const resp = await this.sendMessage({ action: 'startMicRecording', video: true });
                        if (!resp || !resp.success) throw new Error(resp?.error || 'Failed to start');
                    } catch (err) {
                        this.handleRecordingError(err);
                    }
                }
            });
        }

        if (this.mediaTabVideoRecordBtn) {
            this.mediaTabVideoRecordBtn.addEventListener('click', async () => {
                if (this.isRecording) {
                    await this.sendMessage({ action: 'stopRecording' });
                } else {
                    try {
                        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                        if (!tab) throw new Error('No active tab found');
                        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
                        const resp = await this.sendMessage({ action: 'START_TAB_VIDEO_RECORDING', streamId });
                        if (!resp || !resp.success) throw new Error(resp?.error || 'Failed to start');
                    } catch (err) {
                        this.handleRecordingError(err);
                    }
                }
            });
        }
        if (this.addPageDetailBtn) {
            this.addPageDetailBtn.addEventListener('click', (e) => {
                // Clicking the main button now does nothing or toggles the options
                // but the CSS handles hover, so we can just stop propagation
                e.stopPropagation();
            });
        }
        if (this.addPageFromTabBtn) {
            this.addPageFromTabBtn.addEventListener('click', () => {
                this.addTabToCurrentPacket();
            });
        }
        if (this.addPageNewBtn) {
            this.addPageNewBtn.addEventListener('click', () => {
                this.addLocalPage();
            });
        }
        if (this.createNewStackBtn) {
            this.createNewStackBtn.addEventListener('click', () => {
                this.createNewStack();
            });
        }
        if (this.addStackDetailBtn) {
            this.addStackDetailBtn.addEventListener('click', () => {
                this.createNewStack();
            });
        }

        // Check tab status when becoming active or when tab changes
        window.addEventListener('focus', () => this.syncActiveTab());
        chrome.tabs.onActivated.addListener(() => this.syncActiveTab());
        chrome.tabs.onRemoved.addListener(() => this.syncActiveTab());
        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (changeInfo.status === 'complete' || changeInfo.url) {
                this.syncActiveTab();
            }
        });
        if (this.editToggleBtn) {
            this.editToggleBtn.addEventListener('click', () => this.toggleEditMode());
        }
        if (this.deletePacketDetailBtn) {
            this.deletePacketDetailBtn.addEventListener('click', () => this.deleteCurrentPacket());
        }
        if (this.terminalOpenBtn) {
            this.terminalOpenBtn.addEventListener('click', () => this.openTerminal());
        }
        document.getElementById('syncTabOrderBtn').addEventListener('click', () => this.syncTabOrder());


        // Constructor view (packets)
        document.getElementById('constructorBackBtn').addEventListener('click', () => this.showDetailView('packets'));
        document.getElementById('addCurrentTabBtn').addEventListener('click', () => this.addCurrentTab());
        document.getElementById('addMediaBtn').addEventListener('click', () => document.getElementById('mediaFileInput').click());
        document.getElementById('mediaFileInput').addEventListener('change', (e) => this.handleMediaFileSelect(e));
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

        // Drop zone handlers
        const dropZone = this.mediaDropZone;
        if (dropZone) {
            dropZone.addEventListener('dragover', (e) => this.handleMediaDragOver(e));
            dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-active'));
            dropZone.addEventListener('drop', (e) => this.handleMediaDrop(e));
            dropZone.addEventListener('click', () => document.getElementById('mediaFileInput').click());
        }

        // AI Prompt Modal
        document.getElementById('aiGenerateWasmBtn').addEventListener('click', () => this.openAiPromptModal());
        document.getElementById('aiModalCloseBtn').addEventListener('click', () => this.closeAiPromptModal());
        document.getElementById('aiCancelBtn').addEventListener('click', () => this.closeAiPromptModal());
        this.aiGenerateBtn.addEventListener('click', () => this.generateWasmWithAi());
        if (this.aiGenerateWasmDetailBtn) {
            this.aiGenerateWasmDetailBtn.addEventListener('click', () => this.openAiPromptModal());
        }

        // Entry Preview Modal
        this.entryPreviewCloseBtn.addEventListener('click', () => this.entryPreviewModal.classList.add('hidden'));
        this.entryPreviewOkBtn.addEventListener('click', () => this.entryPreviewModal.classList.add('hidden'));
        this.entryPreviewModal.addEventListener('click', (e) => {
            if (e.target === this.entryPreviewModal) this.entryPreviewModal.classList.add('hidden');
        });

        // Global keydown for Escape and Navigation in sidebar
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                // Check if any modal is open first
                const anyModalOpen = [
                    this.schemaModal,
                    this.aiPromptModal,
                    this.wasmResultModal,
                    this.entryPreviewModal,
                    this.schemaPickerOverlay,
                    this.schemaSqlViewerOverlay
                ].some(m => m && !m.classList.contains('hidden'));

                if (anyModalOpen) return; // Let individual modal handlers (if any) or existing logic handle it

                // If no modal is open and clipper is suppressed, don't do anything extra
                // But if we're in packet detail view and clipper is NOT suppressed, cancel it
                const isDetailView = this.packetDetailView.classList.contains('active');
                if (isDetailView && !this.isClipperManuallyCancelled) {
                    this.handleClipperCancelled();
                }

                if (this.editMode) {
                    this.toggleEditMode();
                }
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                this.handleKeyDown(e);
            }
        });
    }

    // ===== NAVIGATION =====
    resetEditMode() {
        this.editMode = false;
        document.body.classList.remove('edit-mode');
        if (this.packetDetailView) this.packetDetailView.classList.remove('edit-mode');
        if (this.constructorView) this.constructorView.classList.remove('edit-mode');
        if (this.editToggleBtn) this.editToggleBtn.classList.remove('active');
        this.updateClipperState();
    }

    toggleEditMode() {
        this.editMode = !this.editMode;
        if (this.editMode) {
            document.body.classList.add('edit-mode');
            if (this.packetDetailView) this.packetDetailView.classList.add('edit-mode');
            if (this.constructorView) this.constructorView.classList.add('edit-mode');
            this.editToggleBtn.classList.add('active');
        } else {
            document.body.classList.remove('edit-mode');
            if (this.packetDetailView) this.packetDetailView.classList.remove('edit-mode');
            if (this.constructorView) this.constructorView.classList.remove('edit-mode');
            this.editToggleBtn.classList.remove('active');
            // Ensure media dropbox is collapsed when exiting edit mode
            if (this.mediaAddOptions) {
                this.mediaAddOptions.classList.add('hidden');
            }
        }
        if (this.currentPacket) {
            this.showPacketDetailView(this.currentPacket);
        }
        if (this.constructorView && this.constructorView.classList.contains('active')) {
            this.renderConstructorItems();
        }
    }

    handlePermissionError() {
        const openPermission = confirm('Wildcard needs microphone permission to record. Open a new tab to grant it?');
        if (openPermission) {
            chrome.tabs.create({ url: chrome.runtime.getURL('sidebar/permission.html') });
        }
    }

    handleRecordingError(err) {
        if (err.name === 'NotAllowedError' || err.message.includes('Permission dismissed')) {
            this.handlePermissionError();
        } else {
            this.showNotification('Failed to start recording: ' + err.message, 'error');
        }
        this.isRecording = false;
        this.updateRecordingUI();
    }

    updateRecordingUI() {
        const states = [
            { btn: this.mediaAudioRecordBtn, icon: '🎤', text: 'Mic', active: this.isAudioRecording },
            { btn: this.mediaTabAudioRecordBtn, icon: '🔊', text: 'Tab', active: this.isTabAudioRecording },
            { btn: this.mediaVideoRecordBtn, icon: '📹', text: 'Cam', active: this.isVideoRecording },
            { btn: this.mediaTabVideoRecordBtn, icon: '🖥️', text: 'Tab', active: this.isTabVideoRecording }
        ];

        states.forEach(({ btn, icon, text, active }) => {
            if (!btn) return;
            if (active) {
                btn.classList.add('recording');
                btn.querySelector('p').textContent = 'Recording...';
                btn.querySelector('.record-zone-icon').textContent = '⏹️';
            } else {
                btn.classList.remove('recording');
                btn.querySelector('p').textContent = text;
                btn.querySelector('.record-zone-icon').textContent = icon;
            }
        });
    }

    async handleMediaClipFinished(mediaId, size, mimeType) {
        if (this.processedMediaIds.has(mediaId)) {
            console.log('[Sidebar] Skipping duplicate media:', mediaId);
            return;
        }
        this.processedMediaIds.add(mediaId);

        try {
            // Already saved by offscreen document to minimize hops
            console.log('[Sidebar] Media capture finished:', mediaId, 'Type:', mimeType, 'Size:', size);

            const displayType = mimeType || 'video/webm;codecs=vp8,opus';
            const name = displayType.startsWith('video') ? `Video ${new Date().toLocaleString()}.webm` : `Audio ${new Date().toLocaleString()}.webm`;
            
            const newItem = {
                type: 'media',
                name: name,
                mediaId: mediaId,
                mimeType: displayType,
                size: size || 0
            };

            if (this.currentPacket) {
                this.currentPacket.urls.push(newItem);
                await this.sendMessage({
                    action: 'savePacket',
                    id: this.currentPacket.id,
                    name: this.currentPacket.name,
                    urls: this.currentPacket.urls
                });
                this.showPacketDetailView(this.currentPacket);
            } else if (this.constructorView.classList.contains('active')) {
                this.constructorItems.push(newItem);
                this.renderConstructorItems();
            }
        } catch (err) {
            console.error('handleMediaClipFinished failed:', err);
            this.showNotification('Failed to save clip: ' + err.message, 'error');
        }
    }

    async renameCurrentPacket() {
        if (!this.currentPacket) return;

        const newName = window.prompt('Rename this packet:', this.currentPacket.name);
        if (!newName || !newName.trim() || newName === this.currentPacket.name) return;

        try {
            const resp = await this.sendMessage({
                action: 'savePacket',
                id: this.currentPacket.id,
                name: newName.trim(),
                urls: this.currentPacket.urls
            });

            if (resp && resp.success) {
                this.currentPacket.name = newName.trim();
                document.getElementById('packetDetailTitle').textContent = this.currentPacket.name;
                this.showNotification('Packet renamed successfully', 'success');
            } else {
                throw new Error(resp?.error || 'Rename failed');
            }
        } catch (err) {
            console.error('Rename packet failed:', err);
            this.showNotification('Failed to rename packet: ' + err.message, 'error');
        }
    }

    async deleteCurrentPacket() {
        if (!this.currentPacket) return;
        if (!confirm(`Delete packet "${this.currentPacket.name}"? This will delete the packet and close its tabs.`)) return;

        try {
            // First delete the packet from DB
            const resp = await this.sendMessage({ action: 'deletePacket', id: this.currentPacket.id });
            if (!resp || !resp.success) throw new Error(resp?.error || 'Delete failed');

            // Then close the tab group if it exists
            await this.sendMessage({
                action: 'closePacketGroup',
                packetId: this.currentPacket.id
            });

            this.showNotification(`Packet "${this.currentPacket.name}" deleted`, 'success');
            this.showDetailView('packets');
        } catch (err) {
            console.error('Delete packet failed:', err);
            this.showNotification('Failed to delete packet: ' + err.message, 'error');
        }
    }

    addReorderEvents(el, index, type) {
        el.addEventListener('dragstart', (e) => {
            this.dragSrcIndex = index;
            // Only add visual dragging class if in edit mode or if we want generic feedback
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'copyMove';
            
            // Set full item data for external drops (e.g. into stack tab)
            const item = this.currentPacket.urls[index];
            const dragData = {
                type: (typeof item === 'object') ? (item.type || 'page') : 'page',
                item: item,
                index: index,
                sourcePacketId: this.currentPacket.id
            };
            e.dataTransfer.setData('application/json', JSON.stringify(dragData));
            // Also set as text/plain for simpler drop targets
            e.dataTransfer.setData('text/plain', dragData.type);
        });

        el.addEventListener('dragover', (e) => {
            if (e.preventDefault) e.preventDefault();
            const srcType = e.dataTransfer.getData('text/plain') || type; // Fallback
            if (srcType !== type) return false;

            el.classList.add('drag-over');
            e.dataTransfer.dropEffect = 'move';
            return false;
        });

        el.addEventListener('dragleave', () => {
            el.classList.remove('drag-over');
        });

        el.addEventListener('drop', async (e) => {
            if (e.stopPropagation) e.stopPropagation();
            el.classList.remove('drag-over');

            // Internal reordering ONLY in edit mode
            if (!this.editMode) return;
            const targetIndex = index;

            if (this.dragSrcIndex === null || this.dragSrcIndex === targetIndex) return;

            // Check if types match - although dragover should handle this, double check
            const srcItem = this.currentPacket.urls[this.dragSrcIndex];
            const targetItem = this.currentPacket.urls[targetIndex];
            // Normalize types for comparison (page and link both count as "page" section)
            const getGroup = (item) => {
                const t = (typeof item === 'object') ? (item.type || 'page') : 'page';
                return (t === 'link' || t === 'local') ? 'page' : t;
            };


            const srcGroup = getGroup(srcItem);
            const targetGroup = getGroup(targetItem);

            if (srcGroup !== targetGroup) {
                this.showNotification('Cannot move items between sections', 'error');
                return;
            }

            // Reorder array
            const [movedItem] = this.currentPacket.urls.splice(this.dragSrcIndex, 1);
            this.currentPacket.urls.splice(targetIndex, 0, movedItem);

            // Save
            const saveResp = await this.sendMessage({
                action: 'savePacket',
                id: this.currentPacket.id,
                name: this.currentPacket.name,
                urls: this.currentPacket.urls
            });

            if (saveResp && saveResp.success) {
                this.showPacketDetailView(this.currentPacket);
            }

            return false;
        });

        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            const allItems = this.packetDetailView.querySelectorAll('.packet-page-card, .packet-media-card');
            allItems.forEach(item => item.classList.remove('drag-over'));
            this.dragSrcIndex = null;
        });
    }

    showView(viewId) {
        this.hideAllViews();
        // Hide status indicator in settings or constructor to keep it clean
        if (this.statusIndicator) {
            const hideIn = ['settingsView', 'constructorView', 'schemaConstructorView', 'witEditorView'];
            this.statusIndicator.style.display = hideIn.includes(viewId) ? 'none' : 'flex';
        }

        const view = document.getElementById(viewId);
        if (view) {
            view.classList.add('active');
            // Disable edit mode when switching views
            if (viewId !== 'packetDetailView') {
                this.resetEditMode();
            }
        } else {
            console.error(`[SidebarUI] View not found: ${viewId}`);
        }
    }

    async updateOnlineStatus() {
        if (!this.statusIndicator) return;

        const isNetworkEnabled = this.networkEnabled !== false;
        
        // Short-circuit 1: if network is simulated OFF, we don't even need to probe
        if (!isNetworkEnabled) {
            this.statusIndicator.classList.remove('offline');
            this.statusIndicator.classList.add('simulated-offline');
            this.enforceOfflineState(true);
            return;
        }

        // Short-circuit 2: Check navigator.onLine as a fast pre-check
        // If the OS says we're offline, we definitely are.
        if (!navigator.onLine) {
            this.consecutiveFailures = this.MAX_CONSECUTIVE_FAILURES;
            this.handleOfflineTransition();
            return;
        }

        // If simulated ON, check if actually online with probes
        const isActualOnline = await this.checkActualConnectivity();
        
        if (isActualOnline) {
            const wasChecking = this.consecutiveFailures > 0;
            this.consecutiveFailures = 0;
            if (this.lastStateWasOnline === false || wasChecking) {
                this.statusIndicator.classList.remove('offline', 'simulated-offline');
                if (this.lastStateWasOnline === false) {
                    console.log('[Status] Back Online');
                    this.enforceOfflineState(false);
                }
            }
        } else {
            this.consecutiveFailures++;
            console.warn(`[Status] Connectivity probe failed (${this.consecutiveFailures}/${this.MAX_CONSECUTIVE_FAILURES})`);
            
            if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
                this.handleOfflineTransition();
            } else {
                // Stay in Online state but maybe show a hint if we're feeling fancy later
                // For now, just don't flip to offline yet.

            }
        }
    }

    handleOfflineTransition() {
        if (this.lastStateWasOnline !== false) {
            console.log(`[Status] Transitioning to Offline after ${this.consecutiveFailures} failures`);
            this.statusIndicator.classList.remove('simulated-offline');
            this.statusIndicator.classList.add('offline');

            this.enforceOfflineState(true);
        }
    }

    async enforceOfflineState(isOffline) {
        // Sync to storage so other windows (stack PIP) can react
        chrome.storage.local.set({ isNetworkOffline: isOffline });

        // 1. Update UI (grey out items)
        const cards = document.querySelectorAll('.packet-page-card:not(.local):not(.wasm):not(.stack)');
        cards.forEach(card => {
            if (isOffline) {
                card.classList.add('disabled');
            } else {
                card.classList.remove('disabled');
            }
        });

        // 2. Close web tabs if we just went offline
        if (isOffline && this.lastStateWasOnline !== false) {
            console.log('[Status] Enforcing offline: closing packet web tabs');
            try {
                const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                const packetGroupIds = new Set(Object.keys(activeGroups).map(id => parseInt(id, 10)));
                
                const tabs = await chrome.tabs.query({});
                const tabsToClose = tabs.filter(t => {
                    if (!t.url || !packetGroupIds.has(t.groupId)) return false;
                    const isLocal = t.url.startsWith('chrome-extension://') || t.url.startsWith('file://');
                    return !isLocal;
                });
                
                if (tabsToClose.length > 0) {
                    const tabIds = tabsToClose.map(t => t.id);
                    await chrome.tabs.remove(tabIds);
                    this.showNotification(`Closed ${tabsToClose.length} packet tabs for offline mode`, 'info');
                }
            } catch (e) {
                console.error('[Status] Failed to close packet tabs:', e);
            }
        }
        this.lastStateWasOnline = !isOffline;
    }

    async checkActualConnectivity() {
        // Step 1: Check network interfaces
        try {
            if (chrome.system && chrome.system.network) {
                const interfaces = await new Promise(resolve => chrome.system.network.getNetworkInterfaces(resolve));
                const activeInterfaces = interfaces.filter(i => 
                    !i.address.startsWith('127.') && 
                    !i.address.startsWith('::1') && 
                    !i.address.startsWith('fe80:') // Ignore loopback and link-local
                );
                if (activeInterfaces.length === 0) {
                    console.log('[Status] No active network interfaces found.');
                    return false;
                }
            }
        } catch (e) {
            console.warn('[Status] chrome.system.network failed:', e);
        }

        // Step 2: Probe for truth across multiple endpoints to avoid single-point failure sensitivity
        const endpoints = [
            `https://clients3.google.com/generate_204?cb=${Math.random()}`,
            `https://1.1.1.1/generate_204?cb=${Math.random()}`
        ];

        for (const probeUrl of endpoints) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000); // Increased from 2s to 5s
                
                await fetch(probeUrl, {
                    method: 'HEAD',
                    mode: 'no-cors',
                    cache: 'no-store',
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                return true; // Any single success is enough to consider us "Online"
            } catch (e) {
                console.log(`[Status] Probe to ${new URL(probeUrl).hostname} failed: ${e.message}`);
            }
        }

        return false; // All probes failed
    }

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

    async showListView() {
        await this.checkEmptyPacketGarbageCollector();
        this.showView('listView');
        this.currentCollection = null;
        this.loadCollections();
    }

    async showDetailView(collectionName) {
        await this.checkEmptyPacketGarbageCollector();
        this.currentCollection = collectionName;
        this.detailTitle.textContent = collectionName;
        this.showView('detailView');
        this.loadCollectionDetail(collectionName);
    }

    async showWitsView() {
        await this.checkEmptyPacketGarbageCollector();
        this.currentCollection = 'wits';
        this.showView('witsView');
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
        this.showView('witEditorView');

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

    // Robust URL normalization for matching across redirects (protocol, www, trailing slashes, hashes)
    normalizeUrl(url) {
        if (!url) return '';
        try {
            const parsed = new URL(url);
            
            // Handle chrome-extension:// URLs specially
            if (url.startsWith('chrome-extension://')) {
                let path = parsed.pathname.replace(/\/$/, '').toLowerCase();
                const search = new URLSearchParams(parsed.search);
                // Strip non-essential parameters for matching identity
                search.delete('packetId');
                search.delete('name'); // Descriptive only
                search.sort();
                const searchString = search.toString();
                return `extension:${path}${searchString ? '?' + searchString : ''}`;
            }

            // Standard web URLs
            // Remove hash and trailing slash, then lowercase
            let u = url.split('#')[0].replace(/\/$/, '').toLowerCase();
            
            // Strip packetId from standard URLs if present
            if (parsed.searchParams.has('packetId')) {
                const cleanSearch = new URLSearchParams(parsed.search);
                cleanSearch.delete('packetId');
                cleanSearch.sort();
                const searchStr = cleanSearch.toString();
                const baseUrl = url.split('?')[0].split('#')[0].replace(/\/$/, '').toLowerCase();
                u = `${baseUrl}${searchStr ? '?' + searchStr : ''}`;
            }

            // Remove protocol and www.
            return u.replace(/^https?:\/\//, '').replace(/^www\./, '');
        } catch (e) { 
            // Fallback for malformed URLs
            return url.split('#')[0].replace(/\/$/, '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
        }
    }

    urlsMatch(u1, u2) {
        return this.normalizeUrl(u1) === this.normalizeUrl(u2);
    }

    async handlePacketDetailBack() {
        await this.checkEmptyPacketGarbageCollector();
        this.showDetailView('packets');
    }

    async checkEmptyPacketGarbageCollector() {
        if (this.newlyCreatedEmptyPacketId && this.currentPacket &&
            String(this.currentPacket.id) === String(this.newlyCreatedEmptyPacketId) &&
            this.currentPacket.urls.length === 0) {

            const pid = this.currentPacket.id;
            this.newlyCreatedEmptyPacketId = null;
            // Silent delete (no confirm)
            await this.sendMessage({ action: 'deletePacket', id: pid });
            await this.sendMessage({ action: 'closePacketGroup', packetId: pid });
            // Disable edit mode if it was auto-enabled
            if (this.editMode) this.toggleEditMode();
        }
    }

    async closePacketGroup() {
        if (!this.currentPacket) return;
        try {
            await this.checkEmptyPacketGarbageCollector();

            await this.sendMessage({
                action: 'closePacketGroup',
                packetId: this.currentPacket.id
            });
            this.showDetailView('packets');
        } catch (err) {
            console.error('Failed to close packet group:', err);
            this.showNotification('Failed to close tab group', 'error');
            // Still go back if it fails
            this.showDetailView('packets');
        }
    }

    async showPacketDetailView(packet) {
        // Switching between different packets or entering a packet should reset edit mode
        if (!this.currentPacket || String(this.currentPacket.id) !== String(packet.id)) {
            this.resetEditMode();
        }

        this.currentPacket = packet;
        this.isClipperManuallyCancelled = false;
        this.activePacketGroupId = packet.groupId || null;
        this.updateTerminalUI();
        if (packet.activeUrl) this.activeUrl = packet.activeUrl;

        // If no groupId provided, try to find one in storage
        if (this.activePacketGroupId === null) {
            try {
                const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                for (const [gid, pid] of Object.entries(activeGroups)) {
                    if (String(pid) === String(packet.id)) {
                        this.activePacketGroupId = parseInt(gid, 10);
                        break;
                    }
                }
            } catch (e) { }
        }

        this.showView('packetDetailView');
        document.getElementById('packetDetailTitle').textContent = packet.name;

        await this.renderPacketItems(packet.urls);
        this.updateItemHighlights(); // Unified highlight step
        this.updateClipperState();
        this.checkReadyToClip();
        this.updateAddPageVisibility();
    }

    async renderPacketItems(urls) {
        // Target new sections
        const pageList = document.getElementById('packetPageList');
        const mediaList = document.getElementById('packetMediaList');
        const wasmList = document.getElementById('packetWasmList');
        const stackList = document.getElementById('packetStackList');
        const dataList = document.getElementById('packetDataList');

        pageList.innerHTML = '';
        mediaList.innerHTML = '';
        wasmList.innerHTML = '';
        stackList.innerHTML = '';
        dataList.innerHTML = '<p class="hint">Loading data...</p>';

        let pageCount = 0;
        let mediaCount = 0;
        let wasmCount = 0;
        let stackCount = 0;

        urls.forEach((item, index) => {
            const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
            if (type === 'page' || type === 'link') {
                pageCount++;
                const url = typeof item === 'string' ? item : item.url;
                const card = document.createElement('div');
                card.setAttribute('tabindex', '0');
                card.setAttribute('data-index', index);
                card.draggable = true;
                const isOffline = !navigator.onLine || this.networkEnabled === false;
                card.className = `packet-page-card ${isOffline ? 'disabled' : ''}`;

                let hostname;
                try { hostname = new URL(url).hostname; } catch (e) { hostname = 'Unknown'; }

                const faviconUrl = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
                card.innerHTML = `
                    <span class="drag-handle" title="Drag to reorder"></span>
                    <img src="${faviconUrl}" class="packet-page-favicon" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjQgMjQ+PHBhdGggZmlsbD0iI2NjYyIgZD0iTTEyIDJDNi40OCAyIDIgNi40OCAyIDEyczQuNDggMTAgMTAgMTAgMTAtNC40OCAxMC0xMFMxNy41MiAyIDEyIDJ6bS0xIDE3LjkyVjE5aC0ydjMtLjA4QzUuNjEgMTguNTMgMi41IDE1LjEyIDIuNSAxMWMwLS45OC4Small-1LjkyLjUtMi44bDMuNTUgMy41NVYxOS45MnpNMjEgMTEuMzhWMTJjMCA0LjQxLTMuNiA4LTggOGgtMXYtMmgtMmwtMy0zVjlsMy0zIDIuMSAyLjFjLjIxLS42My42OC0xLjExIDEuNC0xLjExLjgzIDAgMS41LjY3IDEuNSAxLjV2My41aDN2LTNoMS42MWwuMzktLjM5YzIuMDEgMS4xMSAzLjUgMy4zNSAzLjUgNS44OHoiLz48L3N2Zz4='">
                    <div class="packet-page-info">
                        <div class="packet-page-hostname">${this.escapeHtml(hostname)}</div>
                        <div class="packet-page-url">${this.escapeHtml(url)}</div>
                    </div>
                    <button class="constructor-remove-btn" title="Remove page">🗑️</button>
                `;
                card.querySelector('.constructor-remove-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.removePacketItem(index);
                });
                card.addEventListener('click', async () => {
                    if (this.editMode) return;
                    this.activeUrl = url;
                    this.updateItemHighlights();
                    const resp = await this.sendMessage({ action: 'openTabInGroup', url, groupId: this.activePacketGroupId, packetId: this.currentPacket.id });
                    if (resp && resp.success) {
                        this.activePacketGroupId = resp.groupId || resp.newGroupId || this.activePacketGroupId;
                    }
                    window.focus(); // Reclaim focus
                });
                this.addReorderEvents(card, index, 'page');
                pageList.appendChild(card);
            } else if (type === 'local') {
                pageCount++;
                const url = chrome.runtime.getURL(`sidebar/viewer.html?id=${item.resourceId}&name=${encodeURIComponent(item.name)}`);
                const card = document.createElement('div');
                card.setAttribute('tabindex', '0');
                card.setAttribute('data-index', index);
                card.draggable = true;
                card.className = `packet-page-card local`;

                card.innerHTML = `
                    <span class="drag-handle" title="Drag to reorder"></span>
                    <span class="packet-page-icon">📄</span>
                    <div class="packet-page-info">
                        <div class="packet-page-hostname">Local Page</div>
                        <div class="packet-page-url">${this.escapeHtml(item.name)}</div>
                    </div>
                    <button class="constructor-remove-btn" title="Remove page">🗑️</button>
                `;
                card.querySelector('.constructor-remove-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.removePacketItem(index);
                });
                card.addEventListener('click', async () => {
                    if (this.editMode) return;
                    this.activeUrl = url;
                    this.updateItemHighlights();
                    const resp = await this.sendMessage({ action: 'openTabInGroup', url, groupId: this.activePacketGroupId, packetId: this.currentPacket.id });
                    if (resp && resp.success) {
                        this.activePacketGroupId = resp.groupId || resp.newGroupId || this.activePacketGroupId;
                    }
                    window.focus(); // Reclaim focus
                });
                this.addReorderEvents(card, index, 'page');
                pageList.appendChild(card);
            } else if (type === 'media') {
                mediaCount++;
                const mediaUrl = chrome.runtime.getURL(`sidebar/media.html?id=${item.mediaId}&type=${encodeURIComponent(item.mimeType)}&name=${encodeURIComponent(item.name)}`);
                const itemNorm = this.normalizeUrl(mediaUrl);
                const activeNorm = this.normalizeUrl(this.activeUrl);
                const isActive = itemNorm && activeNorm && itemNorm === activeNorm;

                const card = document.createElement('div');
                card.setAttribute('tabindex', '0');
                card.setAttribute('data-index', index);
                card.draggable = true;
                const isOffline = !navigator.onLine || this.networkEnabled === false;
                card.className = `packet-media-card ${isOffline ? 'disabled' : ''}`;
                const isImage = item.mimeType?.startsWith('image/');
                const isVideo = item.mimeType?.startsWith('video/');
                const icon = isImage ? '🖼️' : (isVideo ? '🎬' : '🎵');
                card.innerHTML = `
                    <span class="drag-handle" title="Drag to reorder"></span>
                    <div class="packet-media-preview" id="detail-preview-${item.mediaId}-${index}">${icon}</div>
                    <div class="packet-media-info">
                        <div class="packet-media-name">${this.escapeHtml(item.name)}</div>
                        <div class="packet-media-meta">${item.mimeType} • ${this.formatSize(item.size)}</div>
                    </div>
                    <button class="constructor-remove-btn" title="Remove media">🗑️</button>
                `;
                card.querySelector('.constructor-remove-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.removePacketItem(index);
                });
                if (isImage || isVideo) {
                    this.loadMediaThumbnail(item.mediaId, `detail-preview-${item.mediaId}-${index}`);
                }
                card.addEventListener('click', () => {
                    if (this.editMode) return;
                    this.activatePacketItem(item, index);
                });
                this.addReorderEvents(card, index, 'media');
                mediaList.appendChild(card);
            } else if (type === 'wasm') {
                wasmCount++;
                const card = document.createElement('div');
                card.setAttribute('tabindex', '0');
                card.setAttribute('data-index', index);
                card.draggable = true;
                card.className = `packet-page-card wasm`;
                card.innerHTML = `
                    <span class="drag-handle" title="Drag to reorder"></span>
                    <div class="packet-page-info">
                        <div class="packet-page-title">${this.escapeHtml(item.prompt || item.name)}</div>
                    </div>
                    <div style="display: flex; gap: 4px; align-items: center;">
                        <button class="constructor-remove-btn" title="Remove function">🗑️</button>
                        <button class="play-btn">▶</button>
                    </div>
                `;
                card.querySelector('.constructor-remove-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.removePacketItem(index);
                });
                card.querySelector('.play-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.activatePacketItem(item, index);
                });
                this.addReorderEvents(card, index, 'wasm');
                wasmList.appendChild(card);
            } else if (type === 'stack') {
                stackCount++;
                const card = document.createElement('div');
                card.setAttribute('tabindex', '0');
                card.setAttribute('data-index', index);
                card.draggable = true;
                card.className = `packet-page-card stack`;
                card.innerHTML = `
                    <span class="drag-handle" title="Drag to reorder"></span>
                    <span class="packet-page-icon">📚</span>
                    <div class="packet-page-info">
                        <div class="packet-page-title">${this.escapeHtml(item.name)}</div>
                    </div>
                    <button class="constructor-remove-btn" title="Remove stack">🗑️</button>
                `;
                card.querySelector('.constructor-remove-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.removePacketItem(index);
                });
                card.addEventListener('click', () => {
                    if (this.editMode) return;
                    this.activatePacketItem(item, index);
                });
                this.addReorderEvents(card, index, 'stack');
                stackList.appendChild(card);
            }
        });

        document.getElementById('packetDetailPageCount').textContent = pageCount;
        document.getElementById('packetMediaCount').textContent = mediaCount;
        document.getElementById('packetWasmCount').textContent = wasmCount;
        document.getElementById('packetStackCount').textContent = stackCount;

        if (pageCount === 0) pageList.innerHTML = '<p class="hint">No pages in this packet.</p>';
        if (mediaCount === 0) mediaList.innerHTML = '<p class="hint">No media in this packet.</p>';
        if (wasmCount === 0) wasmList.innerHTML = '<p class="hint">No Wasm modules in this packet.</p>';
        if (stackCount === 0) stackList.innerHTML = '<p class="hint">No stacks in this packet.</p>';

        // Load and render per-packet data
        try {
            const packetDbName = `packet_${this.currentPacket.id}`;
            await this.sendMessage({ action: 'ensurePacketDatabase', packetId: this.currentPacket.id });
            const schemaResp = await this.sendMessage({ action: 'getSchema', name: packetDbName });

            if (schemaResp.success) {
                const tables = schemaResp.schema;
                this.packetDataCount.textContent = tables.length;

                if (tables.length === 0) {
                    dataList.innerHTML = '<p class="hint">No tables in this packet.</p>';
                } else {
                    dataList.innerHTML = tables.map(table => `
                        <div class="entry-row" style="cursor: default; padding: 6px 10px; background: var(--bg-alt); margin-bottom: 4px; border-radius: 6px;">
                            <span class="drag-handle"></span>
                            <span class="entry-label" style="font-family: inherit;">${this.escapeHtml(table.name)}</span>
                        </div>
                    `).join('');
                }
            } else {
                dataList.innerHTML = '<p class="hint">Failed to load data schema.</p>';
                this.packetDataCount.textContent = '0';
            }
        } catch (err) {
            console.error('Failed to load packet data:', err);
            dataList.innerHTML = '<p class="hint">Error loading packet data.</p>';
            this.packetDataCount.textContent = '0';
        }
    }

    async showConstructorView(packet = null) {
        this.showView('constructorView');
        this.showHeaderOnly();
        this.updateClipperState();
        this.checkReadyToClip();
    }

    async removePacketItem(index) {
        if (!this.currentPacket) return;

        // Remove the item at the specified index
        this.currentPacket.urls.splice(index, 1);

        try {
            // Persist the change
            await this.sendMessage({
                action: 'savePacket',
                id: this.currentPacket.id,
                name: this.currentPacket.name,
                urls: this.currentPacket.urls
            });

            // Refresh the view
            this.showPacketDetailView(this.currentPacket);
            this.showNotification('Item removed');
        } catch (e) {
            console.error('[SidebarUI] Failed to remove item:', e);
            this.showNotification('Failed to remove item', 'error');
        }
    }

    handleKeyDown(e) {
        // Only if packet detail view is active
        if (!this.packetDetailView || !this.packetDetailView.classList.contains('active')) return;

        // Don't interfere if user is typing in an input or textarea
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // Also ignore if a modal is open (like the AI prompt or sequence result)
        if (!this.schemaModal.classList.contains('hidden')) return;
        if (!this.aiPromptModal.classList.contains('hidden')) return;
        if (!this.wasmResultModal.classList.contains('hidden')) return;

        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            this.navigatePacketItems(e.key === 'ArrowRight' ? 1 : -1);
        }
    }

    getVisualSequence() {
        if (!this.currentPacket || !this.currentPacket.urls) return [];
        const itemsWithIndex = this.currentPacket.urls.map((item, originalIndex) => ({ item, originalIndex }));

        const pages = itemsWithIndex.filter(({ item }) => {
            const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
            return type === 'page' || type === 'link' || type === 'local';
        });
        const media = itemsWithIndex.filter(({ item }) => (typeof item === 'object' && item.type === 'media'));
        const wasm = itemsWithIndex.filter(({ item }) => (typeof item === 'object' && item.type === 'wasm'));

        return [...pages, ...media, ...wasm];
    }

    async navigatePacketItems(direction) {
        const visualSeq = this.getVisualSequence();
        if (visualSeq.length === 0) return;

        // Query open tabs in the current group to restrict cycling
        let openUrls = new Set();
        if (this.activePacketGroupId !== null) {
            try {
                const tabs = await chrome.tabs.query({ groupId: this.activePacketGroupId });
                tabs.forEach(t => {
                    if (t.url) openUrls.add(t.url);
                });
            } catch (e) {
                console.error('[Sidebar] Failed to query tabs for cycling:', e);
            }
        }

        // Filter visual sequence to only items that have an open tab
        const filteredSeq = visualSeq.filter(entry => {
            const type = (typeof entry.item === 'object') ? (entry.item.type || 'page') : 'page';
            if (type === 'wasm') return true; // Keep WASM functions as they don't use tabs

            let itemUrl;
            if (type === 'page' || type === 'link') {
                itemUrl = typeof entry.item === 'string' ? entry.item : entry.item.url;
            } else if (type === 'local') {
                itemUrl = chrome.runtime.getURL(`sidebar/viewer.html?id=${entry.item.resourceId}&name=${encodeURIComponent(entry.item.name)}`);
            } else if (type === 'media') {
                itemUrl = chrome.runtime.getURL(`sidebar/media.html?id=${entry.item.mediaId}&type=${encodeURIComponent(entry.item.mimeType)}&name=${encodeURIComponent(entry.item.name)}`);
            }

            return openUrls.has(itemUrl);
        });

        if (filteredSeq.length === 0) return;

        let currentOriginalIndex = this.getActiveItemIndex();

        // If no URL accurately matches (e.g. we're on a WASM item), fallback to tracked index
        if (currentOriginalIndex === -1 && this.lastNavigatedIndex !== undefined) {
            currentOriginalIndex = this.lastNavigatedIndex;
        }

        const currentVisualIndex = filteredSeq.findIndex(entry => entry.originalIndex === currentOriginalIndex);

        let nextVisualIndex;
        if (currentVisualIndex === -1) {
            nextVisualIndex = direction > 0 ? 0 : filteredSeq.length - 1;
        } else {
            nextVisualIndex = (currentVisualIndex + direction + filteredSeq.length) % filteredSeq.length;
        }

        const nextEntry = filteredSeq[nextVisualIndex];
        this.lastNavigatedIndex = nextEntry.originalIndex;

        this.activatePacketItem(nextEntry.item, nextEntry.originalIndex);
    }

    async syncTabOrder() {
        if (!this.currentPacket) return;

        // Fallback: If we lost our group ID (e.g. extension reload), try to look it up/enforce it in the background
        if (this.activePacketGroupId === null) {
            console.log('[SyncTabOrder] Group ID missing locally, attempting background lookup...');
            const resp = await this.sendMessage({ action: 'playPacket', id: this.currentPacket.id });
            if (resp && resp.success && resp.groupId) {
                this.activePacketGroupId = resp.groupId;
            }
        }

        if (this.activePacketGroupId === null) {
            console.warn('[SyncTabOrder] No active group found for this packet');
            this.showNotification('Cannot sync: No tab group found for this packet', 'info');
            return;
        }

        try {
            const resp = await chrome.runtime.sendMessage({
                action: 'syncTabOrder',
                packetId: this.currentPacket.id
            });

            if (resp && resp.success) {
                console.log('[SyncTabOrder] Background sync triggered');
                // Visual feedback
                const btn = document.getElementById('syncTabOrderBtn');
                if (btn) {
                    const originalColor = btn.style.color;
                    btn.style.color = 'var(--success)';
                    setTimeout(() => btn.style.color = originalColor, 1000);
                }
            }
        } catch (e) {
            console.error('[SyncTabOrder] Message failed:', e);
        }
    }


    activatePacketItem(item, index) {
        const type = (typeof item === 'object') ? (item.type || 'page') : 'page';

        // 1. Update state immediately for atomic highlight feedback
        if (type === 'page' || type === 'link') {
            this.activeUrl = typeof item === 'string' ? item : item.url;
        } else if (type === 'local') {
            this.activeUrl = chrome.runtime.getURL(`sidebar/viewer.html?id=${item.resourceId}&name=${encodeURIComponent(item.name)}`);
        } else if (type === 'media') {
            this.activeUrl = chrome.runtime.getURL(`sidebar/media.html?id=${item.mediaId}&type=${encodeURIComponent(item.mimeType)}&name=${encodeURIComponent(item.name)}`);
        } else if (type === 'stack') {
            const sid = item.stackId;
            console.log('[Sidebar] Activating stack:', sid, item.name);
            this.activeUrl = chrome.runtime.getURL(`sidebar/stack.html?id=${sid}&packetId=${this.currentPacket.id}&name=${encodeURIComponent(item.name)}`);
        } else if (type === 'wasm') {
            this.lastNavigatedIndex = index;
        }

        // 2. Trigger atomic highlight update
        this.updateItemHighlights();

        // Helper to reclaim focus
        const reclaimFocus = () => {
            try {
                chrome.windows.getCurrent(win => {
                    if (win) {
                        chrome.sidePanel.open({ windowId: win.id }).catch(() => { });
                    }
                });

                if (index !== undefined) {
                    const selector = `[data-index="${index}"]`;
                    const el = document.querySelector(selector);
                    if (el) el.focus();
                } else {
                    window.focus();
                }
            } catch (e) {
                window.focus();
            }
        };

        if (type === 'page' || type === 'link' || type === 'local') {
            const url = this.activeUrl;
            this.sendMessage({
                action: 'openTabInGroup',
                url,
                groupId: this.activePacketGroupId,
                packetId: this.currentPacket.id
            }).then(resp => {
                if (resp && resp.success && resp.newGroupId) {
                    this.activePacketGroupId = resp.newGroupId;
                }
                reclaimFocus();
            });
        } else if (type === 'media') {
            this.playMedia(item).then(() => {
                reclaimFocus();
            });
        } else if (type === 'wasm') {
            this.runWasm(item, index).then(() => {
                reclaimFocus();
            });
        } else if (type === 'stack') {
            const url = this.activeUrl;
            this.sendMessage({
                action: 'openTabInGroup',
                url,
                groupId: this.activePacketGroupId,
                packetId: this.currentPacket.id
            }).then(resp => {
                if (resp && resp.success && resp.newGroupId) {
                    this.activePacketGroupId = resp.newGroupId;
                }
                reclaimFocus();
            });
        }
    }

    getActiveItemIndex() {
        if (!this.currentPacket || !this.currentPacket.urls) return -1;
        return this.currentPacket.urls.findIndex(item => {
            const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
            if (type === 'page' || type === 'link') {
                const url = typeof item === 'string' ? item : item.url;
                return this.urlsMatch(url, this.activeUrl);
            } else if (type === 'local') {
                const url = chrome.runtime.getURL(`sidebar/viewer.html?id=${item.resourceId}&name=${encodeURIComponent(item.name)}`);
                return this.urlsMatch(url, this.activeUrl);
            } else if (type === 'media') {
                const mediaUrl = chrome.runtime.getURL(`sidebar/media.html?id=${item.mediaId}&type=${encodeURIComponent(item.mimeType)}&name=${encodeURIComponent(item.name)}`);
                return this.urlsMatch(mediaUrl, this.activeUrl);
            } else if (type === 'stack') {
                const sid = item.stackId;
                if (sid) {
                    const stackUrl = chrome.runtime.getURL(`sidebar/stack.html?id=${sid}&packetId=${this.currentPacket.id}&name=${encodeURIComponent(item.name)}`);
                    return this.urlsMatch(stackUrl, this.activeUrl);
                }
            }
            return false;
        });
    }

    handleMediaDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        this.mediaDropZone.classList.add('drag-active');
    }

    async handleMediaDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        const dropZone = this.mediaDropZone;
        dropZone.classList.remove('drag-active');

        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;

        // Filter for media types
        const mediaFiles = files.filter(f => f.type.startsWith('image/') || f.type.startsWith('video/') || f.type.startsWith('audio/'));
        if (mediaFiles.length === 0) {
            this.showNotification('Only image, video, and audio files are supported.', 'error');
            return;
        }

        this.showNotification(`Uploading ${mediaFiles.length} files...`, 'info');

        for (const file of mediaFiles) {
            try {
                const arrayBuffer = await file.arrayBuffer();
                const resp = await this.sendMessage({
                    action: 'saveMediaBlob',
                    data: Array.from(new Uint8Array(arrayBuffer)),
                    type: file.type
                });

                if (resp && resp.success) {
                    this.currentPacket.urls.push({
                        type: 'media',
                        name: file.name,
                        mediaId: resp.id,
                        mimeType: file.type,
                        size: file.size
                    });
                }
            } catch (err) {
                console.error('Drop upload failed:', err);
            }
        }

        // Save packet update
        try {
            await this.sendMessage({
                action: 'savePacket',
                id: this.currentPacket.id,
                name: this.currentPacket.name,
                urls: this.currentPacket.urls
            });
            if (this.editMode) this.toggleEditMode();
            this.showPacketDetailView(this.currentPacket);
            this.showNotification('Packet updated with new media', 'success');
        } catch (err) {
            this.showNotification('Failed to update packet: ' + err.message, 'error');
        }
    }

    showConstructorView() {
        this.constructorItems = [];
        this.dragSrcIndex = null;
        // Reset save button in case it was left disabled from a previous save
        const saveBtn = document.getElementById('savePacketBtn');
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Packet';
        this.renderConstructorItems();
        this.showView('constructorView');
    }

    showSchemaConstructorView() {
        this.schemaRepoNameInput.value = '';
        this.schemaRepoSqlInput.value = '';
        const saveBtn = document.getElementById('saveSchemaRepoBtn');
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Schema';
        this.showView('schemaConstructorView');
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
        // Filter out internal packet databases (starting with packet_)
        const filtered = collections.filter(name => !name.startsWith('packet_'));

        if (filtered.length === 0) {
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
        const sorted = filtered.sort((a, b) => {
            if (a === 'wits') return -1;
            if (b === 'wits') return 1;
            if (a === 'events') return -1;
            if (b === 'events') return 1;
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

        const iconContainer = clone.querySelector('.collection-icon-container');
        if (iconContainer) {
            let svgPath = '';
            if (name === 'packets') {
                svgPath = '<path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"></path>';
            } else if (name === 'events') {
                svgPath = '<path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"></path>';
            } else if (name === 'schemas') {
                svgPath = '<path d="M4 18h16V6H4v12zm9-11h5v3h-5V7zm0 4h5v3h-5v-3zM6 7h5v7H6V7zm0 8h13v2H6v-2z"></path>';
            } else if (name === 'wits') {
                svgPath = '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"></path>';
            } else {
                svgPath = '<path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"></path>';
            }
            iconContainer.innerHTML = `<svg viewBox="0 0 24 24">${svgPath}</svg>`;
        }

        if (name === 'packets' || name === 'schemas' || name === 'wits' || name === 'events') {
            clone.querySelector('.collection-item').classList.add('system-collection');
            const deleteBtn = clone.querySelector('.delete-btn');
            if (deleteBtn) {
                deleteBtn.disabled = true;
                deleteBtn.title = `Cannot delete system collection "${name}"`;
                deleteBtn.style.opacity = '0.3';
                deleteBtn.style.cursor = 'not-allowed';
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

                // Show/hide floating add button for packets
                if (this.addPacketFloatingBtn) {
                    if (name === 'packets') {
                        this.addPacketFloatingBtn.classList.remove('hidden');
                    } else {
                        this.addPacketFloatingBtn.classList.add('hidden');
                    }
                }

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

                // Sync active group colors
                const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                const groups = await chrome.tabGroups.query({});
                const packetToColorMap = {};
                for (const g of groups) {
                    const pId = activeGroups[g.id];
                    if (pId) {
                        packetToColorMap[pId] = g.color;
                    }
                }

                // Removed dynamic addBtn creation (moved to floating action button)

                if (rows.length === 0) {
                    this.entriesContent.innerHTML = '';
                    this.entriesContent.insertAdjacentHTML('beforeend', '<p class="hint">No packets yet. Click the "+" button above to create one.</p>');
                    return;
                }

                const html = rows.map(([rowid, name, urlsJson, created]) => {
                    let itemCount = 0;
                    try {
                        const items = JSON.parse(urlsJson);
                        itemCount = items.length;
                    } catch (e) { }

                    const time = new Date(created).toLocaleString();
                    const groupColor = packetToColorMap[rowid];
                    const colorClass = groupColor ? `group-indicator-${groupColor}` : '';

                    return `
                    <div class="packet-card ${colorClass}" data-id="${rowid}" style="cursor: pointer;">
                        <div class="packet-info">
                            <span class="packet-name">${this.escapeHtml(name)} <span class="packet-url-count">${itemCount} Items</span></span>
                            <span class="packet-meta">Created ${time}</span>
                        </div>
                    </div>`;
                }).join('');

                this.entriesContent.innerHTML = `<div class="packet-list">${html}</div>`;

                // Add click handler to the entire card
                this.entriesContent.querySelectorAll('.packet-card').forEach((card, idx) => {
                    card.addEventListener('click', async (e) => {
                        // Show details immediately
                        const [rowid, name, urlsJson] = rows[idx];
                        this.showPacketDetailView({
                            id: rowid,
                            name: name,
                            urls: JSON.parse(urlsJson)
                        });

                        try {
                            const resp = await this.sendMessage({ action: 'playPacket', id: card.dataset.id });
                            if (resp && resp.success && resp.groupId) {
                                this.activePacketGroupId = resp.groupId;
                            }
                        } catch (error) {
                            console.error('Play failed:', error);
                            this.showNotification('Failed to open packet', 'error');
                        }
                    });
                });
            } else {
                this.entryCount.textContent = '0';
                this.entriesContent.innerHTML = '<p class="hint">No packets yet. Click the "+" button above to create one.</p>';
            }
        } catch (error) {
            console.error('Failed to load packets:', error);
            this.entriesContent.innerHTML = '<p class="hint">Failed to load packets.</p>';
        }
    }

    async loadMediaThumbnail(mediaId, elementId) {
        try {
            const resp = await this.sendMessage({ action: 'getMediaBlob', id: mediaId });
            if (resp && resp.success) {
                const blob = new Blob([new Uint8Array(resp.data)], { type: resp.type });
                const url = URL.createObjectURL(blob);
                const container = document.getElementById(elementId);
                if (container) {
                    if (resp.type.startsWith('video/')) {
                        container.innerHTML = `<video src="${url}" muted autoplay loop style="width:100%; height:100%; object-fit:cover; border-radius:inherit;"></video>`;
                    } else {
                        container.innerHTML = `<img src="${url}" alt="Thumbnail">`;
                    }
                }
            }
        } catch (e) {
            console.error('Thumbnail load failed:', e);
        }
    }

    async playMedia(item) {
        try {
            // Open media in a new tab using the media.html shell
            // and include it in the current packet's group if applicable
            const mediaUrl = chrome.runtime.getURL(`sidebar/media.html?id=${item.mediaId}&type=${encodeURIComponent(item.mimeType)}&name=${encodeURIComponent(item.name)}`);

            await this.sendMessage({
                action: 'openTabInGroup',
                url: mediaUrl,
                packetId: this.currentPacket.id
            });
            window.focus(); // Reclaim focus
        } catch (e) {
            console.error('playMedia failed:', e);
            this.showNotification('Failed to open media: ' + e.message, 'error');
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


    async addCurrentTab(silent = false) {
        try {
            const resp = await this.sendMessage({ action: 'getCurrentTab' });
            if (!resp.success) throw new Error(resp.error || 'Could not get current tab');
            const { title, url } = resp.tab;
            // Avoid duplicates (checking URLs only)
            if (this.constructorItems.some(item => item.type === 'page' && item.url === url)) {
                if (!silent) this.showNotification('Tab already added', 'error');
                return;
            }
            this.constructorItems.push({ type: 'page', title: title || url, url });
            this.renderConstructorItems();
        } catch (err) {
            console.error('addCurrentTab failed:', err);
            if (!silent) this.showNotification('Could not get current tab', 'error');
        }
    }

    async handleMediaFileSelect(event) {
        const files = Array.from(event.target.files);
        if (files.length === 0) return;

        for (const file of files) {
            try {
                const arrayBuffer = await file.arrayBuffer();
                const resp = await this.sendMessage({
                    action: 'saveMediaBlob',
                    data: Array.from(new Uint8Array(arrayBuffer)),
                    type: file.type
                });

                if (resp && resp.success) {
                    this.constructorItems.push({
                        type: 'media',
                        name: file.name,
                        mediaId: resp.id,
                        mimeType: file.type,
                        size: file.size
                    });
                    this.showNotification(`Added ${file.name}`, 'success');
                } else {
                    throw new Error(resp?.error || 'Failed to save media');
                }
            } catch (err) {
                console.error('handleMediaFileSelect failed:', err);
                this.showNotification(`Failed to add ${file.name}: ${err.message}`, 'error');
            }
        }
        this.renderConstructorItems();
        event.target.value = '';
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
                    <span class="drag-handle" title="Drag to reorder"></span>
                    <div class="constructor-card-info">
                        <div class="constructor-card-title">
                            <span class="type-badge wasm">WASM</span>
                            ${this.escapeHtml(item.prompt || item.name)}
                        </div>
                        <div class="constructor-card-url" style="color:var(--text-muted);">${item.zigCode ? 'AI Generated Logic' : 'Binary Module'}</div>
                    </div>
                    <button class="constructor-remove-btn" title="Remove" data-index="${index}">🗑</button>`;
            } else if (item.type === 'media') {
                card.classList.add('media');
                const isImage = item.mimeType.startsWith('image/');
                const icon = isImage ? '🖼️' : (item.mimeType.startsWith('video/') ? '🎬' : '🎵');
                card.innerHTML = `
                    <span class="drag-handle" title="Drag to reorder"></span>
                    <div class="constructor-card-info">
                        <div class="constructor-card-title">
                            <span class="type-badge media">MEDIA</span>
                            ${this.escapeHtml(item.name)}
                        </div>
                        <div class="constructor-card-url" style="color:var(--text-muted);">${icon} ${item.mimeType} (${this.formatSize(item.size)})</div>
                    </div>
                    <button class="constructor-remove-btn" title="Remove" data-index="${index}">🗑</button>`;
            } else {
                // Page
                card.innerHTML = `
                    <span class="drag-handle" title="Drag to reorder"></span>
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

    async createAndShowNewPacket(items = [], tabIdToGroup = null) {
        const now = new Date();
        const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
        const name = `Packet ${timeStr}`;

        try {
            const resp = await this.sendMessage({
                action: 'savePacket',
                name: name,
                urls: items
            });

            if (resp && resp.success && resp.id) {
                const newPacket = {
                    id: resp.id,
                    name: name,
                    urls: items
                };

                // Triggers playPacket to ensure tab group is created/focused
                await this.sendMessage({ action: 'playPacket', id: resp.id });

                if (tabIdToGroup) {
                    await this.sendMessage({
                        action: 'joinPacketGroup',
                        tabId: tabIdToGroup,
                        packetId: resp.id
                    });
                }

                // If empty, mark it for "garbage collection" if abandoned
                if (items.length === 0) {
                    this.newlyCreatedEmptyPacketId = resp.id;
                    if (!this.editMode) this.toggleEditMode();
                } else {
                    this.newlyCreatedEmptyPacketId = null;
                }

                // Refresh the list in background but show detail immediately
                this.loadCollections();
                this.showPacketDetailView(newPacket);
                this.showNotification(`Created "${name}"`, 'success');
            } else {
                throw new Error(resp?.error || 'Failed to create packet');
            }
        } catch (err) {
            console.error('createAndShowNewPacket failed:', err);
            this.showNotification('Failed to create packet: ' + err.message, 'error');
        }
    }

    async openTerminal() {
        if (!this.currentPacket) return;
        const packetId = this.currentPacket.id;

        // Check if terminal is already open
        if (this.terminalTabs[packetId]) {
            try {
                // Focus the existing tab
                await chrome.tabs.update(this.terminalTabs[packetId], { active: true });
                // Also focus the window containing the tab
                const tab = await chrome.tabs.get(this.terminalTabs[packetId]);
                await chrome.windows.update(tab.windowId, { focused: true });
                return;
            } catch (e) {
                console.warn('Failed to focus existing terminal tab, opening new one:', e);
                delete this.terminalTabs[packetId];
            }
        }

        const terminalUrl = chrome.runtime.getURL(`public/terminal.html?packetId=${packetId}`);

        try {
            await this.sendMessage({
                action: 'openTabInGroup',
                url: terminalUrl,
                packetId: packetId
            });
            window.focus(); // Reclaim focus
        } catch (e) {
            console.error('openTerminal failed:', e);
            this.showNotification('Failed to open terminal: ' + e.message, 'error');
        }
    }

    async syncTerminalState() {
        try {
            const response = await this.sendMessage({ action: 'getTerminalTabs' });
            if (response && response.success) {
                this.terminalTabs = response.terminalTabs;
                this.updateTerminalUI();
            }
        } catch (e) {
            console.error('Failed to sync terminal state:', e);
        }
    }

    updateTerminalUI() {
        if (!this.terminalOpenBtn || !this.currentPacket) return;
        // Defensive: convert to string for robust lookup
        const isActive = !!this.terminalTabs[String(this.currentPacket.id)];
        if (isActive) {
            this.terminalOpenBtn.classList.add('terminal-active');
            this.terminalOpenBtn.title = 'Focus Terminal';
        } else {
            this.terminalOpenBtn.classList.remove('terminal-active');
            this.terminalOpenBtn.title = 'Open Terminal';
        }
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
        const name = prompt('Enter database name:');
        if (!name || !name.trim()) return;

        try {
            const response = await this.sendMessage({ action: 'createCollection', name: name.trim() });
            if (response.success) {
                this.loadCollections();
                this.showNotification(`Database "${name}" created`, 'success');
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
            const name = prompt('Enter database name:', file.name.replace(/\.(db|sqlite|sqlite3)$/, ''));
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

                this.showNotification(`Database "${name}" exported`, 'success');
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
                    this.showNotification(`Database "${name}" restored`, 'success');
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
                this.showNotification(`Database "${name}" deleted`, 'success');
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
          color: var(--text); border-radius: 8px;
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
        this.geminiApiKeyInput.value = this.geminiApiKey;
        this.geminiSystemPromptInput.value = this.geminiSystemPrompt || DEFAULT_SYSTEM_INSTRUCTION;
        this.showView('settingsView');
        this.updateThemeUI();
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

    async saveApiKey(silent = false) {
        const apiKey = this.geminiApiKeyInput.value.trim();
        this.geminiApiKey = apiKey;
        await chrome.storage.local.set({ geminiApiKey: apiKey });
        if (!silent) this.showNotification('API Key saved', 'success');
        this.checkAiFeatureAvailability();
    }

    async savePrompt(silent = false) {
        const systemPrompt = this.geminiSystemPromptInput.value.trim();
        this.geminiSystemPrompt = systemPrompt;
        await chrome.storage.local.set({ geminiSystemPrompt: systemPrompt });
        if (!silent) this.showNotification('System Prompt saved', 'success');
    }

    async saveAutoSettings() {
        const model = this.geminiModelSelect.value;
        const theme = this.theme;
        this.geminiModel = model;
        await chrome.storage.local.set({
            geminiModel: model,
            theme: theme
        });
        this.applyTheme();
    }

    async saveNetworkSettings() {
        const networkEnabled = this.networkAccessToggle.checked;
        this.networkEnabled = networkEnabled;
        await chrome.storage.local.set({ networkEnabled: networkEnabled });
        await this.sendMessage({ action: 'TOGGLE_NETWORK', enabled: networkEnabled });
        this.applyOfflineMode();
        this.updateOnlineStatus(); // NEW: Update indicator immediately
        this.showNotification(`Network ${networkEnabled ? 'enabled' : 'disabled'}`, 'success');
    }

    restoreDefaultPrompt() {
        if (confirm('Restore default system instructions? This will overwrite your current changes.')) {
            this.geminiSystemPromptInput.value = DEFAULT_SYSTEM_INSTRUCTION;
        }
    }

    async loadSettings() {
        const data = await chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'geminiSystemPrompt', 'theme', 'networkEnabled', 'webAuthnEnabled', 'webAuthnCredentialId']);
        this.geminiApiKey = data.geminiApiKey || '';
        this.geminiModel = data.geminiModel || '';
        this.geminiSystemPrompt = data.geminiSystemPrompt || '';
        this.theme = data.theme || 'system';
        this.networkEnabled = data.networkEnabled !== false; // Default to true
        this.webAuthnEnabled = data.webAuthnEnabled || false;
        this.webAuthnCredentialId = data.webAuthnCredentialId || null;

        // Populate UI
        this.geminiApiKeyInput.value = this.geminiApiKey;
        this.geminiSystemPromptInput.value = this.geminiSystemPrompt || DEFAULT_SYSTEM_INSTRUCTION;
        this.updateThemeUI();
        if (this.networkAccessToggle) this.networkAccessToggle.checked = this.networkEnabled;
        if (this.webAuthnToggle) this.webAuthnToggle.checked = this.webAuthnEnabled;
        this.renderModelSelect();
        this.geminiModelSelect.value = this.geminiModel;

        this.applyTheme();
        this.applyOfflineMode();
        this.checkAiFeatureAvailability();
    }

    applyOfflineMode() {
        if (this.networkEnabled) {
            document.body.classList.remove('offline-mode');
        } else {
            document.body.classList.add('offline-mode');
        }
    }

    // ===== WEBAUTHN LOGIC =====

    showLockScreen() {
        if (this.lockScreen) {
            this.lockScreen.classList.remove('hidden');
            // Auto-trigger verification
            this.verifyWebAuthn();
        }
    }

    hideLockScreen() {
        if (this.lockScreen) {
            this.lockScreen.classList.add('hidden');
        }
    }

    async handleWebAuthnToggle() {
        const enabled = this.webAuthnToggle.checked;
        if (enabled) {
            // Open registration tab
            chrome.tabs.create({ url: chrome.runtime.getURL('sidebar/auth.html?mode=register') });
            this.showNotification('Complete registration in the new tab...', 'info');
        } else {
            if (confirm('Are you sure you want to disable biometric protection?')) {
                this.webAuthnEnabled = false;
                this.webAuthnCredentialId = null;
                await chrome.storage.local.set({
                    webAuthnEnabled: false,
                    webAuthnCredentialId: null
                });
                this.showNotification('Biometric protection disabled', 'info');
            } else {
                this.webAuthnToggle.checked = true;
            }
        }
    }

    async verifyWebAuthn() {
        if (!this.webAuthnCredentialId) {
            this.showNotification('No biometric credential found. Please toggle setting.', 'error');
            this.hideLockScreen();
            return;
        }
        // Open verification tab
        chrome.tabs.create({ url: chrome.runtime.getURL('sidebar/auth.html?mode=verify') });
        this.showNotification('Verify your identity in the new tab...', 'info');
    }

    async handleAuthResult(result) {
        if (!result || !result.success) return;
        
        // Cooldown check: only process recent results (last 10 seconds)
        if (Date.now() - result.timestamp > 10000) return;

        if (result.mode === 'register') {
            await this.loadSettings();
            this.showNotification('Biometric protection enabled', 'success');
        } else if (result.mode === 'verify') {
            this.isVerified = true;
            this.hideLockScreen();
            this.showNotification('Identity verified', 'success');
            this.continueInit();
        }
        
        // Clear result so it's not re-processed
        await chrome.storage.local.remove('webAuthnResult');
    }

    async handleAuthResult(result) {
        if (!result || !result.success) return;
        
        // Cooldown check: only process recent results (last 10 seconds)
        if (Date.now() - result.timestamp > 10000) return;

        if (result.mode === 'register') {
            await this.loadSettings();
            this.showNotification('Biometric protection enabled', 'success');
        } else if (result.mode === 'verify') {
            this.isVerified = true;
            this.hideLockScreen();
            this.showNotification('Identity verified', 'success');
            this.continueInit();
        }
        
        // Clear result so it's not re-processed
        await chrome.storage.local.remove('webAuthnResult');
    }

    applyTheme() {
        let activeTheme = this.theme;
        if (activeTheme === 'system') {
            activeTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }

        if (activeTheme === 'dark') {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
        this.updateThemeUI();
    }

    setTheme(theme) {
        this.theme = theme;
        this.applyTheme();
        this.saveAutoSettings();
    }

    updateThemeUI() {
        if (!this.themeLightCard) return;
        this.themeLightCard.classList.toggle('active', this.theme === 'light');
        this.themeSystemCard.classList.toggle('active', this.theme === 'system');
        this.themeDarkCard.classList.toggle('active', this.theme === 'dark');
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
            const response = await fetch(url).catch(err => {
                if (!this.networkEnabled) {
                    throw new Error('Network access is disabled in settings');
                }
                throw err;
            });

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
            if (this.aiGenerateWasmDetailBtn) this.aiGenerateWasmDetailBtn.classList.remove('hidden');
        } else {
            this.aiGenerateWasmBtn.classList.add('hidden');
            if (this.aiGenerateWasmDetailBtn) this.aiGenerateWasmDetailBtn.classList.add('hidden');
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
                let finalPrompt = `${originalPrompt}\n\n`;
                if (attempt > 1 && lastError) {
                    finalPrompt += `IMPORTANT: Your previous attempt failed to compile. Please fix the errors below.\n\nPREVIOUS CODE:\n\`\`\`zig\n${lastCode}\n\`\`\`\n\nCOMPILER ERROR:\n${lastError}`;
                }

                const zigCode = await this.callGeminiApi(finalPrompt, wits, dbContext);
                console.log('%c[AI Generated Zig Code]', 'color: #10b981; font-weight: bold; font-size: 12px;');
                console.log(zigCode);
                lastCode = zigCode;

                // 3. Compile Zig to WASM (Validation)
                if (typeof compileZigCode === 'undefined') {
                    throw new Error('Internal compiler not loaded');
                }
                this.aiStatusText.textContent = `Validating (Attempt #${attempt})...`;
                const wasmBytes = await compileZigCode(zigCode, (status) => {
                    this.aiStatusText.textContent = `${status} (Attempt #${attempt})...`;
                });

                // Convert binary to base64 for storage
                const base64 = this.arrayBufferToBase64(wasmBytes);

                const newWasmItem = {
                    type: 'wasm',
                    name: 'Function',
                    zigCode: zigCode,
                    data: base64,
                    prompt: originalPrompt
                };

                // Add to the appropriate place depending on current view
                if (this.packetDetailView.classList.contains('active') && this.currentPacket) {
                    this.currentPacket.urls.push(newWasmItem);
                    await this.sendMessage({
                        action: 'savePacket',
                        id: this.currentPacket.id,
                        name: this.currentPacket.name,
                        urls: this.currentPacket.urls
                    });
                    if (this.editMode) this.toggleEditMode();
                    this.showPacketDetailView(this.currentPacket);
                } else {
                    this.constructorItems.push(newWasmItem);
                    this.renderConstructorItems();
                }

                this.showNotification('Logic generated, validated, and added!', 'success');
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

    async isWasmInteractive(base64Data) {
        try {
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const module = await WebAssembly.compile(bytes);
            const imports = WebAssembly.Module.imports(module);

            // Heuristic: If it imports wasi_snapshot_preview1's fd_read or fd_write,
            // it likely wants to interact with a terminal.
            return imports.some(imp =>
                imp.module === 'wasi_snapshot_preview1' &&
                (imp.name === 'fd_read' || imp.name === 'fd_write')
            );
        } catch (e) {
            console.warn('Failed to inspect WASM imports:', e);
            return false;
        }
    }

    async runWasm(item, index) {
        if (!item.data) {
            this.showNotification('Function has no data', 'error');
            return;
        }

        const isInteractive = await this.isWasmInteractive(item.data);
        if (isInteractive) {
            // Open terminal and execute (untracked)
            let name = item.name || item.title || `wasm_${index}`;
            name = name.replace(/[\/\\?%*:|"<>]/g, '_');

            const url = chrome.runtime.getURL(`public/terminal.html?packetId=${this.currentPacket.id}&exec=${encodeURIComponent(name)}&track=false`);
            await this.sendMessage({
                action: 'openTabInGroup',
                url: url,
                packetId: this.currentPacket.id
            });
            return;
        }

        try {
            const resp = await this.sendMessage({ action: 'runWasmPacketItem', item });
            if (resp.success) {
                this.showWasmResults(resp.logs, resp.result, true);
            } else {
                this.showWasmResults(resp.logs, null, false, resp.error);
            }
        } catch (error) {
            console.error('WASM run error:', error);
            this.showWasmResults([], null, false, error.message);
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
        }).catch(err => {
            if (!this.networkEnabled) {
                throw new Error('Network access is disabled in settings. Please enable it to use AI features.');
            }
            throw err;
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

    async updateClipperState() {
        const isDetailView = this.packetDetailView.classList.contains('active');
        const isConstructorView = this.constructorView.classList.contains('active');

        // Update toolbar badge for "Ready to Clip" state
        await this.checkReadyToClip();

        // REDESIGN: Only active if manually invoked, not cancelled, and in detail or constructor view
        if ((!isDetailView && !isConstructorView) || this.isClipperManuallyCancelled || !this.isClipperInvoked) {
            this.setClipperActive(false);
            return;
        }

        // If in detail view, we also need a currentPacket
        if (isDetailView && !this.currentPacket) {
            this.setClipperActive(false);
            return;
        }

        try {
            const resp = await this.sendMessage({ action: 'getCurrentTab' });
            if (!resp.success) {
                this.setClipperActive(false);
                return;
            }

            const currentUrl = resp.tab.url;
            const currentGroupId = resp.tab.groupId;

            // Boundary enforcement: must be the correct tab group (if in a packet)
            // For constructor view, we don't have a fixed group yet, so we're more lenient
            let isInPacket = false;
            if (isDetailView && this.currentPacket) {
                isInPacket = this.currentPacket.urls.some(item => {
                    const itemUrl = typeof item === 'string' ? item : item.url;
                    return itemUrl && this.urlsMatch(itemUrl, currentUrl);
                });
            }

            const isCorrectGroup = currentGroupId !== undefined && currentGroupId === this.activePacketGroupId;

            // REDESIGN: If manually invoked, show in islandOnly mode first
            const active = this.isClipperInvoked || (isInPacket && isCorrectGroup);
            this.setClipperActive(active, this.isClipperInvoked);
        } catch (err) {
            this.setClipperActive(false);
        }
    }

    async setClipperActive(active, islandOnly = false) {
        // If we are deactivating, make sure we clear the last known capture tab's badge
        if (!active && this.activeCaptureTabId) {
            this.sendMessage({ type: 'UPDATE_BADGE', isReadyToClip: false, tabId: this.activeCaptureTabId }).catch(() => { });
            this.activeCaptureTabId = null;
        }
        
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            chrome.tabs.sendMessage(tab.id, { type: 'SET_CLIPPER_ACTIVE', active, islandOnly }).catch(() => { });

            if (active) {
                this.activeCaptureTabId = tab.id;
            }

            // Re-sync badge state
            await this.checkReadyToClip();
        }
    }

    async checkReadyToClip() {
        if (this.isClipperIconProcessing) return;

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) return;

            let isReady = false;

            // Only "Ready to Clip" if we're NOT already invoked/open and NOT a media page
            if (!this.isClipperInvoked && !this.isMediaPage(tab.url)) {
                const isDetailView = this.packetDetailView.classList.contains('active');
                const isConstructorView = this.constructorView.classList.contains('active');

                if (isDetailView && this.currentPacket) {
                    const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                    const packetIdFromGroup = activeGroups[tab.groupId];
                    if (packetIdFromGroup && String(packetIdFromGroup) === String(this.currentPacket.id)) {
                        isReady = true;
                    }
                } else if (isConstructorView) {
                    const isTabInConstructor = this.constructorItems.some(item => item.type === 'link' && item.url === tab.url);
                    if (isTabInConstructor) {
                        isReady = true;
                    }
                }
            }

            // Notify background about toolbar badge change
            this.sendMessage({
                type: 'UPDATE_BADGE',
                isReadyToClip: isReady,
                tabId: tab.id
            }).catch(() => { });

        } catch (e) {
            console.error('[SidebarUI] checkReadyToClip failed:', e);
        }
    }

    async handleClipperRegionSelected(region) {
        try {
            if (this.pendingVideoClip) {
                // Video Clip path
                this.pendingVideoRegion = region;
                await this.setClipperActive(false);
                
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) throw new Error('No active tab');

                const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
                
                await this.sendMessage({ 
                    action: 'START_TAB_VIDEO_RECORDING', 
                    streamId,
                    region: region
                });
                
                this.pendingVideoClip = false;
                this.pendingVideoRegion = null;
                return;
            }

            // Image Clip path (screenshot)
            // 1. Deactivate clipper UI immediately so it's hidden from the screenshot
            await this.setClipperActive(false);

            // 2. Wait a small amount of time for the browser to re-render without the overlay
            await new Promise(r => setTimeout(r, 100));

            // 3. Now capture the visible tab
            const resp = await this.sendMessage({ action: 'captureVisibleTab' });
            if (!resp.success) throw new Error(resp.error);

            const img = new Image();
            img.src = resp.dataUrl;
            await new Promise(r => img.onload = r);

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const dpr = region.devicePixelRatio || 1;

            canvas.width = region.width * dpr;
            canvas.height = region.height * dpr;

            ctx.drawImage(
                img,
                region.x * dpr,
                region.y * dpr,
                region.width * dpr,
                region.height * dpr,
                0,
                0,
                region.width * dpr,
                region.height * dpr
            );

            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const arrayBuffer = await blob.arrayBuffer();

            const saveResp = await this.sendMessage({
                action: 'saveMediaBlob',
                data: Array.from(new Uint8Array(arrayBuffer)),
                type: 'image/png'
            });

            if (saveResp && saveResp.success) {
                const name = `Clip ${new Date().toLocaleString()}`;
                const newMediaItem = {
                    type: 'media',
                    name: name,
                    mediaId: saveResp.id,
                    mimeType: 'image/png',
                    size: blob.size
                };

                if (this.constructorView.classList.contains('active')) {
                    // Route to constructor instead of existing packet
                    this.constructorItems.push(newMediaItem);
                    this.renderConstructorItems();
                } else if (this.currentPacket) {
                    this.currentPacket.urls.push(newMediaItem);
                    await this.sendMessage({
                        action: 'savePacket',
                        id: this.currentPacket.id,
                        name: this.currentPacket.name,
                        urls: this.currentPacket.urls
                    });
                    this.showPacketDetailView(this.currentPacket);
                }

                // Note: setClipperActive(false) was already called at the start

                // Highlight the new item
                setTimeout(() => {
                    const cards = document.querySelectorAll('.packet-media-card');
                    const lastCard = cards[cards.length - 1];
                    if (lastCard) {
                        lastCard.classList.add('new-clip-animation');
                        lastCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                }, 100);
            }
        } catch (err) {
            console.error('Clipping failed:', err);
            this.showNotification('Clipping failed: ' + err.message, 'error');
        }
    }

    handleClipperCancelled() {
        this.isClipperManuallyCancelled = true;
        this.isClipperInvoked = false;
        this.setClipperActive(false);
    }

    async handleAudioClipFinished(dataUrl) {
        console.log('[Wildcard] handleAudioClipFinished received dataUrl length:', dataUrl.length);
        try {
            const res = await fetch(dataUrl);
            const blob = await res.blob();
            console.log('[Wildcard] Audio blob created, size:', blob.size, 'type:', blob.type);
            const arrayBuffer = await blob.arrayBuffer();

            const saveResp = await this.sendMessage({
                action: 'saveMediaBlob',
                data: Array.from(new Uint8Array(arrayBuffer)),
                type: 'audio/webm'
            });

            console.log('[Wildcard] saveMediaBlob response:', saveResp);

            if (saveResp && saveResp.success) {
                const name = `Audio Clip ${new Date().toLocaleString()}`;
                const newMediaItem = {
                    type: 'media',
                    name: name,
                    mediaId: saveResp.id,
                    mimeType: 'audio/webm',
                    size: blob.size
                };

                if (this.constructorView.classList.contains('active')) {
                    // Route to constructor
                    this.constructorItems.push(newMediaItem);
                    this.renderConstructorItems();
                } else if (this.currentPacket) {
                    console.log('[Wildcard] Adding audio clip to packet:', this.currentPacket.id);
                    this.currentPacket.urls.push(newMediaItem);

                    await this.sendMessage({
                        action: 'savePacket',
                        id: this.currentPacket.id,
                        name: this.currentPacket.name,
                        urls: this.currentPacket.urls
                    });

                    if (this.editMode) this.toggleEditMode();
                    this.showPacketDetailView(this.currentPacket);
                }

                // Highlight the new item
                setTimeout(() => {
                    const cards = document.querySelectorAll('.packet-media-card');
                    const lastCard = cards[cards.length - 1];
                    if (lastCard) {
                        lastCard.classList.add('new-clip-animation');
                        lastCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                }, 100);
            }
        } catch (err) {
            console.error('[Wildcard] Audio clip saving failed:', err);
            this.showNotification('Audio clip saving failed: ' + err.message, 'error');
        }
    }

    isMediaPage(url) {
        if (!url) return false;
        // Internal media viewer
        if (url.includes('sidebar/media.html')) return true;
        // Common direct media extensions
        const mediaExts = ['.mp4', '.webm', '.ogg', '.mp3', '.wav', '.png', '.jpg', '.jpeg', '.gif', '.pdf'];
        try {
            const path = new URL(url).pathname.toLowerCase();
            return mediaExts.some(ext => path.endsWith(ext));
        } catch (e) {
            return false;
        }
    }

    formatSize(size) {
        const bytes = Math.max(0, Number(size) || 0);
        if (bytes < 1024 * 1024) { // < 1 MB
            return (bytes / 1024).toFixed(1) + ' KB';
        }
        return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    }
}

// Initialize UI when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new SidebarUI();
});

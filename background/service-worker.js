/**
 * Background Service Worker for SQLite Manager Extension
 * Handles database operations and side panel management
 */

// Import scripts in service worker context (paths relative to extension root)
self.importScripts('../vendor/sqlite/sql-wasm.js', '../src/sqlite-manager.js', '../src/blob-storage.js');

let sqliteManager = null;
const blobStorage = new BlobStorage();
let SQL = null;
let initialized = false;
let initializing = null; // Lock for initialization

// In-memory cache for synchronous mapping access
let tabToUrlMapCached = {};

// Bookmarks cache for synchronous access from WASM
let bookmarkCache = null;

// Track sidebar port to know if it's open
let sidebarPort = null;

// Track open terminal tabs: packetId -> tabId
let terminalTabs = {};

const NETWORK_BLOCK_RULE_ID = 1;

async function syncBookmarkCache() {
    try {
        bookmarkCache = await chrome.bookmarks.getTree();
        console.log('[BookmarksCache] Synced', bookmarkCache.length, 'root nodes:', JSON.stringify(bookmarkCache).substring(0, 100) + '...');
    } catch (e) {
        console.error('[BookmarksCache] Sync failed:', e);
    }
}

// Keep cache in sync
chrome.bookmarks.onCreated.addListener(syncBookmarkCache);
chrome.bookmarks.onRemoved.addListener(syncBookmarkCache);
chrome.bookmarks.onChanged.addListener(syncBookmarkCache);
chrome.bookmarks.onMoved.addListener(syncBookmarkCache);
chrome.bookmarks.onChildrenReordered.addListener(syncBookmarkCache);
chrome.bookmarks.onImportEnded.addListener(syncBookmarkCache);

// Terminal tab tracking
chrome.tabs.onRemoved.addListener((tabId) => {
    for (const [packetId, tId] of Object.entries(terminalTabs)) {
        if (tId === tabId) {
            delete terminalTabs[packetId];
            console.log(`[SW] Terminal tab ${tabId} closed for packet ${packetId}`);
            // Notify sidebar if it's open
            if (sidebarPort) {
                sidebarPort.postMessage({ type: 'TERMINAL_STATE_CHANGED', terminalTabs });
            }
            break;
        }
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && tab.url.includes('terminal.html')) {
        try {
            const url = new URL(tab.url);
            const packetId = url.searchParams.get('packetId');
            const track = url.searchParams.get('track') !== 'false';
            if (packetId && track) {
                terminalTabs[packetId] = tabId;
                console.log(`[SW] Terminal tab ${tabId} registered for packet ${packetId}`);
                if (sidebarPort) {
                    sidebarPort.postMessage({ type: 'TERMINAL_STATE_CHANGED', terminalTabs });
                }
            } else if (packetId) {
                console.log(`[SW] Terminal tab ${tabId} opened for packet ${packetId} (untracked)`);
            }
        } catch (e) {
            console.error('[SW] Failed to parse terminal URL:', e);
        }
    }
});

// Ensure the side panel doesn't intercept the click event so onClicked can fire
chrome.runtime.onInstalled.addListener(async () => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);

    // Programmatic injection for all existing tabs on install/reload
    // This allows the clipper to work without needing a refresh
    try {
        const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
        for (const tab of tabs) {
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['src/clipper.js']
            }).catch(() => {
                // Silently skip restricted tabs (like Chrome Settings or Web Store)
            });
            // Also update badge for each tab
            updateBadge({ tabId: tab.id });
        }
    } catch (e) {
        console.error('[SW] Programmatic injection/badge update failed:', e);
    }

    // Ensure network rules are in sync with settings on install/update
    await syncNetworkStatus();
});

chrome.runtime.onStartup.addListener(async () => {
    try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            updateBadge({ tabId: tab.id });
        }
    } catch (e) { }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.activeGroups || changes.networkEnabled)) {
        chrome.tabs.query({}).then(tabs => {
            for (const tab of tabs) {
                updateBadge({ tabId: tab.id }).catch(() => { });
            }
        });
    }
});

async function syncNetworkStatus() {
    try {
        const { networkEnabled } = await chrome.storage.local.get('networkEnabled');
        const isDisabled = networkEnabled === false;

        if (isDisabled) {
            console.log('[SW-Startup] Network kill switch is ENABLED (blocking requests)');
            await updateBadge({});
            await chrome.declarativeNetRequest.updateDynamicRules({
                addRules: [{
                    id: NETWORK_BLOCK_RULE_ID,
                    priority: 100,
                    action: { type: 'block' },
                    condition: {
                        urlFilter: '*',
                        resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other']
                    }
                }],
                removeRuleIds: [NETWORK_BLOCK_RULE_ID]
            });
        } else {
            console.log('[SW-Startup] Network kill switch is DISABLED (allowing requests)');
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: [NETWORK_BLOCK_RULE_ID]
            });
        }
    } catch (e) {
        console.error('[SW] syncNetworkStatus failed:', e);
    }
}

// Call on startup
syncNetworkStatus();

// Context menu removed as per user request. Toolbar is now the primary invocation method.

chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'toggle-recording') {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) return;
        try {
            console.log('[SW] Command invocation, requesting streamId');
            const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
            await initiateAudioRecording(streamId, tab.id);
        } catch (e) {
            console.error('[SW] Command invocation failed:', e);
        }
    }
});

async function ensureOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length === 0) {
        console.log('[SW] Creating offscreen document');
        await chrome.offscreen.createDocument({
            url: 'offscreen/offscreen.html',
            reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
            justification: 'Capture audio for clipping tool'
        });
        // Small delay to ensure script is loaded
        await new Promise(r => setTimeout(r, 500));
    }
}

function isMediaPage(url) {
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

async function initiateAudioRecording(streamId, targetTabId) {
    console.log('[SW] initiateAudioRecording for tab:', targetTabId);

    // 1. Ensure clipper is active on that tab (unless it's a media page where overlay fails)
    const tab = await chrome.tabs.get(targetTabId).catch(() => null);
    if (tab && !isMediaPage(tab.url)) {
        await chrome.tabs.sendMessage(targetTabId, { type: 'SET_CLIPPER_ACTIVE', active: true }).catch(() => { });
    }

    // 2. Create offscreen document if it doesn't exist
    await ensureOffscreenDocument();

    // 3. Start recording in offscreen
    console.log('[SW] Sending START_RECORDING to offscreen');
    chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        streamId
    });

    // 4. Update Island UI (if it's already open, it will receive this)
    setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'AUDIO_RECORDING_REMOTE_START', streamId });
    }, 200);
}

// Robust URL normalization for matching across redirects (protocol, www, trailing slashes, hashes)
function normalizeUrl(url) {
    if (!url) return '';
    try {
        // Remove hash and trailing slash, then lowercase
        let u = url.split('#')[0].replace(/\/$/, '').toLowerCase();
        // Remove protocol and www.
        return u.replace(/^https?:\/\//, '').replace(/^www\./, '');
    } catch (e) { return url; }
}

function urlsMatch(u1, u2) {
    return normalizeUrl(u1) === normalizeUrl(u2);
}

async function setTabMapping(tabId, url, packetId) {
    try {
        tabToUrlMapCached[tabId] = { url, packetId };
        await chrome.storage.local.set({ tabToUrlMap: tabToUrlMapCached });

        // Track local pages for recovery after reload
        if (url && url.includes('viewer.html')) {
            const { openLocalPages = {} } = await chrome.storage.local.get('openLocalPages');
            openLocalPages[tabId] = { url, packetId };
            await chrome.storage.local.set({ openLocalPages });
        }
    } catch (e) { }
}

function getMappedUrlSync(tabId) {
    const mapping = tabToUrlMapCached[tabId];
    if (!mapping) return null;
    return typeof mapping === 'object' ? mapping.url : mapping;
}

function getMappedPacketIdSync(tabId) {
    const mapping = tabToUrlMapCached[tabId];
    if (!mapping || typeof mapping !== 'object') return null;
    return mapping.packetId;
}

async function removeTabMapping(tabId) {
    try {
        delete tabToUrlMapCached[tabId];
        await chrome.storage.local.set({ tabToUrlMap: tabToUrlMapCached });

        // Also remove from local page tracking
        const { openLocalPages = {} } = await chrome.storage.local.get('openLocalPages');
        if (openLocalPages[tabId]) {
            delete openLocalPages[tabId];
            await chrome.storage.local.set({ openLocalPages });
        }
    } catch (e) { }
}

function getVisualSequence(packet) {
    if (!packet || !packet.urls) return [];
    const itemsWithIndex = packet.urls.map((item, originalIndex) => ({ item, originalIndex }));

    const pages = itemsWithIndex.filter(({ item }) => {
        const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
        return type === 'page' || type === 'link' || type === 'local';
    });
    const media = itemsWithIndex.filter(({ item }) => (typeof item === 'object' && item.type === 'media'));
    const wasm = itemsWithIndex.filter(({ item }) => (typeof item === 'object' && item.type === 'wasm'));

    return [...pages, ...media, ...wasm];
}

async function navigatePacketItems(groupId, direction) {
    const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
    const packetId = activeGroups[groupId];
    if (!packetId) return;

    try {
        await initializeSQLite();
        const db = sqliteManager.getDatabase('packets');
        const rows = db.exec(`SELECT name, urls FROM packets WHERE rowid = ${packetId}`);
        if (!rows.length) return;

        const [name, urlsJson] = rows[0].values[0];
        const packet = { id: packetId, name, urls: JSON.parse(urlsJson) };

        const visualSeq = getVisualSequence(packet);
        if (visualSeq.length === 0) return;

        const tabs = await chrome.tabs.query({ groupId: groupId });
        const openUrls = new Set(tabs.map(t => t.url).filter(Boolean));

        const filteredSeq = visualSeq.filter(entry => {
            const type = (typeof entry.item === 'object') ? (entry.item.type || 'page') : 'page';
            if (type === 'wasm') return true;

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

        // Find current active tab in group
        const [activeTab] = await chrome.tabs.query({ active: true, groupId: groupId });
        let currentIndex = -1;
        if (activeTab) {
            const activeUrl = getMappedUrlSync(activeTab.id) || activeTab.url;
            currentIndex = filteredSeq.findIndex(entry => {
                const item = entry.item;
                const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
                if (type === 'page' || type === 'link') {
                    const url = typeof item === 'string' ? item : item.url;
                    return urlsMatch(url, activeUrl);
                } else if (type === 'media') {
                    const mediaUrl = chrome.runtime.getURL(`sidebar/media.html?id=${item.mediaId}&type=${encodeURIComponent(item.mimeType)}&name=${encodeURIComponent(item.name)}`);
                    return urlsMatch(mediaUrl, activeUrl);
                }
                return false;
            });
        }

        let nextVisualIndex;
        if (currentIndex === -1) {
            nextVisualIndex = direction > 0 ? 0 : filteredSeq.length - 1;
        } else {
            nextVisualIndex = (currentIndex + direction + filteredSeq.length) % filteredSeq.length;
        }

        const nextEntry = filteredSeq[nextVisualIndex];
        const nextItem = nextEntry.item;
        const type = (typeof nextItem === 'object') ? (nextItem.type || 'page') : 'page';

        if (type === 'page' || type === 'link' || type === 'media') {
            let url;
            if (type === 'media') {
                url = chrome.runtime.getURL(`sidebar/media.html?id=${nextItem.mediaId}&type=${encodeURIComponent(nextItem.mimeType)}&name=${encodeURIComponent(nextItem.name)}`);
            } else if (type === 'local') {
                url = chrome.runtime.getURL(`sidebar/viewer.html?id=${nextItem.resourceId}&name=${encodeURIComponent(nextItem.name)}`);
            } else {
                url = typeof nextItem === 'string' ? nextItem : nextItem.url;
            }

            // Reuse handleMessage logic or simplified version
            const tabsInGroup = await chrome.tabs.query({ groupId });
            let existing = null;
            for (const t of tabsInGroup) {
                const mapped = getMappedUrlSync(t.id);
                if (mapped && urlsMatch(mapped, url)) { existing = t; break; }
                const turl = t.url || t.pendingUrl;
                if (turl && urlsMatch(turl, url)) { existing = t; break; }
            }

            if (existing) {
                await chrome.tabs.update(existing.id, { active: true });
                await setTabMapping(existing.id, url, packetId);
            }
        } else if (type === 'wasm') {
            try {
                // Execute WASM directly in the background
                await executeWasm(nextItem);

                // Still notify sidebar for UI sync if it's open
                if (sidebarPort) {
                    sidebarPort.postMessage({
                        type: 'RUN_WASM_ITEM_SYNC',
                        item: nextItem,
                        index: nextEntry.originalIndex
                    });
                }
            } catch (err) {
                console.error('[SW] Background WASM execution failed:', err);
            }
        }

        // Notify sidebar about focus change
        if (sidebarPort) {
            sidebarPort.postMessage({
                type: 'ITEM_NAVIGATED',
                packetId: packetId,
                index: nextEntry.originalIndex,
                item: nextItem
            });
        }
    } catch (e) {
        console.error('[SW] Navigation failed:', e);
    }
}

// WasmRuntime helper for Canonical ABI encoding/decoding
class WasmRuntime {
    constructor() {
        this.instance = null;
        this.memory = null;
    }
    setInstance(instance) {
        this.instance = instance;
        this.memory = instance.exports.memory;
    }
    getView() {
        if (!this.memory) throw new Error("Wasm memory not initialized");
        return new DataView(this.memory.buffer);
    }
    readString(ptr, len) {
        const bytes = new Uint8Array(this.memory.buffer, ptr, len);
        return new TextDecoder().decode(bytes);
    }
    alloc(size, align) {
        if (!this.instance) throw new Error("Wasm instance not initialized");
        const realloc = this.instance.exports.cabi_realloc || this.instance.exports.canonical_abi_realloc;
        if (!realloc) {
            throw new Error("WASM module missing 'cabi_realloc' or 'canonical_abi_realloc' export");
        }
        return realloc(0, 0, align, size);
    }
    writeString(str) {
        const bytes = new TextEncoder().encode(str);
        const ptr = this.alloc(bytes.length, 1);
        const dest = new Uint8Array(this.memory.buffer, ptr, bytes.length);
        dest.set(bytes);
        return { ptr, len: bytes.length };
    }
    encodeBookmarkNode(node, targetPtr = null) {
        const ptr = targetPtr || this.alloc(52, 4);
        const idStr = this.writeString(node.id);
        let view = this.getView();
        view.setUint32(ptr + 0, idStr.ptr, true);
        view.setUint32(ptr + 4, idStr.len, true);

        if (node.parentId) {
            const pIdStr = this.writeString(node.parentId);
            view = this.getView();
            view.setUint32(ptr + 8, 1, true);
            view.setUint32(ptr + 12, pIdStr.ptr, true);
            view.setUint32(ptr + 16, pIdStr.len, true);
        } else {
            this.getView().setUint32(ptr + 8, 0, true);
        }

        const titleStr = this.writeString(node.title || '');
        view = this.getView();
        view.setUint32(ptr + 20, titleStr.ptr, true);
        view.setUint32(ptr + 24, titleStr.len, true);

        if (node.url) {
            const urlStr = this.writeString(node.url);
            view = this.getView();
            view.setUint32(ptr + 28, 1, true);
            view.setUint32(ptr + 32, urlStr.ptr, true);
            view.setUint32(ptr + 36, urlStr.len, true);
        } else {
            this.getView().setUint32(ptr + 28, 0, true);
        }

        if (node.children && node.children.length > 0) {
            const encodedChildren = this.encodeBookmarkList(node.children);
            view = this.getView();
            view.setUint32(ptr + 40, 1, true);
            view.setUint32(ptr + 44, encodedChildren.ptr, true);
            view.setUint32(ptr + 48, encodedChildren.len, true);
        } else {
            this.getView().setUint32(ptr + 40, 0, true);
        }
        return ptr;
    }
    encodeBookmarkList(nodes) {
        // Canonical ABI: list<struct> is a contiguous array of structs.
        // Each BookmarkNode is 52 bytes.
        const listPtr = this.alloc(nodes.length * 52, 4);
        for (let i = 0; i < nodes.length; i++) {
            this.encodeBookmarkNode(nodes[i], listPtr + (i * 52));
        }
        return { ptr: listPtr, len: nodes.length };
    }
    encodeStringList(strs) {
        const listPtr = this.alloc(strs.length * 8, 4);
        let view = this.getView();
        strs.forEach((s, i) => {
            const { ptr, len } = this.writeString(s);
            view = this.getView();
            view.setUint32(listPtr + (i * 8), ptr, true);
            view.setUint32(listPtr + (i * 8) + 4, len, true);
        });
        return { ptr: listPtr, len: strs.length };
    }
}

// Initialize SQL.js and auto-restore all checkpoints
async function initializeSQLite() {
    if (initialized) return sqliteManager;
    if (initializing) return initializing;

    initializing = (async () => {
        try {
            if (!SQL) {
                SQL = await initSqlJs({
                    locateFile: file => chrome.runtime.getURL(`vendor/sqlite/${file}`)
                });
                sqliteManager = new SQLiteManager(SQL);
            }

            // Auto-restore all saved checkpoints before handling any messages
            const restored = await sqliteManager.restoreAllCheckpoints(chrome.storage.local);
            if (restored.length > 0) {
                console.log(`[AutoRestore] Restored collections: ${restored.join(', ')}`);
            } else {
                console.log('[AutoRestore] No checkpoints found starting with "db_"');
                // Debug: list all keys in storage
                const all = await chrome.storage.local.get(null);
                console.log('[AutoRestore] All storage keys:', Object.keys(all));
            }

            await sqliteManager.ensurePacketsCollection();
            await sqliteManager.ensureSchemasCollection();
            await sqliteManager.ensureWitsCollection();

            // Load tab mappings into memory cache
            const { tabToUrlMap = {} } = await chrome.storage.local.get('tabToUrlMap');
            tabToUrlMapCached = tabToUrlMap;

            // Also sync bookmarks cache
            await syncBookmarkCache();
            initialized = true;

            // Recover local pages after reload
            recoverLocalPages().catch(e => console.error('[Recovery] Failed:', e));

            // NEW: Recover orphaned tab groups with retries for startup resilience
            const recover = () => reassociateTabGroups().catch(e => console.error('[GroupRecovery] Failed:', e));
            recover(); // Immediate
            setTimeout(recover, 2000); // 2s delay
            setTimeout(recover, 5000); // 5s delay

            return sqliteManager;
        } catch (error) {
            console.error('Initialization failed:', error);
            initializing = null;
            throw error;
        }
    })();

    return initializing;
}

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
    // 1. Synchronous check: Do we have an active port?
    // Using 'async/await' here breaks the "user gesture" required for sidePanel.open()
    if (sidebarPort) {
        // Sidebar is OPEN! Delegate toggle logic to it
        chrome.runtime.sendMessage({ type: 'CLIPPER_ICON_CLICKED', tab }).catch(() => { });
    } else {
        // Sidebar is CLOSED! Open it
        chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
    }
});

// Message handler for sidebar communication
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request, sender, sendResponse);
    return true; // Keep channel open for async response
});

async function handleMessage(request, sender, sendResponse) {
    const action = request.action || request.type;
    console.log('[SW] Message received:', action, request);
    try {
        await initializeSQLite();

        switch (action) {
            case 'startMicRecording': {
                try {
                    console.log('[SW] startMicRecording action received. Ensuring offscreen document...');
                    await ensureOffscreenDocument();
                    console.log('[SW] Offscreen document ready. Sending START_MIC_RECORDING to offscreen...');
                    chrome.runtime.sendMessage({ type: 'START_MIC_RECORDING', video: !!request.video });
                    sendResponse({ success: true });
                } catch (err) {
                    console.error('[SW] startMicRecording failed:', err);
                    sendResponse({ success: false, error: err.message || 'Failed to start offscreen recording' });
                }
                break;
            }
            case 'stopRecording':
            case 'stopMicRecording': {
                chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
                sendResponse({ success: true });
                break;
            }
            case 'startRecording': {
                await initiateAudioRecording(request.streamId, request.tabId);
                sendResponse({ success: true });
                break;
            }
            case 'PROXY_KEY_DOWN': {
                // Find current group of the tab that sent the proxy key
                if (sender.tab && sender.tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
                    const direction = request.key === 'ArrowRight' ? 1 : -1;
                    await navigatePacketItems(sender.tab.groupId, direction);
                } else if (sidebarPort) {
                    // Fallback to legacy sidebar-only logic if tab is not in a group
                    sidebarPort.postMessage({
                        type: 'PROXY_KEY_DOWN',
                        key: request.key,
                        shiftKey: request.shiftKey,
                        altKey: request.altKey,
                        ctrlKey: request.ctrlKey,
                        metaKey: request.metaKey
                    });
                }
                sendResponse({ success: true });
                break;
            }
            case 'listCollections': {
                const collections = sqliteManager.listCollections();
                sendResponse({ success: true, collections });
                break;
            }
            case 'createCollection': {
                await sqliteManager.initDatabase(request.name);
                await sqliteManager.saveCheckpoint(request.name, chrome.storage.local);
                sendResponse({ success: true });
                break;
            }
            case 'importFromBlob': {
                const importData = new Uint8Array(request.data).buffer;
                await sqliteManager.importFromBlob(request.name, importData);
                await sqliteManager.saveCheckpoint(request.name, chrome.storage.local);
                sendResponse({ success: true });
                break;
            }
            case 'exportToBlob': {
                const blob = await sqliteManager.exportToBlob(request.name);
                const arrayBuffer = await blob.arrayBuffer();
                sendResponse({ success: true, data: Array.from(new Uint8Array(arrayBuffer)) });
                break;
            }
            case 'saveCheckpoint': {
                await sqliteManager.saveCheckpoint(request.name, chrome.storage.local, request.prefix || 'db_');
                sendResponse({ success: true });
                break;
            }
            case 'restoreCheckpoint': {
                const restored = await sqliteManager.restoreCheckpoint(request.name, chrome.storage.local, request.prefix || 'db_');
                sendResponse({ success: true, restored });
                break;
            }
            case 'deleteCollection': {
                sqliteManager.closeDatabase(request.name);
                await chrome.storage.local.remove([`db_${request.name}`]);
                sendResponse({ success: true });
                break;
            }
            case 'executeSQL': {
                const db = sqliteManager.getDatabase(request.name);
                if (!db) {
                    sendResponse({ success: false, error: 'Database not found' });
                    break;
                }
                // Use params if provided
                const result = db.exec(request.sql, request.params || []);
                sendResponse({ success: true, result });
                break;
            }
            case 'getSchema': {
                const schema = sqliteManager.getSchema(request.name);
                sendResponse({ success: true, schema });
                break;
            }
            case 'getEntries': {
                const entries = sqliteManager.getEntries(request.name, request.tableName);
                sendResponse({ success: true, entries });
                break;
            }
            case 'getEntry': {
                try {
                    const row = sqliteManager.getEntry(request.name, request.tableName, request.rowId);
                    sendResponse({ success: true, row });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'setSchema': {
                await sqliteManager.applySchema(request.name, request.createSQL, chrome.storage.local, 'db_');
                sendResponse({ success: true });
                break;
            }
            case 'playPacket': {
                try {
                    const db = sqliteManager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');

                    const result = db.exec(`SELECT name, urls FROM packets WHERE rowid = ${request.id}`);
                    if (!result.length || !result[0].values.length) {
                        throw new Error('Packet not found');
                    }

                    const [name, urlsJson] = result[0].values[0];
                    const items = JSON.parse(urlsJson);

                    if (!items.length) {
                        sendResponse({ success: true, message: 'No items in packet' });
                        break;
                    }

                    const pages = items.filter(item => {
                        if (typeof item === 'string') return true;
                        return item.type === 'page' || item.type === 'link';
                    }).map(item => typeof item === 'string' ? item : item.url);

                    if (pages.length === 0) {
                        sendResponse({ success: true, message: 'No web pages found in packet.' });
                        break;
                    }

                    // Check if this packet already has an active tab group
                    const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                    const groups = await chrome.tabGroups.query({});
                    let existingGroupId = null;
                    for (const g of groups) {
                        if (String(activeGroups[g.id]) === String(request.id)) {
                            existingGroupId = g.id;
                            break;
                        }
                    }

                    if (existingGroupId !== null) {
                        // Focus the existing group
                        const tabsInGroup = await chrome.tabs.query({ groupId: existingGroupId });
                        if (tabsInGroup.length > 0) {
                            await chrome.tabs.update(tabsInGroup[0].id, { active: true });
                            sendResponse({ success: true, groupId: existingGroupId });
                            return;
                        }
                    }

                    // Lazy load: don't open all links anymore. 
                    // The sidebar detail view will show the items and user can click them.
                    sendResponse({ success: true, message: 'Packet focused in sidebar' });
                } catch (error) {
                    console.error('Failed to play packet:', error);
                    sendResponse({ success: false, error: error.message });
                }
                break;
            }
            case 'ensurePacketDatabase': {
                try {
                    const packetId = request.packetId;
                    const dbName = `packet_${packetId}`;
                    await sqliteManager.restoreCheckpoint(dbName, chrome.storage.local);
                    const db = sqliteManager.initDatabase(dbName);
                    db.exec(`
                        CREATE TABLE IF NOT EXISTS associations (
                          id INTEGER PRIMARY KEY AUTOINCREMENT,
                          source_id TEXT,
                          target_id TEXT,
                          type TEXT,
                          metadata TEXT,
                          created TEXT DEFAULT (datetime('now'))
                        );
                    `);
                    await sqliteManager.saveCheckpoint(dbName, chrome.storage.local);
                    sendResponse({ success: true, dbName });
                } catch (err) {
                    console.error('ensurePacketDatabase error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'getCurrentTab': {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) {
                    sendResponse({ success: false, error: 'No active tab found' });
                } else {
                    sendResponse({ success: true, tab: { id: tab.id, title: tab.title, url: tab.url, groupId: tab.groupId } });
                }
                break;
            }
            case 'savePacket': {
                try {
                    const db = sqliteManager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');
                    const urlsJson = JSON.stringify(request.urls);
                    const escapedName = request.name.replace(/'/g, "''");
                    const escapedUrls = urlsJson.replace(/'/g, "''");

                    if (request.id) {
                        const id = parseInt(request.id, 10);
                        db.exec(`UPDATE packets SET name = '${escapedName}', urls = '${escapedUrls}' WHERE rowid = ${id}`);
                        await sqliteManager.saveCheckpoint('packets', chrome.storage.local);
                        sendResponse({ success: true, id });
                    } else {
                        db.exec(`INSERT INTO packets (name, urls) VALUES ('${escapedName}', '${escapedUrls}')`);
                        const result = db.exec("SELECT last_insert_rowid()");
                        const newId = result[0].values[0][0];
                        await sqliteManager.saveCheckpoint('packets', chrome.storage.local);
                        sendResponse({ success: true, id: newId });
                    }
                } catch (err) {
                    console.error('savePacket error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'deletePacket': {
                try {
                    const db = sqliteManager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');
                    const id = parseInt(request.id, 10);
                    db.exec(`DELETE FROM packets WHERE rowid = ${id}`);
                    await sqliteManager.saveCheckpoint('packets', chrome.storage.local);
                    sendResponse({ success: true });
                } catch (err) {
                    console.error('deletePacket error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'saveSchema': {
                try {
                    const db = sqliteManager.getDatabase('schemas');
                    if (!db) throw new Error('Schemas database not found');
                    const escapedName = request.name.replace(/'/g, "''");
                    const escapedSql = request.sql.replace(/'/g, "''");
                    db.exec(`INSERT INTO schemas (name, sql) VALUES ('${escapedName}', '${escapedSql}')`);
                    await sqliteManager.saveCheckpoint('schemas', chrome.storage.local);
                    sendResponse({ success: true });
                } catch (err) {
                    console.error('saveSchema error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'deleteSchema': {
                try {
                    const db = sqliteManager.getDatabase('schemas');
                    if (!db) throw new Error('Schemas database not found');
                    const id = parseInt(request.id, 10);
                    db.exec(`DELETE FROM schemas WHERE rowid = ${id}`);
                    await sqliteManager.saveCheckpoint('schemas', chrome.storage.local);
                    sendResponse({ success: true });
                } catch (err) {
                    console.error('deleteSchema error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'listSchemas': {
                try {
                    const db = sqliteManager.getDatabase('schemas');
                    if (!db) throw new Error('Schemas database not found');
                    const result = db.exec(`SELECT rowid, name, sql FROM schemas ORDER BY created DESC`);
                    const rows = result.length > 0 ? result[0].values : [];
                    sendResponse({ success: true, schemas: rows.map(([id, name, sql]) => ({ id, name, sql })) });
                } catch (err) {
                    console.error('listSchemas error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'getPacketByGroupId': {
                try {
                    const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                    const packetId = activeGroups[request.groupId];
                    if (!packetId) { sendResponse({ success: true, packet: null }); break; }
                    const db = sqliteManager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');
                    const result = db.exec(`SELECT rowid, name, urls FROM packets WHERE rowid = ${packetId}`);
                    if (!result.length || !result[0].values.length) { sendResponse({ success: true, packet: null }); break; }
                    const [id, name, urlsJson] = result[0].values[0];
                    sendResponse({ success: true, packet: { id, name, urls: JSON.parse(urlsJson) } });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'getTerminalTabs': {
                sendResponse({ success: true, terminalTabs });
                break;
            }
            case 'registerTerminalTab': {
                if (request.packetId && request.tabId) {
                    if (request.track !== false) {
                        terminalTabs[request.packetId] = request.tabId;
                        if (sidebarPort) {
                            sidebarPort.postMessage({ type: 'TERMINAL_STATE_CHANGED', terminalTabs });
                        }
                    } else {
                        console.log(`[SW] Explicitly skipped registration for untracked terminal tab ${request.tabId}`);
                    }
                    sendResponse({ success: true });
                } else {
                    sendResponse({ success: false, error: 'Missing packetId or tabId' });
                }
                break;
            }
            case 'saveMediaBlob': {
                try {
                    const blob = new Blob([new Uint8Array(request.data)], { type: request.type });
                    const id = request.id || await blobStorage.generateId(blob);
                    await blobStorage.put(id, blob);
                    sendResponse({ success: true, id });
                } catch (err) {

                    console.error('saveMediaBlob error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'getMediaBlob': {
                try {
                    const blob = await blobStorage.get(request.id);
                    if (!blob) throw new Error('Blob not found');
                    const arrayBuffer = await blob.arrayBuffer();
                    sendResponse({
                        success: true,
                        data: Array.from(new Uint8Array(arrayBuffer)),
                        type: blob.type
                    });
                } catch (err) {
                    console.error('getMediaBlob error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'getActivePacket': {
                try {
                    if (!tab || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
                        sendResponse({ success: true, packet: null }); break;
                    }
                    let { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                    let packetId = activeGroups[tab.groupId];

                    // Lazy Recovery: If tab is in a group but we don't have a mapping, try to repair it
                    if (!packetId) {
                        console.log(`[GroupRecovery] Lazy recovery triggered for group ${tab.groupId}`);
                        await reassociateTabGroups();
                        const updatedStore = await chrome.storage.local.get('activeGroups');
                        activeGroups = updatedStore.activeGroups || {};
                        packetId = activeGroups[tab.groupId];
                    }

                    if (!packetId) { sendResponse({ success: true, packet: null }); break; }
                    const db = sqliteManager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');
                    const result = db.exec(`SELECT rowid, name, urls FROM packets WHERE rowid = ${packetId}`);
                    if (!result.length || !result[0].values.length) { sendResponse({ success: true, packet: null }); break; }
                    const [id, name, urlsJson] = result[0].values[0];
                    sendResponse({
                        success: true,
                        packet: {
                            id,
                            name,
                            urls: JSON.parse(urlsJson),
                            groupId: tab.groupId,
                            activeUrl: tab.url
                        }
                    });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'getPacket': {
                try {
                    const db = sqliteManager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');
                    const result = db.exec(`SELECT rowid, name, urls FROM packets WHERE rowid = ${request.id}`);
                    if (!result.length || !result[0].values.length) {
                        sendResponse({ success: false, error: 'Packet not found' });
                        break;
                    }
                    const [id, name, urlsJson] = result[0].values[0];
                    sendResponse({
                        success: true,
                        packet: { id, name, urls: JSON.parse(urlsJson) }
                    });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'closePacketGroup': {
                try {
                    const { packetId } = request;
                    const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');

                    // Find all groups associated with this packet
                    const groupsToClose = [];
                    for (const [gid, pid] of Object.entries(activeGroups)) {
                        if (String(pid) === String(packetId)) {
                            groupsToClose.push(parseInt(gid, 10));
                        }
                    }

                    for (const groupId of groupsToClose) {
                        try {
                            const tabs = await chrome.tabs.query({ groupId });
                            if (tabs.length > 0) {
                                await chrome.tabs.remove(tabs.map(t => t.id));
                            }
                            delete activeGroups[groupId];
                        } catch (e) {
                            console.warn(`Failed to close group ${groupId}:`, e);
                            // It might already be closed
                            delete activeGroups[groupId];
                        }
                    }

                    await chrome.storage.local.set({ activeGroups });
                    sendResponse({ success: true });
                } catch (err) {
                    console.error('closePacketGroup error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'joinPacketGroup': {
                try {
                    const { tabId, packetId } = request;
                    const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                    const groups = await chrome.tabGroups.query({});

                    let targetGroupId = null;
                    for (const g of groups) {
                        if (String(activeGroups[g.id]) === String(packetId)) {
                            targetGroupId = g.id;
                            break;
                        }
                    }

                    if (targetGroupId !== null) {
                        await chrome.tabs.group({ tabIds: [tabId], groupId: targetGroupId });
                        // Map the tab so we know it belongs to this packet even if URL is duplicate elsewhere
                        const [tab] = await chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT, active: true }); // We might not have the tab object, but we have tabId
                        try {
                            const t = await chrome.tabs.get(tabId);
                            if (t && t.url) await setTabMapping(tabId, t.url, packetId);
                        } catch (e) { }
                        sendResponse({ success: true, groupId: targetGroupId });
                    } else {
                        // Create new group
                        targetGroupId = await chrome.tabs.group({ tabIds: [tabId] });
                        let packetName = 'Packet';
                        try {
                            const db = sqliteManager.getDatabase('packets');
                            if (db) {
                                const result = db.exec(`SELECT name FROM packets WHERE rowid = ${packetId}`);
                                if (result.length && result[0].values.length) {
                                    packetName = result[0].values[0][0];
                                }
                            }
                        } catch (e) { }

                        const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
                        const randomColor = colors[Math.floor(Math.random() * colors.length)];
                        await chrome.tabGroups.update(targetGroupId, { title: packetName, color: randomColor });

                        activeGroups[targetGroupId] = packetId;
                        await chrome.storage.local.set({ activeGroups });
                        sendResponse({ success: true, groupId: targetGroupId });
                    }
                } catch (err) {
                    console.error('joinPacketGroup error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'openTabInGroup': {
                try {
                    const { url, groupId, packetId } = request;
                    let targetGroupId = groupId;

                    // Always try to find existing group by packetId if we have it
                    if (packetId) {
                        const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                        const groups = await chrome.tabGroups.query({});

                        // CRITICAL: Verify that the provided targetGroupId still belongs to this packet.
                        // If it doesn't match our mapping, we MUST NOT use it as it belongs to another packet.
                        if (targetGroupId !== undefined && targetGroupId !== null) {
                            if (String(activeGroups[targetGroupId]) !== String(packetId)) {
                                console.log(`[SW] Provided groupId ${targetGroupId} belongs to packet ${activeGroups[targetGroupId]}, not ${packetId}. Resetting.`);
                                targetGroupId = null;
                            }
                        }

                        if (targetGroupId === null || targetGroupId === undefined) {
                            // Search all groups for one mapped to this packet
                            for (const g of groups) {
                                if (String(activeGroups[g.id]) === String(packetId)) {
                                    targetGroupId = g.id;
                                    break;
                                }
                            }
                        }
                    }

                    let groupExists = false;
                    try {
                        if (targetGroupId !== undefined && targetGroupId !== null) {
                            await chrome.tabGroups.get(targetGroupId);
                            groupExists = true;
                        }
                    } catch (e) { }

                    if (groupExists) {
                        const tabsInGroup = await chrome.tabs.query({ groupId: targetGroupId });

                        // Look for existing tab using both current URL and mapped URL (for redirects)
                        let existing = null;
                        for (const t of tabsInGroup) {
                            const mapped = getMappedUrlSync(t.id);
                            if (mapped && urlsMatch(mapped, url)) {
                                existing = t;
                                break;
                            }
                            const turl = t.url || t.pendingUrl;
                            if (turl && urlsMatch(turl, url)) {
                                existing = t;
                                break;
                            }
                        }

                        if (existing) {
                            await chrome.tabs.update(existing.id, { active: true });
                            await setTabMapping(existing.id, url, packetId);
                        } else {
                            const newTab = await chrome.tabs.create({ url, active: true });
                            await chrome.tabs.group({ tabIds: [newTab.id], groupId: targetGroupId });
                            await setTabMapping(newTab.id, url, packetId);
                        }
                        sendResponse({ success: true });
                    } else {
                        const newTab = await chrome.tabs.create({ url, active: true });
                        targetGroupId = await chrome.tabs.group({ tabIds: [newTab.id] });
                        let packetName = 'Packet';
                        if (packetId) {
                            try {
                                const db = sqliteManager.getDatabase('packets');
                                if (db) {
                                    const result = db.exec(`SELECT name FROM packets WHERE rowid = ${packetId}`);
                                    if (result.length && result[0].values.length) {
                                        packetName = result[0].values[0][0];
                                    }
                                }
                            } catch (e) { }
                        }
                        const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
                        const randomColor = colors[Math.floor(Math.random() * colors.length)];
                        await chrome.tabGroups.update(targetGroupId, { title: packetName, color: randomColor });
                        if (packetId) {
                            const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                            activeGroups[targetGroupId] = packetId;
                            await chrome.storage.local.set({ activeGroups });
                        }
                        await setTabMapping(newTab.id, url, packetId);
                        sendResponse({ success: true, newGroupId: targetGroupId });
                    }
                } catch (err) {
                    console.error('openTabInGroup error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }

            case 'syncTabOrder': {
                try {
                    const { packetId } = request;
                    await syncTabOrderForPacket(packetId);
                    sendResponse({ success: true });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }

                async function executeWasm(item) {
                    const runtime = new WasmRuntime();
                    const executionLogs = [];

                    const data = item.bytes || item.data;
                    if (!data) throw new Error("No WASM data provided");

                    let binaryString = atob(data);
                    if (binaryString.charCodeAt(0) !== 0 && binaryString.startsWith('AGFz')) {
                        try { binaryString = atob(binaryString); } catch (e) { }
                    }

                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }

                    const sqliteHost = {
                        "execute": (dbNamePtr, dbNameLen, sqlPtr, sqlLen) => {
                            const dbName = runtime.readString(dbNamePtr, dbNameLen);
                            const sql = runtime.readString(sqlPtr, sqlLen);
                            try {
                                const db = sqliteManager.initDatabase(dbName);
                                db.exec(sql);
                                const changes = db.getRowsModified();
                                sqliteManager.saveCheckpoint(dbName, chrome.storage.local).catch(console.error);
                                const resultPtr = runtime.alloc(12, 4);
                                const view = runtime.getView();
                                view.setUint32(resultPtr, 0, true);
                                view.setUint32(resultPtr + 4, changes, true);
                                return resultPtr;
                            } catch (e) {
                                console.error(`[Host] sqlite.execute error:`, e);
                                const errStr = runtime.writeString(e.message);
                                const resultPtr = runtime.alloc(12, 4);
                                const view = runtime.getView();
                                view.setUint32(resultPtr, 1, true);
                                view.setUint32(resultPtr + 4, errStr.ptr, true);
                                view.setUint32(resultPtr + 8, errStr.len, true);
                                return resultPtr;
                            }
                        },
                        "query": (dbNamePtr, dbNameLen, sqlPtr, sqlLen) => {
                            const dbName = runtime.readString(dbNamePtr, dbNameLen);
                            const sql = runtime.readString(sqlPtr, sqlLen);
                            try {
                                const db = sqliteManager.initDatabase(dbName);
                                const result = db.exec(sql);
                                const columns = result.length > 0 ? result[0].columns : [];
                                const rows = result.length > 0 ? result[0].values : [];
                                const colEncoded = runtime.encodeStringList(columns);
                                const rowPtrs = rows.map(r => {
                                    const valuesEncoded = runtime.encodeStringList(r.map(v => String(v ?? '')));
                                    const rPtr = runtime.alloc(8, 4);
                                    const rView = runtime.getView();
                                    rView.setUint32(rPtr, valuesEncoded.ptr, true);
                                    rView.setUint32(rPtr + 4, valuesEncoded.len, true);
                                    return rPtr;
                                });
                                const rowsListPtr = runtime.alloc(rowPtrs.length * 4, 4);
                                const rowsListBytes = new Uint32Array(runtime.memory.buffer, rowsListPtr, rowPtrs.length);
                                rowsListBytes.set(rowPtrs);
                                const qrPtr = runtime.alloc(16, 4);
                                const qrView = runtime.getView();
                                qrView.setUint32(qrPtr, colEncoded.ptr, true);
                                qrView.setUint32(qrPtr + 4, colEncoded.len, true);
                                qrView.setUint32(qrPtr + 8, rowsListPtr, true);
                                qrView.setUint32(qrPtr + 12, rowPtrs.length, true);
                                const resultPtr = runtime.alloc(20, 4);
                                const view = runtime.getView();
                                view.setUint32(resultPtr, 0, true);
                                const resultPayload = new Uint8Array(runtime.memory.buffer, resultPtr + 4, 16);
                                const qrData = new Uint8Array(runtime.memory.buffer, qrPtr, 16);
                                resultPayload.set(qrData);
                                return resultPtr;
                            } catch (e) {
                                const errStr = runtime.writeString(e.message);
                                const resultPtr = runtime.alloc(20, 4);
                                const view = runtime.getView();
                                view.setUint32(resultPtr, 1, true);
                                view.setUint32(resultPtr + 4, errStr.ptr, true);
                                view.setUint32(resultPtr + 8, errStr.len, true);
                                return resultPtr;
                            }
                        }
                    };

                    const importObject = {
                        env: {
                            log: (ptr, len) => {
                                const msg = runtime.readString(ptr, len);
                                executionLogs.push(msg);
                            }
                        },
                        "chrome:bookmarks/bookmarks": {
                            "get-tree": () => {
                                try {
                                    if (!bookmarkCache) throw new Error("Cache not ready");
                                    const encoded = runtime.encodeBookmarkList(bookmarkCache);
                                    const resultPtr = runtime.alloc(12, 4);
                                    const view = runtime.getView();
                                    view.setUint32(resultPtr, 0, true);
                                    view.setUint32(resultPtr + 4, encoded.ptr, true);
                                    view.setUint32(resultPtr + 8, encoded.len, true);
                                    return resultPtr;
                                } catch (e) {
                                    const errStr = runtime.writeString(e.message);
                                    const resultPtr = runtime.alloc(12, 4);
                                    const view = runtime.getView();
                                    view.setUint32(resultPtr, 1, true);
                                    view.setUint32(resultPtr + 4, errStr.ptr, true);
                                    view.setUint32(resultPtr + 8, errStr.len, true);
                                    return resultPtr;
                                }
                            },
                            "get_tree": (...args) => importObject["chrome:bookmarks/bookmarks"]["get-tree"](...args),
                            "get-all-bookmarks": () => importObject["chrome:bookmarks/bookmarks"]["get-tree"](),
                            "get_all_bookmarks": () => importObject["chrome:bookmarks/bookmarks"]["get-tree"](),
                            "create": (titlePtr, titleLen, urlPtr, urlLen) => {
                                const errStr = runtime.writeString("Async 'create' requires JSPI.");
                                const resultPtr = runtime.alloc(12, 4);
                                const view = runtime.getView();
                                view.setUint32(resultPtr, 1, true);
                                view.setUint32(resultPtr + 4, errStr.ptr, true);
                                view.setUint32(resultPtr + 8, errStr.len, true);
                                return resultPtr;
                            }
                        },
                        "chrome:bookmarks": {
                            "get-tree": () => importObject["chrome:bookmarks/bookmarks"]["get-tree"](),
                            "get_tree": () => importObject["chrome:bookmarks/bookmarks"]["get-tree"](),
                            "get-all-bookmarks": () => importObject["chrome:bookmarks/bookmarks"]["get_tree"](),
                            "get_all_bookmarks": () => importObject["chrome:bookmarks/bookmarks"]["get_tree"](),
                            "create": (...args) => importObject["chrome:bookmarks/bookmarks"]["create"](...args)
                        },
                        "user:sqlite/sqlite": sqliteHost,
                        "wasi_snapshot_preview1": {
                            fd_write: (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
                                let totalWritten = 0;
                                const view = runtime.getView();
                                for (let i = 0; i < iovs_len; i++) {
                                    const ptr = view.getUint32(iovs_ptr + i * 8, true);
                                    const len = view.getUint32(iovs_ptr + i * 8 + 4, true);
                                    const msg = runtime.readString(ptr, len);
                                    executionLogs.push(msg);
                                    totalWritten += len;
                                }
                                view.setUint32(nwritten_ptr, totalWritten, true);
                                return 0; // Success
                            },
                            environ_get: () => 0,
                            environ_sizes_get: (countPtr, sizePtr) => {
                                const view = runtime.getView();
                                view.setUint32(countPtr, 0, true);
                                view.setUint32(sizePtr, 0, true);
                                return 0;
                            },
                            proc_exit: (code) => { console.log("Proc exit:", code); return 0; },
                            fd_close: () => 0,
                            fd_seek: () => 0,
                            fd_fdstat_get: (fd, statPtr) => {
                                const view = runtime.getView();
                                view.setUint8(statPtr, 2); // character device
                                return 0;
                            },
                            random_get: (buf_ptr, buf_len) => {
                                const buffer = new Uint8Array(runtime.memory.buffer, buf_ptr, buf_len);
                                crypto.getRandomValues(buffer);
                                return 0;
                            },
                            clock_time_get: (id, precision, time_ptr) => {
                                const view = runtime.getView();
                                const now = BigInt(Date.now()) * 1000000n; // ns
                                view.setBigUint64(time_ptr, now, true);
                                return 0;
                            }
                        }
                    };

                    const { instance } = await WebAssembly.instantiate(bytes, importObject);
                    runtime.setInstance(instance);

                    let result;
                    if (instance.exports.run) {
                        result = instance.exports.run();
                    } else if (instance.exports.main) {
                        result = instance.exports.main();
                    } else {
                        throw new Error("No run or main export found");
                    }

                    return { success: true, result, logs: executionLogs };
                }

            case 'runWasmPacketItem': {
                try {
                    const result = await executeWasm(request.item || request);
                    sendResponse(result);
                } catch (err) {
                    console.error('WASM error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'captureVisibleTab': {
                try {
                    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
                    sendResponse({ success: true, dataUrl });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'CLIPPER_REGION_SELECTED':
            case 'CLIPPER_CANCELLED': {
                // No need to relay: content scripts broadcast to all extension pages
                sendResponse({ success: true });
                break;
            }
            case 'START_AUDIO_RECORDING': {
                console.log('[SW] START_AUDIO_RECORDING received, streamId:', request.streamId);
                try {
                    let streamId = request.streamId;
                    let targetTabId = sender.tab?.id;

                    if (!targetTabId) {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        targetTabId = tab?.id;
                    }

                    if (!streamId) {
                        console.log('[SW] No streamId provided, requesting fallback');
                        if (!targetTabId) throw new Error('Could not identify active tab');
                        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
                        console.log('[SW] Fallback streamId obtained:', streamId);
                    }

                    await initiateAudioRecording(streamId, targetTabId);
                    sendResponse({ success: true });
                } catch (e) {
                    console.error('[SW] Failed to start audio recording:', e);
                    sendResponse({ success: false, error: e.message });
                }
                break;
            }
            case 'STOP_AUDIO_RECORDING': {
                console.log('[SW] STOP_AUDIO_RECORDING received');
                chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
                sendResponse({ success: true });
                break;
            }
            case 'OFFSCREEN_LOG':
            case 'RECORDING_STARTED':
            case 'RECORDING_ERROR': {
                // Relay these to the sidebar and island
                chrome.runtime.sendMessage(request).catch(() => { });
                break;
            }
            case 'AUDIO_RECORDING_RESULT':
            case 'VIDEO_RECORDING_RESULT': {
                const isVideo = action === 'VIDEO_RECORDING_RESULT';
                console.log(`[SW] ${action} received, dataUrl length:`, request.dataUrl?.length);
                // Forward the result to the sidebar
                chrome.runtime.sendMessage({
                    type: isVideo ? 'VIDEO_CLIP_FINISHED' : 'AUDIO_CLIP_FINISHED',
                    dataUrl: request.dataUrl
                }).then(() => {
                    console.log(`[SW] Successfully forwarded ${isVideo ? 'VIDEO' : 'AUDIO'}_CLIP_FINISHED to sidebar`);
                }).catch((err) => {
                    console.warn('[SW] Failed to forward to sidebar (sidebar might be closed):', err);
                });

                // Close offscreen document after a short delay
                setTimeout(async () => {
                    const existingContexts = await chrome.runtime.getContexts({
                        contextTypes: ['OFFSCREEN_DOCUMENT']
                    });
                    if (existingContexts.length > 0) {
                        chrome.offscreen.closeDocument().catch(e => {
                            console.warn('[SW] Error closing offscreen document:', e);
                        });
                    }
                }, 1000);
                break;
            }
            case 'TOGGLE_NETWORK': {
                try {
                    const enabled = request.enabled;
                    await chrome.storage.local.set({ networkEnabled: enabled }); // Ensure it's in storage for updateBadge
                    await updateBadge({}); // Trigger global update
                    if (!enabled) {
                        // Block all network requests (HTTP/HTTPS)
                        await chrome.declarativeNetRequest.updateDynamicRules({
                            addRules: [{
                                id: NETWORK_BLOCK_RULE_ID,
                                priority: 100, // Higher priority
                                action: { type: 'block' },
                                condition: {
                                    urlFilter: '*', // Match everything
                                    // Including all possible resource types
                                    resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other']
                                }
                            }],
                            removeRuleIds: [NETWORK_BLOCK_RULE_ID]
                        });
                    } else {
                        // Allow network requests by removing the block rule
                        await chrome.declarativeNetRequest.updateDynamicRules({
                            removeRuleIds: [NETWORK_BLOCK_RULE_ID]
                        });
                    }
                    console.log(`[SW] Network kill switch: ${enabled ? 'OFF' : 'ON'}`);
                    sendResponse({ success: true });
                } catch (err) {
                    console.error('TOGGLE_NETWORK error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'UPDATE_BADGE': {
                await updateBadge({
                    isReadyToClip: request.isReadyToClip,
                    tabId: request.tabId
                });
                sendResponse({ success: true });
                break;
            }
            default:
                sendResponse({ success: false, error: 'Unknown action' });
        }
    } catch (error) {
        console.error('Error handling message:', error);
        sendResponse({ success: false, error: error.message });
    }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
        await updateBadge({ tabId });
        const tab = await chrome.tabs.get(tabId);
        const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
        const groupId = tab.groupId;

        if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE || !activeGroups[groupId]) {
            chrome.runtime.sendMessage({ type: 'packetFocused', packet: null }).catch(() => { });
            return;
        }

        const packetId = activeGroups[groupId];
        await initializeSQLite();
        const db = sqliteManager.getDatabase('packets');
        if (!db) return;
        const result = db.exec(`SELECT rowid, name, urls FROM packets WHERE rowid = ${packetId}`);
        if (!result.length || !result[0].values.length) return;
        const [id, name, urlsJson] = result[0].values[0];

        // Use mapping if available but prefer active tab URL if it matches any item in the packet
        const mappedUrl = getMappedUrlSync(tabId);
        const urls = JSON.parse(urlsJson);
        const currentUrlMatches = urls.some(item => {
            const u = typeof item === 'object' ? item.url : item;
            return u && urlsMatch(u, tab.url);
        });

        const activeUrl = currentUrlMatches ? tab.url : (mappedUrl || tab.url);
        const packet = { id, name, urls, groupId, activeUrl };
        chrome.runtime.sendMessage({ type: 'packetFocused', packet }).catch(() => { });
    } catch (e) { }
});

// Also track when a tab is updated (e.g. navigation within a group)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' || changeInfo.url) {
        try {
            await updateBadge({ tabId });

            const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
            const groupId = tab.groupId;

            // Only notify sidebar of highlight change if it's already in the group
            if (groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && activeGroups[groupId]) {
                const packetId = activeGroups[groupId];
                await initializeSQLite();
                const db = sqliteManager.getDatabase('packets');
                if (!db) return;
                const result = db.exec(`SELECT urls FROM packets WHERE rowid = ${packetId}`);
                if (!result.length || !result[0].values.length) return;
                const [urlsJson] = result[0].values[0];
                const urls = JSON.parse(urlsJson);

                // If new URL matches a packet item, update mapping
                const currentUrlMatches = urls.some(item => {
                    const u = typeof item === 'object' ? item.url : item;
                    return u && urlsMatch(u, tab.url);
                });

                if (currentUrlMatches) {
                    await setTabMapping(tabId, tab.url, packetId);
                }

                // If this is the active tab, surgically update sidebar highlight
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (activeTab && activeTab.id === tabId) {
                    chrome.runtime.sendMessage({
                        type: 'UPDATE_ACTIVE_URL',
                        url: getMappedUrlSync(tabId) || tab.url,
                        packetId
                    }).catch(() => { });
                }
            }
        } catch (e) { }
    }
});


chrome.tabs.onRemoved.addListener(async (tabId) => {
    await removeTabMapping(tabId);
});

chrome.tabGroups.onRemoved.addListener(async (group) => {
    try {
        const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
        if (activeGroups[group.id]) {
            delete activeGroups[group.id];
            await chrome.storage.local.set({ activeGroups });
        }
    } catch (e) { }
});

// Handle sidebar connection for robust closure detection
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'sidebar') {
        sidebarPort = port;
        // Update badge for active tab when sidebar opens
        chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
            if (tab) updateBadge({ tabId: tab.id });
        });

        port.onDisconnect.addListener(async () => {
            sidebarPort = null;
            try {
                // Sidebar closed! Deactivate clipper on the active tab
                const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                if (tab) {
                    chrome.tabs.sendMessage(tab.id, { type: 'SET_CLIPPER_ACTIVE', active: false }).catch(() => { });
                    // Update badge when sidebar closes
                    updateBadge({ tabId: tab.id });
                }
            } catch (e) {
                console.error('[ServiceWorker] Failed to deactivate clipper on sidebar close:', e);
            }
        });
    }
});

initializeSQLite().then(() => {
    console.log('SQLite Manager initialized');
}).catch(error => {
    console.error('Failed to initialize SQLite:', error);
});

async function updateBadge({ isReadyToClip, tabId }) {
    try {
        const { networkEnabled, activeGroups = {} } = await chrome.storage.local.get(['networkEnabled', 'activeGroups']);
        const offline = networkEnabled === false;

        if (tabId) {
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab) return;

            // Check if this is a page we can actually clip/add to a packet
            const isSupportedPage = tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://') || tab.url.includes('viewer.html'));

            const isMedia = isMediaPage(tab.url);

            if (isReadyToClip && !isMedia) {
                // Priority 1: Red dot for capture mode
                await chrome.action.setBadgeText({ text: '•', tabId });
                await chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId });
            } else if (isSupportedPage && sidebarPort && !isMedia) {
                // Priority 2: Blue "+" for pages NOT in a packet (ONLY IF SIDEBAR IS OPEN AND NOT A MEDIA PAGE)
                const inPacket = tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && activeGroups[tab.groupId];
                if (!inPacket) {
                    await chrome.action.setBadgeText({ text: '+', tabId });
                    await chrome.action.setBadgeBackgroundColor({ color: '#3b82f6', tabId });
                } else if (offline) {
                    await chrome.action.setBadgeText({ text: 'OFF', tabId });
                    await chrome.action.setBadgeBackgroundColor({ color: '#f97316', tabId });
                } else {
                    await chrome.action.setBadgeText({ text: '', tabId });
                }
            } else if (offline) {
                // Priority 3: Offline badge if enabled
                await chrome.action.setBadgeText({ text: 'OFF', tabId });
                await chrome.action.setBadgeBackgroundColor({ color: '#f97316', tabId });
            } else {
                await chrome.action.setBadgeText({ text: '', tabId });
            }
        } else {
            // Global update (usually for network kill switch)
            if (offline) {
                await chrome.action.setBadgeText({ text: 'OFF' });
                await chrome.action.setBadgeBackgroundColor({ color: '#f97316' });
            } else {
                await chrome.action.setBadgeText({ text: '' });
                // Note: We don't set "+" globally as it's per-tab and per-sidebar-state
            }
        }
    } catch (e) {
        console.error('[SW] updateBadge failed:', e);
    }
}
async function recoverLocalPages() {
    try {
        const { openLocalPages = {} } = await chrome.storage.local.get('openLocalPages');
        const entryCount = Object.keys(openLocalPages).length;
        if (entryCount === 0) return;

        console.log(`[Recovery] Checking ${entryCount} potentially lost local pages...`);

        // Get currently open tabs to check which of these "old" tabIds are actually gone
        const currentTabs = await chrome.tabs.query({});
        const currentTabIds = new Set(currentTabs.map(t => t.id));

        // Group by packetId to restore efficiently
        const recordsToRestore = [];
        const deadTabIds = [];

        for (const [oldTabId, record] of Object.entries(openLocalPages)) {
            if (!currentTabIds.has(parseInt(oldTabId))) {
                recordsToRestore.push(record);
                deadTabIds.push(oldTabId);
            }
        }

        if (recordsToRestore.length > 0) {
            console.log(`[Recovery] Restoring ${recordsToRestore.length} local pages...`);
            
            // Clear dead IDs from storage first to avoid infinite loops if something fails
            for (const id of deadTabIds) {
                delete openLocalPages[id];
            }
            await chrome.storage.local.set({ openLocalPages });

            for (const record of recordsToRestore) {
                try {
                    // Use handleMessage internal logic or just call openTabInGroup logic
                    // We can simulate a message to openTabInGroup
                    await handleMessage({
                        action: 'openTabInGroup',
                        url: record.url,
                        packetId: record.packetId
                    }, {}, () => {});
                } catch (e) {
                    console.error('[Recovery] Failed to restore page:', record.url, e);
                }
            }

            // Group by packetId to sync ordering for each affected group
            const uniquePacketIds = [...new Set(recordsToRestore.map(r => r.packetId).filter(Boolean))];
            if (uniquePacketIds.length > 0) {
                console.log(`[Recovery] Triggering tab sync for ${uniquePacketIds.length} packets...`);
                // Short delay to allow tabs to finish grouping
                setTimeout(async () => {
                    for (const pid of uniquePacketIds) {
                        await syncTabOrderForPacket(pid).catch(e => console.error(`[Recovery] Sync failed for ${pid}:`, e));
                    }
                }, 1000);
            }

        } else {
            console.log('[Recovery] No dead local pages found.');
            // However, we should probably prune entries for tabs that are standard pages now
            // But openLocalPages only contains viewer.html URLs anyway.
        }
    } catch (e) {
        console.error('[Recovery] Error:', e);
    }
}
async function syncTabOrderForPacket(packetId) {
    if (!packetId) return;

    try {
        console.log(`[SyncTabOrder] Starting for packet ${packetId}`);
        await initializeSQLite();
        const db = sqliteManager.getDatabase('packets');
        if (!db) return;

        const result = db.exec(`SELECT urls FROM packets WHERE rowid = ${packetId}`);
        if (!result.length || !result[0].values.length) return;

        const urls = JSON.parse(result[0].values[0][0]);
        const packetUrls = urls.map(item => {
            const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
            if (type === 'page' || type === 'link') {
                return typeof item === 'string' ? item : item.url;
            } else if (type === 'local') {
                return chrome.runtime.getURL(`sidebar/viewer.html?id=${item.resourceId}&name=${encodeURIComponent(item.name)}`);
            } else if (type === 'media') {
                return chrome.runtime.getURL(`sidebar/media.html?id=${item.mediaId}&type=${encodeURIComponent(item.mimeType)}&name=${encodeURIComponent(item.name)}`);
            }
            return null;
        }).filter(u => u !== null);

        console.log(`[SyncTabOrder] Packet has ${packetUrls.length} URLs to match`);

        // Find the group mapped to this packet
        const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
        let targetGroupId = null;
        let tabs = [];
        
        // Loop through all mappings to find a LIVE group for this packet
        // This handles cases where stale/dead group IDs are still in storage
        for (const [gid, pid] of Object.entries(activeGroups)) {
            if (String(pid) === String(packetId)) {
                const candidateGroupId = parseInt(gid);
                try {
                    const candidateTabs = await chrome.tabs.query({ groupId: candidateGroupId });
                    if (candidateTabs.length > 0) {
                        targetGroupId = candidateGroupId;
                        tabs = candidateTabs;
                        break; // Found a live group!
                    } else {
                        console.log(`[SyncTabOrder] Skipping empty candidate group ${candidateGroupId}`);
                    }
                } catch (e) {
                    console.log(`[SyncTabOrder] Skipping invalid candidate group ${candidateGroupId}`);
                }
            }
        }

        if (targetGroupId === null) {
            console.warn(`[SyncTabOrder] No LIVE mapped group found for packet ${packetId}`);
            return;
        }

        console.log(`[SyncTabOrder] Identified ${tabs.length} tabs in group ${targetGroupId}`);

        // Get window ID for this group to find tabs outside the group but in the same window
        const windowId = tabs[0].windowId;
        const allTabsInWindow = await chrome.tabs.query({ windowId });

        // Find the start index of the group in its window
        const startPos = Math.min(...tabs.map(t => t.index));
        console.log(`[SyncTabOrder] Group starts at window index ${startPos}`);

        // For each URL in the packet, if an open tab matches it, move it to the correct position
        let moveCount = 0;
        let contiguousOffset = 0;

        for (let i = 0; i < packetUrls.length; i++) {
            const targetUrl = packetUrls[i];
            
            // Robust match: Check EVERY tab in the window, even if it's currently outside the group
            const matchingTab = allTabsInWindow.find(t => {
                const turl = t.url || t.pendingUrl;
                const mappedUrl = getMappedUrlSync(t.id);
                const mappedPacketId = getMappedPacketIdSync(t.id);

                // If tab is already mapped to a DIFFERENT packet, skip it!
                if (mappedPacketId && String(mappedPacketId) !== String(packetId)) return false;

                const urlMatches = (turl && urlsMatch(turl, targetUrl)) || (mappedUrl && urlsMatch(mappedUrl, targetUrl));
                return urlMatches;
            });

            if (matchingTab) {
                const targetIndex = startPos + contiguousOffset;
                
                // 1. Explicitly ensure it's in the group (fixes "kicked out" bug)
                if (matchingTab.groupId !== targetGroupId) {
                    console.log(`[SyncTabOrder] Adding tab ${matchingTab.id} to group ${targetGroupId}`);
                    await chrome.tabs.group({ tabIds: [matchingTab.id], groupId: targetGroupId });
                }

                // 2. Move to correct relative position
                if (matchingTab.index !== targetIndex) {
                    console.log(`[SyncTabOrder] Moving tab ${matchingTab.id} to index ${targetIndex} (was ${matchingTab.index})`);
                    await chrome.tabs.move(matchingTab.id, { index: targetIndex });
                    moveCount++;
                }
                
                contiguousOffset++;
            } else {
                console.log(`[SyncTabOrder] No tab found for URL: ${targetUrl.substring(0, 50)}...`);
            }
        }
        console.log(`[SyncTabOrder] Success. Moved ${moveCount} tabs. Total size: ${contiguousOffset}`);
    } catch (e) {
        console.error('[SyncTabOrder] Error:', e);
    }
}

/**
 * Re-associates browser tab groups with logical packets after a restart.
 * Uses title matching and URL validation to ensure strong association.
 */
async function reassociateTabGroups() {
    try {
        console.log('[GroupRecovery] Starting re-association check...');
        const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
        const groups = await chrome.tabGroups.query({});
        
        if (groups.length === 0) {
            console.log('[GroupRecovery] No tab groups found in browser.');
            return;
        }

        await initializeSQLite();
        const db = sqliteManager.getDatabase('packets');
        if (!db) return;

        const result = db.exec(`SELECT rowid, name, urls FROM packets`);
        if (!result.length) return;
        const allPackets = result[0].values.map(([id, name, urlsJson]) => ({
            id,
            name,
            urls: JSON.parse(urlsJson)
        }));

        const newActiveGroups = { ...activeGroups };
        let recoveryCount = 0;

        for (const group of groups) {
            // Already correctly mapped?
            if (activeGroups[group.id]) {
                const pid = activeGroups[group.id];
                if (allPackets.some(p => String(p.id) === String(pid))) continue;
            }

            // Recovery Strategy 1: Title match (Strong signal but not always available on startup)
            let candidates = allPackets.filter(p => group.title && p.name === group.title);
            
            // Recovery Strategy 2: URL overlap (Excellent signal for restored tabs)
            const tabs = await chrome.tabs.query({ groupId: group.id });
            if (tabs.length === 0) continue;
            const groupUrls = tabs.map(t => t.url || t.pendingUrl).filter(Boolean).map(normalizeUrl);

            let bestPacket = null;
            let highestMatch = 0;

            // If title match failed or yielded multiple, use URL validation
            const packetsToTest = (candidates.length > 0) ? candidates : allPackets;

            for (const packet of packetsToTest) {
                const packetUrlSet = new Set(packet.urls.map(item => {
                    const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
                    let url;
                    if (type === 'page' || type === 'link') url = typeof item === 'string' ? item : item.url;
                    else if (type === 'local') url = chrome.runtime.getURL(`sidebar/viewer.html?id=${item.resourceId}&name=${encodeURIComponent(item.name)}`);
                    else if (type === 'media') url = chrome.runtime.getURL(`sidebar/media.html?id=${item.mediaId}&type=${encodeURIComponent(item.mimeType)}&name=${encodeURIComponent(item.name)}`);
                    return url ? normalizeUrl(url) : null;
                }).filter(Boolean));

                const matches = groupUrls.filter(u => packetUrlSet.has(u)).length;
                if (matches > highestMatch) {
                    highestMatch = matches;
                    bestPacket = packet;
                }
            }

            // Acceptance Criteria: 
            // 1. If title matches AND there is at least 1 URL match -> RECOVER
            // 2. If NO title matches but more than 50% of the tabs URL match -> RECOVER
            const groupConfidence = highestMatch / Math.max(1, groupUrls.length);
            const isConfident = (group.title && candidates.some(p => p.id === bestPacket?.id) && highestMatch > 0) || (groupConfidence >= 0.5);

            if (bestPacket && isConfident) {
                console.log(`[GroupRecovery] RECOVERED: "${group.title}" (ID: ${group.id}) -> Packet "${bestPacket.name}" (Confidence: ${Math.round(groupConfidence * 100)}%)`);
                
                // Aggressive Cleanup: If this packet was previously mapped to other groups, clear them.
                // This prevents "ghost" mappings where one packet points to multiple group IDs.
                for (const [gid, pid] of Object.entries(newActiveGroups)) {
                    if (String(pid) === String(bestPacket.id) && String(gid) !== String(group.id)) {
                        console.log(`[GroupRecovery] Clearing stale mapping for packet "${bestPacket.name}" (ID: ${gid})`);
                        delete newActiveGroups[gid];
                    }
                }
                
                newActiveGroups[group.id] = bestPacket.id;
                recoveryCount++;
            }
        }

        // Prune mappings, but be conservative during the first 10 seconds of startup
        const currentGroupIds = new Set(groups.map(g => String(g.id)));
        const isWarm = (performance.now() > 10000); 
        
        let pruneCount = 0;
        for (const gid of Object.keys(newActiveGroups)) {
            if (!currentGroupIds.has(gid)) {
                if (isWarm) {
                    delete newActiveGroups[gid];
                    pruneCount++;
                }
            }
        }

        if (recoveryCount > 0 || pruneCount > 0) {
            await chrome.storage.local.set({ activeGroups: newActiveGroups });
            console.log(`[GroupRecovery] Finished. Recovered: ${recoveryCount}, Pruned: ${pruneCount}. Active: ${Object.keys(newActiveGroups).length}`);
            
            // Sync UI if sidebar is connected
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTab && sidebarPort && activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
                const packetId = newActiveGroups[activeTab.groupId];
                if (packetId) {
                    const db = sqliteManager.getDatabase('packets');
                    const res = db.exec(`SELECT rowid, name, urls FROM packets WHERE rowid = ${packetId}`);
                    if (res.length && res[0].values.length) {
                        const [id, name, urlsJson] = res[0].values[0];
                        chrome.runtime.sendMessage({ 
                            type: 'packetFocused', 
                            packet: { id, name, urls: JSON.parse(urlsJson), groupId: activeTab.groupId, activeUrl: activeTab.url } 
                        }).catch(() => {});
                    }
                }
            }
        }
    } catch (e) {
        console.error('[GroupRecovery] Error:', e);
    }
}

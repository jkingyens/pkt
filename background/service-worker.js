/**
 * Background Service Worker for SQLite Manager Extension
 * Handles database operations and side panel management
 */

// Import scripts in service worker context (paths relative to extension root)
self.importScripts('../sql-wasm.js', '../src/sqlite-manager.js', '../src/blob-storage.js');

let sqliteManager = null;
const blobStorage = new BlobStorage();
let SQL = null;
let initialized = false;
let initializing = null; // Lock for initialization

// In-memory cache for synchronous mapping access
let tabToUrlMapCached = {};

// Bookmarks cache for synchronous access from WASM
let bookmarkCache = null;

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

// Ensure the side panel doesn't intercept the click event so onClicked can fire
chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);

    // Create context menu for a guaranteed way to "invoke" the extension on a page
    chrome.contextMenus.create({
        id: 'wildcard-record-audio',
        title: 'Wildcard: Start Audio Recording',
        contexts: ['all']
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'wildcard-record-audio') {
        try {
            console.log('[SW] Context menu invocation, requesting streamId');
            const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
            await initiateAudioRecording(streamId, tab.id);
        } catch (e) {
            console.error('[SW] Context menu invocation failed:', e);
            chrome.tabs.sendMessage(tab.id, { type: 'RECORDING_ERROR', error: 'Please click the extension icon first.' });
        }
    }
});

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

async function initiateAudioRecording(streamId, targetTabId) {
    console.log('[SW] initiateAudioRecording for tab:', targetTabId);

    // 1. Ensure clipper is active on that tab
    await chrome.tabs.sendMessage(targetTabId, { type: 'SET_CLIPPER_ACTIVE', active: true }).catch(() => { });

    // 2. Create offscreen document if it doesn't exist
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length === 0) {
        console.log('[SW] Creating offscreen document');
        await chrome.offscreen.createDocument({
            url: 'offscreen/offscreen.html',
            reasons: ['USER_MEDIA'],
            justification: 'Capture tab audio for clipping tool'
        });
        // Small delay to ensure script is loaded
        await new Promise(r => setTimeout(r, 500));
    }

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

async function setTabMapping(tabId, url) {
    try {
        tabToUrlMapCached[tabId] = url;
        await chrome.storage.local.set({ tabToUrlMap: tabToUrlMapCached });
    } catch (e) { }
}

function getMappedUrlSync(tabId) {
    return tabToUrlMapCached[tabId];
}

async function removeTabMapping(tabId) {
    try {
        delete tabToUrlMapCached[tabId];
        await chrome.storage.local.set({ tabToUrlMap: tabToUrlMapCached });
    } catch (e) { }
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
                    locateFile: file => chrome.runtime.getURL(file)
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
    // Attempt to open the side panel synchronously to preserve user gesture context
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);

    // Send a message in case the sidebar is already open. 
    // If it's closed, this will fail silently which is exactly what we want.
    chrome.runtime.sendMessage({ action: 'triggerNewPacketWithTab' }).catch(e => { });
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
                const result = db.exec(request.sql);
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

                    const links = items.filter(item => {
                        if (typeof item === 'string') return true;
                        return item.type === 'link';
                    }).map(item => typeof item === 'string' ? item : item.url);

                    if (links.length === 0) {
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
            case 'getCurrentTab': {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) {
                    sendResponse({ success: false, error: 'No active tab found' });
                } else {
                    sendResponse({ success: true, tab: { id: tab.id, title: tab.title, url: tab.url } });
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
                    } else {
                        db.exec(`INSERT INTO packets (name, urls) VALUES ('${escapedName}', '${escapedUrls}')`);
                    }

                    await sqliteManager.saveCheckpoint('packets', chrome.storage.local);
                    sendResponse({ success: true });
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
            case 'saveMediaBlob': {
                try {
                    const blob = new Blob([new Uint8Array(request.data)], { type: request.type });
                    const id = await blobStorage.generateId(blob);
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
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (!tab || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
                        sendResponse({ success: true, packet: null }); break;
                    }
                    const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                    const packetId = activeGroups[tab.groupId];
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
            case 'openTabInGroup': {
                try {
                    const { url, groupId, packetId } = request;
                    let targetGroupId = groupId;

                    // Always try to find existing group by packetId if we have it
                    if (packetId) {
                        const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                        const groups = await chrome.tabGroups.query({});

                        // Check if the provided targetGroupId still actually belongs to this packet
                        let providedIsGood = false;
                        if (targetGroupId !== undefined && targetGroupId !== null) {
                            if (String(activeGroups[targetGroupId]) === String(packetId)) {
                                providedIsGood = true;
                            }
                        }

                        if (!providedIsGood) {
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
                            await setTabMapping(existing.id, url);
                        } else {
                            const newTab = await chrome.tabs.create({ url, active: true });
                            await chrome.tabs.group({ tabIds: [newTab.id], groupId: targetGroupId });
                            await setTabMapping(newTab.id, url);
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
                        await chrome.tabGroups.update(targetGroupId, { title: packetName, color: 'blue' });
                        if (packetId) {
                            const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                            activeGroups[targetGroupId] = packetId;
                            await chrome.storage.local.set({ activeGroups });
                        }
                        await setTabMapping(newTab.id, url);
                        sendResponse({ success: true, newGroupId: targetGroupId });
                    }
                } catch (err) {
                    console.error('openTabInGroup error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'runWasmPacketItem': {
                try {
                    const data = request.bytes || request.data || (request.item && request.item.data);
                    if (!data) throw new Error("No WASM data provided");
                    let binaryString = atob(data);
                    if (binaryString.charCodeAt(0) !== 0 && binaryString.startsWith('AGFz')) {
                        try { binaryString = atob(binaryString); } catch (e) { }
                    }
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const runtime = new WasmRuntime();
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
                            console.log(`[Host] sqlite.query: db=${dbName}, sql=${sql}`);
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
                    const executionLogs = [];
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
                                // Basic stat for stdout/stderr
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
                    let instance;
                    try {
                        const result = await WebAssembly.instantiate(bytes, importObject);
                        instance = result.instance;
                    } catch (e) {
                        if (e instanceof WebAssembly.LinkError) {
                            throw new Error(`WASM LinkError: ${e.message}. Possible mismatch between generated code and host imports.`);
                        }
                        throw e;
                    }
                    runtime.setInstance(instance);
                    if (instance.exports.run) {
                        const result = instance.exports.run();
                        sendResponse({ success: true, result, logs: executionLogs });
                    } else if (instance.exports.main) {
                        const result = instance.exports.main();
                        sendResponse({ success: true, result, logs: executionLogs });
                    } else {
                        sendResponse({ success: false, error: "No run or main export found", logs: executionLogs });
                    }
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
            case 'AUDIO_RECORDING_RESULT': {
                console.log('[SW] AUDIO_RECORDING_RESULT received, dataUrl length:', request.dataUrl?.length);
                // Forward the result to the sidebar
                chrome.runtime.sendMessage({
                    type: 'AUDIO_CLIP_FINISHED',
                    dataUrl: request.dataUrl
                }).then(() => {
                    console.log('[SW] Successfully forwarded AUDIO_CLIP_FINISHED to sidebar');
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
        const tab = await chrome.tabs.get(tabId);
        const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
        const groupId = tab.groupId;
        if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE || !activeGroups[groupId]) return;
        const packetId = activeGroups[groupId];
        await initializeSQLite();
        const db = sqliteManager.getDatabase('packets');
        if (!db) return;
        const result = db.exec(`SELECT rowid, name, urls FROM packets WHERE rowid = ${packetId}`);
        if (!result.length || !result[0].values.length) return;
        const [id, name, urlsJson] = result[0].values[0];

        // Use mapping if available to persist highlight through redirects
        const mappedUrl = getMappedUrlSync(tabId);
        const packet = { id, name, urls: JSON.parse(urlsJson), groupId, activeUrl: mappedUrl || tab.url };
        chrome.runtime.sendMessage({ type: 'packetFocused', packet }).catch(() => { });
    } catch (e) { }
});

// Also track when a tab is updated (e.g. navigation within a group)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' || changeInfo.url) {
        try {
            const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
            const groupId = tab.groupId;
            if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE || !activeGroups[groupId]) return;
            const packetId = activeGroups[groupId];
            await initializeSQLite();
            const db = sqliteManager.getDatabase('packets');
            if (!db) return;
            const result = db.exec(`SELECT rowid, name, urls FROM packets WHERE rowid = ${packetId}`);
            if (!result.length || !result[0].values.length) return;
            const [id, name, urlsJson] = result[0].values[0];

            // Use mapping if available to persist highlight through redirects
            const mappedUrl = getMappedUrlSync(tabId);
            const packet = { id, name, urls: JSON.parse(urlsJson), groupId, activeUrl: mappedUrl || tab.url };
            chrome.runtime.sendMessage({ type: 'packetFocused', packet }).catch(() => { });
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
        port.onDisconnect.addListener(async () => {
            try {
                // Sidebar closed! Deactivate clipper on the active tab
                const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                if (tab) {
                    chrome.tabs.sendMessage(tab.id, { type: 'SET_CLIPPER_ACTIVE', active: false }).catch(() => { });
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

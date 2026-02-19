/**
 * Background Service Worker for SQLite Manager Extension
 * Handles database operations and side panel management
 */

// Import scripts in service worker context (paths relative to extension root)
self.importScripts('../sql-wasm.js', '../src/sqlite-manager.js');

let sqliteManager = null;
let SQL = null;
let initialized = false; // track full initialization including restore

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

// Initialize SQL.js and auto-restore all checkpoints
async function initializeSQLite() {
    if (initialized) return sqliteManager;

    if (!SQL) {
        SQL = await initSqlJs({
            locateFile: file => chrome.runtime.getURL(file)
        });
        sqliteManager = new SQLiteManager(SQL);
    }

    // Auto-restore all saved checkpoints before handling any messages
    try {
        const restored = await sqliteManager.restoreAllCheckpoints(chrome.storage.local);
        if (restored.length > 0) {
            console.log(`Auto-restored collections: ${restored.join(', ')}`);
        }
        await sqliteManager.ensurePacketsCollection(chrome.storage.local);
        await sqliteManager.ensureSchemasCollection(chrome.storage.local);
        await sqliteManager.ensureWitsCollection(chrome.storage.local);

        // Also sync bookmarks cache
        await syncBookmarkCache();
    } catch (error) {
        console.error('Failed to auto-restore checkpoints:', error);
    }

    initialized = true;
    return sqliteManager;
}

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId });
});

// Message handler for sidebar communication
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request, sender, sendResponse);
    return true; // Keep channel open for async response
});

async function handleMessage(request, sender, sendResponse) {
    try {
        await initializeSQLite();

        switch (request.action) {
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
                await sqliteManager.saveCheckpoint(request.name, chrome.storage.local);
                sendResponse({ success: true });
                break;
            }
            case 'restoreCheckpoint': {
                const restored = await sqliteManager.restoreCheckpoint(request.name, chrome.storage.local);
                sendResponse({ success: true, restored });
                break;
            }
            case 'deleteCollection': {
                sqliteManager.closeDatabase(request.name);
                await chrome.storage.local.remove(`checkpoint_${request.name}`);
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
            case 'setSchema': {
                await sqliteManager.applySchema(request.name, request.createSQL, chrome.storage.local);
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

                    const tabIds = [];
                    for (const url of links) {
                        const tab = await chrome.tabs.create({ url, active: false });
                        tabIds.push(tab.id);
                    }

                    if (tabIds.length === 0) {
                        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
                        tabIds.push(tab.id);
                    }

                    const groupId = await chrome.tabs.group({ tabIds });
                    await chrome.tabGroups.update(groupId, { title: name, color: 'blue' });

                    const { activeGroups = {} } = await chrome.storage.session.get('activeGroups');
                    activeGroups[groupId] = request.id;
                    await chrome.storage.session.set({ activeGroups });

                    await chrome.tabs.update(tabIds[0], { active: true });
                    sendResponse({ success: true, groupId });
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
                    db.exec(`INSERT INTO packets (name, urls) VALUES ('${escapedName}', '${escapedUrls}')`);
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
                    const { activeGroups = {} } = await chrome.storage.session.get('activeGroups');
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
            case 'getActivePacket': {
                try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (!tab || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
                        sendResponse({ success: true, packet: null }); break;
                    }
                    const { activeGroups = {} } = await chrome.storage.session.get('activeGroups');
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
                    let groupExists = false;
                    try {
                        if (targetGroupId !== undefined && targetGroupId !== null) {
                            await chrome.tabGroups.get(targetGroupId);
                            groupExists = true;
                        }
                    } catch (e) { }

                    if (groupExists) {
                        const tabsInGroup = await chrome.tabs.query({ groupId: targetGroupId });
                        const existing = tabsInGroup.find(t => t.url === url || t.pendingUrl === url);
                        if (existing) {
                            await chrome.tabs.update(existing.id, { active: true });
                        } else {
                            const newTab = await chrome.tabs.create({ url, active: true });
                            await chrome.tabs.group({ tabIds: [newTab.id], groupId: targetGroupId });
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
                            const { activeGroups = {} } = await chrome.storage.session.get('activeGroups');
                            activeGroups[targetGroupId] = packetId;
                            await chrome.storage.session.set({ activeGroups });
                        }
                        sendResponse({ success: true, newGroupId: targetGroupId });
                    }
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'runWasmPacketItem': {
                try {
                    const { name, data } = request.item;
                    let binaryString = atob(data);

                    // Check for WASM magic word (0x00 0x61 0x73 0x6d)
                    // If not found, and it looks like Base64 (starts with "AGFz"), try decoding again.
                    // This handles cases where user provides Base64-encoded text as a file.
                    if (binaryString.charCodeAt(0) !== 0 && binaryString.startsWith('AGFz')) {
                        try {
                            binaryString = atob(binaryString);
                        } catch (e) { /* fallback to original if not valid b64 */ }
                    }


                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }

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
                            // Always create a fresh DataView on the latest buffer
                            return new DataView(this.memory.buffer);
                        }
                        readString(ptr, len) {
                            const bytes = new Uint8Array(this.memory.buffer, ptr, len);
                            return new TextDecoder().decode(bytes);
                        }
                        alloc(size, align) {
                            if (!this.instance.exports.cabi_realloc) {
                                throw new Error("WASM module missing 'cabi_realloc' export");
                            }
                            return this.instance.exports.cabi_realloc(0, 0, align, size);
                        }
                        writeString(str) {
                            const bytes = new TextEncoder().encode(str);
                            const ptr = this.alloc(bytes.length, 1);
                            const dest = new Uint8Array(this.memory.buffer, ptr, bytes.length);
                            dest.set(bytes);
                            return { ptr, len: bytes.length };
                        }
                        encodeBookmarkNode(node) {
                            const ptr = this.alloc(52, 4);

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
                                const childPtrs = node.children.map(c => this.encodeBookmarkNode(c));
                                const listPtr = this.alloc(childPtrs.length * 4, 4);
                                view = this.getView();
                                try {
                                    const listBytes = new Uint32Array(this.memory.buffer, listPtr, childPtrs.length);
                                    listBytes.set(childPtrs);
                                } catch (e) {
                                    console.error(`[Runtime] Failed to create listBytes: ptr=${listPtr}, len=${childPtrs.length}, bufLen=${this.memory.buffer.byteLength}`);
                                    throw e;
                                }
                                view.setUint32(ptr + 40, 1, true);
                                view.setUint32(ptr + 44, listPtr, true);
                                view.setUint32(ptr + 48, node.children.length, true);
                            } else {
                                this.getView().setUint32(ptr + 40, 0, true);
                            }
                            return ptr;
                        }
                        encodeBookmarkList(nodes) {
                            const ptrs = nodes.map(n => this.encodeBookmarkNode(n));
                            const listPtr = this.alloc(ptrs.length * 4, 4);
                            console.log(`[Runtime] encodeBookmarkList: ptrs=${ptrs.length}, listPtr=${listPtr}, bufLen=${this.memory.buffer.byteLength}`);
                            const listBytes = new Uint32Array(this.memory.buffer, listPtr, ptrs.length);
                            listBytes.set(ptrs);
                            return { ptr: listPtr, len: ptrs.length };
                        }
                    }

                    const runtime = new WasmRuntime();

                    const importObject = {
                        env: {
                            log: (ptr, len) => console.log('WASM Log:', runtime.readString(ptr, len))
                        },
                        "chrome:bookmarks/bookmarks": {
                            "get-tree": () => {
                                console.log('[Host] get-tree called');
                                try {
                                    if (!bookmarkCache) throw new Error("Cache not ready");
                                    const encoded = runtime.encodeBookmarkList(bookmarkCache);
                                    const resultPtr = runtime.alloc(12, 4);
                                    const view = runtime.getView();
                                    view.setUint32(resultPtr, 0, true);
                                    view.setUint32(resultPtr + 4, encoded.ptr, true);
                                    view.setUint32(resultPtr + 8, encoded.len, true);
                                    console.log(`[Host] get-tree success, resultPtr: ${resultPtr}, len: ${encoded.len}`);
                                    return resultPtr;
                                } catch (e) {
                                    console.error('[Host] get-tree error:', e.message);
                                    const errStr = runtime.writeString(e.message);
                                    const resultPtr = runtime.alloc(12, 4);
                                    const view = runtime.getView();
                                    view.setUint32(resultPtr, 1, true);
                                    view.setUint32(resultPtr + 4, errStr.ptr, true);
                                    view.setUint32(resultPtr + 8, errStr.len, true);
                                    return resultPtr;
                                }
                            },
                            "create": (titlePtr, titleLen, urlPtr, urlLen) => {
                                const errStr = runtime.writeString("Async 'create' requires JSPI.");
                                const resultPtr = runtime.alloc(12, 4);
                                const view = runtime.getView();
                                view.setUint32(resultPtr, 1, true);
                                view.setUint32(resultPtr + 4, errStr.ptr, true);
                                view.setUint32(resultPtr + 8, errStr.len, true);
                                return resultPtr;
                            }
                        }
                    };

                    const { instance } = await WebAssembly.instantiate(bytes, importObject);
                    runtime.setInstance(instance);

                    if (instance.exports.main) {
                        const result = instance.exports.main();
                        sendResponse({ success: true, result });
                    } else {
                        sendResponse({ success: false, error: "No main export" });
                    }
                } catch (err) {
                    console.error('WASM error:', err);
                    sendResponse({ success: false, error: err.message });
                }
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
        const { activeGroups = {} } = await chrome.storage.session.get('activeGroups');
        const groupId = tab.groupId;
        if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE || !activeGroups[groupId]) return;
        const packetId = activeGroups[groupId];
        await initializeSQLite();
        const db = sqliteManager.getDatabase('packets');
        if (!db) return;
        const result = db.exec(`SELECT rowid, name, urls FROM packets WHERE rowid = ${packetId}`);
        if (!result.length || !result[0].values.length) return;
        const [id, name, urlsJson] = result[0].values[0];
        const packet = { id, name, urls: JSON.parse(urlsJson), groupId };
        chrome.runtime.sendMessage({ type: 'packetFocused', packet }).catch(() => { });
    } catch (e) { }
});

chrome.tabGroups.onRemoved.addListener(async (group) => {
    try {
        const { activeGroups = {} } = await chrome.storage.session.get('activeGroups');
        if (activeGroups[group.id]) {
            delete activeGroups[group.id];
            await chrome.storage.session.set({ activeGroups });
        }
    } catch (e) { }
});

initializeSQLite().then(() => {
    console.log('SQLite Manager initialized');
}).catch(error => {
    console.error('Failed to initialize SQLite:', error);
});

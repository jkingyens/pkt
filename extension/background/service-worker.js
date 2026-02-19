/**
 * Background Service Worker for SQLite Manager Extension
 * Handles database operations and side panel management
 */

// Import scripts in service worker context (paths relative to extension root)
self.importScripts('../sql-wasm.js', '../src/sqlite-manager.js');

let sqliteManager = null;
let SQL = null;
let initialized = false; // track full initialization including restore

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
                // data arrives as a plain Array (ArrayBuffer can't survive sendMessage serialization)
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

                    // Filter for link items only
                    const links = items.filter(item => {
                        // Backward compatibility: string items are links
                        if (typeof item === 'string') return true;
                        // New format: check type
                        return item.type === 'link';
                    }).map(item => typeof item === 'string' ? item : item.url);

                    // Create tabs (only for links)
                    const tabIds = [];
                    for (const url of links) {
                        const tab = await chrome.tabs.create({ url, active: false });
                        tabIds.push(tab.id);
                    }

                    if (tabIds.length === 0) {
                        // If packet only has WASM items, we still want to show it as active?
                        // Actually, without tabs, we can't make a tab group. 
                        // User might want to just access the WASM functions.
                        // For now, if no tabs, just return success (sidebar will show details).
                        // But wait, active detection relies on tab group ID. 
                        // If no group, we can't track it as 'active'.
                        // Let's create a placeholder tab? No, that's annoying.
                        // Let's just create an 'about:blank' tab if only WASM items exist, or just fail to group.
                        // Decision: If no links, open a single 'about:blank' to hold the group.
                        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
                        tabIds.push(tab.id);
                    }

                    // Group them
                    const groupId = await chrome.tabs.group({ tabIds });
                    await chrome.tabGroups.update(groupId, { title: name, color: 'blue' });

                    // Store groupId → packetRowId mapping in session storage
                    const { activeGroups = {} } = await chrome.storage.session.get('activeGroups');
                    activeGroups[groupId] = request.id;
                    await chrome.storage.session.set({ activeGroups });

                    // Focus the first tab
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
                    // Use escaped string literals — sql.js parameterized run() can be unreliable
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
                // Called by sidebar on init to check if already inside a packet group
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
                // Open or focus a URL inside the given tab group
                try {
                    const { url, groupId } = request;
                    // Check if a tab with this URL already exists in the group
                    const tabsInGroup = await chrome.tabs.query({ groupId });
                    const existing = tabsInGroup.find(t => t.url === url || t.pendingUrl === url);
                    if (existing) {
                        await chrome.tabs.update(existing.id, { active: true });
                    } else {
                        const newTab = await chrome.tabs.create({ url, active: true });
                        await chrome.tabs.group({ tabIds: [newTab.id], groupId });
                    }
                    sendResponse({ success: true });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'runWasmPacketItem': {
                try {
                    const { name, data } = request.item; // data is base64 string
                    // 1. Decode Base64 to ArrayBuffer
                    const binaryString = atob(data);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }

                    // 2. Instantiate WASM
                    // We use minimal imports for now. 
                    // Use 'console' for logging if needed.
                    const importObject = {
                        env: {
                            log: (arg) => console.log('WASM Log:', arg)
                        },
                        console: {
                            log: (arg) => console.log(arg)
                        }
                    };

                    const { instance } = await WebAssembly.instantiate(bytes, importObject);

                    // 3. Run main()
                    if (instance.exports.main) {
                        try {
                            const result = instance.exports.main();
                            console.log(`WASM '${name}' main() result:`, result);

                            // Send result back to sidebar (or notification)
                            // Since this is a message handler, we can just return the result
                            sendResponse({ success: true, result });
                        } catch (execErr) {
                            sendResponse({ success: false, error: `Execution failed: ${execErr.message}` });
                        }
                    } else {
                        sendResponse({ success: false, error: "Module does not export 'main' function" });
                    }
                } catch (err) {
                    console.error('WASM execution failed:', err);
                    sendResponse({ success: false, error: `Load failed: ${err.message}` });
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

// ─── Tab activation listener ────────────────────────────────────────────────
// When user switches to a tab, check if it's in a known packet group.
// If so, push a packetFocused event to the sidebar.
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
        // Broadcast to all extension contexts (sidebar)
        chrome.runtime.sendMessage({ type: 'packetFocused', packet }).catch(() => { });
    } catch (e) { /* tab may have been closed */ }
});

// When a tab group is removed, clean up our activeGroups mapping.
chrome.tabGroups.onRemoved.addListener(async (group) => {
    try {
        const { activeGroups = {} } = await chrome.storage.session.get('activeGroups');
        if (activeGroups[group.id]) {
            delete activeGroups[group.id];
            await chrome.storage.session.set({ activeGroups });
        }
    } catch (e) { }
});

// Kick off initialization eagerly on service worker startup
initializeSQLite().then(() => {
    console.log('SQLite Manager initialized');
}).catch(error => {
    console.error('Failed to initialize SQLite:', error);
});


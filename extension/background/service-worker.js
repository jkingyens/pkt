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
            default:
                sendResponse({ success: false, error: 'Unknown action' });
        }
    } catch (error) {
        console.error('Error handling message:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// Kick off initialization eagerly on service worker startup
initializeSQLite().then(() => {
    console.log('SQLite Manager initialized');
}).catch(error => {
    console.error('Failed to initialize SQLite:', error);
});


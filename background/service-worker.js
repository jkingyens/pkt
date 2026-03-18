/**
 * Background Service Worker for SQLite Manager Extension
 * Handles database operations and side panel management
 */

// Import scripts in service worker context (paths relative to extension root)
self.importScripts('../src/sqlite-manager.js', '../src/blob-storage.js');

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

// Track pending recording intent for session-based permissions
let pendingRecordingState = {
    type: null, // 'audio', 'video', or null
    timestamp: 0,
    permissionTabId: null
};

// Biometric session state
let isSessionVerified = false;

const NETWORK_BLOCK_RULE_ID = 1;

async function syncBookmarkCache() {
    if (!chrome.bookmarks) return;
    try {
        bookmarkCache = await chrome.bookmarks.getTree();
        console.log('[BookmarksCache] Synced', bookmarkCache.length, 'root nodes:', JSON.stringify(bookmarkCache).substring(0, 100) + '...');
    } catch (e) {
        console.error('[BookmarksCache] Sync failed:', e);
    }
}

// Keep cache in sync
if (chrome.bookmarks) {
    chrome.bookmarks.onCreated.addListener(syncBookmarkCache);
    chrome.bookmarks.onRemoved.addListener(syncBookmarkCache);
    chrome.bookmarks.onChanged.addListener(syncBookmarkCache);
    chrome.bookmarks.onMoved.addListener(syncBookmarkCache);
    chrome.bookmarks.onChildrenReordered.addListener(syncBookmarkCache);
    chrome.bookmarks.onImportEnded.addListener(syncBookmarkCache);
}

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
    if (area === 'local') {
        if (changes.activeGroups || changes.networkEnabled) {
            chrome.tabs.query({}).then(tabs => {
                for (const tab of tabs) {
                    updateBadge({ tabId: tab.id }).catch(() => { });
                }
            });
        }
        if (changes.playbackTabIds) {
            tabToUrlMapCached.playbackTabIds = changes.playbackTabIds.newValue || [];
            chrome.tabs.query({}).then(tabs => {
                for (const tab of tabs) {
                    updateBadge({ tabId: tab.id }).catch(() => { });
                }
            });
        }
    }
});

async function logEvent(title, body, isSimulated = 0) {
    try {
        const manager = await initializeSQLite();
        const db = manager.getDatabase('events');
        if (!db) {
            console.error('[EventLogger] Events database not found');
            return;
        }
        const escapedTitle = title.replace(/'/g, "''");
        const escapedBody = body ? body.replace(/'/g, "''") : '';
        await db.exec(`INSERT INTO events (title, body, is_simulated) VALUES ('${escapedTitle}', '${escapedBody}', ${isSimulated ? 1 : 0})`);
        console.log(`[EventLogger] Logged: ${title}`);
    } catch (e) {
        console.error('[EventLogger] Failed to log event:', e);
    }
}

async function syncNetworkStatus() {
    try {
        const { networkEnabled } = await chrome.storage.local.get('networkEnabled');
        const isDisabled = networkEnabled === false;

        const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
        const wasDisabled = currentRules.some(r => r.id === NETWORK_BLOCK_RULE_ID);

        if (isDisabled) {
            console.log('[SW-Startup] Network kill switch is ENABLED (blocking requests)');
            await updateBadge({});
            
            // 1. Clear existing rules first
            const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
            const ruleIds = existingRules.map(r => r.id);
            
            // 2. Add specific block rules and high-priority internal allow rules
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: ruleIds,
                addRules: [
                    // Rule 100+: High-priority ALLOW rules for internal resources
                    {
                        id: 100,
                        priority: 200,
                        action: { type: 'allow' },
                        condition: { urlFilter: 'chrome-extension://*', resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'] }
                    },
                    {
                        id: 101,
                        priority: 200,
                        action: { type: 'allow' },
                        condition: { urlFilter: 'blob:*', resourceTypes: ['image', 'media', 'other', 'xmlhttprequest'] }
                    },
                    // Rule 1+: Standard priority BLOCK rules for external protocols
                    {
                        id: NETWORK_BLOCK_RULE_ID,
                        priority: 100,
                        action: { type: 'block' },
                        condition: {
                            urlFilter: 'http://*',
                            resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other']
                        }
                    },
                    {
                        id: NETWORK_BLOCK_RULE_ID + 1,
                        priority: 100,
                        action: { type: 'block' },
                        condition: {
                            urlFilter: 'https://*',
                            resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other']
                        }
                    },
                    {
                        id: NETWORK_BLOCK_RULE_ID + 2,
                        priority: 100,
                        action: { type: 'block' },
                        condition: {
                            urlFilter: 'ws://*',
                            resourceTypes: ['websocket']
                        }
                    },
                    {
                        id: NETWORK_BLOCK_RULE_ID + 3,
                        priority: 100,
                        action: { type: 'block' },
                        condition: {
                            urlFilter: 'wss://*',
                            resourceTypes: ['websocket']
                        }
                    }
                ]
            });
            if (!wasDisabled) {
                await logEvent('Network Offline (Simulated)', 'Network access was disabled via extension settings.', 1);
            }
        } else {
            console.log('[SW-Startup] Network kill switch is DISABLED (allowing requests)');
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: [
                    NETWORK_BLOCK_RULE_ID, NETWORK_BLOCK_RULE_ID + 1, 
                    NETWORK_BLOCK_RULE_ID + 2, NETWORK_BLOCK_RULE_ID + 3,
                    100, 101 // Internal allow rules
                ]
            });
            if (wasDisabled) {
                await logEvent('Network Online (Simulated)', 'Network access was enabled via extension settings.', 1);
            }
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
            reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'LOCAL_STORAGE'],
            justification: 'Capture tab audio and video for clipping tool and host SQLite database engine'
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

function isStackEditorOrPlayback(tabId, url) {
    if (!url && !tabId) return false;
    // 1. Stack Editor itself
    if (url && url.includes('sidebar/stack.html')) return true;
    
    // 2. Check if this tab is registered for playback
    const playbackTabIds = tabToUrlMapCached.playbackTabIds || [];
    if (tabId && playbackTabIds.includes(tabId)) return true;

    return false;
}

async function initiateTabCapture(streamId, targetTabId, isVideo = false, region = null) {
    console.log(`[SW] initiateTabCapture (${isVideo ? 'video' : 'audio'}) for tab:`, targetTabId, 'Region:', region);

    // 1. Ensure clipper is active on that tab (unless it's a media page where overlay fails)
    const tab = await chrome.tabs.get(targetTabId).catch(() => null);
    if (tab && !isMediaPage(tab.url)) {
        await chrome.tabs.sendMessage(targetTabId, { type: 'SET_CLIPPER_ACTIVE', active: true, islandOnly: true }).catch(() => { });
    }

    // 2. Create offscreen document if it doesn't exist
    await ensureOffscreenDocument();

    // 3. Start recording in offscreen
    console.log('[SW] Sending START_RECORDING to offscreen');
    chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        streamId,
        isVideo,
        region
    });

    // 4. Update Island UI (if it's already open, it will receive this)
    setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'AUDIO_RECORDING_REMOTE_START', streamId, isVideo });
    }, 200);
}

// Robust URL normalization for matching across redirects (protocol, www, trailing slashes, hashes)
/**
 * Safely parses packet URLs, handling malformed data or string "undefined".
 */
function safeParseUrls(urlsJson) {
    if (!urlsJson || urlsJson === 'undefined') return [];
    try {
        const parsed = (typeof urlsJson === 'string') ? JSON.parse(urlsJson) : urlsJson;
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error('[SW] Failed to parse URLs JSON:', urlsJson, e);
        return [];
    }
}

/**
 * Normalizes a URL for comparison.
 */
function normalizeUrl(url) {
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
        
        // Strip non-essential parameters for matching identity
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

/**
 * Generates the canonical URL for a packet item.
 */
function getItemUrl(item, packetId) {
    if (!item) return null;
    const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
    
    // For items loaded from stack_items table, essential IDs are inside metadata
    const meta = (typeof item.metadata === 'object') ? item.metadata : {};
    const resourceId = item.resourceId || meta.resourceId;
    const mediaId = item.mediaId || meta.mediaId;
    const mimeType = item.mimeType || meta.mimeType;
    const name = item.name || meta.name || '';

    if (type === 'page' || type === 'link') {
        const url = typeof item === 'string' ? item : (item.url || meta.url);
        return url;
    } else if (type === 'local' || type === 'wasm') {
        if (!resourceId) return null;
        return chrome.runtime.getURL(`sidebar/viewer.html?id=${resourceId}&name=${encodeURIComponent(name)}&packetId=${packetId || ''}`);
    } else if (type === 'media' || type === 'image' || type === 'video' || type === 'audio') {
        if (!mediaId) return null;
        return chrome.runtime.getURL(`sidebar/media.html?id=${mediaId}&type=${encodeURIComponent(mimeType || '')}&name=${encodeURIComponent(name)}&packetId=${packetId || ''}`);
    } else if (type === 'stack') {
        const pid = packetId || item.packetId || meta.packetId || '';
        return chrome.runtime.getURL(`sidebar/stack.html?id=${item.stackId || meta.stackId}&packetId=${pid}&name=${encodeURIComponent(name)}`);
    }
    return null;
}

function urlsMatch(u1, u2) {
    return normalizeUrl(u1) === normalizeUrl(u2);
}

async function setTabMapping(tabId, url, packetId) {
    try {
        tabToUrlMapCached[tabId] = { url, packetId };
        await chrome.storage.local.set({ tabToUrlMap: tabToUrlMapCached });

        // Track local pages and stack editors for recovery after reload
        // We EXCLUDE playback tabs from being recovery targets
        const playbackTabIds = tabToUrlMapCached.playbackTabIds || [];
        const isPlaybackTab = playbackTabIds.includes(tabId);

        if (url && (url.includes('viewer.html') || url.includes('sidebar/stack.html')) && !isPlaybackTab) {
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

async function getVisualSequence(packet) {
    if (!packet || !packet.urls) return [];
    
    const sequence = [];
    const urls = packet.urls;

    const addItem = (item, originalIndex) => {
        const url = getItemUrl(item, packet.id);
        if (url) {
            sequence.push({ item, originalIndex });
        } else {
            // Wasm etc might not have URLs but need to be in sequence
            sequence.push({ item, originalIndex });
        }
    };

    // 1. Stacks (Top section)
    const stacks = urls.map((item, i) => ({ item, i })).filter(x => x.item.type === 'stack');
    for (const { item, i } of stacks) {
        addItem(item, i);
    }

    // 2. Pages (Web/Local)
    urls.map((item, i) => ({ item, i })).filter(x => {
        const t = (typeof x.item === 'object') ? (x.item.type || 'page') : 'page';
        return t === 'page' || t === 'link' || t === 'local';
    }).forEach(x => addItem(x.item, x.i));

    // 3. Media
    urls.map((item, i) => ({ item, i })).filter(x => {
        const t = (typeof x.item === 'object') ? (x.item.type || 'page') : 'page';
        return t === 'media';
    }).forEach(x => addItem(x.item, x.i));

    // 4. WASM
    urls.map((item, i) => ({ item, i })).filter(x => {
        const t = (typeof x.item === 'object') ? (x.item.type || 'page') : 'page';
        return t === 'wasm';
    }).forEach(x => addItem(x.item, x.i));

    return sequence;
}

async function navigatePacketItems(groupId, direction, manager) {
    if (!manager) manager = await initializeSQLite();
    const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
    const packetId = activeGroups[groupId];
    if (!packetId) return;

    try {
        const db = manager.getDatabase('packets');
        const rows = await db.query(`SELECT name, urls FROM packets WHERE rowid = ${packetId}`);
        if (!rows || !rows.length) return;

        const { name, urls: urlsJson } = rows[0];
        const packet = { id: packetId, name, urls: safeParseUrls(urlsJson) };

        const visualSeq = await getVisualSequence(packet);
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

// Initialize SQLite Worker and handle migration
async function initializeSQLite() {
    if (initialized) return sqliteManager;
    if (initializing) return initializing;

    initializing = (async () => {
        try {
            console.log('[SQLiteInit] Starting initialization...');

            // Ensure Offscreen Document is up (hosting the SQLite engine)
            await ensureOffscreenDocument();
            console.log('[SQLiteInit] Offscreen document ensured.');

            sqliteManager = new SQLiteManager();
            await sqliteManager.init();
            console.log('[SQLiteInit] SQLiteManager initialized.');

            // Migration Check: If we haven't migrated checkpoints to OPFS yet, do it now.
            const { opfsMigrationDone } = await chrome.storage.local.get('opfsMigrationDone');
            if (!opfsMigrationDone) {
                console.log('[Migration] Starting one-time migration from chrome.storage.local to OPFS...');
                
                const allStor = await chrome.storage.local.get(null);
                const allKeys = Object.keys(allStor);
                console.log('[Migration] Keys found in storage:', allKeys.filter(k => k.startsWith('db_') || k.startsWith('sqlite_checkpoint_')));

                const restored = await sqliteManager.restoreAllCheckpoints(chrome.storage.local, 'db_');
                const restoredAlt = await sqliteManager.restoreAllCheckpoints(chrome.storage.local, 'sqlite_checkpoint_');
                const allRestored = [...restored, ...restoredAlt];

                if (allRestored.length > 0) {
                    console.log(`[Migration] Successfully migrated ${allRestored.length} collections: ${allRestored.join(', ')}`);
                } else {
                    console.warn('[Migration] No databases were found for migration.');
                }
                await chrome.storage.local.set({ opfsMigrationDone: true });
            } else {
                console.log('[SQLiteInit] OPFS migration already done.');
        }

        console.log('[SQLiteInit] Ensuring system collections...');
        await sqliteManager.ensurePacketsCollection();
        await sqliteManager.ensureSchemasCollection();
        await sqliteManager.ensureWitsCollection();
        await sqliteManager.ensureEventsCollection();
        await sqliteManager.ensureServicesCollection();
        console.log('[SQLiteInit] System collections ensured.');

            // Load tab mappings into memory cache
            const { tabToUrlMap = {}, playbackTabIds = [] } = await chrome.storage.local.get(['tabToUrlMap', 'playbackTabIds']);
            tabToUrlMapCached = tabToUrlMap;
            tabToUrlMapCached.playbackTabIds = playbackTabIds;

            // Also sync bookmarks cache
            await syncBookmarkCache();
            initialized = true;

            // Recover local pages and tab groups
            const { webAuthnEnabled = false } = await chrome.storage.local.get('webAuthnEnabled');
            
            if (webAuthnEnabled && !isSessionVerified) {
                console.log('[SW] Biometrics enabled and session NOT verified. Gating restoration...');
            } else {
                recoverLocalPages().catch(e => console.error('[Recovery] Failed:', e));
                const recover = () => reassociateTabGroups().catch(e => console.error('[GroupRecovery] Failed:', e));
                recover();
                setTimeout(recover, 2000);
            }

            cleanupPlaybackTabs().catch(e => console.error('[Cleanup] Failed:', e));
            performStartupLock().catch(e => console.error('[StartupLock] Failed:', e));

            return sqliteManager;
        } catch (error) {
            console.error('[SQLiteInit] Initialization failed:', error);
            initializing = null;
            throw error;
        }
    })();

    return initializing;
}

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
    // Check if this is a stack editor or playback tab
    if (isStackEditorOrPlayback(tab.id, tab.url)) {
        if (sidebarPort) {
            // Sidebar is OPEN! Toggle it closed
            chrome.runtime.sendMessage({ type: 'TOGGLE_SIDEBAR' }).catch(() => { });
        } else {
            // Sidebar is CLOSED! Open it
            chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
        }
        return;
    }

    // Standard external page behavior (clipper / add to packet)
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
        const manager = await initializeSQLite();
        
        // Final guard: if initializeSQLite returned but manager is still null (rare race), throw
        if (!manager && action !== 'RESET_STATE') {
            throw new Error('SQLiteManager failed to initialize');
        }

        // Validate database name if provided in request to avoid 'packet_undefined' errors
        if (request.name && (request.name === 'undefined' || request.name === 'packet_undefined')) {
            console.warn(`[SW] Invalid database name: ${request.name} for action: ${action}`);
            sendResponse({ success: false, error: 'Invalid database name: ' + request.name });
            return;
        }

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
            case 'RESET_STATE': {
                console.log('[SW] RESET_STATE received. Clearing databases and caches.');
                if (sqliteManager) {
                    await sqliteManager.wipe().catch(e => console.error('Failed to wipe:', e));
                }
                initialized = false;
                initializing = null; // IMPORTANT: Release the initialization lock
                sqliteManager = null;
                tabToUrlMapCached = {};
                isSessionVerified = false;
                sendResponse({ success: true });
                break;
            }
            case 'stopRecording':
            case 'stopMicRecording': {
                chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
                sendResponse({ success: true });
                break;
            }
            case 'startRecording': {
                await initiateTabCapture(request.streamId, request.tabId, !!request.video);
                sendResponse({ success: true });
                break;
            }
            case 'SET_PENDING_RECORDING': {
                pendingRecordingState = {
                    type: request.recordingType, // 'audio' or 'video'
                    timestamp: Date.now()
                };
                console.log('[SW] Pending recording state set:', pendingRecordingState);
                sendResponse({ success: true });
                break;
            }
            case 'PERMISSION_GRANTED': {
                console.log('[SW] PERMISSION_GRANTED received. Checking for pending recording...');
                // Store the tabId that granted the permission
                if (sender.tab) {
                    pendingRecordingState.permissionTabId = sender.tab.id;
                    console.log('[SW] Permission tab ID tracked:', pendingRecordingState.permissionTabId);
                }

                // Only honor if it happened within the last 5 minutes
                if (pendingRecordingState.type && (Date.now() - pendingRecordingState.timestamp < 300000)) {
                    const isVideo = pendingRecordingState.type === 'video';
                    console.log(`[SW] Resuming pending ${isVideo ? 'video' : 'audio'} recording...`);
                    
                    // Small delay to ensure the offscreen document is ready and the permission tab is still active
                    setTimeout(async () => {
                        try {
                            await ensureOffscreenDocument();
                            chrome.runtime.sendMessage({ type: 'START_MIC_RECORDING', video: isVideo });
                        } catch (err) {
                            console.error('[SW] Failed to resume recording:', err);
                        }
                    }, 500);
                }
                sendResponse({ success: true });
                break;
            }
            case 'RECORDING_STOPPED': {
                if (pendingRecordingState.permissionTabId) {
                    console.log('[SW] Recording stopped. Closing permission tab:', pendingRecordingState.permissionTabId);
                    chrome.tabs.remove(pendingRecordingState.permissionTabId).catch(() => {});
                    pendingRecordingState.permissionTabId = null;
                }
                sendResponse({ success: true });
                break;
            }
            case 'PROXY_KEY_DOWN': {
                // Find current group of the tab that sent the proxy key
                if (sender.tab && sender.tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
                    const direction = request.key === 'ArrowRight' ? 1 : -1;
                    await navigatePacketItems(sender.tab.groupId, direction, manager);
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
                const collections = manager.listCollections();
                sendResponse({ success: true, collections });
                break;
            }
            case 'createCollection': {
                await manager.initDatabase(request.name);
                await manager.saveCheckpoint(request.name, chrome.storage.local);
                sendResponse({ success: true });
                break;
            }
            case 'importFromBlob': {
                const importData = new Uint8Array(request.data).buffer;
                await manager.importFromBlob(request.name, importData);
                await manager.saveCheckpoint(request.name, chrome.storage.local);
                sendResponse({ success: true });
                break;
            }
            case 'exportToBlob': {
                const blob = await manager.exportToBlob(request.name);
                const arrayBuffer = await blob.arrayBuffer();
                sendResponse({ success: true, data: Array.from(new Uint8Array(arrayBuffer)) });
                break;
            }
            case 'saveCheckpoint': {
                await manager.saveCheckpoint(request.name, chrome.storage.local, request.prefix || 'db_');
                sendResponse({ success: true });
                break;
            }
            case 'restoreCheckpoint': {
                const restored = await manager.restoreCheckpoint(request.name, chrome.storage.local, request.prefix || 'db_');
                sendResponse({ success: true, restored });
                break;
            }
            case 'deleteCollection': {
                manager.closeDatabase(request.name);
                await chrome.storage.local.remove([`db_${request.name}`]);
                sendResponse({ success: true });
                break;
            }
            case 'executeSQL': {
                const db = manager.getDatabase(request.name);
                if (!db) {
                    sendResponse({ success: false, error: 'Database not found' });
                    break;
                }
                const result = await db.exec(request.sql, request.params || []);
                sendResponse({ success: true, result });
                break;
            }
            case 'exec': {
                try {
                    const { name, sql, bind } = request.payload || request;
                    const db = manager.getDatabase(name);
                    if (!db) {
                        sendResponse({ success: false, error: 'Database not found' });
                        break;
                    }
                    const result = await db.exec(sql, bind || []);
                    sendResponse({ success: true, result });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'query': {
                try {
                    const { name, sql, bind } = request.payload || request;
                    const db = manager.getDatabase(name);
                    if (!db) {
                        sendResponse({ success: false, error: 'Database not found' });
                        break;
                    }
                    const result = await db.query(sql, bind || []);
                    sendResponse({ success: true, result });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'getSchema': {
                if (!request.name) {
                    sendResponse({ success: false, error: 'Missing database name' });
                    break;
                }
                const schema = await manager.getSchema(request.name);
                sendResponse({ success: true, schema });
                break;
            }
            case 'getEntries': {
                const entries = await manager.getEntries(request.name, request.tableName);
                sendResponse({ success: true, entries });
                break;
            }
            case 'getEntry': {
                try {
                    const row = await manager.getEntry(request.name, request.tableName, request.rowId);
                    sendResponse({ success: true, row });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'setSchema': {
                await manager.applySchema(request.name, request.createSQL, chrome.storage.local, 'db_');
                sendResponse({ success: true });
                break;
            }
            case 'playPacket': {
                try {
                    const db = manager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');

                    const result = await db.query(`SELECT name, urls FROM packets WHERE rowid = ${request.id}`);
                    if (!result || !result.length) {
                        throw new Error('Packet not found');
                    }

                    const { name, urls: urlsJson } = result[0];
                    const items = safeParseUrls(urlsJson);

                    if (!items.length) {
                        sendResponse({ success: true, message: 'No items in packet' });
                        break;
                    }

                    const pages = items.filter(item => {
                        if (typeof item === 'string') return true;
                        const t = item.type || 'page';
                        return t === 'page' || t === 'link' || t === 'local';
                    }).map(item => getItemUrl(item, request.id));

                    if (pages.length === 0) {
                        sendResponse({ success: true, message: 'No pages found in packet.' });
                        break;
                    }

                    // Unified group lookup/enforcement
                    const targetGroupId = await getOrCreateGroupForPacket(request.id, null, null, manager);

                    if (targetGroupId !== null) {
                        // Focus the existing group if it has tabs
                        const tabsInGroup = await chrome.tabs.query({ groupId: targetGroupId });
                        if (tabsInGroup.length > 0) {
                            await chrome.tabs.update(tabsInGroup[0].id, { active: true });
                            sendResponse({ success: true, groupId: targetGroupId });
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
            case 'syncTabOrder': {
                await syncTabOrderForPacket(request.packetId, manager).catch(() => {});
                sendResponse({ success: true });
                break;
            }
            case 'ensurePacketDatabase': {
                try {
                    const packetId = request.packetId;
                    await ensurePacketDatabase(packetId, manager);
                    sendResponse({ success: true, dbName: `packet_${packetId}` });
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
                    const activeUrl = getMappedUrlSync(tab.id) || tab.url;
                    sendResponse({ success: true, tab: { id: tab.id, title: tab.title, url: activeUrl, groupId: tab.groupId } });
                }
                break;
            }
            case 'savePacket': {
                try {
                    const db = manager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');
                    const urlsJson = JSON.stringify(request.urls || []);
                    const escapedName = request.name.replace(/'/g, "''");
                    const escapedUrls = urlsJson.replace(/'/g, "''");

                    if (request.id !== undefined && request.id !== null) {
                        const id = parseInt(request.id, 10);
                        await db.exec(`UPDATE packets SET name = '${escapedName}', urls = '${escapedUrls}' WHERE rowid = ${id}`);
                        
                        // Sync tab order after saving reordered items
                        setTimeout(() => syncTabOrderForPacket(id, manager).catch(() => {}), 100);
                        
                        sendResponse({ success: true, id });
                    } else {
                        await db.exec(`INSERT INTO packets (name, urls) VALUES ('${escapedName}', '${escapedUrls}')`);
                        const result = await db.query("SELECT last_insert_rowid()");
                        const newId = result[0]['last_insert_rowid()'];
                        
                        // Sync tab order for new packet
                        setTimeout(() => syncTabOrderForPacket(newId, manager).catch(() => {}), 100);
                        
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
                    const db = manager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');
                    const id = parseInt(request.id, 10);
                    await db.exec(`DELETE FROM packets WHERE rowid = ${id}`);
                    sendResponse({ success: true });
                } catch (err) {
                    console.error('deletePacket error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'saveSchema': {
                try {
                    const db = manager.getDatabase('schemas');
                    if (!db) throw new Error('Schemas database not found');
                    const escapedName = request.name.replace(/'/g, "''");
                    const escapedSql = request.sql.replace(/'/g, "''");
                    await db.exec(`INSERT INTO schemas (name, sql) VALUES ('${escapedName}', '${escapedSql}')`);
                    sendResponse({ success: true });
                } catch (err) {
                    console.error('saveSchema error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'deleteSchema': {
                try {
                    const db = manager.getDatabase('schemas');
                    if (!db) throw new Error('Schemas database not found');
                    const id = parseInt(request.id, 10);
                    await db.exec(`DELETE FROM schemas WHERE rowid = ${id}`);
                    sendResponse({ success: true });
                } catch (err) {
                    console.error('deleteSchema error:', err);
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'listSchemas': {
                try {
                    const db = manager.getDatabase('schemas');
                    if (!db) throw new Error('Schemas database not found');
                    const rows = await db.query(`SELECT rowid, name, sql FROM schemas ORDER BY created DESC`);
                    sendResponse({ success: true, schemas: rows.map(row => ({ id: row.rowid, name: row.name, sql: row.sql })) });
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
                    const db = manager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');
                    const result = await db.query(`SELECT rowid, name, urls FROM packets WHERE rowid = ${packetId}`);
                    if (!result.length) { sendResponse({ success: true, packet: null }); break; }
                    const { rowid: id, name, urls: urlsJson } = result[0];
                    sendResponse({ success: true, packet: { id, name, urls: safeParseUrls(urlsJson) } });
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
            case 'UNLOCK_TAB_GROUPS':
                (async () => {
                    isSessionVerified = true;
                    try {
                        const { lockedGroupsRestoration = [] } = await chrome.storage.local.get('lockedGroupsRestoration');
                        if (lockedGroupsRestoration.length === 0) {
                            sendResponse({ success: true, message: 'No groups to restore' });
                            return;
                        }

                        console.log(`[Unlock] Restoring ${lockedGroupsRestoration.length} groups...`);
                        for (const groupData of lockedGroupsRestoration) {
                            const { packetId, urls } = groupData;
                            if (!urls || urls.length === 0) continue;

                            // Open the first tab to start the group
                            const firstTab = await chrome.tabs.create({ url: urls[0], active: false });
                            const groupId = await chrome.tabs.group({ tabIds: [firstTab.id] });
                            
                            // Add remaining tabs
                            for (let i = 1; i < urls.length; i++) {
                                await chrome.tabs.create({ url: urls[i], active: false }).then(tab => {
                                    return chrome.tabs.group({ tabIds: [tab.id], groupId });
                                });
                            }
                            
                            // Re-associate in activeGroups
                            const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                            activeGroups[groupId] = packetId;
                            await chrome.storage.local.set({ activeGroups });
                            
                            // Refresh title/color from DB
                            await getOrCreateGroupForPacket(packetId, null, groupId, manager);
                        }

                        await chrome.storage.local.remove('lockedGroupsRestoration');

                        // Perform deferred restoration of local pages and re-association of existing/restored groups
                        console.log('[Unlock] Performing deferred restoration...');
                        recoverLocalPages().catch(e => console.error('[Recovery] Failed:', e));
                        
                        const recover = () => reassociateTabGroups(manager).catch(e => console.error('[GroupRecovery] Failed:', e));
                        recover();
                        setTimeout(recover, 2000);

                        sendResponse({ success: true });
                    } catch (e) {
                        console.error('[Unlock] Restoration failed:', e);
                        sendResponse({ success: false, error: e.message });
                    }
                })();
                return true;
            case 'saveMediaBlob': {
                try {
                    let blob;
                    if (typeof request.data === 'string' && request.data.startsWith('data:')) {
                        // Handle DataURL
                        const resp = await fetch(request.data);
                        blob = await resp.blob();
                    } else {
                        // Handle binary (Uint8Array or serialized Object)
                        const data = request.data instanceof Uint8Array ? request.data : 
                                     (request.data?.buffer instanceof ArrayBuffer ? new Uint8Array(request.data.buffer) :
                                     (Array.isArray(request.data) ? new Uint8Array(request.data) :
                                     (request.data && typeof request.data === 'object' ? new Uint8Array(Object.values(request.data)) : request.data)));
                        blob = new Blob([data], { type: request.type });
                    }
                    
                    const id = request.id || await blobStorage.generateId(blob);
                    await blobStorage.put(id, blob);
                    console.log(`[SW] Saved media blob: ${id}, Size: ${blob.size}`);
                    sendResponse({ success: true, id, size: blob.size });
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
                        data: new Uint8Array(arrayBuffer),
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
                    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                    if (!tab || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
                        sendResponse({ success: true, packet: null }); break;
                    }
                    let { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
                    let packetId = activeGroups[tab.groupId];

                    // Lazy Recovery: If tab is in a group but we don't have a mapping, try to repair it
                    if (!packetId) {
                        console.log(`[GroupRecovery] Lazy recovery triggered for group ${tab.groupId}`);
                        await reassociateTabGroups(manager);
                        const updatedStore = await chrome.storage.local.get('activeGroups');
                        activeGroups = updatedStore.activeGroups || {};
                        packetId = activeGroups[tab.groupId];
                    }

                    if (!packetId) { sendResponse({ success: true, packet: null }); break; }
                    const db = manager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');
                    const result = await db.query(`SELECT rowid, name, urls FROM packets WHERE rowid = ${packetId}`);
                    if (!result.length) { sendResponse({ success: true, packet: null }); break; }
                    const { rowid: id, name, urls: urlsJson } = result[0];
                    sendResponse({
                        success: true,
                        packet: {
                            id,
                            name,
                            urls: safeParseUrls(urlsJson),
                            groupId: tab.groupId,
                            activeUrl: getMappedUrlSync(tab.id) || tab.url
                        }
                    });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
            }
            case 'getPacket': {
                try {
                    const db = manager.getDatabase('packets');
                    if (!db) throw new Error('Packets database not found');
                    const result = await db.query(`SELECT rowid, name, urls FROM packets WHERE rowid = ${request.id}`);
                    if (!result.length) {
                        sendResponse({ success: false, error: 'Packet not found' });
                        break;
                    }
                    const { rowid: id, name, urls: urlsJson } = result[0];
                    sendResponse({
                        success: true,
                        packet: { id, name, urls: safeParseUrls(urlsJson) }
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
                    const targetGroupId = await getOrCreateGroupForPacket(packetId, tabId, null, manager);
                    
                    if (targetGroupId) {
                        // Map the tab so we know it belongs to this packet even if URL is duplicate elsewhere
                        try {
                            const t = await chrome.tabs.get(tabId);
                            if (t && t.url) await setTabMapping(tabId, t.url, packetId);
                        } catch (e) { }
                        sendResponse({ success: true, groupId: targetGroupId });
                    } else {
                        throw new Error('Failed to join or create group');
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
                    
                    // Unified group lookup/enforcement
                    const targetGroupId = await getOrCreateGroupForPacket(packetId, null, groupId, manager);

                    if (targetGroupId !== null) {
                        // 1. Search existing tabs in group (fastest)
                        const allTabs = await chrome.tabs.query({});
                        
                        let existing = null;
                        for (const t of allTabs) {
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
                            // RELAXED MATCH: If it's a stack editor, reuse any open stack editor tab
                            if (turl && turl.includes('sidebar/stack.html') && url.includes('sidebar/stack.html')) {
                                existing = t;
                                break;
                            }
                        }

                        if (existing) {
                            // If it's already in a group but not this one, move it
                            if (existing.groupId !== targetGroupId) {
                                await chrome.tabs.group({ tabIds: [existing.id], groupId: targetGroupId });
                            }
                            
                            // Force update for stack editor to ensure the page reloads with new params
                            if (url.includes('sidebar/stack.html')) {
                                await chrome.tabs.update(existing.id, { url, active: true });
                                // Secondary signal if update doesn't trigger reload
                                chrome.tabs.sendMessage(existing.id, { action: 'RELOAD_STACK', url }).catch(() => {});
                            } else if (!urlsMatch(existing.url, url)) {
                                await chrome.tabs.update(existing.id, { url, active: true });
                            } else {
                                await chrome.tabs.update(existing.id, { active: true });
                            }
                            await setTabMapping(existing.id, url, packetId);
                        } else {
                            const newTab = await chrome.tabs.create({ url, active: true });
                            await chrome.tabs.group({ tabIds: [newTab.id], groupId: targetGroupId });
                            await setTabMapping(newTab.id, url, packetId);
                        }
                        sendResponse({ success: true, groupId: targetGroupId });
                    } else {
                        // This case should ideally not happen with getOrCreateGroupForPacket
                        const newTab = await chrome.tabs.create({ url, active: true });
                        const newGroupId = await getOrCreateGroupForPacket(packetId, newTab.id, null, manager);
                        await setTabMapping(newTab.id, url, packetId);
                        sendResponse({ success: true, newGroupId });
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
                    await syncTabOrderForPacket(packetId, manager);
                    sendResponse({ success: true });
                } catch (err) {
                    sendResponse({ success: false, error: err.message });
                }
                break;
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
            case 'START_AUDIO_RECORDING':
            case 'START_TAB_VIDEO_RECORDING': {
                const isVideo = action === 'START_TAB_VIDEO_RECORDING' || !!request.video;
                console.log(`[SW] ${action} received, streamId:`, request.streamId);
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

                    await initiateTabCapture(streamId, targetTabId, isVideo, request.region);
                    sendResponse({ success: true });
                } catch (e) {
                    console.error(`[SW] Failed to start ${isVideo ? 'video' : 'audio'} recording:`, e);
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
            case 'AUDIO_CLIP_FINISHED':
            case 'VIDEO_CLIP_FINISHED': {
                // No need to relay FINISHED messages; offscreen.js already broadcasts them.
                // However, we still want to close the offscreen document after completion.
                setTimeout(async () => {
                    const existingContexts = await chrome.runtime.getContexts({
                        contextTypes: ['OFFSCREEN_DOCUMENT']
                    });
                    if (existingContexts.length > 0) {
                        try {
                            await chrome.offscreen.closeDocument();
                            console.log('[SW] Offscreen document closed after capture finished');
                        } catch (e) {
                            console.warn('[SW] Error closing offscreen document:', e);
                        }
                    }
                }, 1000);
                break;
            }
            case 'RECORDING_STARTED':
            case 'RECORDING_ERROR': {
                // These are broadcasted by offscreen.js.
                break;
            }

            case 'TOGGLE_NETWORK': {
                try {
                    const enabled = request.enabled;
                    await chrome.storage.local.set({ networkEnabled: enabled });
                    await syncNetworkStatus();
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
    } catch (err) {
        // Suppress expected SQL errors from the global handler to reduce console noise
        const isExpectedSqlError = err.message && (err.message.includes('SQLITE_ERROR') && (err.message.includes('duplicate column') || err.message.includes('no such table')));
        
        if (!isExpectedSqlError) {
            console.error('[SW] Unhandled error in handleMessage:', err);
        } else {
            console.log('[SW] Handled expected SQL error:', err.message);
        }

        // Ensure sendResponse is only called once.
        try { sendResponse({ success: false, error: err.message || 'Internal background error' }); } catch (e) {}
    }
}

async function ensurePacketDatabase(packetId, manager) {
    if (!manager) manager = await initializeSQLite();
    if (!packetId) return null;
    const dbName = `packet_${packetId}`;
    await manager.initDatabase(dbName);
    const db = manager.getDatabase(dbName);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS associations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id TEXT,
            target_id TEXT,
            type TEXT,
            metadata TEXT,
            created TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS stacks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            mode TEXT DEFAULT 'manual',
            media_id TEXT,
            markers TEXT DEFAULT '[]',
            created TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS stack_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stack_id INTEGER,
            type TEXT,
            name TEXT,
            url TEXT,
            metadata TEXT,
            position INTEGER,
            FOREIGN KEY(stack_id) REFERENCES stacks(id) ON DELETE CASCADE
        );
    `);

    // Migration: ensure columns exist in existing stacks table
    try {
        const columns = await db.query("PRAGMA table_info(stacks)");
        if (columns && columns.length) {
            const columnNames = columns.map(c => c.name);
            if (!columnNames.includes('mode')) {
                await db.exec("ALTER TABLE stacks ADD COLUMN mode TEXT DEFAULT 'manual'");
            }
            if (!columnNames.includes('media_id')) {
                await db.exec("ALTER TABLE stacks ADD COLUMN media_id TEXT");
            }
            if (!columnNames.includes('markers')) {
                await db.exec("ALTER TABLE stacks ADD COLUMN markers TEXT DEFAULT '[]'");
            }
        }
    } catch (e) {
        console.error('[SW] Migration failed for stacks table:', e);
    }

    return db;
}

async function cleanupPlaybackTabs() {
    try {
        const { playbackTabIds = [] } = await chrome.storage.local.get('playbackTabIds');
        if (playbackTabIds.length === 0) return;

        console.log(`[Cleanup] Closing ${playbackTabIds.length} orphaned playback tabs...`);
        for (const tabId of playbackTabIds) {
            try {
                await chrome.tabs.remove(tabId);
                console.log(`[Cleanup] Closed playback tab: ${tabId}`);
            } catch (e) {
                // Tab likely already gone
            }
        }

        // Fresh start for playback tracking
        await chrome.storage.local.remove('playbackTabIds');
        if (tabToUrlMapCached) {
            tabToUrlMapCached.playbackTabIds = [];
        }
    } catch (e) {
        console.error('[Cleanup] Playback tab cleanup failed:', e);
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
        const db = manager.getDatabase('packets');
        if (!db) return;
        const result = await db.query(`SELECT rowid, name, urls FROM packets WHERE rowid = ${packetId}`);
        if (!result || !result.length) return;
        const { rowid: id, name, urls: urlsJson } = result[0];

        // Use mapping if available but prefer active tab URL if it matches any item in the packet
        const mappedUrl = getMappedUrlSync(tabId);
        const urls = safeParseUrls(urlsJson);
        const currentUrlMatches = urls.some(item => {
            const u = getItemUrl(item, packetId);
            return u && urlsMatch(u, tab.url);
        });

        const activeUrl = currentUrlMatches ? tab.url : (mappedUrl || tab.url);
        const packet = { id, name, urls, groupId, activeUrl };
        chrome.runtime.sendMessage({ type: 'packetFocused', packet }).catch(() => { });
    } catch (e) { }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    try {
        const { playbackTabIds = [] } = await chrome.storage.local.get('playbackTabIds');
        if (playbackTabIds.includes(tabId)) {
            const newList = playbackTabIds.filter(id => id !== tabId);
            await chrome.storage.local.set({ playbackTabIds: newList });
            // Also update cache if we decide to maintain it globally
            if (tabToUrlMapCached.playbackTabIds) {
                tabToUrlMapCached.playbackTabIds = newList;
            }
        }
    } catch (e) {}
    await removeTabMapping(tabId);
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
        const db = manager.getDatabase('packets');
                if (!db) return;
                const result = await db.query(`SELECT urls FROM packets WHERE rowid = ${packetId}`);
                if (!result || !result.length) return;
                const { urls: urlsJson } = result[0];
                const urls = safeParseUrls(urlsJson);

                // If new URL matches a packet item, update mapping
                const currentUrlMatches = urls.some(item => {
                    const u = getItemUrl(item, packetId);
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

// Sync back on tab move (Total Ordering)
chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
    try {
        const packetId = getMappedPacketIdSync(tabId);
        if (packetId) {
            const tab = await chrome.tabs.get(tabId);
            if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
                // If the user moved a tab, we should sync and potentially update sidebar order?
                // For now, let's just log and ensure consistency.
                console.log(`[SW] Tab ${tabId} moved in packet ${packetId}`);
            }
        }
    } catch (e) {}
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
            const isEditorOrPlayback = isStackEditorOrPlayback(tabId, tab.url);

            if (isEditorOrPlayback) {
                // Stack Editor & Playback HAVE NO BADGES
                await chrome.action.setBadgeText({ text: '', tabId });
            } else if (isReadyToClip && !isMedia) {
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
async function syncTabOrderForPacket(packetId, manager) {
    if (!manager) manager = await initializeSQLite();
    if (!packetId) return;

    try {
        console.log(`[SyncTabOrder] Starting for packet ${packetId}`);
        await initializeSQLite();
        const db = manager.getDatabase('packets');
        if (!db) return;

        const result = await db.query(`SELECT urls FROM packets WHERE rowid = ${packetId}`);
        if (!result.length) return;

        const urls = safeParseUrls(result[0].urls);
        
        // Categorize items into sections: Stacks, Pages, and Media (Total Ordering)
        const totalUrls = [];

        const addUrl = (url) => {
            if (url) {
                totalUrls.push(url);
            }
        };

        // 1. Process Stacks (Top section)
        const stacksItems = urls.filter(item => (typeof item === 'object' && item.type === 'stack'));
        for (const stack of stacksItems) {
            addUrl(getItemUrl(stack, packetId));
        }

        // 2. Process Pages
        const pagesItems = urls.filter(item => {
            const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
            return type === 'page' || type === 'link' || type === 'local';
        });
        pagesItems.forEach(p => addUrl(getItemUrl(p, packetId)));

        // 3. Process Media
        const mediaItems = urls.filter(item => (typeof item === 'object' && item.type === 'media'));
        mediaItems.forEach(m => addUrl(getItemUrl(m, packetId)));

        const packetUrls = totalUrls;

        console.log(`[SyncTabOrder] Packet has ${packetUrls.length} total URLs in sequence`);

        // Find the group mapped to this packet
        const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
        let targetGroupId = null;
        let tabs = [];
        
        // Loop through all mappings to find a LIVE group for this packet
        for (const [gid, pid] of Object.entries(activeGroups)) {
            if (String(pid) === String(packetId)) {
                const candidateGroupId = parseInt(gid);
                try {
                    const candidateTabs = await chrome.tabs.query({ groupId: candidateGroupId });
                    if (candidateTabs.length > 0) {
                        targetGroupId = candidateGroupId;
                        tabs = candidateTabs;
                        break; 
                    }
                } catch (e) { }
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
        const usedTabIds = new Set();

        for (let i = 0; i < packetUrls.length; i++) {
            const targetUrl = packetUrls[i];
            
            // Robust match: Check EVERY tab in the window, even if it's currently outside the group
            const matchingTab = allTabsInWindow.find(t => {
                if (usedTabIds.has(t.id)) return false;

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
                usedTabIds.add(matchingTab.id);
                
                // 1. Explicitly ensure it's in the group
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
            }
        }
        console.log(`[SyncTabOrder] Success. Moved ${moveCount} tabs. Total matching tabs: ${contiguousOffset}`);
    } catch (e) {
        console.error('[SyncTabOrder] Error:', e);
    }
}

/**
 * Ensures a 1:1 mapping between a packet and a tab group.
 * Finds existing group, cleans up duplicates, or creates new if needed.
 */
async function getOrCreateGroupForPacket(packetId, tabIdToJoin, hintGroupId, manager) {
    if (!manager) manager = await initializeSQLite();
    if (!packetId) return null;

    let { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
    const groups = await chrome.tabGroups.query({});
    
    // Find all groups currently mapped to this packetId
    let matchingGroups = groups.filter(g => String(activeGroups[g.id]) === String(packetId));
    
    // Check if hintGroupId is actually mapped to this packet
    if (hintGroupId && !matchingGroups.some(g => g.id === hintGroupId)) {
        if (String(activeGroups[hintGroupId]) === String(packetId)) {
            try {
                const hint = await chrome.tabGroups.get(hintGroupId);
                matchingGroups.push(hint);
            } catch (e) { }
        }
    }

    let targetGroupId = null;
    if (matchingGroups.length > 0) {
        // Preference:
        // 1. Group in current window
        // 2. The hint group (if valid)
        // 3. Any existing group
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentWindowId = activeTab?.windowId;
        
        const inWindow = matchingGroups.find(g => g.windowId === currentWindowId);
        const hinted = hintGroupId ? matchingGroups.find(g => g.id === hintGroupId) : null;
        
        targetGroupId = (inWindow || hinted || matchingGroups[0]).id;

        // Cleanup: If multiple groups exist for same packet, merge or unmap
        for (const g of matchingGroups) {
            if (g.id !== targetGroupId) {
                console.log(`[SW] Cleaning up redundant group ${g.id} for packet ${packetId}`);
                // Move tabs to target if in the same window, otherwise just orphans
                if (g.windowId === (inWindow || hinted || matchingGroups[0]).windowId) {
                    try {
                        const tabsToMove = await chrome.tabs.query({ groupId: g.id });
                        if (tabsToMove.length > 0) {
                            await chrome.tabs.group({ tabIds: tabsToMove.map(t => t.id), groupId: targetGroupId });
                        }
                    } catch (e) { }
                }
                delete activeGroups[g.id];
            }
        }
    }

    if (targetGroupId) {
        if (tabIdToJoin) {
            await chrome.tabs.group({ tabIds: [tabIdToJoin], groupId: targetGroupId });
        }
    } else {
        // Create new group ONLY if we have a tab to start it with.
        // This prevents "swallowing" an unrelated active tab just because the user viewed a packet.
        if (tabIdToJoin) {
            targetGroupId = await chrome.tabs.group({ tabIds: [tabIdToJoin] });
        } else {
            // Passive case: No group exists and no tab provided to start one. 
            // Just return null so we don't force a group on the user.
            await chrome.storage.local.set({ activeGroups });
            return null;
        }

        if (targetGroupId) {
            let packetName = 'Packet';
            try {
                const db = manager.getDatabase('packets');
                if (db) {
                    const result = await db.query(`SELECT name FROM packets WHERE rowid = ${packetId}`);
                    if (result.length) packetName = result[0].name;
                }
            } catch (e) { }

            const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
            const availableColors = colors.filter(c => !groups.some(g => g.color === c));
            const pool = availableColors.length > 0 ? availableColors : colors;
            const randomColor = pool[Math.floor(Math.random() * pool.length)];
            await chrome.tabGroups.update(targetGroupId, { title: packetName, color: randomColor });
            activeGroups[targetGroupId] = packetId;
        }
    }

    // Final purge of any other mappings for this packetId to enforce 1:1
    for (const [gid, pid] of Object.entries(activeGroups)) {
        if (String(pid) === String(packetId) && parseInt(gid) !== targetGroupId) {
            delete activeGroups[gid];
        }
    }

    await chrome.storage.local.set({ activeGroups });
    return targetGroupId;
}

/**
 * Re-associates browser tab groups with logical packets after a restart.
 * Uses title matching and URL validation to ensure strong association.
 */
async function reassociateTabGroups(manager) {
    if (!manager) manager = await initializeSQLite();
    const db = manager.getDatabase('packets');
    try {
        console.log('[GroupRecovery] Starting re-association check...');
        const { activeGroups = {} } = await chrome.storage.local.get('activeGroups');
        const groups = await chrome.tabGroups.query({});
        
        if (groups.length === 0) {
            console.log('[GroupRecovery] No tab groups found in browser.');
            return;
        }

        await initializeSQLite();
        const db = manager.getDatabase('packets');
        if (!db) return;

        const result = await db.query(`SELECT rowid, name, urls FROM packets`);
        const allPackets = result.map(row => ({
            id: row.rowid,
            name: row.name,
            urls: safeParseUrls(row.urls)
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
            // 1. If title match failed or yielded multiple, use URL validation
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
                    const db = manager.getDatabase('packets');
                    const res = await db.query(`SELECT rowid, name, urls FROM packets WHERE rowid = ${packetId}`);
                    if (res.length) {
                        const { rowid: id, name, urls: urlsJson } = res[0];
                        chrome.runtime.sendMessage({ 
                            type: 'packetFocused', 
                            packet: { id, name, urls: safeParseUrls(urlsJson), groupId: activeTab.groupId, activeUrl: activeTab.url } 
                        }).catch(() => {});
                    }
                }
            }
        }
    } catch (e) {
        console.error('[GroupRecovery] Error:', e);
    }
}

/**
 * Checks if biometrics are enabled and locks tab groups if not yet verified for this session.
 */
async function performStartupLock() {
    try {
        const { webAuthnEnabled = false, activeGroups = {} } = await chrome.storage.local.get(['webAuthnEnabled', 'activeGroups']);
        
        if (!webAuthnEnabled || isSessionVerified) {
            console.log('[StartupLock] Skipping: webAuthnEnabled=', webAuthnEnabled, 'isSessionVerified=', isSessionVerified);
            return;
        }

        const gids = Object.keys(activeGroups);
        if (gids.length === 0) {
            console.log('[StartupLock] No active groups to lock.');
            return;
        }

        console.log(`[StartupLock] Locking ${gids.length} groups...`);
        const restorationData = [];

        for (const gid of gids) {
            const groupId = parseInt(gid);
            const packetId = activeGroups[gid];
            
            try {
                const tabs = await chrome.tabs.query({ groupId });
                if (tabs.length > 0) {
                    restorationData.push({
                        packetId,
                        urls: tabs.map(t => t.url || t.pendingUrl).filter(Boolean)
                    });
                    
                    // Close all tabs in the group
                    const tabIds = tabs.map(t => t.id);
                    await chrome.tabs.remove(tabIds);
                }
            } catch (e) {
                console.warn(`[StartupLock] Failed to lock group ${gid}:`, e);
            }
        }

        // Save restoration data and clear activeGroups
        await chrome.storage.local.set({ 
            lockedGroupsRestoration: restorationData,
            activeGroups: {} // Wipe active groups so they don't show up in sidebar until restored
        });

        console.log(`[StartupLock] Successfully locked and saved ${restorationData.length} groups.`);
    } catch (e) {
        console.error('[StartupLock] Error during locking:', e);
    }
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
                            // NOTE: Async within sync host call is problematic without JSPI.
                            // We trigger the execute and return success for now.
                            (async () => {
                                try {
                                    const db = manager.getDatabase(dbName) || await manager.initDatabase(dbName);
                                    await db.exec(sql);
                                } catch (e) { console.error('[WASM-Host] execute failed:', e); }
                            })();
                            const resultPtr = runtime.alloc(12, 4);
                            const view = runtime.getView();
                            view.setUint32(resultPtr, 0, true);
                            view.setUint32(resultPtr + 4, 0, true); // Changes unknown
                            return resultPtr;
                        },
                        "query": (dbNamePtr, dbNameLen, sqlPtr, sqlLen) => {
                            // Query is unfortunately impossible to do synchronously with worker-based SQLite
                            // Return an empty result as a fallback
                            const resultPtr = runtime.alloc(20, 4);
                            const view = runtime.getView();
                            view.setUint32(resultPtr, 1, true); // Error
                            const errStr = runtime.writeString("Synchronous query not supported with Worker SQLite. Use JSPI.");
                            view.setUint32(resultPtr + 4, errStr.ptr, true);
                            view.setUint32(resultPtr + 8, errStr.len, true);
                            return resultPtr;
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

(async () => {
    const params = new URLSearchParams(window.location.search);
    const stackId = params.get('id');
    const packetId = params.get('packetId');
    const name = params.get('name') || 'Stack';

    const canvas = document.getElementById('stack-canvas');
    const itemsContainer = document.getElementById('stack-items-container');
    const stackTitle = document.getElementById('stack-title');
    const loading = document.getElementById('loading');
    const flowSvg = document.getElementById('flow-svg');
    const dropZone = document.getElementById('drop-zone');
    const playBtn = document.getElementById('play-btn');
    const shareBtn = document.getElementById('share-btn');

    function showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 12px;
            background: ${type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : '#3b82f6')};
            color: white;
            font-size: 14px;
            font-weight: 600;
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
            z-index: 9999;
            animation: slideIn 0.3s ease-out;
        `;
        notification.textContent = message;
        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease-in forwards';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }


    // Driver Settings Elements
    const driverModeBadge = document.getElementById('driver-mode-badge');
    const bindingZone = document.getElementById('binding-zone');
    const bindingPrompt = document.getElementById('binding-prompt');
    const timelineArea = document.getElementById('timeline-area');
    const timelineTrack = document.getElementById('timeline-track');

    const durationLabel = document.getElementById('duration-label');
    const clearMarkersBtn = document.getElementById('clear-markers-btn');

    if (clearMarkersBtn) {
        clearMarkersBtn.onclick = () => {
            if (stackMarkers.length === 0) return;
            if (confirm('Clear all advancement markers?')) {
                stackMarkers = [];
                renderMarkers();
                saveStackDriverMetadata();
            }
        };
    }


    let stackMode = 'manual';
    let stackMediaId = null;
    let stackMarkers = [];
    let mediaDuration = 0;
    let mediaMetadata = null;
    let boundMediaItem = null;



    if (!stackId || !packetId) {
        loading.innerHTML = '<div class="error">Missing stack ID or packet ID.</div>';
        return;
    }

    const dbName = `packet_${packetId}`;
    let items = [];
    let currentActiveUrl = null;
    let pipWindow = null;
    let contentTabId = null;
    let currentSlideIndex = 0;
    let isPageLoading = false;
    let loadInterval = null;
    let loadProgress = 0;
    let isNetworkOffline = false;

    // Listen for theme and offline state changes
    chrome.storage.local.get(['isNetworkOffline', 'theme'], (data) => {
        isNetworkOffline = !!data.isNetworkOffline;
        if (pipWindow) updatePipStatus();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
            if (changes.isNetworkOffline) {
                isNetworkOffline = !!changes.isNetworkOffline.newValue;
                if (pipWindow) updatePipStatus();
                renderStructure(); // Re-render to grey out/restore slides
            }
            if (changes.theme) {
                const theme = changes.theme.newValue;
                let shouldBeDark = theme === 'dark';
                if (theme === 'system') {
                    shouldBeDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                }

                if (pipWindow) {
                    if (shouldBeDark) {
                        pipWindow.document.body.classList.add('dark-mode');
                    } else {
                        pipWindow.document.body.classList.remove('dark-mode');
                    }
                }
            }
        }
    });

    // Handle closing of content tab or editor window
    chrome.tabs.onRemoved.addListener((tabId) => {
        if (tabId === contentTabId) {
            console.log('[Stack] Content tab closed, closing PiP');
            if (pipWindow) {
                // Remove beforeunload to avoid double close if it was trigger by a window unload
                // however here we are reacting to a tab removal from another window.
                pipWindow.close();
                pipWindow = null;
            }
            contentTabId = null;
        }
    });

    window.addEventListener('beforeunload', () => {
        if (pipWindow) {
            console.log('[Stack] Editor window closing, closing PiP');
            pipWindow.close();
            pipWindow = null;
        }
    });

    const ICONS = {
        play: `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>`,
        restart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
        next: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`,
        finish: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M20 6L9 17l-5-5"/></svg>`,
        fullscreen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`,
        trueFullscreen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><path d="M12 17v4M8 21h8"/></svg>`
    };

    function normalizeSqlResults(resp) {
        if (!resp || !resp.success || !resp.result) return [];
        const res = resp.result;
        if (!Array.isArray(res) || res.length === 0) return [];

        // Legacy format: [{columns: [...], values: [[...], [...]]}]
        if (res[0] && Array.isArray(res[0].columns) && Array.isArray(res[0].values)) {
            const cols = res[0].columns;
            return res[0].values.map(v => {
                const row = {};
                cols.forEach((c, i) => row[c] = v[i]);
                return row;
            });
        }

        // Modern format: [row1, row2, ...]
        return res;
    }

    async function loadStack() {
        try {
            await chrome.runtime.sendMessage({ action: 'ensurePacketDatabase', packetId });

            // Get stack data
            try {
                const stackResp = await chrome.runtime.sendMessage({
                    action: 'executeSQL',
                    name: dbName,
                    sql: `SELECT name, mode, media_id, markers FROM stacks WHERE id = ${stackId}`
                });
                const stackRows = normalizeSqlResults(stackResp);
                if (stackRows.length > 0) {
                    const row = stackRows[0];
                    stackTitle.textContent = row.name;
                    stackMode = row.mode || 'manual';
                    stackMediaId = row.media_id;
                    try {
                        stackMarkers = JSON.parse(row.markers || '[]');
                    } catch (e) { stackMarkers = []; }
                } else {
                    stackTitle.textContent = name;
                }
            } catch (e) {
                stackTitle.textContent = name;
            }

            // Get items
            const itemsResp = await chrome.runtime.sendMessage({
                action: 'executeSQL',
                name: dbName,
                sql: `SELECT * FROM stack_items WHERE stack_id = ${stackId} ORDER BY position ASC`
            });

            console.log('[Stack] Items Query Resp:', itemsResp);
            const itemRows = normalizeSqlResults(itemsResp);
            items = itemRows.map(item => {
                try {
                    if (item.metadata && typeof item.metadata === 'string') {
                        item.metadata = JSON.parse(item.metadata);
                    }
                } catch (e) { }
                return item;
            });
            console.log('[Stack] Loaded items:', items.length);

                // Identify bound media from the packet's resources (not stack items, but packet media)
                await loadBoundMediaInfo();
                updateModeUI();
                renderStructure();

                // Request current tab status to set initial highlight
                const tabResp = await chrome.runtime.sendMessage({ action: 'getCurrentTab' });
                if (tabResp.success && tabResp.tab) {
                    updateActiveHighlight(tabResp.tab.url);
                }
        } catch (err) {
            console.error('Failed to load stack:', err);
        } finally {
            loading.classList.add('hidden');
        }
    }

    function getIcon(type) {
        switch (type) {
            case 'page': return '📄';
            case 'media': return '🖼️';
            case 'wasm': return '🧩';
            case 'stack': return '📚';
            case 'link': return '🔗';
            case 'local': return '✨';
            default: return '📦';
        }
    }

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

    function isOnlineRequired(item) {
        if (!item) return false;
        const type = (typeof item === 'object') ? (item.type || 'page') : 'page';
        // Pages and Links require internet (unless we add a more granular check for local files later)
        // Media (internally hosted), Local, and WASM are offline-capable.
        return type === 'page' || type === 'link';
    }

    async function startPlayback(index = 0) {
        if (items.length === 0) return;
        const targetIndex = Math.max(0, Math.min(index, items.length - 1));
        const item = items[targetIndex];

        // Block navigation to online items if offline
        const isBlocked = isNetworkOffline && isOnlineRequired(item);

        if (isBlocked) {
            console.warn('Navigation blocked: Offline and item requires online access');
            if (pipWindow) {
                updatePipStatus();
            }
        } else {
            currentSlideIndex = targetIndex;
            const url = getItemUrl(item);

            if (!url) {
                console.error('No URL for item at index', currentSlideIndex);
                return;
            }

            isPageLoading = true;
            loadProgress = 0;
            updateProgressBar();
            startLoadSimulation();

            try {
                // 1. Manage content window
                if (contentTabId) {
                    try {
                        await chrome.tabs.update(contentTabId, { url, active: true });
                        // Removed: auto-fullscreen enforcement
                    } catch (e) {
                        contentTabId = null; // Tab probably closed
                    }
                }

                if (!contentTabId) {
                    const win = await chrome.windows.create({
                        url,
                        type: 'normal',
                        state: 'maximized'
                    });
                    contentTabId = win.tabs[0].id;

                    // Register this tab for playback tracking (clears badges, enables toggle)
                    const { playbackTabIds = [] } = await chrome.storage.local.get('playbackTabIds');
                    if (!playbackTabIds.includes(contentTabId)) {
                        playbackTabIds.push(contentTabId);
                        await chrome.storage.local.set({ playbackTabIds });
                    }
                }

                // 1.5 Inject keyboard listener
                if (contentTabId) {
                    injectKeyboardListener(contentTabId);
                }
            } catch (err) {
                console.error('Playback failed:', err);
            }
        }

        try {
            // Manage PiP controller - always ensure it's open if playback is "started"
            if (!pipWindow) {
                await openPipController();
            } else {
                updatePipStatus();
            }
        } catch (err) {
            console.error('PiP management failed:', err);
        }
    }

    async function openPipController() {
        if (!('documentPictureInPicture' in window)) {
            console.warn('PiP not supported');
            return;
        }

        try {
            let width = 340;
            let height = 180;

            if (stackMode === 'media' && boundMediaItem) {
                if ((boundMediaItem.mimeType || '').startsWith('video')) {
                    width = 480;
                    height = 520;
                } else {
                    width = 340;
                    height = 320;
                }
            } else {
                width = 320;
                height = 240;
            }

            pipWindow = await window.documentPictureInPicture.requestWindow({
                width,
                height,
            });

            // Copy style sheets
            [...document.styleSheets].forEach((styleSheet) => {
                try {
                    const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
                    const style = document.createElement('style');
                    style.textContent = cssRules;
                    pipWindow.document.head.appendChild(style);
                } catch (e) {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = styleSheet.href;
                    pipWindow.document.head.appendChild(link);
                }
            });

            pipWindow.document.body.style.cssText = `
                background: var(--bg);
                color: var(--text);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 0;
                margin: 0;
                height: 100vh;
                width: 100vw;
                overflow: hidden;
                user-select: none;
            `;

            // Initial theme sync for PiP
            chrome.storage.local.get(['theme'], (result) => {
                const theme = result.theme || 'system';
                let isDark = theme === 'dark';
                if (theme === 'system') {
                    isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                }
                if (isDark) {
                    pipWindow.document.body.classList.add('dark-mode');
                } else {
                    pipWindow.document.body.classList.remove('dark-mode');
                }
            });

            // Inject additional premium styles
            const globalStyle = pipWindow.document.createElement('style');
            globalStyle.textContent = `
                .pip-header {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 100%;
                    position: relative;
                    margin-bottom: 12px;
                    height: 24px;
                }
                .network-indicator {
                    position: absolute;
                    left: 0;
                    top: 50%;
                    transform: translateY(-50%);
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: var(--success);
                    box-shadow: 0 0 8px var(--success);
                    transition: all 0.3s ease;
                }
                .network-indicator.offline {
                    background: var(--danger);
                    box-shadow: 0 0 8px var(--danger);
                }
                .pip-controls {
                    display: flex;
                    gap: 20px;
                    justify-content: center;
                    align-items: center;
                    margin: 16px 0;
                }
                .play-btn, .restart-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                    cursor: pointer;
                }
                .fullscreen-btn, .true-fs-btn {
                    background: transparent;
                    color: var(--text-secondary);
                    border: none;
                    padding: 4px;
                    border-radius: 4px;
                    cursor: pointer;
                    opacity: 0.6;
                    transition: all 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .fullscreen-btn:hover, .true-fs-btn:hover {
                    opacity: 1;
                    background: var(--border);
                    color: var(--text);
                }
                .play-btn:disabled, .fullscreen-btn:disabled, .true-fs-btn:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                    filter: grayscale(1);
                }
                .play-btn svg, .restart-btn svg {
                    flex-shrink: 0;
                }
                .pip-counter {
                    font-family: "JetBrains Mono", monospace;
                    font-size: 11px;
                    letter-spacing: 0.1em;
                    opacity: 0.6;
                    text-transform: uppercase;
                    margin-bottom: 12px;
                }
                .progress-container {
                    width: calc(100% - 24px);
                    height: 8px;
                    background: var(--border);
                    border-radius: 4px;
                    overflow: hidden;
                    margin-top: 16px;
                    position: relative;
                    margin-left: 12px;
                }
                .progress-bar {
                    position: absolute;
                    bottom: 0;
                    left: 0;
                    height: 4px;
                    background: var(--success);
                    transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1), background 0.3s;
                    z-index: 1000;
                }
                #pip-progress-bar.media-mode {
                    background: var(--success); /* Always green for slides */
                }
                #pip-media-progress-container {
                    padding: 8px 12px 0 12px;
                    width: calc(100% - 24px);
                    display: none;
                }
                #pip-media-progress-container.visible {
                    display: block;
                }
                .media-group {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    width: 100%;
                    align-items: center;
                }
                #pip-spectrum-canvas {
                    width: 100%;
                    height: 20px;
                    opacity: 0.8;
                }
                #pip-media-wrapper {
                    width: 100%;
                    border-radius: 8px;
                    overflow: hidden;
                    background: black;
                    display: none;
                    aspect-ratio: 16/9;
                    margin-bottom: 8px;
                }
                #pip-media-wrapper video {
                    width: 100%;
                    height: 100%;
                    display: block;
                }
                .media-progress-background {
                    height: 3px;
                    background: rgba(255,255,255,0.1);
                    border-radius: 1.5px;
                    overflow: hidden;
                    width: 100%;
                }
                #pip-media-progress-bar {
                    height: 100%;
                    width: 0%;
                    background: var(--danger);
                    box-shadow: 0 0 8px rgba(239, 68, 68, 0.3);
                    transition: width 0.2s linear;
                }


                @keyframes pulse-green {
                    0% { transform: scale(1); color: var(--text-secondary); }
                    50% { transform: scale(1.1); color: var(--success); }
                    100% { transform: scale(1); color: var(--text-secondary); }
                }

                .pulse {
                    animation: pulse-green 0.8s ease-out;
                }
                .progress-bar.loading {
                    background: var(--primary);
                    animation: shimmer 1.5s infinite linear;
                    background-image: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.4) 50%, rgba(255,255,255,0) 100%);
                    background-size: 200% 100%;
                }
                @keyframes shimmer {
                    from { background-position: 200% 0; }
                    to { background-position: -200% 0; }
                }
            `;
            pipWindow.document.head.appendChild(globalStyle);

            renderPipContent();

            // Set up driver logic if in media mode
            if (stackMode === 'media' && stackMediaId) {
                setupMediaDriver();
            }

            pipWindow.document.body.addEventListener('click', async (e) => {

                // Ignore if clicking a button
                if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;

                if (contentTabId) {
                    try {
                        const tab = await chrome.tabs.get(contentTabId);
                        await chrome.windows.update(tab.windowId, { focused: true });
                    } catch (err) {
                        console.error('Focus failed:', err);
                    }
                }
            });

            pipWindow.addEventListener('pagehide', () => {
                if (contentTabId) {
                    try {
                        chrome.tabs.remove(contentTabId);
                    } catch (e) { }
                    contentTabId = null;
                }
                pipWindow = null;
            });
        } catch (e) {
            console.error('Failed to open PiP:', e);
        }
    }

    function renderPipContent() {
        if (!pipWindow) return;
        pipWindow.document.body.innerHTML = '';

        const container = pipWindow.document.createElement('div');
        container.style.cssText = 'text-align: center; width: 100%; padding: 0 24px; box-sizing: border-box; position: relative;';

        const header = pipWindow.document.createElement('div');
        header.className = 'pip-header';

        const title = pipWindow.document.createElement('div');
        title.id = 'pip-title';
        title.style.cssText = 'font-size: 10px; font-weight: 800; text-transform: uppercase; color: var(--text-secondary); letter-spacing: 0.1em; opacity: 0.8;';
        header.appendChild(title);

        const networkStatus = pipWindow.document.createElement('div');
        networkStatus.id = 'pip-network-indicator';
        networkStatus.className = 'network-indicator';
        header.appendChild(networkStatus);

        const btnGroup = pipWindow.document.createElement('div');
        btnGroup.style.cssText = 'position: absolute; right: 0; top: 0; display: flex; gap: 4px;';

        const trueFsBtn = pipWindow.document.createElement('button');
        trueFsBtn.id = 'pip-true-fs-btn';
        trueFsBtn.className = 'true-fs-btn';
        trueFsBtn.title = 'True Fullscreen (OS Space)';
        trueFsBtn.innerHTML = ICONS.trueFullscreen;
        trueFsBtn.addEventListener('click', toggleTrueFullscreen);
        btnGroup.appendChild(trueFsBtn);

        const fsBtn = pipWindow.document.createElement('button');
        fsBtn.id = 'pip-fs-btn';
        fsBtn.className = 'fullscreen-btn';
        fsBtn.title = 'Maximize (Stay in Space)';
        fsBtn.innerHTML = ICONS.fullscreen;
        fsBtn.addEventListener('click', toggleMaximized);
        btnGroup.appendChild(fsBtn);

        header.appendChild(btnGroup);
        container.appendChild(header);

        const controls = pipWindow.document.createElement('div');
        controls.className = 'pip-controls';

        const restartBtnPip = pipWindow.document.createElement('button');
        restartBtnPip.innerHTML = `${ICONS.restart} Restart`;
        restartBtnPip.className = 'restart-btn';
        restartBtnPip.addEventListener('click', restartPlayback);
        controls.appendChild(restartBtnPip);

        const nextBtn = pipWindow.document.createElement('button');
        nextBtn.id = 'pip-next-btn';
        nextBtn.innerHTML = `Next ${ICONS.next}`;
        nextBtn.className = 'play-btn';
        // nextBtn.addEventListener('click', advanceSlide); // REMOVED: Managed by updatePipStatus
        controls.appendChild(nextBtn);

        container.appendChild(controls);

        const counter = pipWindow.document.createElement('div');
        counter.id = 'pip-counter';
        counter.className = 'pip-counter';
        container.appendChild(counter);

        // Media Progress & Spectrum Group
        const mediaProgressContainer = pipWindow.document.createElement('div');
        mediaProgressContainer.id = 'pip-media-progress-container';
        mediaProgressContainer.className = 'pip-media-progress-container';

        const mediaGroup = pipWindow.document.createElement('div');
        mediaGroup.className = 'media-group';

        const spectrumCanvas = pipWindow.document.createElement('canvas');
        spectrumCanvas.id = 'pip-spectrum-canvas';
        spectrumCanvas.width = 300; // Internal resolution
        spectrumCanvas.height = 40;
        mediaGroup.appendChild(spectrumCanvas);

        const mediaProgressBg = pipWindow.document.createElement('div');
        mediaProgressBg.className = 'media-progress-background';

        const mediaProgressBar = pipWindow.document.createElement('div');
        mediaProgressBar.id = 'pip-media-progress-bar';
        mediaProgressBg.appendChild(mediaProgressBar);
        mediaGroup.appendChild(mediaProgressBg);

        mediaProgressContainer.appendChild(mediaGroup);
        container.appendChild(mediaProgressContainer);


        if (stackMode === 'media' && stackMediaId) {
            const mediaWrapper = pipWindow.document.createElement('div');
            mediaWrapper.id = 'pip-media-wrapper';
            container.appendChild(mediaWrapper);
        }


        const progressContainer = pipWindow.document.createElement('div');
        progressContainer.className = 'progress-container';
        const progressBar = pipWindow.document.createElement('div');
        progressBar.id = 'pip-progress-bar';
        progressBar.className = 'progress-bar';
        progressContainer.appendChild(progressBar);
        container.appendChild(progressContainer);

        pipWindow.document.body.appendChild(container);
        updatePipStatus();
    }

    function updatePipStatus() {
        if (!pipWindow) return;
        const title = pipWindow.document.getElementById('pip-title');
        const counter = pipWindow.document.getElementById('pip-counter');
        const nextBtn = pipWindow.document.getElementById('pip-next-btn');
        const fsBtn = pipWindow.document.getElementById('pip-fs-btn');
        const trueFsBtn = pipWindow.document.getElementById('pip-true-fs-btn');
        const netInd = pipWindow.document.getElementById('pip-network-indicator');

        if (title) title.textContent = stackTitle.textContent;

        if (netInd) {
            if (isNetworkOffline) {
                netInd.classList.add('offline');
                netInd.title = 'Offline - Web slides unavailable';
            } else {
                netInd.classList.remove('offline');
                netInd.title = 'Online';
            }
        }

        if (counter) {
            if (isPageLoading) {
                counter.textContent = 'Loading Page...';
                counter.style.color = 'var(--primary)';
                counter.style.opacity = '1';
            } else {
                counter.textContent = `Slide ${currentSlideIndex + 1} of ${items.length}`;
                counter.style.color = 'var(--text-secondary)';
                counter.style.opacity = '0.6';
            }
        }

        if (fsBtn) {
            fsBtn.disabled = isPageLoading;
        }

        if (trueFsBtn) {
            trueFsBtn.disabled = isPageLoading;
        }

        if (nextBtn) {
            const isLastSlide = currentSlideIndex === items.length - 1;
            const nextItem = items[currentSlideIndex + 1];
            const nextRequiresOnline = isOnlineRequired(nextItem);

            const isBlocked = isNetworkOffline && nextRequiresOnline && !isLastSlide;

            nextBtn.disabled = isPageLoading || isBlocked;

            let showFinish = isLastSlide;
            if (stackMode === 'media' && pipWindow) {
                const mediaEl = pipWindow.document.getElementById('pip-media-driver');
                if (mediaEl) {
                    // Show finish if media is complete (at the end)
                    showFinish = mediaEl.currentTime >= mediaEl.duration - 0.2 || mediaEl.ended;
                }
            }

            if (showFinish) {
                nextBtn.innerHTML = `Finish ${ICONS.finish}`;
                nextBtn.onclick = async () => {
                    if (contentTabId) {
                        try {
                            await chrome.tabs.remove(contentTabId);
                        } catch (e) { }
                        contentTabId = null;
                    }
                    if (pipWindow) {
                        pipWindow.close();
                        pipWindow = null;
                    }
                };
            } else {
                const label = (stackMode === 'media') ? 'Skip' : 'Next';
                nextBtn.innerHTML = `${label} ${ICONS.next}`;
                nextBtn.onclick = advanceSlide;
            }
        }

        // Hide/Show media progress
        const mediaContainer = pipWindow.document.getElementById('pip-media-progress-container');
        if (mediaContainer) {
            mediaContainer.classList.toggle('visible', stackMode === 'media' && !!stackMediaId);
        }

        // Call resizePip based on state
        if (stackMode === 'manual') {
            resizePip('manual');
        } else if (boundMediaItem) {
            const isVideo = (boundMediaItem.mimeType || '').startsWith('video');
            resizePip(isVideo ? 'video' : 'audio');
        }

        updateProgressBar();
    }

    function updateProgressBar() {
        if (!pipWindow) return;
        const slideBar = pipWindow.document.getElementById('pip-progress-bar');
        const mediaBar = pipWindow.document.getElementById('pip-media-progress-bar');
        const mediaContainer = pipWindow.document.getElementById('pip-media-progress-container');

        if (!slideBar) return;

        // 1. Slide Progress (Bottom Green Bar)
        if (isPageLoading) {
            slideBar.classList.add('loading');
            slideBar.style.transition = 'width 0.5s ease-out';
            slideBar.style.width = `${Math.max(5, loadProgress)}%`;
        } else {
            slideBar.classList.remove('loading');
            slideBar.style.transition = 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
            const progress = ((currentSlideIndex + 1) / items.length) * 100;
            slideBar.style.width = `${progress}%`;
        }

        // 2. Media Progress (Top Red Bar)
        if (stackMode === 'media' && pipWindow) {
            if (mediaContainer) mediaContainer.classList.add('visible');
            const mediaEl = pipWindow.document.getElementById('pip-media-driver');
            if (mediaEl && mediaEl.duration > 0 && mediaBar) {
                const progress = (mediaEl.currentTime / mediaEl.duration) * 100;
                mediaBar.style.width = `${progress}%`;
            }
        } else if (mediaContainer) {
            mediaContainer.classList.remove('visible');
        }
    }


    function startLoadSimulation() {
        if (loadInterval) clearInterval(loadInterval);
        loadInterval = setInterval(() => {
            if (!isPageLoading) {
                clearInterval(loadInterval);
                return;
            }
            if (loadProgress < 95) {
                // Slower increment as it gets higher
                const increment = Math.max(0.5, (100 - loadProgress) / 20);
                loadProgress += increment;
                updateProgressBar();
            }
        }, 100);
    }

    let lastPipSize = { width: 0, height: 0 };
    function resizePip(type = 'manual') {
        if (!pipWindow) return;
        let width = 320;
        let height = 200;

        if (type === 'audio') {
            width = 340;
            height = 280;
        } else if (type === 'video') {
            width = 480;
            height = 450;
        }

        if (lastPipSize.width === width && lastPipSize.height === height) return;

        try {
            pipWindow.resizeTo(width, height);
            lastPipSize = { width, height };
        } catch (e) {
            // NotAllowedErrors are expected if there's no user activation in the PiP window
            // We only warn if it's a different kind of error
            if (e.name !== 'NotAllowedError') {
                console.warn('[Stack] Failed to resize PIP:', e);
            }
        }
    }


    async function toggleMaximized() {
        if (!contentTabId) return;
        try {
            const tab = await chrome.tabs.get(contentTabId);
            await chrome.windows.update(tab.windowId, { state: 'maximized', focused: true });
        } catch (err) {
            console.error('Maximize toggle failed:', err);
        }
    }

    async function toggleTrueFullscreen() {
        if (!contentTabId) return;
        try {
            const tab = await chrome.tabs.get(contentTabId);
            await chrome.windows.update(tab.windowId, { state: 'fullscreen', focused: true });
        } catch (err) {
            console.error('True Fullscreen toggle failed:', err);
        }
    }

    function injectKeyboardListener(tabId) {
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab || !tab.url) return;
            
            // Skip script injection for internal extension pages to avoid permission errors
            // These pages should have their own key listeners
            if (tab.url.startsWith('chrome-extension://')) {
                console.log('[Stack] Skipping script injection for internal page:', tab.url);
                return;
            }

            chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    // Remove existing listener if any
                    if (window.__wildcardKeyboardListener) {
                        window.removeEventListener('keydown', window.__wildcardKeyboardListener);
                    }

                    window.__wildcardKeyboardListener = (e) => {
                        // Only handle if not in an input/textarea
                        if (['input', 'textarea'].includes(document.activeElement.tagName.toLowerCase()) ||
                            document.activeElement.isContentEditable) {
                            return;
                        }

                        const keys = ['ArrowRight', 'ArrowLeft', 'Space', 'Enter', 'r', 'R'];
                        if (keys.includes(e.key)) {
                            e.preventDefault();
                            chrome.runtime.sendMessage({
                                type: 'STACK_NAVIGATION',
                                action: e.key
                            });
                        }
                    };

                    window.addEventListener('keydown', window.__wildcardKeyboardListener);
                }
            }).catch(err => console.error('Script injection failed:', err));
        });
    }

    async function advanceSlide() {
        if (currentSlideIndex < items.length - 1) {
            const nextIndex = currentSlideIndex + 1;

            // Sync Media if driving
            if (stackMode === 'media' && pipWindow) {
                const mediaEl = pipWindow.document.getElementById('pip-media-driver');
                if (mediaEl && stackMarkers[nextIndex] !== undefined) {
                    const nextMarkerTime = stackMarkers[nextIndex];
                    mediaEl.currentTime = nextMarkerTime;
                    // Reset lastMarkerIndex to prevent double-advance
                    lastMarkerIndex = nextIndex;
                }
            }

            await startPlayback(nextIndex);
        }
    }


    function restartPlayback() {
        lastMarkerIndex = -1; // Reset marker tracking index
        mediaLastTime = 0;    // Reset the "rewind guard" so it doesn't block restart
        if (pipWindow && stackMode === 'media') {
            const mediaEl = pipWindow.document.getElementById('pip-media-driver');
            if (mediaEl) {
                mediaEl.currentTime = 0;
                mediaEl.play().catch(() => { }); // Try to auto-play on restart
            }
        }
        startPlayback(0);
    }


    function getItemUrl(item) {
        if (!item) return null;
        const type = (typeof item === 'object') ? (item.type || 'page') : 'page';

        // For items loaded from stack_items table, essential IDs are inside metadata
        const meta = (typeof item.metadata === 'object') ? item.metadata : {};
        const resourceId = item.resourceId || meta.resourceId;
        const mediaId = item.mediaId || meta.mediaId;
        const mimeType = item.mimeType || meta.mimeType;
        const itemName = item.name || meta.name || '';

        if (type === 'page' || type === 'link') {
            return item.url || meta.url;
        } else if (type === 'local' || type === 'wasm') {
            if (!resourceId) return null;
            return chrome.runtime.getURL(`sidebar/viewer.html?id=${resourceId}&name=${encodeURIComponent(itemName)}&packetId=${packetId}`);
        } else if (type === 'media') {
            if (!mediaId) return null;
            return chrome.runtime.getURL(`sidebar/media.html?id=${mediaId}&type=${encodeURIComponent(mimeType || '')}&name=${encodeURIComponent(itemName)}&packetId=${packetId}`);
        } else if (type === 'stack') {
            const sid = item.stackId || meta.stackId; // Strictly use stackId or metadata-based stackId
            if (!sid) return null;
            return chrome.runtime.getURL(`sidebar/stack.html?id=${sid}&packetId=${packetId}&name=${encodeURIComponent(itemName)}`);
        }
        return null;
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'STACK_NAVIGATION' && contentTabId) {
            switch (message.action) {
                case 'ArrowRight':
                case 'Space':
                case 'Enter':
                    advanceSlide();
                    break;
                case 'ArrowLeft':
                    currentSlideIndex = Math.max(0, currentSlideIndex - 1);
                    startPlayback(currentSlideIndex);
                    break;
                case 'r':
                case 'R':
                    restartPlayback();
                    break;
            }
        }
    });

    function updateActiveHighlight(activeUrl) {
        currentActiveUrl = activeUrl;
        const normalizedActive = normalizeUrl(activeUrl);
        const cards = itemsContainer.querySelectorAll('.stack-item');

        cards.forEach((card, idx) => {
            const item = items[idx];
            const itemUrl = getItemUrl(item);
            if (itemUrl && normalizeUrl(itemUrl) === normalizedActive) {
                card.classList.add('active');
            } else {
                card.classList.remove('active');
            }
        });
    }

    function renderStructure() {
        itemsContainer.innerHTML = '';

        items.forEach((item, index) => {
            const card = document.createElement('div');
            const isDisabled = isNetworkOffline && isOnlineRequired(item);
            card.className = `stack-item ${isDisabled ? 'disabled' : ''}`;
            card.id = `slide-card-${index}`;
            card.draggable = !isDisabled;
            card.dataset.index = index;

            // Find if there is a marker for this slide
            // 1:1 Mapping: Slide 1 (Index 0) -> Marker 1 (Index 0)
            const triggerMarkerTime = stackMarkers[index];

            card.innerHTML = `
                <div class="item-index">${index + 1}</div>
                ${isDisabled ? '<div class="offline-badge">Offline</div>' : ''}
                <div class="item-icon-box">${getIcon(item.type)}</div>
                <div class="item-content">
                    <div class="item-name">${escapeHtml(item.name || 'Untitled')}</div>
                    <div class="item-type-badge">${item.type}</div>
                    ${triggerMarkerTime !== undefined && triggerMarkerTime !== null ? `
                        <div class="marker-trigger-label" title="Triggered by marker at ${formatTime(triggerMarkerTime)}">
                            <span style="font-size: 10px;">⏱️</span> ${formatTime(triggerMarkerTime)}
                        </div>
                    ` : ''}
                </div>
                <div class="item-footer">
                    <button class="remove-btn" title="Remove">✕</button>
                    <div style="font-size: 10px; color: var(--text-secondary);">#${item.id}</div>
                </div>
            `;

            if (!isDisabled) {
                card.addEventListener('click', () => {
                    const url = getItemUrl(item);
                    if (url) {
                        chrome.runtime.sendMessage({
                            action: 'openTabInGroup',
                            url: url,
                            packetId: packetId
                        });
                    }
                });
            }

            card.addEventListener('mouseenter', () => {
                const url = getItemUrl(item);
                if (url) {
                    chrome.runtime.sendMessage({
                        type: 'HOVER_ITEM_START',
                        url: url,
                        packetId: packetId
                    });
                }
                // Synchronized Highlight: Slide -> Marker
                const markerEl = timelineTrack.querySelectorAll('.marker')[index];
                if (markerEl) markerEl.classList.add('highlight');
            });

            card.addEventListener('mouseleave', () => {
                const url = getItemUrl(item);
                if (url) {
                    chrome.runtime.sendMessage({
                        type: 'HOVER_ITEM_END',
                        url: url,
                        packetId: packetId
                    });
                }
                // Synchronized Highlight: Slide -> Marker
                const markerEl = timelineTrack.querySelectorAll('.marker')[index];
                if (markerEl) markerEl.classList.remove('highlight');
            });



            card.querySelector('.remove-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                removeItem(index);
            });

            // Drag events for reordering
            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('internal/index', index);
                card.classList.add('dragging');
                clearConnectors();
            });

            card.addEventListener('dragend', () => {
                card.classList.remove('dragging');
                drawConnectors();
            });

            // Advanced Reordering Detection
            card.addEventListener('dragover', (e) => {
                e.preventDefault();
                const rect = card.getBoundingClientRect();
                const x = e.clientX - rect.left;

                // Remove existing indicators
                card.classList.remove('insert-before', 'insert-after');

                if (x < rect.width / 2) {
                    card.classList.add('insert-before');
                } else {
                    card.classList.add('insert-after');
                }
            });

            card.addEventListener('dragleave', () => {
                card.classList.remove('insert-before', 'insert-after');
            });

            card.addEventListener('drop', async (e) => {
                e.preventDefault();
                const isBefore = card.classList.contains('insert-before');
                card.classList.remove('insert-before', 'insert-after');

                const fromIndexStr = e.dataTransfer.getData('internal/index');
                const jsonData = e.dataTransfer.getData('application/json');

                let targetIndex = isBefore ? index : index + 1;

                if (fromIndexStr !== "") {
                    // Internal reorder
                    let fromIndex = parseInt(fromIndexStr);
                    // Adjust targetIndex if we are moving forward
                    if (fromIndex < targetIndex) {
                        targetIndex -= 1;
                    }
                    await reorderItems(fromIndex, targetIndex);
                } else if (jsonData) {
                    // External drop
                    try {
                        const data = JSON.parse(jsonData);
                        await addItem(data, targetIndex);
                    } catch (err) {
                        console.error('Drop failed:', err);
                    }
                }
            });

            itemsContainer.appendChild(card);
        });

        // Restore highlight if we have an active URL
        if (currentActiveUrl) {
            updateActiveHighlight(currentActiveUrl);
        }

        // Delay connector drawing until layout is stable
        setTimeout(drawConnectors, 50);
    }

    function clearConnectors() {
        const paths = flowSvg.querySelectorAll('.connector-path');
        paths.forEach(p => p.remove());
    }

    function drawConnectors() {
        clearConnectors();
        const cards = itemsContainer.querySelectorAll('.stack-item');
        const canvasRect = canvas.getBoundingClientRect();

        for (let i = 0; i < cards.length; i++) {
            const current = cards[i];
            const next = cards[i + 1] || dropZone;

            const r1 = current.getBoundingClientRect();
            const r2 = next.getBoundingClientRect();

            const p1 = {
                x: r1.right - canvasRect.left,
                y: r1.top + r1.height / 2 - canvasRect.top
            };
            const p2 = {
                x: r2.left - canvasRect.left,
                y: r2.top + r2.height / 2 - canvasRect.top
            };

            const dx = Math.abs(p2.x - p1.x);
            const dy = Math.abs(p2.y - p1.y);

            let pathData;
            if (dy < 20) {
                const cp1x = p1.x + dx / 2;
                const cp1y = p1.y;
                pathData = `M ${p1.x} ${p1.y} C ${cp1x} ${cp1y}, ${cp1x} ${p2.y}, ${p2.x} ${p2.y}`;
            } else {
                const offset = 40;
                const cp1x = p1.x + offset;
                const cp1y = p1.y;
                const cp2x = p2.x - offset;
                const cp2y = p2.y;
                pathData = `M ${p1.x} ${p1.y} C ${cp1x} ${cp1y}, ${cp1x} ${p1.y + dy / 2}, ${(p1.x + p2.x) / 2} ${(p1.y + p2.y) / 2} S ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
            }

            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", pathData);
            path.setAttribute("class", "connector-path");
            path.setAttribute("marker-end", "url(#arrowhead)");
            flowSvg.appendChild(path);
        }
    }

    async function addItem(data, atIndex = -1) {
        const type = data.type;
        const item = data.item;
        const itemName = (typeof item === 'object') ? (item.name || item.url || item.prompt || 'Untitled') : item;
        const itemUrl = (typeof item === 'object') ? (item.url || '') : item;
        const metadata = (typeof item === 'object') ? JSON.stringify(item) : '{}';

        try {
            // If atIndex is provided, we need to shift others
            if (atIndex !== -1 && atIndex < items.length) {
                for (let i = items.length - 1; i >= atIndex; i--) {
                    await chrome.runtime.sendMessage({
                        action: 'executeSQL',
                        name: dbName,
                        sql: `UPDATE stack_items SET position = ${i + 1} WHERE id = ${items[i].id}`
                    });
                }
            } else {
                atIndex = items.length;
            }

            const sql = `INSERT INTO stack_items (stack_id, type, name, url, metadata, position) 
                        VALUES (${stackId}, '${type}', '${itemName.replace(/'/g, "''")}', 
                        '${itemUrl.replace(/'/g, "''")}', '${metadata.replace(/'/g, "''")}', ${atIndex})`;

            await chrome.runtime.sendMessage({ action: 'executeSQL', name: dbName, sql });
            await chrome.runtime.sendMessage({ action: 'saveCheckpoint', name: dbName });
            
            // Phase 2: Marker Automation
            if (stackMode === 'media' && mediaDuration > 0) {
                let newMarkerTime = 0;
                if (atIndex === 0) {
                    newMarkerTime = 0;
                } else if (atIndex >= items.length) {
                    // Appending (items.length is count BEFORE reload, but atIndex is final position)
                    const lastMarker = stackMarkers.length > 0 ? stackMarkers[stackMarkers.length - 1] : 0;
                    newMarkerTime = Number(((lastMarker + mediaDuration) / 2).toFixed(2));
                } else {
                    // Inserting
                    const prevMarker = stackMarkers[atIndex - 1] || 0;
                    const nextMarker = stackMarkers[atIndex] || mediaDuration;
                    newMarkerTime = Number(((prevMarker + nextMarker) / 2).toFixed(2));
                }
                stackMarkers.splice(atIndex, 0, newMarkerTime);
                await saveStackDriverMetadata();
            }

            // Sync tab group order to reflect new item
            chrome.runtime.sendMessage({ action: 'syncTabOrder', packetId }).catch(() => { });

            await loadStack();
        } catch (err) {
            console.error('Failed to add item:', err);
        }
    }

    async function removeItem(index) {
        const item = items[index];
        try {
            await chrome.runtime.sendMessage({
                action: 'executeSQL',
                name: dbName,
                sql: `DELETE FROM stack_items WHERE id = ${item.id}`
            });
            // Shift remaining down
            for (let i = index + 1; i < items.length; i++) {
                await chrome.runtime.sendMessage({
                    action: 'executeSQL',
                    name: dbName,
                    sql: `UPDATE stack_items SET position = ${i - 1} WHERE id = ${items[i].id}`
                });
            }
            await chrome.runtime.sendMessage({ action: 'saveCheckpoint', name: dbName });

            // Phase 2: Marker Automation
            if (stackMode === 'media') {
                stackMarkers.splice(index, 1);
                await saveStackDriverMetadata();
            }

            // Sync tab group order after removal
            chrome.runtime.sendMessage({ action: 'syncTabOrder', packetId }).catch(() => { });

            await loadStack();
        } catch (err) {
            console.error('Failed to remove item:', err);
        }
    }

    async function reorderItems(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;

        const movedItem = items.splice(fromIndex, 1)[0];
        items.splice(toIndex, 0, movedItem);

        try {
            // Update all positions
            for (let i = 0; i < items.length; i++) {
                await chrome.runtime.sendMessage({
                    action: 'executeSQL',
                    name: dbName,
                    sql: `UPDATE stack_items SET position = ${i} WHERE id = ${items[i].id}`
                });
            }
            await chrome.runtime.sendMessage({ action: 'saveCheckpoint', name: dbName });

            // Phase 2: Marker Automation
            if (stackMode === 'media') {
                const movedMarker = stackMarkers.splice(fromIndex, 1)[0];
                stackMarkers.splice(toIndex, 0, movedMarker);
                await saveStackDriverMetadata();
            }

            // Sync tab group order after internal reorder
            chrome.runtime.sendMessage({ action: 'syncTabOrder', packetId }).catch(() => { });

            renderStructure();
        } catch (err) {
            console.error('Reorder failed:', err);
        }
    }

    // Canvas Drop Global (Always appends)
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');

        const jsonData = e.dataTransfer.getData('application/json');
        const fromIndexStr = e.dataTransfer.getData('internal/index');

        if (jsonData) {
            try {
                const data = JSON.parse(jsonData);
                await addItem(data);
            } catch (err) {
                console.error('Drop failed:', err);
            }
        } else if (fromIndexStr !== "") {
            await reorderItems(parseInt(fromIndexStr), items.length - 1);
        }
    });

    chrome.runtime.onMessage.addListener((request) => {
        if (request.type === 'UPDATE_ACTIVE_URL') {
            // Only care if it's for our current packet
            if (String(request.packetId) === String(packetId)) {
                updateActiveHighlight(request.url);
            }
        }
    });

    function escapeHtml(text) {
        if (typeof text !== 'string') return text;
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    window.addEventListener('resize', drawConnectors);

    playBtn.addEventListener('click', () => startPlayback(0));

    if (shareBtn) {
        shareBtn.addEventListener('click', handleShare);
    }

    function uint8ArrayToBase64(Uint8Arr) {
        let binary = '';
        const len = Uint8Arr.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(Uint8Arr[i]);
        }
        return window.btoa(binary);
    }

    async function handleShare() {
        try {
            // 1. Collect all referenced IDs
            const mediaIds = new Set();
            const resourceIds = new Set();

            if (stackMediaId) mediaIds.add(String(stackMediaId));

            items.forEach(item => {
                const meta = item.metadata || {};
                const rid = item.resourceId || meta.resourceId;
                const mid = item.mediaId || meta.mediaId;
                if (rid) resourceIds.add(String(rid));
                if (mid) mediaIds.add(String(mid));
            });

            // 2. Fetch blobs
            const blobs = {};
            const allIds = new Set([...mediaIds, ...resourceIds]);
            
            if (allIds.size > 0) {
                showNotification(`Preparing ${allIds.size} resources...`);
            }

            for (const id of allIds) {
                const resp = await chrome.runtime.sendMessage({ action: 'getMediaBlob', id });
                if (resp.success) {
                    const data = resp.data instanceof Uint8Array ? resp.data :
                                 (resp.data && typeof resp.data === 'object' ? new Uint8Array(Object.values(resp.data)) : resp.data);
                    blobs[id] = { 
                        data: uint8ArrayToBase64(new Uint8Array(data)), 
                        type: resp.type 
                    };
                } else {
                    console.warn(`[Share] Failed to fetch blob ${id}:`, resp.error);
                }
            }

            // 3. Package data
            const exportData = {
                version: 2,
                packetId: packetId,
                packetName: name,
                stack: {
                    name: stackTitle.textContent,
                    mode: stackMode,
                    mediaId: stackMediaId,
                    markers: stackMarkers
                },
                items: items.map(item => {
                    const exportItem = { ...item };
                    // Remove internal database IDs to prevent confusion on import
                    delete exportItem.id;
                    delete exportItem.stack_id;
                    // Ensure metadata is an object if it's a string
                    if (typeof exportItem.metadata === 'string') {
                        try { exportItem.metadata = JSON.parse(exportItem.metadata); } catch(e){}
                    }
                    return exportItem;
                }),
                blobs
            };

            // 4. Sanitize filename
            const sanitizedName = name.replace(/\s+/g, '_').replace(/[^a-z0-9_]/gi, '');
            const filename = `${sanitizedName}_stack.json`;

            // 5. Save file
            if ('showSaveFilePicker' in window) {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'JSON Files',
                        accept: { 'application/json': ['.json'] },
                    }],
                });
                const writable = await handle.createWritable();
                await writable.write(JSON.stringify(exportData, null, 2));
                await writable.close();
                showNotification('Stack shared successfully!', 'success');
            } else {
                // Fallback for browsers without File System Access API
                const json = JSON.stringify(exportData, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
                showNotification('Stack downloaded!', 'success');
            }

        } catch (err) {
            console.error('[Share] Failed:', err);
            if (err.name !== 'AbortError') {
                showNotification('Share failed: ' + err.message, 'error');
            }
        }
    }

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (tabId === contentTabId && changeInfo.status === 'complete') {
            isPageLoading = false;
            loadProgress = 100;
            if (loadInterval) clearInterval(loadInterval);
            updatePipStatus();
        }
    });

    // Listen for manual reload signals from background if tab reuse didn't trigger a reload
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'RELOAD_STACK' && msg.url) {
            // Update URL without necessarily triggering a full reload if we're already on stack.html
            // but we want the variables to re-evaluate or the data to re-load
            window.location.href = msg.url;
        }
    });

    // Handle same-document navigation (e.g. if the browser reuses the instance but just changes parameters)
    window.addEventListener('popstate', () => {
        const newParams = new URLSearchParams(window.location.search);
        const newStackId = newParams.get('id');
        if (newStackId) {
            // Force a full reload of the state
            window.location.reload();
        }
    });

    async function loadBoundMediaInfo() {
        if (!stackMediaId) {
            boundMediaItem = null;
            return;
        }

        try {
            // Get packet items to find the media resource
            const resp = await chrome.runtime.sendMessage({ action: 'getPacket', id: packetId });
            if (resp.success && resp.packet) {
                const mediaItem = resp.packet.urls.find(u => u.type === 'media' && String(u.mediaId) === String(stackMediaId));
                if (mediaItem) {
                    boundMediaItem = mediaItem;
                    mediaDuration = mediaItem.duration || 0;

                    // If duration is missing, try to detect it by loading the blob
                    if (!mediaDuration) {
                        try {
                            console.log('[Stack] Missing duration, fetching blob for detection...', stackMediaId);
                            const blobResp = await chrome.runtime.sendMessage({
                                action: 'getMediaBlob',
                                id: stackMediaId
                            });

                            if (blobResp.success && blobResp.data) {
                                await new Promise((resolve) => {
                                    const data = blobResp.data instanceof Uint8Array ? blobResp.data :
                                        (blobResp.data && typeof blobResp.data === 'object' ? new Uint8Array(Object.values(blobResp.data)) : blobResp.data);
                                    const uint8Array = new Uint8Array(data);
                                    const blob = new Blob([uint8Array], { type: mediaItem.mimeType });


                                    const detectWithUrl = (sourceUrl, name = 'Blob') => {
                                        return new Promise((res) => {
                                            const isVideo = mediaItem.mimeType.startsWith('video/');
                                            const tempMedia = document.createElement(isVideo ? 'video' : 'audio');
                                            tempMedia.muted = true;
                                            tempMedia.preload = 'metadata';
                                            tempMedia.setAttribute('playsinline', '');

                                            const timeout = setTimeout(() => {
                                                console.warn(`[Stack] Duration detection (${name}) timed out after 10s`);
                                                cleanup();
                                            }, 10000);

                                            const cleanup = () => {
                                                clearTimeout(timeout);
                                                tempMedia.onloadedmetadata = null;
                                                tempMedia.onerror = null;
                                                tempMedia.remove();
                                                res();
                                            };

                                            tempMedia.onloadedmetadata = () => {
                                                if (tempMedia.duration && tempMedia.duration !== Infinity) {
                                                    mediaDuration = tempMedia.duration;
                                                    console.log(`[Stack] Detected duration via ${name}:`, mediaDuration);
                                                    if (durationLabel) durationLabel.textContent = formatTime(mediaDuration);
                                                }
                                                cleanup();
                                            };

                                            tempMedia.onerror = (e) => {
                                                console.error(`[Stack] Media error during duration detection (${name})`);
                                                cleanup();
                                            };

                                            tempMedia.src = sourceUrl;
                                        });
                                    };

                                    (async () => {
                                        // 1. Try Blob URL (Standard)
                                        const blobUrl = URL.createObjectURL(blob);
                                        await detectWithUrl(blobUrl, 'Blob URL');
                                        URL.revokeObjectURL(blobUrl);

                                        // 2. Fallback to Data URL if blob failed and size is reasonable (< 30MB)
                                        if (mediaDuration <= 0 && blob.size < 30 * 1024 * 1024) {
                                            console.log('[Stack] Blob detection failed, attempting Data URL fallback...');
                                            await new Promise((res) => {
                                                const reader = new FileReader();
                                                reader.onload = async () => {
                                                    await detectWithUrl(reader.result, 'Data URL');
                                                    res();
                                                };
                                                reader.onerror = () => res();
                                                reader.readAsDataURL(blob);
                                            });
                                        }

                                        if (mediaDuration <= 0) {
                                            console.warn('[Stack] Failed to detect duration from both Blob and Data URL. Media might be missing headers.');
                                        }

                                        resolve();
                                    })();
                                });


                            } else {
                                console.warn('[Stack] Failed to fetch media blob for duration detection:', blobResp.error);
                            }
                        } catch (err) {
                            console.warn('[Stack] Duration detection failed:', err);
                        }
                    }


                } else {
                    // Resource no longer exists?
                    stackMediaId = null;
                    stackMode = 'manual';
                    boundMediaItem = null;
                    await saveStackDriverMetadata();
                }
            }
        } catch (e) {
            console.error('[Stack] Failed to load bound media info:', e);
        }
    }

    function updateModeUI() {
        if (stackMode === 'manual' || !stackMediaId) {
            driverModeBadge.className = 'driver-mode-badge manual';
            driverModeBadge.textContent = 'Manual';
            timelineArea.style.display = 'none';
            renderBindingPrompt();

            // Clear all trigger labels from cards
            const labels = document.querySelectorAll('.marker-trigger-label');
            labels.forEach(l => l.remove());
        } else {

            driverModeBadge.className = 'driver-mode-badge media';
            driverModeBadge.textContent = 'Media Driven';
            timelineArea.style.display = 'block';
            renderBoundInfo();

            if (mediaDuration > 0) {
                durationLabel.textContent = formatTime(mediaDuration);
                renderMarkers();
            } else {
                durationLabel.textContent = 'Detecting...';
                // Try one last time if we are in this state
                if (boundMediaItem && !mediaDuration) {
                    loadBoundMediaInfo().then(() => renderMarkers());
                }
            }
        }

        updateProgressBar();
        if (pipWindow) updatePipStatus();
    }


    function renderBindingPrompt() {
        bindingZone.className = 'binding-zone';
        bindingZone.innerHTML = '';
        const prompt = document.createElement('div');
        prompt.id = 'binding-prompt';
        prompt.innerHTML = `
            <span style="font-size: 14px; margin-right: 4px;">🎯</span>
            <span style="font-size: 11px; font-weight: 600; color: var(--text-secondary);">Drop media to drive presentation by audio or video.</span>
        `;
        bindingZone.appendChild(prompt);
    }

    function renderBoundInfo() {
        if (!boundMediaItem) return;
        bindingZone.className = 'binding-zone bound';
        bindingZone.innerHTML = '';

        const info = document.createElement('div');
        info.className = 'bound-info';
        info.style.gap = '8px';

        const icon = document.createElement('div');
        icon.className = 'bound-icon';
        icon.style.fontSize = '16px';
        icon.textContent = (boundMediaItem.mimeType || '').startsWith('video') ? '🎥' : '🎵';

        const name = document.createElement('div');
        name.className = 'bound-name';
        name.style.fontSize = '11px';
        name.textContent = boundMediaItem.name || 'Unnamed Media';

        info.appendChild(icon);
        info.appendChild(name);

        const clearBtn = document.createElement('button');
        clearBtn.className = 'clear-binding';
        clearBtn.textContent = 'Clear';
        clearBtn.style.fontSize = '9px';
        clearBtn.style.padding = '2px 8px';
        clearBtn.onclick = async (e) => {
            e.stopPropagation();
            stackMediaId = null;
            stackMode = 'manual';
            boundMediaItem = null;
            stackMarkers = [];
            updateModeUI();
            await saveStackDriverMetadata();
        };

        bindingZone.appendChild(info);
        bindingZone.appendChild(clearBtn);
    }

    // Drag and Drop for Binding
    bindingZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        bindingZone.classList.add('drag-active');
    });

    bindingZone.addEventListener('dragleave', () => {
        bindingZone.classList.remove('drag-active');
    });

    bindingZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        bindingZone.classList.remove('drag-active');

        try {
            const data = JSON.parse(e.dataTransfer.getData('application/json'));
            // Sidebar wraps the object in { type, item, ... }
            const item = data.item || data;
            const type = item.type || data.type;

            if (type === 'media' && item.mediaId) {
                // Check if it's audio or video
                const mimeType = item.mimeType || '';
                if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
                    stackMediaId = item.mediaId;
                    stackMode = 'media';
                    await loadBoundMediaInfo();

                    // Auto-generate markers if empty
                    if (items.length > 0 && stackMarkers.length === 0) {
                        if (mediaDuration > 0) {
                            for (let i = 0; i < items.length; i++) {
                                stackMarkers.push((mediaDuration / items.length) * i);
                            }
                        }
                    }

                    updateModeUI();
                    if (pipWindow) {
                        setupMediaDriver();
                    }
                    await saveStackDriverMetadata();
                    showNotification('Media bound to stack driver', 'success');
                } else {
                    showNotification('Only audio or video files can drive the stack', 'error');
                }
            }
        } catch (err) {
            console.error('[Stack] Drop failed:', err);
        }

    });


    function formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function renderMarkers() {
        const oldMarkers = timelineTrack.querySelectorAll('.marker');
        oldMarkers.forEach(m => m.remove());

        if (mediaDuration <= 0) return;

        stackMarkers.sort((a, b) => a - b).forEach((time, i) => {
            const marker = document.createElement('div');
            marker.className = 'marker';
            const pct = (time / mediaDuration) * 100;
            marker.style.left = `${pct}%`;
            marker.title = `Advance to Slide ${i + 1} at ${formatTime(time)}`;

            // Numbered Bubble
            const bubble = document.createElement('div');
            bubble.className = 'marker-bubble';
            bubble.textContent = i + 1;
            marker.appendChild(bubble);

            // Timestamp Label
            const ts = document.createElement('div');
            ts.className = 'marker-timestamp';
            ts.textContent = formatTime(time);
            marker.appendChild(ts);

            marker.addEventListener('click', (e) => {
                e.stopPropagation();
                if (marker.dataset.wasDragging === 'true') {
                    delete marker.dataset.wasDragging;
                    return;
                }
                removeMarker(time);
            });

            // Draggable Logic
            marker.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                
                const rect = timelineTrack.getBoundingClientRect();
                
                const onMouseMove = (moveEvent) => {
                    marker.dataset.wasDragging = 'true';
                    const x = Math.max(0, Math.min(moveEvent.clientX - rect.left, rect.width));
                    const newTime = (x / rect.width) * mediaDuration;
                    
                    // Constrain between neighbors to preserve order
                    const minTime = i > 0 ? stackMarkers[i - 1] + 0.1 : 0;
                    const maxTime = i < stackMarkers.length - 1 ? stackMarkers[i + 1] - 0.1 : mediaDuration;
                    
                    const constrainedTime = Math.max(minTime, Math.min(newTime, maxTime));
                    stackMarkers[i] = constrainedTime;
                    
                    // Visual update
                    marker.style.left = `${(constrainedTime / mediaDuration) * 100}%`;
                    ts.textContent = formatTime(constrainedTime);
                    marker.title = `Advance to Slide ${i + 1} at ${formatTime(constrainedTime)}`;
                    
                    // Update slide card label if exists
                    const card = document.getElementById(`slide-card-${i}`);
                    if (card) {
                        const label = card.querySelector('.marker-trigger-label');
                        if (label) label.querySelector('span:last-child').textContent = formatTime(constrainedTime);
                    }
                };
                
                const onMouseUp = () => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                    saveStackDriverMetadata();
                };
                
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });

            // Synchronized Highlight: Marker -> Slide
            marker.addEventListener('mouseenter', () => {
                const card = document.getElementById(`slide-card-${i}`);
                if (card) card.classList.add('highlight');
            });

            marker.addEventListener('mouseleave', () => {
                const card = document.getElementById(`slide-card-${i}`);
                if (card) card.classList.remove('highlight');
            });

            timelineTrack.appendChild(marker);
        });

        // Update timestamps on slide cards without full re-render if possible
        items.forEach((item, index) => {
            const card = document.getElementById(`slide-card-${index}`);
            if (card) {
                const markerTime = stackMarkers[index];
                let label = card.querySelector('.marker-trigger-label');
                if (markerTime !== undefined) {
                    if (!label) {
                        const content = card.querySelector('.item-content');
                        label = document.createElement('div');
                        label.className = 'marker-trigger-label';
                        content.appendChild(label);
                    }
                    label.innerHTML = `<span style="font-size: 10px;">⏱️</span> ${formatTime(markerTime)}`;
                    label.title = `Triggered by marker at ${formatTime(markerTime)}`;
                } else if (label) {
                    label.remove();
                }
            }
        });
    }



    async function addMarker(time) {
        if (!stackMediaId) return;

        if (mediaDuration <= 0) {
            showNotification('Wait for media duration to be detected...', 'warning');
            return;
        }

        // Enforce limit: number of markers <= number of slides
        // Re-check items if it's somehow empty (though it shouldn't be)
        if (!items || items.length === 0) {
            const itemsResp = await chrome.runtime.sendMessage({
                action: 'executeSQL',
                name: dbName,
                sql: `SELECT * FROM stack_items WHERE stack_id = ${stackId} ORDER BY position ASC`
            });
            if (itemsResp.success && itemsResp.result[0]?.values) {
                const result = itemsResp.result[0];
                const cols = result.columns;
                items = result.values.map(v => {
                    const item = {};
                    cols.forEach((c, i) => item[c] = v[i]);
                    return item;
                });
            }
        }

        if (stackMarkers.length >= items.length) {
            showNotification(`You can only have as many markers as there are slides (${items.length})`, 'warning');
            return;
        }



        if (time < 0.2) {
            showNotification('Markers cannot be at the very start', 'warning');
            return;
        }

        const exists = stackMarkers.find(m => Math.abs(m - time) < 0.1);
        if (!exists) {
            stackMarkers.push(time);
            stackMarkers.sort((a, b) => a - b);
            renderMarkers();
            saveStackDriverMetadata();
        }
    }


    function removeMarker(time) {
        const index = stackMarkers.findIndex(m => Math.abs(m - time) < 0.05);
        if (index !== -1) {
            stackMarkers.splice(index, 1);
            renderMarkers();
            saveStackDriverMetadata();
        }
    }

    async function saveStackDriverMetadata() {
        try {
            await chrome.runtime.sendMessage({
                action: 'executeSQL',
                name: dbName,
                sql: `UPDATE stacks SET mode = ?, media_id = ?, markers = ? WHERE id = ?`,
                params: [stackMode, stackMediaId, JSON.stringify(stackMarkers), stackId]
            });
            // Persist the change to storage
            await chrome.runtime.sendMessage({ action: 'saveCheckpoint', name: dbName });
        } catch (e) {
            console.error('[Stack] Failed to save driver metadata:', e);
        }

    }


    timelineTrack.onclick = (e) => {
        if (mediaDuration <= 0) return;
        const rect = timelineTrack.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, x / rect.width));
        const time = Number((pct * mediaDuration).toFixed(2));
        addMarker(time);
    };



    async function setupMediaDriver() {
        if (!pipWindow || !stackMediaId) return;
        const wrapper = pipWindow.document.getElementById('pip-media-wrapper');
        if (!wrapper) return;

        try {
            const resp = await chrome.runtime.sendMessage({ action: 'getMediaBlob', id: stackMediaId });
            if (!resp || !resp.success) throw new Error('Failed to load driver media');

            const uint8Array = resp.data instanceof Uint8Array ? resp.data : new Uint8Array(Object.values(resp.data));
            const blob = new Blob([uint8Array], { type: resp.type });
            const url = URL.createObjectURL(blob);

            // Clean up existing media driver
            const oldMedia = pipWindow.document.getElementById('pip-media-driver');
            if (oldMedia) oldMedia.remove();

            mediaLastTime = 0;
            lastMarkerIndex = -1;

            const isVideo = resp.type.startsWith('video/');
            const mediaEl = pipWindow.document.createElement(isVideo ? 'video' : 'audio');
            mediaEl.id = 'pip-media-driver';
            mediaEl.src = url;
            mediaEl.autoplay = true;
            mediaEl.currentTime = 0;

            if (isVideo) {
                wrapper.style.display = 'block';
                mediaEl.controls = false; // We use our own controls
            } else {
                wrapper.style.display = 'none';
            }

            mediaEl.onloadedmetadata = () => {
                const checkDuration = () => {
                    if (mediaEl.duration && mediaEl.duration !== Infinity) {
                        if (mediaDuration !== mediaEl.duration) {
                            mediaDuration = mediaEl.duration;
                            if (durationLabel) durationLabel.textContent = formatTime(mediaDuration);
                            renderMarkers();
                        }
                    } else if (mediaEl.duration === Infinity) {
                        mediaEl.currentTime = 1000000;
                        mediaEl.onseeking = () => {
                            if (mediaEl.duration && mediaEl.duration !== Infinity) {
                                mediaDuration = mediaEl.duration;
                                if (durationLabel) durationLabel.textContent = formatTime(mediaDuration);
                                renderMarkers();
                                mediaEl.currentTime = 0;
                                mediaEl.onseeking = null;
                            }
                        };
                    }
                };
                checkDuration();
            };



            // Prevent rewinding (unless explicitly reset by restart)
            mediaEl.ontimeupdate = () => {
                if (mediaEl.currentTime < mediaLastTime) {
                    mediaEl.currentTime = mediaLastTime;
                } else {
                    mediaLastTime = mediaEl.currentTime;
                }
                handleMediaTimeUpdate(mediaEl.currentTime);
            };

            wrapper.appendChild(mediaEl);

            // --- Web Audio Visualizer ---
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                const audioCtx = new AudioContext();
                const source = audioCtx.createMediaElementSource(mediaEl);
                const analyser = audioCtx.createAnalyser();
                analyser.fftSize = 64; // Small fft for a clean, broad spectrum

                source.connect(analyser);
                analyser.connect(audioCtx.destination);

                const canvas = pipWindow.document.getElementById('pip-spectrum-canvas');
                if (canvas) {
                    // Hide spectrum for video
                    canvas.style.display = isVideo ? 'none' : 'block';

                    if (!isVideo) {
                        const ctx = canvas.getContext('2d');
                        const bufferLength = analyser.frequencyBinCount;
                        const dataArray = new Uint8Array(bufferLength);

                        const draw = () => {
                            if (!pipWindow) return; // Stop if PIP closed
                            requestAnimationFrame(draw);

                            analyser.getByteFrequencyData(dataArray);

                            // Clear canvas
                            ctx.clearRect(0, 0, canvas.width, canvas.height);

                            const barWidth = (canvas.width / bufferLength) * 2.5;
                            let barHeight;
                            let x = 0;

                            for (let i = 0; i < bufferLength; i++) {
                                barHeight = (dataArray[i] / 255) * canvas.height;

                                // Beautiful gradient/theme color
                                ctx.fillStyle = `rgba(239, 68, 68, ${0.3 + (barHeight / canvas.height) * 0.7})`;
                                ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);

                                x += barWidth;
                            }
                        };

                        // Start visualizer on play
                        mediaEl.onplay = () => {
                            if (audioCtx.state === 'suspended') {
                                audioCtx.resume();
                            }
                            draw();
                        };
                    }
                }
            } catch (err) {
                console.warn('[Stack] Visualizer setup failed (likely cross-origin or gesture related):', err);
            }

        } catch (e) {
            console.error('[Stack] Media driver setup failed:', e);
        }
    }

    let lastMarkerIndex = -1;
    let mediaLastTime = 0;

    function handleMediaTimeUpdate(currentTime) {
        if (stackMode !== 'media') return;

        // Reset tracking if seeking backwards or restarting
        if (currentTime < 0.2) {
            lastMarkerIndex = -1;
        }

        const sortedMarkers = [...stackMarkers].sort((a, b) => a - b);


        let currentMarkerIndex = -1;
        for (let i = 0; i < sortedMarkers.length; i++) {
            if (currentTime >= sortedMarkers[i]) {
                currentMarkerIndex = i;
            } else {
                break;
            }
        }

        if (currentMarkerIndex > lastMarkerIndex) {
            // Crossed one or more markers!
            // Map Marker Index directly to Slide Index
            const targetSlide = currentMarkerIndex;

            if (targetSlide >= 0 && targetSlide < items.length) {
                if (targetSlide !== currentSlideIndex) {
                    console.log('[Stack] Marker crossed, advancing to slide', targetSlide + 1);
                    startPlayback(targetSlide);

                    // Pulse indicator in PIP
                    if (pipWindow) {
                        const counter = pipWindow.document.getElementById('pip-counter');
                        if (counter) {
                            counter.classList.remove('pulse');
                            void counter.offsetWidth; // Trigger reflow
                            counter.classList.add('pulse');
                        }
                    }
                }
            }

            lastMarkerIndex = currentMarkerIndex;
        }





        // Always update the PIP progress UI
        updateProgressBar();
        if (pipWindow) updatePipStatus();
    }

    async function advanceToNextMarker() {
        if (stackMode !== 'media' || !pipWindow) return;
        const mediaEl = pipWindow.document.getElementById('pip-media-driver');
        if (!mediaEl) return;

        const currentTime = mediaEl.currentTime;
        const sortedMarkers = [...stackMarkers].sort((a, b) => a - b);

        // Find the first marker that is ahead of current time (+ buffer to avoid staying on same marker)
        const nextMarker = sortedMarkers.find(m => m > currentTime + 0.3);
        
        if (nextMarker !== undefined) {
            mediaEl.currentTime = nextMarker;
        } else {
            // No more markers, skip to the end
            mediaEl.currentTime = mediaEl.duration;
        }
    }

    // Update Next button behavior in PIP
    const originalAdvanceSlide = advanceSlide;
    advanceSlide = async function () {
        if (stackMode === 'media' && pipWindow) {
            await advanceToNextMarker();
        } else {
            await originalAdvanceSlide();
        }
    };

    // Initial load
    loadStack();


})();

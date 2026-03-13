(async () => {
    const params = new URLSearchParams(window.location.search);
    const stackId = params.get('id');
    const packetId = params.get('packetId');
    const name = params.get('name') || 'Stack';

    const canvas = document.getElementById('stack-canvas');
    const itemsContainer = document.getElementById('stack-items-container');
    const stackTitle = document.getElementById('stack-title');
    const loading = document.getElementById('loading');
    const statusBadge = document.getElementById('status-badge');
    const flowSvg = document.getElementById('flow-svg');
    const dropZone = document.getElementById('drop-zone');
    const playBtn = document.getElementById('play-btn');

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

    const ICONS = {
        play: `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>`,
        restart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
        next: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`,
        finish: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M20 6L9 17l-5-5"/></svg>`,
        fullscreen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`
    };

    async function loadStack() {
        try {
            statusBadge.textContent = 'Syncing...';
            await chrome.runtime.sendMessage({ action: 'ensurePacketDatabase', packetId });
            
            // Get stack name
            try {
                const stackResp = await chrome.runtime.sendMessage({
                    action: 'executeSQL',
                    name: dbName,
                    sql: `SELECT name FROM stacks WHERE id = ${stackId}`
                });
                if (stackResp.success && stackResp.result[0]?.values?.length) {
                    stackTitle.textContent = stackResp.result[0].values[0][0];
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

            if (itemsResp.success) {
                const result = itemsResp.result[0];
                if (result) {
                    const cols = result.columns;
                    items = result.values.map(v => {
                        const item = {};
                        cols.forEach((c, i) => item[c] = v[i]);
                        try {
                            if (item.metadata && typeof item.metadata === 'string') {
                                item.metadata = JSON.parse(item.metadata);
                            }
                        } catch (e) {}
                        return item;
                    });
                } else {
                    items = [];
                }
                renderStructure();
                statusBadge.textContent = 'Synced';
                
                // Request current tab status to set initial highlight
                const tabResp = await chrome.runtime.sendMessage({ action: 'getCurrentTab' });
                if (tabResp.success && tabResp.tab) {
                    updateActiveHighlight(tabResp.tab.url);
                }
            }
        } catch (err) {
            console.error('Failed to load stack:', err);
            statusBadge.textContent = 'Error';
        } finally {
            loading.classList.add('hidden');
        }
    }

    function getIcon(type) {
        switch(type) {
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

    async function startPlayback(index = 0) {
        if (items.length === 0) return;
        currentSlideIndex = Math.max(0, Math.min(index, items.length - 1));
        const item = items[currentSlideIndex];
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
            }

            // 2. Manage PiP controller
            if (!pipWindow) {
                await openPipController();
            } else {
                updatePipStatus();
            }
        } catch (err) {
            console.error('Playback failed:', err);
        }
    }

    async function openPipController() {
        if (!('documentPictureInPicture' in window)) {
            console.warn('PiP not supported');
            return;
        }

        try {
            pipWindow = await window.documentPictureInPicture.requestWindow({
                width: 340,
                height: 220,
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
                height: 100vh;
                margin: 0;
                overflow: hidden;
                user-select: none;
            `;

            // Inject additional premium styles
            const globalStyle = pipWindow.document.createElement('style');
            globalStyle.textContent = `
                .pip-controls {
                    display: flex;
                    gap: 16px;
                    justify-content: center;
                    align-items: center;
                    margin: 24px 0;
                }
                .play-btn, .restart-btn {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                    cursor: pointer;
                }
                .fullscreen-btn {
                    position: absolute;
                    top: 12px;
                    right: 12px;
                    background: transparent;
                    color: var(--text-secondary);
                    border: none;
                    padding: 6px;
                    border-radius: 4px;
                    cursor: pointer;
                    opacity: 0.6;
                    transition: all 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .fullscreen-btn:hover {
                    opacity: 1;
                    background: var(--border);
                    color: var(--text);
                }
                .play-btn:disabled, .fullscreen-btn:disabled {
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
                }
                .progress-container {
                    width: 100%;
                    height: 8px;
                    background: var(--border);
                    border-radius: 4px;
                    overflow: hidden;
                    margin-top: 16px;
                    position: relative;
                }
                .progress-bar {
                    height: 100%;
                    width: 0%;
                    background: var(--success);
                    transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1), background 0.3s;
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
                    } catch (e) {}
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

        const fsBtn = pipWindow.document.createElement('button');
        fsBtn.id = 'pip-fs-btn';
        fsBtn.className = 'fullscreen-btn';
        fsBtn.title = 'Toggle Fullscreen';
        fsBtn.innerHTML = ICONS.fullscreen;
        fsBtn.addEventListener('click', toggleFullscreen);
        container.appendChild(fsBtn);

        const title = pipWindow.document.createElement('div');
        title.id = 'pip-title';
        title.style.cssText = 'font-size: 10px; font-weight: 800; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 8px; letter-spacing: 0.1em; opacity: 0.8;';
        container.appendChild(title);

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
        
        if (title) title.textContent = stackTitle.textContent;
        
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

        if (nextBtn) {
            nextBtn.disabled = isPageLoading;
            const isLastSlide = currentSlideIndex === items.length - 1;
            if (isLastSlide) {
                nextBtn.innerHTML = `Finish ${ICONS.finish}`;
                nextBtn.onclick = async () => {
                    if (contentTabId) {
                        try {
                            await chrome.tabs.remove(contentTabId);
                        } catch (e) {}
                        contentTabId = null;
                    }
                    pipWindow.close();
                };
            } else {
                nextBtn.innerHTML = `Next ${ICONS.next}`;
                nextBtn.onclick = advanceSlide;
            }
        }
        
        updateProgressBar();
    }

    function updateProgressBar() {
        if (!pipWindow) return;
        const bar = pipWindow.document.getElementById('pip-progress-bar');
        if (!bar) return;

        if (isPageLoading) {
            bar.classList.add('loading');
            bar.style.transition = 'width 0.5s ease-out';
            bar.style.width = `${Math.max(5, loadProgress)}%`;
        } else {
            bar.classList.remove('loading');
            bar.style.transition = 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
            const progress = ((currentSlideIndex + 1) / items.length) * 100;
            bar.style.width = `${progress}%`;
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

    async function toggleFullscreen() {
        if (!contentTabId) return;
        try {
            const tab = await chrome.tabs.get(contentTabId);
            // Use 'maximized' instead of 'fullscreen' on macOS to keep PiP visible
            await chrome.windows.update(tab.windowId, { state: 'maximized', focused: true });
        } catch (err) {
            console.error('Fullscreen toggle failed:', err);
        }
    }

    async function advanceSlide() {
        if (currentSlideIndex < items.length - 1) {
            currentSlideIndex++;
            await startPlayback(currentSlideIndex);
        }
    }

    function restartPlayback() {
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
        }
        return null;
    }

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
            card.className = 'stack-item';
            card.draggable = true;
            card.dataset.index = index;
            card.innerHTML = `
                <div class="item-index">${index + 1}</div>
                <div class="item-icon-box">${getIcon(item.type)}</div>
                <div class="item-content">
                    <div class="item-name">${escapeHtml(item.name || 'Untitled')}</div>
                    <div class="item-type-badge">${item.type}</div>
                </div>
                <div class="item-footer">
                    <button class="remove-btn" title="Remove">✕</button>
                    <div style="font-size: 10px; color: var(--text-secondary);">#${item.id}</div>
                </div>
            `;

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

            card.addEventListener('mouseenter', () => {
                const url = getItemUrl(item);
                if (url) {
                    chrome.runtime.sendMessage({
                        type: 'HOVER_ITEM_START',
                        url: url,
                        packetId: packetId
                    });
                }
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
                pathData = `M ${p1.x} ${p1.y} C ${cp1x} ${cp1y}, ${cp1x} ${p1.y + dy/2}, ${(p1.x+p2.x)/2} ${(p1.y+p2.y)/2} S ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
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
            statusBadge.textContent = 'Saving...';
            
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
            
            // Sync tab group order to reflect new item
            chrome.runtime.sendMessage({ action: 'syncTabOrder', packetId }).catch(() => {});
            
            await loadStack();
        } catch (err) {
            console.error('Failed to add item:', err);
            statusBadge.textContent = 'Error';
        }
    }

    async function removeItem(index) {
        const item = items[index];
        try {
            statusBadge.textContent = 'Removing...';
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

            // Sync tab group order after removal
            chrome.runtime.sendMessage({ action: 'syncTabOrder', packetId }).catch(() => {});

            await loadStack();
        } catch (err) {
            console.error('Failed to remove item:', err);
            statusBadge.textContent = 'Error';
        }
    }

    async function reorderItems(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;
        
        const movedItem = items.splice(fromIndex, 1)[0];
        items.splice(toIndex, 0, movedItem);
        
        try {
            statusBadge.textContent = 'Reordering...';
            // Update all positions
            for (let i = 0; i < items.length; i++) {
                await chrome.runtime.sendMessage({
                    action: 'executeSQL',
                    name: dbName,
                    sql: `UPDATE stack_items SET position = ${i} WHERE id = ${items[i].id}`
                });
            }
            await chrome.runtime.sendMessage({ action: 'saveCheckpoint', name: dbName });
            
            // Sync tab group order after internal reorder
            chrome.runtime.sendMessage({ action: 'syncTabOrder', packetId }).catch(() => {});

            renderStructure();
            statusBadge.textContent = 'Synced';
        } catch (err) {
            console.error('Reorder failed:', err);
            statusBadge.textContent = 'Error';
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

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (tabId === contentTabId && changeInfo.status === 'complete') {
            isPageLoading = false;
            loadProgress = 100;
            if (loadInterval) clearInterval(loadInterval);
            updatePipStatus(); 
        }
    });
    
    // Initial load
    loadStack();
})();

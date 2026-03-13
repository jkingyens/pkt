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

    if (!stackId || !packetId) {
        loading.innerHTML = '<div class="error">Missing stack ID or packet ID.</div>';
        return;
    }

    const dbName = `packet_${packetId}`;
    let items = [];
    let currentActiveUrl = null;

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
    
    // Initial load
    loadStack();
})();

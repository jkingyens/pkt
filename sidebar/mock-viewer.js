(async () => {
    const params = new URLSearchParams(window.location.search);
    const packetId = params.get('packetId');
    const apiId = params.get('apiId');

    const codeBlock = document.getElementById('code-block');
    const headerText = document.getElementById('header-text');
    const headerApiInfo = document.getElementById('header-api-info');
    const loading = document.getElementById('loading');
    const tableList = document.getElementById('table-list');
    const dataGridContainer = document.getElementById('data-grid-container');
    const selectedTableName = document.getElementById('selected-table-name');
    const rowCount = document.getElementById('row-count');

    const docBtn = document.getElementById('doc-btn');
    const schemaBtn = document.getElementById('schema-btn');

    if (!packetId || !apiId) {
        loading.innerHTML = '<div class="error">Missing information to load mock.</div>';
        return;
    }

    let currentApi = null;
    let mockDbName = `mock_${apiId}`;

    async function getChromiumSourceBaseUrl() {
        let version;
        try {
            if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
                const hints = await navigator.userAgentData.getHighEntropyValues(['uaFullVersion']);
                version = hints.uaFullVersion; // e.g. "146.0.7680.153"
            }
        } catch (_) { /* Client Hints not available */ }

        if (!version) {
            const match = navigator.userAgent.match(/Chrome\/([\d.]+)/);
            version = match ? match[1] : null;
        }

        if (!version) return null;

        const cacheKey = `chromiumSourceBaseUrl_${version}`;
        try {
            const cached = await chrome.storage.local.get(cacheKey);
            if (cached[cacheKey]) return cached[cacheKey];
        } catch (_) {}

        let baseUrl;
        try {
            const response = await fetch(
                `https://chromiumdash.appspot.com/fetch_releases?num=1&offset=0&version=${encodeURIComponent(version)}`
            );
            const data = await response.json();
            if (data && data.length > 0) {
                const release = data[0];
                const hash = release.chromium_main_branch_hash
                    || (release.hashes && release.hashes.chromium)
                    || release.commit;
                if (hash) {
                    baseUrl = `https://chromium.googlesource.com/chromium/src/+/${hash}`;
                }
            }
        } catch (e) {
            console.warn('ChromiumDash lookup failed, using branch fallback:', e);
        }

        if (!baseUrl) {
            baseUrl = `https://chromium.googlesource.com/chromium/src/+/refs/tags/${version}`;
        }

        // Cache result
        try {
            await chrome.storage.local.set({ [cacheKey]: baseUrl });
        } catch (_) {}

        return baseUrl;
    }

    function highlightJS(code) {
        if (!code) return '';
        let escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return escaped
            .replace(/(\/\/.*)/g, '<span class="token comment">$1</span>')
            .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="token comment">$1</span>')
            .replace(/(".+?"|'.+?'|`.+?`)/g, '<span class="token string">$1</span>')
            .replace(/\b(async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|new|return|super|switch|this|throw|try|typeof|var|void|while|with|yield|let|static|enum|await|implements|package|protected|interface|private|public)\b/g, '<span class="token keyword">$1</span>')
            .replace(/\b(console|window|document|chrome|Math|Date|Array|Object|String|Number|Boolean|Promise|Atomics|SharedArrayBuffer|Uint8Array|Int32Array|TextEncoder|TextDecoder)\b/g, '<span class="token type">$1</span>')
            .replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?=\()/g, '<span class="token function">$1</span>')
            .replace(/\b(\d+)\b/g, '<span class="token number">$1</span>');
    }

    async function loadMockData() {
        const resp = await chrome.runtime.sendMessage({
            action: 'executeSQL',
            name: 'packets',
            sql: `SELECT urls FROM packets WHERE id = ?`,
            params: [packetId]
        });

        if (!resp || !resp.success || !resp.result.length) {
            throw new Error('Failed to load packet data');
        }

        const urls = JSON.parse(resp.result[0].values[0]);
        currentApi = urls.find(u => u.id === apiId);

        if (!currentApi) {
            throw new Error('Mock API not found in packet');
        }

        headerText.textContent = currentApi.mock_prompt || currentApi.name;
        headerApiInfo.textContent = `${currentApi.name} (${currentApi.config_id})`;
        codeBlock.innerHTML = highlightJS(currentApi.mock_js || '// No implementation available');

        // Documentation Button
        if (currentApi.documentation_url) {
            docBtn.classList.remove('hidden');
            docBtn.onclick = () => window.open(currentApi.documentation_url, '_blank');
        }

        // Schema Button
        try {
            const baseUrl = await getChromiumSourceBaseUrl();
            const apisResp = await fetch(chrome.runtime.getURL('apis.json'));
            if (apisResp.ok) {
                const allApis = await apisResp.json();
                const baseConfigId = currentApi.config_id.split('/')[0];
                const match = allApis.find(a => a.config_id === currentApi.config_id || a.config_id === baseConfigId);
                if (match && match.schema_path && baseUrl) {
                    const schemaUrl = `${baseUrl}/${match.schema_path}`;
                    schemaBtn.classList.remove('hidden');
                    const ext = match.schema_path.split('.').pop().toUpperCase();
                    schemaBtn.innerHTML = `<span>🔬</span> Source Schema (${ext})`;
                    schemaBtn.onclick = () => window.open(schemaUrl, '_blank');
                }
            }
        } catch (e) { console.warn('Failed to load schema info:', e); }

        await loadTables();
    }

    async function loadTables() {
        const resp = await chrome.runtime.sendMessage({
            action: 'getSchema',
            name: mockDbName
        });

        tableList.innerHTML = '';
        if (resp && resp.success && resp.schema.length > 0) {
            resp.schema.forEach(table => {
                const item = document.createElement('div');
                item.className = 'table-item';
                item.innerHTML = `<span>📊</span> <span>${table.name}</span>`;
                item.onclick = () => selectTable(table.name, item);
                tableList.appendChild(item);
            });
        } else {
            tableList.innerHTML = '<div style="padding: 12px; font-size: 12px; color: var(--text-muted);">No tables found</div>';
        }
    }

    async function selectTable(tableName, element) {
        document.querySelectorAll('.table-item').forEach(el => el.classList.remove('active'));
        element.classList.add('active');
        selectedTableName.textContent = tableName;

        dataGridContainer.innerHTML = '<div class="loading-inline"><div class="spinner small"></div></div>';

        const resp = await chrome.runtime.sendMessage({
            action: 'executeSQL',
            name: mockDbName,
            sql: `SELECT * FROM ${tableName} LIMIT 100`
        });

        if (resp && resp.success && resp.result.length > 0) {
            renderDataGrid(resp.result[0]);
        } else if (resp && resp.success) {
            dataGridContainer.innerHTML = '<div class="empty-state"><p>Table is empty</p></div>';
            rowCount.textContent = '0 rows';
        } else {
            dataGridContainer.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">Error: ${resp.error || 'Failed to load data'}</p></div>`;
        }
    }

    function renderDataGrid(result) {
        const columns = result.columns;
        const values = result.values;
        rowCount.textContent = `${values.length}${values.length >= 100 ? '+' : ''} rows`;

        let tableHtml = '<table class="data-grid"><thead><tr>';
        columns.forEach(col => {
            tableHtml += `<th>${col}</th>`;
        });
        tableHtml += '</tr></thead><tbody>';

        values.forEach(row => {
            tableHtml += '<tr>';
            row.forEach(cell => {
                const display = cell === null ? '<i style="color:var(--text-muted)">null</i>' : 
                               (typeof cell === 'object' ? JSON.stringify(cell) : String(cell));
                tableHtml += `<td title="${String(display).replace(/"/g, '&quot;')}">${display}</td>`;
            });
            tableHtml += '</tr>';
        });

        tableHtml += '</tbody></table>';
        dataGridContainer.innerHTML = tableHtml;
    }

    // Initialize
    try {
        await loadMockData();
    } catch (err) {
        loading.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    } finally {
        loading.classList.add('hidden');
    }
})();

/**
 * Wildcard Terminal
 * Main Thread Logic
 */

import { init, Terminal, FitAddon } from "./assets/terminal/ghostty-web.js";

async function initTerminal() {
    console.log('Terminal: Starting initTerminal...');
    const urlParams = new URLSearchParams(window.location.search);
    const packetId = urlParams.get('packetId');

    if (!packetId) {
        console.error('Terminal: No packetId provided in URL');
        return;
    }

    // 0. Register with background immediately for state tracking
    const track = urlParams.get('track') !== 'false';
    chrome.runtime.sendMessage({
        action: 'registerTerminalTab',
        packetId,
        tabId: (await chrome.tabs.getCurrent())?.id,
        track: track
    }).catch(() => { });

    // 1. Initialize Terminal UI
    await init();
    const container = document.getElementById('terminal-container');
    const terminal = new Terminal({
        cursorStyle: 'block',
        fontSize: 14,
        background: '#1e293b', // Matching --bg-alt / --surface
        foreground: '#f1f5f9', // Matching --text
        padding: 4,
    });
    terminal.open(container);

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Improved fit logic with retries to ensure it catches the container size
    const performFit = () => {
        try {
            fitAddon.fit();
        } catch (e) {
            console.warn('Terminal: fit() failed', e);
        }
    };

    performFit();
    setTimeout(performFit, 50);
    setTimeout(performFit, 500);

    window.addEventListener('resize', performFit);
    fitAddon.observeResize();

    // 2. Fetch Packet Data
    const response = await chrome.runtime.sendMessage({
        action: 'executeSQL',
        name: 'packets',
        sql: `SELECT name, urls FROM packets WHERE rowid = ?`,
        params: [packetId]
    });

    let packetData = { name: 'Unknown', items: [] };
    if (response.success && response.result.length > 0) {
        const row = response.result[0].values[0];
        packetData = {
            name: row[0],
            items: JSON.parse(row[1]) || []
        };
    }

    // 3. Setup SharedArrayBuffer for Input and Mocks
    let inputSAB = null;
    let controlSAB = null;
    let mockControlSAB = null;
    let mockDataSAB = null;

    try {
        inputSAB = new SharedArrayBuffer(4096);
        controlSAB = new SharedArrayBuffer(16); // [writeIndex, readIndex, ...]
        
        mockControlSAB = new SharedArrayBuffer(64); // [state, resultType, resultLength, ...]
        mockDataSAB = new SharedArrayBuffer(1024 * 1024); // 1MB for large results (e.g. bookmarks)
        
        console.log('Terminal: SharedArrayBuffers initialized');
    } catch (e) {
        console.error('Terminal: SharedArrayBuffer not supported! Input/Mocks will fail.', e);
        terminal.write('\r\n\x1b[31mError: SharedArrayBuffer not supported.\x1b[0m\r\n');
        return;
    }

    const inputData = new Uint8Array(inputSAB);
    const controlData = new Int32Array(controlSAB);
    const mockControlData = new Int32Array(mockControlSAB);
    const mockData = new Uint8Array(mockDataSAB);

    // 4. Start WASI Worker (with cache busting)
    const worker = new Worker(new URL(`./assets/terminal/terminal-worker.js?v=${Date.now()}`, import.meta.url), { type: 'module' });

    worker.onmessage = (e) => {
        if (e.data.type === 'stdout') {
            const text = new TextDecoder().decode(e.data.data);
            // Convert LF to CRLF for display (don't convert if already CRLF)
            terminal.write(text.replace(/(?<!\r)\n/g, '\r\n'));
        } else if (e.data.type === 'log') {
            console.log(`[Host Log] ${e.data.data}`);
        } else if (e.data.type === 'exit') {
            const embedded = urlParams.get('embedded') === 'true';
            if (embedded) {
                terminal.write('\r\n\x1b[1;33m[Process completed. Press Escape to close terminal]\x1b[0m\r\n');
                const disposable = terminal.onKey(e => {
                    if (e.domEvent.code === 'Escape') {
                        disposable.dispose();
                        window.parent.postMessage({ type: 'close-terminal' }, '*');
                    }
                });
            } else if (isDirectExec) {
                terminal.write('\r\n\x1b[1;33m[Process completed. Press Escape to close tab]\x1b[0m\r\n');
                const disposable = terminal.onKey(e => {
                    if (e.domEvent.code === 'Escape') {
                        disposable.dispose();
                        chrome.tabs.getCurrent(tab => {
                            if (tab) chrome.tabs.remove(tab.id);
                        });
                    }
                });
            } else {
                window.close();
            }
        }
    };

    terminal.onData((data) => {
        // Log input for debugging if needed
        // console.log('Terminal Input:', JSON.stringify(data));

        let processed = data;
        // Map CR to NL as BusyBox ash without a TTY driver expects NL
        processed = processed.replace(/\r/g, '\n');

        const bytes = new TextEncoder().encode(processed);

        let writeIdx = Atomics.load(controlData, 0);
        for (let i = 0; i < bytes.length; i++) {
            inputData[(writeIdx + i) % 4096] = bytes[i];
        }
        Atomics.store(controlData, 0, writeIdx + bytes.length);
        Atomics.notify(controlData, 0);
    });

    terminal.focus();

    const sandboxIframe = document.createElement('iframe');
    sandboxIframe.setAttribute('sandbox', 'allow-scripts');
    sandboxIframe.src = chrome.runtime.getURL('sandbox.html');
    sandboxIframe.style.display = 'none';
    document.body.appendChild(sandboxIframe);

    let sandboxReady = false;
    const initQueue = [];

    window.addEventListener('message', async (e) => {
        const data = e.data;
        if (data.type === 'sandbox-ready') {
            console.log('Terminal: Sandbox ready, processing queue:', initQueue.length);
            sandboxReady = true;
            initQueue.forEach(msg => sandboxIframe.contentWindow.postMessage(msg, '*'));
        } else if (data.type === 'sqlite-query') {
            const dbName = data.mockId ? `mock_${data.mockId}` : `mock_${data.configId.replace(/:/g, '_')}_${packetId}`;
            const resp = await chrome.runtime.sendMessage({
                action: 'executeSQL',
                name: dbName,
                sql: data.sql,
                params: data.bind
            });
            sandboxIframe.contentWindow.postMessage({ type: 'sqlite-result', result: resp.result, qId: data.qId }, '*');
        } else if (data.type === 'sqlite-exec') {
            const dbName = data.mockId ? `mock_${data.mockId}` : `mock_${data.configId.replace(/:/g, '_')}_${packetId}`;
            const resp = await chrome.runtime.sendMessage({
                action: 'executeSQL',
                name: dbName,
                sql: data.sql,
                params: data.bind
            });
            sandboxIframe.contentWindow.postMessage({ type: 'sqlite-exec-result', success: resp?.success, changes: resp?.changes, qId: data.qId }, '*');
        } else if (data.type === 'mock-result' || data.type === 'mock-error' || data.type === 'call-result' || data.type === 'call-error') {
            const { val, error, callId } = data;
            const type = data.type;
            const isError = type === 'mock-error' || type === 'call-error';
            
            if (isError) console.error(`Terminal: Mock call error [${callId}]:`, error);
            else console.log(`Terminal: Received mock result [${callId}]`, val);
            
            // Write result to SAB and notify worker
            const res = isError ? { error } : { val };
            const json = JSON.stringify(res);
            const bytes = new TextEncoder().encode(json);
            
            mockData.set(bytes);
            Atomics.store(mockControlData, 1, bytes.length); // length
            Atomics.store(mockControlData, 0, isError ? 3 : 2); // state: result_ready or error
            Atomics.notify(mockControlData, 0);
        } else if (data.type === 'mock-initialized') {
            console.log(`Terminal: Mock ${data.configId} initialized in sandbox`);
        } else if (data.type === 'mock-error') {
            console.error(`Terminal: Mock ${data.configId} init failed:`, data.error);
        }
    });

    // Parse per-API mock selections: { 'chrome:bookmarks': 'api_...' | 'live' }
    let mockSelections = {};
    try {
        const rawSelections = urlParams.get('mockSelections');
        if (rawSelections) {
            mockSelections = JSON.parse(decodeURIComponent(rawSelections));
        }
    } catch (e) {
        console.warn('Terminal: Failed to parse mockSelections:', e);
    }

    // For backward compat, treat ?production=true as all-live
    const isProduction = urlParams.get('production') === 'true';
    if (isProduction) {
        // Will be overridden per-API below if needed
        console.log('Terminal: Legacy production mode enabled');
    }

    function isApiLive(configId) {
        const base = configId.includes('/') ? configId.split('/')[0] : configId;
        return isProduction || mockSelections[base] === 'live';
    }

    console.log('Terminal: mockSelections:', mockSelections);

    async function callRealApi(configId, methodName, args) {
        // Map WIT-style configId (chrome:bookmarks/bookmarks) to Chrome API (chrome.bookmarks)
        // and kebab-case methodName (get-tree) to camelCase (getTree)
        if (!configId.startsWith('chrome:')) {
            throw new Error(`Real API forwarding only supported for chrome:* APIs (got ${configId})`);
        }

        const apiPath = configId.split(':')[1].split('/')[0];
        const parts = apiPath.split('.');
        let obj = chrome;
        for (const p of parts) {
            if (!obj || !obj[p]) throw new Error(`Chrome API chrome.${apiPath} not found`);
            obj = obj[p];
        }

        const camelMethodName = methodName.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
        const realMethod = obj[camelMethodName] || obj[methodName];

        if (typeof realMethod !== 'function') {
            throw new Error(`Method ${camelMethodName} (or ${methodName}) not found on chrome.${apiPath}`);
        }

        console.log(`Terminal: [Production] Calling real API chrome.${apiPath}.${camelMethodName}`, args);

        const res = realMethod.apply(obj, args);
        return res instanceof Promise ? res : Promise.resolve(res);
    }

    const initMockInSandbox = (configId, mockId, code) => {
        if (isApiLive(configId)) {
            // In Production Mode, we bypass the sandbox but still need to satisfy the "all mocks ready" check
            setTimeout(() => {
                window.postMessage({ type: 'mock-initialized', configId }, '*');
            }, 0);
            return;
        }
        const msg = { type: 'init-mock', configId, mockId, code };
        if (sandboxReady) {
            sandboxIframe.contentWindow.postMessage(msg, '*');
        } else {
            initQueue.push(msg);
        }
    };

    // Worker monitor for synchronous calls
    const checkMockCalls = async () => {
        if (Atomics.load(mockControlData, 0) === 1) { // state: pending
            Atomics.store(mockControlData, 0, 4); // state: forwarding/processing
            Atomics.notify(mockControlData, 0);

            const len = Atomics.load(mockControlData, 1);
            const bytes = new Uint8Array(len);
            bytes.set(mockData.subarray(0, len));
            const json = new TextDecoder().decode(bytes);
            
            try {
                const { configId, methodName, args } = JSON.parse(json);
                const callId = Math.random().toString(36).substr(2, 9);
                
                if (isApiLive(configId) && configId.startsWith('chrome:')) {
                    try {
                        const val = await callRealApi(configId, methodName, args || []);
                        const resultJson = JSON.stringify({ val, callId });
                        const resultBytes = new TextEncoder().encode(resultJson);
                        mockData.set(resultBytes);
                        Atomics.store(mockControlData, 1, resultBytes.length);
                        Atomics.store(mockControlData, 0, 2); // state: result_ready
                        Atomics.notify(mockControlData, 0);
                    } catch (err) {
                        console.error(`Terminal: Real API call failed [${callId}]:`, err);
                        const errorJson = JSON.stringify({ error: err.message, callId });
                        const errorBytes = new TextEncoder().encode(errorJson);
                        mockData.set(errorBytes);
                        Atomics.store(mockControlData, 1, errorBytes.length);
                        Atomics.store(mockControlData, 0, 3); // state: error
                        Atomics.notify(mockControlData, 0);
                    }
                } else {
                    // Normalization for mock calls:
                    // 1. Strip interface name from configId if needed (e.g. chrome:bookmarks/bookmarks -> chrome:bookmarks)
                    const baseConfigId = configId.includes('/') ? configId.split('/')[0] : configId;
                    
                    // 2. Try both kebab-case and camelCase for methodName
                    const camelMethodName = methodName.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
                    
                    console.log(`Terminal: Forwarding mock call ${configId}.${methodName} (as ${camelMethodName}) to sandbox [${callId}]`);
                    sandboxIframe.contentWindow.postMessage({ 
                        type: 'call-mock', 
                        configId: baseConfigId, 
                        methodName: camelMethodName, 
                        originalMethodName: methodName,
                        args, 
                        callId 
                    }, '*');
                }
            } catch (err) {
                console.error('Terminal: Failed to parse or process mock call:', err);
                Atomics.store(mockControlData, 0, 3); // error
                Atomics.notify(mockControlData, 0);
            }
        }
        setTimeout(checkMockCalls, 10);
    };
    checkMockCalls();

    // 6. Handle Direct Execution
    const execCommand = urlParams.get('exec');
    let wasmBytes = null;
    let zigzagCode = null;

    if (execCommand) {
        const item = packetData.items.find((it, idx) => {
            let name = it.name || it.title || `wasm_${idx}`;
            name = name.replace(/[\/\\?%*:|"<>]/g, '_');
            return it.type === 'wasm' && name === execCommand;
        });

        if (item && item.data) {
            try {
                zigzagCode = item.zigCode || null;
                const binaryString = atob(item.data);
                wasmBytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    wasmBytes[i] = binaryString.charCodeAt(i);
                }
                console.log(`Terminal: Prepared direct execution for ${execCommand} (${wasmBytes.length} bytes)`);
            } catch (e) {
                console.error(`Terminal: Failed to decode WASM for ${execCommand}:`, e);
            }
        }
    }

    const isDirectExec = !!wasmBytes;

    if (!isDirectExec) {
        // BBS-style ANSI logo for Wildcard
        const primaryColor = '\x1b[1;38;2;129;140;248m';
        const reset = '\x1b[0m';

        terminal.write('\r\n');
        terminal.write(`${primaryColor} ██╗    ██╗██╗██╗     ██████╗  ██████╗ █████╗ ██████╗ ██████╗ ${reset}\r\n`);
        terminal.write(`${primaryColor} ██║    ██║██║██║     ██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔══██╗${reset}\r\n`);
        terminal.write(`${primaryColor} ██║ █╗ ██║██║██║     ██║  ██║██║     ███████║██████╔╝██║  ██║${reset}\r\n`);
        terminal.write(`${primaryColor} ██║███╗██║██║██║     ██║  ██║██║     ██╔══██║██╔══██╗██║  ██║${reset}\r\n`);
        terminal.write(`${primaryColor} ╚███╔███╔╝██║███████╗██████╔╝╚██████╗██║  ██║██║  ██║██████╔╝${reset}\r\n`);
        terminal.write(`${primaryColor}  ╚══╝╚══╝ ╚═╝╚══════╝╚═════╝  ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ${reset}\r\n`);
        terminal.write('\r\n');
        terminal.write(` \x1b[1;32mPacket: ${packetData.name}\x1b[0m\r\n\r\n`);
    }

    const startWorker = () => {
        worker.postMessage({
            type: 'init',
            packetId,
            packetData,
            inputSAB,
            controlSAB,
            mockControlSAB,
            mockDataSAB,
            wasmBytes,
            execName: execCommand,
            zigCode: zigzagCode
        });
    };

    // Filter mock items to only those selected (not live)
    const mockItems = packetData.items.filter(it => {
        if (it.type !== 'api' || !it.mock_js) return false;
        const base = it.config_id.includes('/') ? it.config_id.split('/')[0] : it.config_id;
        if (isApiLive(it.config_id)) return false; // skip live APIs
        // If selections exist for this base, only load the selected mock
        const selection = mockSelections[base];
        if (selection && selection !== 'live') {
            return it.id === selection;
        }
        return true; // include all mocks if no explicit selection
    });
    if (mockItems.length > 0) {
        console.log(`Terminal: Waiting for ${mockItems.length} mocks before starting worker`);
        mockItems.forEach(it => {
            initMockInSandbox(it.config_id, it.id, it.mock_js);
        });
        
        // Start worker when sandbox and all mocks are ready
        let initializedMocks = 0;
        const initialMockCount = mockItems.length;
        
        window.addEventListener('message', function startListener(e) {
            if (e.data.type === 'mock-initialized') {
                initializedMocks++;
                if (initializedMocks >= initialMockCount) {
                    window.removeEventListener('message', startListener);
                    console.log('Terminal: All mocks ready, starting worker');
                    startWorker();
                }
            }
        });
    } else {
        startWorker();
    }
}

initTerminal().catch(err => {
    console.error('Terminal: Global Error:', err);
});

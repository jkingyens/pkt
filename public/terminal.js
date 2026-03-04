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
    chrome.runtime.sendMessage({
        action: 'registerTerminalTab',
        packetId,
        tabId: (await chrome.tabs.getCurrent())?.id
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

    // 3. Setup SharedArrayBuffer for Input
    let inputSAB = null;
    let controlSAB = null;
    try {
        inputSAB = new SharedArrayBuffer(4096);
        controlSAB = new SharedArrayBuffer(16); // [writeIndex, readIndex, ...]
        console.log('Terminal: SharedArrayBuffer initialized');
    } catch (e) {
        console.error('Terminal: SharedArrayBuffer not supported! Input will fail.', e);
        terminal.write('\r\n\x1b[31mError: SharedArrayBuffer not supported.\x1b[0m\r\n');
        return;
    }

    const inputData = new Uint8Array(inputSAB);
    const controlData = new Int32Array(controlSAB);

    // 4. Start WASI Worker
    const worker = new Worker(new URL('./assets/terminal/terminal-worker.js', import.meta.url), { type: 'module' });

    worker.onmessage = (e) => {
        if (e.data.type === 'stdout') {
            const text = new TextDecoder().decode(e.data.data);
            // Convert LF to CRLF for display (don't convert if already CRLF)
            terminal.write(text.replace(/(?<!\r)\n/g, '\r\n'));
        } else if (e.data.type === 'exit') {
            window.close();
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

    worker.postMessage({
        type: 'init',
        packetId,
        packetData,
        inputSAB,
        controlSAB
    });

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
    terminal.focus();
}

initTerminal().catch(err => {
    console.error('Terminal: Global Error:', err);
});

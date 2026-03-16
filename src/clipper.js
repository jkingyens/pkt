(function () {
    // Flag injection but always proceed to attach listeners (new context after reload)
    window.wildcardClipperInjected = true;

    let isActive = false;
    let isDragging = false;
    let startX, startY;

    let host = null;
    let shadow = null;
    let overlay = null;
    let selection = null;
    let recordingFrame = null;

    function createOverlay() {
        // If a host already exists (e.g., from an orphaned script), remove it
        // to ensure the new script has a clean and responsive UI.
        const existingHost = document.getElementById('wildcard-clipper-host');
        if (existingHost) {
            existingHost.remove();
            // Reset all references to ensure full re-initialization
            host = null;
            shadow = null;
            overlay = null;
            selection = null;
            island = null;
            recordingFrame = null;
        }

        // Create the host element that will hold the shadow root
        host = document.createElement('div');
        host.id = 'wildcard-clipper-host';
        // Ensure the host itself doesn't interfere with the page
        Object.assign(host.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            zIndex: '2147483647',
            pointerEvents: 'none'
        });

        shadow = host.attachShadow({ mode: 'closed' });

        overlay = document.createElement('div');
        overlay.id = 'wildcard-clipper-overlay';
        Object.assign(overlay.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100vw',
            height: '100vh',
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            cursor: 'crosshair',
            pointerEvents: 'none',
            display: 'none'
        });

        selection = document.createElement('div');
        Object.assign(selection.style, {
            position: 'absolute',
            border: '2px solid #ffffff',
            boxShadow: '0 0 0 1px #007bff',
            backgroundColor: 'rgba(0, 123, 255, 0.2)',
            boxSizing: 'border-box',
            display: 'none',
            pointerEvents: 'none'
        });

        recordingFrame = document.createElement('div');
        recordingFrame.id = 'wildcard-recording-frame';
        Object.assign(recordingFrame.style, {
            position: 'absolute',
            boxSizing: 'border-box',
            display: 'none',
            pointerEvents: 'none',
            // Border is outside the recording area
            border: '2px solid #ff4444',
            // Large box-shadow creates the dimming effect
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)',
            zIndex: '2147483646' 
        });

        shadow.appendChild(overlay);
        overlay.appendChild(selection);
        shadow.appendChild(recordingFrame);

        if (document.body) {
            document.body.appendChild(host);
        } else {
            // Wait for body if we injected at document_start and it's not ready
            document.addEventListener('DOMContentLoaded', () => {
                document.body.appendChild(host);
            });
        }
    }

    function onMouseDown(e) {
        if (!isActive) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        selection.style.left = `${startX}px`;
        selection.style.top = `${startY}px`;
        selection.style.width = '0px';
        selection.style.height = '0px';
        selection.style.display = 'block';

        e.preventDefault();
        e.stopPropagation();
    }

    function onMouseMove(e) {
        if (!isDragging) return;

        const currentX = e.clientX;
        const currentY = e.clientY;

        const left = Math.min(startX, currentX);
        const top = Math.min(startY, currentY);
        const width = Math.abs(startX - currentX);
        const height = Math.abs(startY - currentY);

        selection.style.left = `${left}px`;
        selection.style.top = `${top}px`;
        selection.style.width = `${width}px`;
        selection.style.height = `${height}px`;

        e.preventDefault();
        e.stopPropagation();
    }

    function onMouseUp(e) {
        if (!isDragging) return;
        isDragging = false;

        const rect = selection.getBoundingClientRect();
        if (rect.width > 5 && rect.height > 5) {
            safeSendMessage({
                type: 'CLIPPER_REGION_SELECTED',
                region: {
                    x: rect.left,
                    y: rect.top,
                    width: rect.width,
                    height: rect.height,
                    devicePixelRatio: window.devicePixelRatio,
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight
                }
            });
        }
        selection.style.display = 'none';

        e.preventDefault();
        e.stopPropagation();
    }

    function onKeyDown(e) {
        const isRecording = recordingFrame && recordingFrame.style.display === 'block';
        if (e.key === 'Escape' && (isActive || isRecording)) {
            safeSendMessage({ type: 'CLIPPER_CANCELLED' });
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            // Keyboard Proxy: Send arrow keys to background even if clipper is not active
            // The sidebar will decide whether to act on them
            safeSendMessage({
                type: 'PROXY_KEY_DOWN',
                key: e.key,
                shiftKey: e.shiftKey,
                altKey: e.altKey,
                ctrlKey: e.ctrlKey,
                metaKey: e.metaKey
            });
        }
    }

    function safeSendMessage(message, callback) {
        try {
            if (!chrome.runtime?.id) {
                console.warn('[Wildcard] Extension context invalidated. Please refresh the page.');
                return;
            }
            chrome.runtime.sendMessage(message, callback);
        } catch (e) {
            if (e.message.includes('Extension context invalidated')) {
                console.warn('[Wildcard] Extension context invalidated. Please refresh the page.');
            } else {
                console.error('[Wildcard] Send message failed:', e);
            }
        }
    }

    let island = null;
    let isRecording = false;

    function createDynamicIsland() {
        if (island) return;

        island = document.createElement('iframe');
        island.id = 'wildcard-dynamic-island';
        island.src = chrome.runtime.getURL('src/island.html');
        Object.assign(island.style, {
            position: 'fixed',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '200px',
            height: '40px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '20px',
            zIndex: '2147483647',
            boxShadow: '0 4px 20px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05), 0 0 15px rgba(255,255,255,0.05)',
            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            overflow: 'hidden',
            backgroundColor: '#000000',
            pointerEvents: 'auto'
        });

        shadow.appendChild(island);

        // Listen for messages from the island
        window.addEventListener('message', (event) => {
            if (event.data.type === 'ISLAND_EXPAND') {
                island.style.width = event.data.expand ? '220px' : '200px';
                if (event.data.height) {
                    island.style.height = event.data.height + 'px';
                } else {
                    island.style.height = '40px';
                }
            } else if (event.data.type === 'ESCAPE_PRESSED') {
                safeSendMessage({ type: 'CLIPPER_CANCELLED' });
            }
        });
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'SET_CLIPPER_ACTIVE') {
            isActive = message.active;
            const isIslandOnly = !!message.islandOnly;

            if (isActive) {
                createOverlay();
                createDynamicIsland();
                
                if (isIslandOnly) {
                    overlay.style.display = 'none';
                    overlay.style.pointerEvents = 'none';
                } else {
                    overlay.style.display = 'block';
                    overlay.style.pointerEvents = 'auto';
                    // Attach listeners to the overlay specifically to capture events before the page
                    overlay.addEventListener('mousedown', onMouseDown, true);
                    overlay.addEventListener('mousemove', onMouseMove, true);
                    overlay.addEventListener('mouseup', onMouseUp, true);
                }
                
                island.style.display = 'block';
                window.addEventListener('keydown', onKeyDown, true);
            } else {
                if (overlay) {
                    overlay.style.display = 'none';
                    overlay.style.pointerEvents = 'none';
                    overlay.removeEventListener('mousedown', onMouseDown, true);
                    overlay.removeEventListener('mousemove', onMouseMove, true);
                    overlay.removeEventListener('mouseup', onMouseUp, true);
                }
                if (island) {
                    island.style.display = 'none';
                    // Force stop recording if active
                    island.contentWindow.postMessage({ type: 'STOP_RECORDING_FORCE' }, '*');
                }
                if (selection) {
                    selection.style.display = 'none';
                }
                window.removeEventListener('keydown', onKeyDown, true);
                isDragging = false;
            }
            sendResponse({ success: true });
        } else if (message.type === 'SET_RECORDING_OVERLAY') {
            if (message.active && message.region) {
                createOverlay(); // Ensure exists
                const r = message.region;
                Object.assign(recordingFrame.style, {
                    display: 'block',
                    left: `${r.x - 2}px`,
                    top: `${r.y - 2}px`,
                    width: `${r.width + 4}px`,
                    height: `${r.height + 4}px`
                });
            } else if (recordingFrame) {
                recordingFrame.style.display = 'none';
            }
            sendResponse({ success: true });
        }
    });

    // Always listen for keydown to support keyboard proxying
    window.addEventListener('keydown', onKeyDown, true);

    console.log('[Wildcard] Clipper content script initialized with Shadow DOM');
})();

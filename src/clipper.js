(function () {
    if (window.wildcardClipperInjected) return;
    window.wildcardClipperInjected = true;

    let isActive = false;
    let isDragging = false;
    let startX, startY;

    let host = null;
    let shadow = null;
    let overlay = null;
    let selection = null;

    function createOverlay() {
        if (host) return;

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
            backgroundColor: 'rgba(0, 0, 0, 0.3)',
            cursor: 'crosshair',
            pointerEvents: 'none',
            display: 'none'
        });

        selection = document.createElement('div');
        Object.assign(selection.style, {
            position: 'absolute',
            border: '2px dashed #007bff',
            backgroundColor: 'rgba(0, 123, 255, 0.1)',
            boxSizing: 'border-box',
            display: 'none',
            pointerEvents: 'none'
        });

        shadow.appendChild(overlay);
        overlay.appendChild(selection);
        document.body.appendChild(host);
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
            chrome.runtime.sendMessage({
                type: 'CLIPPER_REGION_SELECTED',
                region: {
                    x: rect.left,
                    y: rect.top,
                    width: rect.width,
                    height: rect.height,
                    devicePixelRatio: window.devicePixelRatio
                }
            });
        }
        selection.style.display = 'none';

        e.preventDefault();
        e.stopPropagation();
    }

    function onKeyDown(e) {
        if (e.key === 'Escape' && isActive) {
            chrome.runtime.sendMessage({ type: 'CLIPPER_CANCELLED' });
            e.preventDefault();
            e.stopPropagation();
        }
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'SET_CLIPPER_ACTIVE') {
            isActive = message.active;
            if (isActive) {
                createOverlay();
                overlay.style.display = 'block';
                overlay.style.pointerEvents = 'auto';
                // Attach listeners to the overlay specifically to capture events before the page
                overlay.addEventListener('mousedown', onMouseDown, true);
                overlay.addEventListener('mousemove', onMouseMove, true);
                overlay.addEventListener('mouseup', onMouseUp, true);
                window.addEventListener('keydown', onKeyDown, true);
            } else {
                if (overlay) {
                    overlay.style.display = 'none';
                    overlay.style.pointerEvents = 'none';
                    overlay.removeEventListener('mousedown', onMouseDown, true);
                    overlay.removeEventListener('mousemove', onMouseMove, true);
                    overlay.removeEventListener('mouseup', onMouseUp, true);
                }
                if (selection) {
                    selection.style.display = 'none';
                }
                window.removeEventListener('keydown', onKeyDown, true);
                isDragging = false;
            }
        }
    });

    console.log('[WildcardCX] Clipper content script initialized with Shadow DOM');
})();

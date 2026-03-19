(async () => {
    const params = new URLSearchParams(window.location.search);
    const resourceId = params.get('id');
    const name = params.get('name') || 'Local Page';

    const iframe = document.getElementById('content-frame');
    const loading = document.getElementById('loading');

    if (!resourceId) {
        loading.innerHTML = '<div class="error">No resource ID provided.</div>';
        return;
    }

    let saveTimeout = null;
    let isDirty = false;

    async function saveContent() {
        if (!isDirty) return;
        
        try {
            // Clone the document to strip transient states before saving
            const docClone = iframe.contentDocument.cloneNode(true);
            
            // Cleanup any UI state before saving (be generic)
            const body = docClone.body;
            if (body) {
                body.classList.remove('dark-mode');
            }

            const formatToggle = docClone.getElementById('format-toggle');
            if (formatToggle) {
                // We keep the toggle, but maybe reset its hover state if any classes were added
            }

            // Remove any selection ranges
            const selection = iframe.contentWindow.getSelection();
            if (selection) selection.removeAllRanges();

            const htmlContent = '<!DOCTYPE html>\n' + docClone.documentElement.outerHTML;
            const encoder = new TextEncoder();

            const data = encoder.encode(htmlContent);

            await chrome.runtime.sendMessage({
                action: 'saveMediaBlob',
                id: resourceId,
                data: Array.from(new Uint8Array(data)),
                type: 'text/html'
            });
            
            isDirty = false;
            console.log('[Viewer] Auto-save complete');
        } catch (err) {
            console.error('[Viewer] Auto-save failed:', err);
        }
    }

    function scheduleSave() {
        isDirty = true;
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(saveContent, 2000); // 2 second debounce
    }

    try {
        const resp = await chrome.runtime.sendMessage({ action: 'getMediaBlob', id: resourceId });
        if (!resp || !resp.success) {
            throw new Error(resp?.error || 'Failed to load page content');
        }

        const uint8Array = new Uint8Array(resp.data);
        const htmlContent = new TextDecoder().decode(uint8Array);
        
        document.title = `${name} - Wildcard`;
        iframe.onload = () => {
            console.log('[Viewer] iframe loaded');
            loading.classList.add('hidden');
            iframe.classList.remove('hidden');

            // Setup MutationObserver for auto-save
            const observer = new MutationObserver((mutations) => {
                scheduleSave();
            });

            observer.observe(iframe.contentDocument.body, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true
            });
        };

        iframe.srcdoc = htmlContent;

        // Final save on close
        window.addEventListener('beforeunload', () => {
            if (isDirty) {
                // Use beacon or sync message if possible, 
                // but for extensions sendMessage usually works or we just lose the last 2s.
                // Since this is a local tab, it's usually fine.
                saveContent();
            }
        });

    } catch (err) {
        console.error('Local page load failed:', err);
        loading.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    }

    // Add keyboard listener for stack navigation
    window.addEventListener('keydown', (e) => {
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
    });

    // Bridge theme changes from extension to srcdoc iframe
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes.theme) {
                const newTheme = changes.theme.newValue;
                console.log('[Viewer] Theme changed, bridging to iframe:', newTheme);
                if (iframe && iframe.contentWindow) {
                    iframe.contentWindow.postMessage({
                        type: 'THEME_CHANGE',
                        theme: newTheme
                    }, '*');
                }
            }
        });
    }

})();

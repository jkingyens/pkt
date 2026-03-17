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
            const btn = docClone.getElementById('edit-toggle-btn');
            const content = docClone.getElementById('editable-content');
            const icon = docClone.getElementById('btn-icon');
            const text = docClone.getElementById('btn-text');

            if (btn) btn.classList.remove('active');
            if (content) content.contentEditable = 'false';
            if (icon) icon.textContent = '✏️';
            if (text) text.textContent = 'Edit Page';

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
        iframe.srcdoc = htmlContent;
        
        iframe.onload = () => {
            loading.classList.add('hidden');
            iframe.classList.remove('hidden');

            // Setup MutationObserver for auto-save
            const observer = new MutationObserver((mutations) => {
                // Ignore changes to the edit button or scripts themselves 
                // if they happen, but usually edits are inside #editable-content
                scheduleSave();
            });

            observer.observe(iframe.contentDocument.body, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true
            });
        };

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

})();

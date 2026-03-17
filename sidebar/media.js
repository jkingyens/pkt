(async () => {
    const params = new URLSearchParams(window.location.search);
    const mediaId = params.get('id');
    const mimeType = params.get('type');
    const name = params.get('name') || 'Media';

    const container = document.getElementById('container');
    const loading = document.getElementById('loading');

    if (!mediaId) {
        loading.innerHTML = '<div class="error">No media ID provided.</div>';
        return;
    }

    try {
        const resp = await chrome.runtime.sendMessage({ action: 'getMediaBlob', id: mediaId });
        if (!resp || !resp.success) {
            throw new Error(resp?.error || 'Failed to load media');
        }

        const rawData = resp.data;
        const uint8Array = rawData instanceof Uint8Array ? rawData : 
                           (rawData && typeof rawData === 'object' ? new Uint8Array(Object.values(rawData)) : 
                           new Uint8Array(rawData));

        console.log('[Media] Received data, type:', resp.type, 'size:', uint8Array.byteLength);
        const blob = new Blob([uint8Array], { type: resp.type || mimeType });
        const url = URL.createObjectURL(blob);
        loading.remove();

        // Update title
        document.title = `${name} - Wildcard`;

        const info = document.createElement('div');
        info.className = 'info';
        info.innerHTML = `<h2>${name}</h2><div class="meta">${blob.type}</div>`;

        if (blob.type.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = url;
            container.appendChild(img);
        } else if (blob.type.startsWith('video/')) {
            const video = document.createElement('video');
            video.src = url;
            video.controls = true;
            video.autoplay = true;
            
            video.onerror = () => {
                const err = video.error;
                console.error('[Media] Video error:', err.code, err.message);
                const errorMsg = document.createElement('div');
                errorMsg.className = 'error';
                errorMsg.textContent = `Video Playback Error: ${err.message || 'Unknown error'}`;
                container.appendChild(errorMsg);
            };

            video.onloadeddata = () => console.log('[Media] Video data loaded');
            video.onplay = () => console.log('[Media] Video started playing');
            
            container.appendChild(video);
        } else if (blob.type.startsWith('audio/')) {
            const audio = document.createElement('audio');
            audio.src = url;
            audio.controls = true;
            audio.autoplay = true;
            container.appendChild(audio);
        } else {
            loading.innerHTML = `<div class="error">Unsupported media type: ${blob.type}</div>`;
            return;
        }

        container.appendChild(info);

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

    } catch (err) {
        console.error('Media preview failed:', err);
        loading.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    }
})();

/**
 * Dynamic Island Logic
 * Runs inside the iframe (extension context)
 */

let isRecording = false;
let startTime = 0;
let timerInterval = null;

const timerEl = document.getElementById('timer');
const indicator = document.getElementById('indicator');
const recordBtn = document.getElementById('record-btn');
const recordVideoBtn = document.getElementById('record-video-btn');
const clipBtn = document.getElementById('clip-btn');
const stopBtn = document.getElementById('stop-btn');
const clipOptions = document.getElementById('clip-options');
const clipImageBtn = document.getElementById('clip-image-btn');
const clipVideoBtn = document.getElementById('clip-video-btn');

recordBtn.onclick = () => toggleRecording(false);
recordVideoBtn.onclick = () => toggleRecording(true);
clipBtn.onclick = () => {
    clipOptions.style.display = clipOptions.style.display === 'flex' ? 'none' : 'flex';
    const isExpanded = clipOptions.style.display === 'flex';
    window.parent.postMessage({ 
        type: 'ISLAND_EXPAND', 
        expand: isExpanded,
        height: isExpanded ? 130 : 40 
    }, '*');
};
clipImageBtn.onclick = () => activateClipper(false);
clipVideoBtn.onclick = () => activateClipper(true);
stopBtn.onclick = () => toggleRecording();

function activateClipper(isVideo) {
    clipOptions.style.display = 'none';
    window.parent.postMessage({ type: 'ISLAND_EXPAND', expand: false }, '*');
    safeSendMessage({ type: 'ACTIVATE_CLIPPER_OVERLAY', isVideo });
}

async function toggleRecording(isVideo = false) {
    if (!isRecording) {
        // Immediate visual feedback
        timerEl.textContent = 'Starting...';
        recordBtn.style.display = 'none';
        recordVideoBtn.style.display = 'none';

        try {
            console.log('[Island] Querying active tab...');
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (!tab) throw new Error('Could not identify active tab');

            console.log('[Island] Requesting streamId for tab:', tab.id);
            // Obtain streamId directly in the extension page context responding to user gesture
            const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
            console.log('[Island] Obtained streamId:', streamId);

            if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
                throw new Error('Chrome internal pages cannot be recorded');
            }

            console.log('[Island] Sending START_AUDIO_RECORDING to background');
            safeSendMessage({ action: isVideo ? 'START_TAB_VIDEO_RECORDING' : 'START_AUDIO_RECORDING', streamId }, (resp) => {
                if (resp && resp.success) {
                    console.log('[Island] Background confirmed recording started');
                    isRecording = true;
                    startTime = Date.now();
                    updateUI();
                    window.parent.postMessage({ type: 'ISLAND_EXPAND', expand: true, height: 40 }, '*');
                } else if (resp) {
                    throw new Error(resp.error || 'Failed to start in background');
                }
            });
        } catch (err) {
            console.error('[Wildcard] Start recording failed:', err);
            if (err.message.includes('invoked')) {
                timerEl.textContent = 'Right-click page -> Wildcard';
            } else {
                timerEl.textContent = 'Error: Check Permission';
            }
            timerEl.style.color = '#ff453a';
            recordBtn.style.display = 'block'; // Restore button on error
            recordVideoBtn.style.display = 'block';
            window.parent.postMessage({ type: 'ISLAND_EXPAND', expand: true, height: 40 }, '*');
            setTimeout(() => {
                if (!isRecording) {
                    timerEl.textContent = 'Wildcard';
                    timerEl.style.color = 'white';
                    window.parent.postMessage({ type: 'ISLAND_EXPAND', expand: false, height: 40 }, '*');
                }
            }, 5000);
        }
    } else {
        // Stop
        console.log('[Island] Stop button clicked. Sending STOP_AUDIO_RECORDING.');
        safeSendMessage({ action: 'STOP_AUDIO_RECORDING' }, (resp) => {
            console.log('[Island] Stop confirmation from background:', resp);
            if (resp && resp.success) {
                isRecording = false;
                clearInterval(timerInterval);
                updateUI();
                window.parent.postMessage({ type: 'ISLAND_EXPAND', expand: false, height: 40 }, '*');
            }
        });
    }
}

function safeSendMessage(message, callback) {
    try {
        if (!chrome.runtime?.id) {
            handleInvalidatedContext();
            return;
        }
        chrome.runtime.sendMessage(message, (resp) => {
            if (chrome.runtime.lastError) {
                if (chrome.runtime.lastError.message.includes('context invalidated')) {
                    handleInvalidatedContext();
                } else {
                    console.error('[Wildcard] Send message error:', chrome.runtime.lastError);
                }
                return;
            }
            if (callback) callback(resp);
        });
    } catch (e) {
        if (e.message.includes('context invalidated')) {
            handleInvalidatedContext();
        } else {
            console.error('[Wildcard] Send message failed:', e);
        }
    }
}

function handleInvalidatedContext() {
    indicator.style.display = 'none';
    timerEl.textContent = 'Refresh Page';
    timerEl.style.color = '#ff453a';
    recordBtn.style.display = 'none';
    stopBtn.style.display = 'none';
}

// Global listeners
window.addEventListener('message', (event) => {
    if (event.data.type === 'STOP_RECORDING_FORCE') {
        console.log('[Island] Received STOP_RECORDING_FORCE message from parent.');
        if (isRecording) {
            toggleRecording(); // This will handle sending STOP_AUDIO_RECORDING and updating UI
        }
    }
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'AUDIO_RECORDING_REMOTE_START') {
        if (!isRecording) {
            isRecording = true;
            startTime = Date.now();
            updateUI();
            window.parent.postMessage({ type: 'ISLAND_EXPAND', expand: true, height: 40 }, '*');
        }
    } else if (message.type === 'AUDIO_CLIP_FINISHED' || message.type === 'VIDEO_CLIP_FINISHED') {
        if (isRecording) {
            isRecording = false;
            clearInterval(timerInterval);
            updateUI();
            window.parent.postMessage({ type: 'ISLAND_EXPAND', expand: false, height: 40 }, '*');
        }
    } else if (message.type === 'RECORDING_ERROR') {
        timerEl.textContent = message.error;
        timerEl.style.color = '#ff453a';
        isRecording = false;
        clearInterval(timerInterval);
        updateUI();
        setTimeout(() => {
            timerEl.textContent = 'Wildcard';
            timerEl.style.color = 'white';
        }, 5000);
    }
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isRecording) {
        toggleRecording();
    }
});

function updateUI() {
    if (isRecording) {
        indicator.style.display = 'block';
        recordBtn.style.display = 'none';
        recordVideoBtn.style.display = 'none';
        stopBtn.style.display = 'block';

        // Initial text for recording
        timerEl.textContent = 'REC 00:00';

        timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const secs = String(elapsed % 60).padStart(2, '0');
            timerEl.textContent = `REC ${mins}:${secs}`;
            indicator.style.opacity = indicator.style.opacity === '1' ? '0.3' : '1';
            indicator.style.transition = 'opacity 0.5s';
        }, 1000);
    } else {
        indicator.style.display = 'none';
        recordBtn.style.display = 'block';
        recordVideoBtn.style.display = 'block';
        stopBtn.style.display = 'none';
        timerEl.textContent = 'Wildcard';
        clearInterval(timerInterval);
    }
}

// Initialize UI state
updateUI();

function log(msg, ...args) {
    chrome.runtime.sendMessage({
        type: 'OFFSCREEN_LOG',
        message: msg,
        timestamp: new Date().toISOString()
    });
    console.log(msg, ...args);
}

let recorder;
let data = [];

chrome.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'START_RECORDING') {
        startRecording(message.streamId);
    } else if (message.type === 'STOP_RECORDING') {
        stopRecording();
    }
});

async function startRecording(streamId) {
    if (recorder && recorder.state !== 'inactive') return;

    log('[Offscreen] Starting recording with streamId:', streamId);
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            },
            video: false
        });

        log('[Offscreen] Stream obtained, tracks:', stream.getTracks().length);

        // Continue playing audio in the tab while recording
        const output = new AudioContext();
        const source = output.createMediaStreamSource(stream);
        source.connect(output.destination);

        recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        data = [];

        recorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                log('[Offscreen] Data available, size: ' + event.data.size);
                data.push(event.data);
            }
        };

        recorder.onstop = () => {
            log('[Offscreen] Recorder stopped, total chunks: ' + data.length);
            const blob = new Blob(data, { type: 'audio/webm' });
            log('[Offscreen] Blob created, size: ' + blob.size);
            const reader = new FileReader();
            reader.onload = () => {
                log('[Offscreen] Sending AUDIO_RECORDING_RESULT to background');
                chrome.runtime.sendMessage({
                    type: 'AUDIO_RECORDING_RESULT',
                    dataUrl: reader.result
                });
            };
            reader.readAsDataURL(blob);

            // Clean up
            stream.getTracks().forEach(t => {
                log('[Offscreen] Stopping track: ' + t.label);
                t.stop();
            });
        };

        recorder.start();
        log('[Offscreen] Recorder started, state: ' + recorder.state);
        chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });
    } catch (e) {
        log('[Offscreen] recording failed: ' + e.message);
        chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: e.message });
    }
}

function stopRecording() {
    log('[Offscreen] stopRecording requested, state: ' + (recorder?.state || 'undefined'));
    if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
        log('[Offscreen] recorder.stop() called');
    } else {
        log('[Offscreen] recorder.stop() NOT called: state is ' + (recorder?.state || 'undefined'));
    }
}

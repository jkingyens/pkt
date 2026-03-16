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
        startRecording(message.streamId, message.isVideo, message.region);
    } else if (message.type === 'START_MIC_RECORDING') {
        startMicRecording(message.video);
    } else if (message.type === 'STOP_RECORDING') {
        stopRecording();
    }
});

async function startMicRecording(isVideo = false) {
    if (recorder && recorder.state !== 'inactive') return;

    log(`[Offscreen] Starting ${isVideo ? 'video' : 'microphone'} recording`);
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: isVideo
        });

        log('[Offscreen] Mic stream obtained. Waiting for stabilization...');
        await new Promise(r => setTimeout(r, 500));
        setupRecorder(stream, isVideo);
    } catch (e) {
        log(`[Offscreen] Mic recording failed. Name: ${e.name}, Message: ${e.message}`);
        chrome.runtime.sendMessage({
            type: 'RECORDING_ERROR',
            error: `${e.name}: ${e.message}`
        });
    }
}

let recordingStartTime = 0;

function setupRecorder(stream, isVideo) {
    // Simplified mimeType selection for maximum compatibility
    const options = {
        mimeType: isVideo ? 'video/webm' : 'audio/webm'
    };

    if (isVideo && MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) {
        options.mimeType = 'video/webm;codecs=vp8,opus';
    }

    log(`[Offscreen] Initializing MediaRecorder: ${options.mimeType}`);
    
    try {
        recorder = new MediaRecorder(stream, options);
    } catch (e) {
        log('[Offscreen] MediaRecorder init failed: ' + e.message + ', falling back to default');
        recorder = new MediaRecorder(stream);
    }
    
    data = [];
    recordingStartTime = Date.now();

    recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            data.push(event.data);
            log(`[Offscreen] Received chunk: ${event.data.size} bytes`);
        }
    };

    recorder.onstop = async () => {
        const duration = Date.now() - recordingStartTime;
        log(`[Offscreen] Recorder stopped. Duration: ${duration}ms, Chunks: ${data.length}`);
        
        if (duration < 1000) {
            log('[Offscreen] Short recording detected, allowing buffer to flush...');
            await new Promise(r => setTimeout(r, 200));
        }

        if (data.length === 0) {
            log('[Offscreen] CRITICAL: No data captured!');
        }
        
        const blob = new Blob(data, { type: options.mimeType });
        log(`[Offscreen] Created Blob: ${blob.size} bytes, ${blob.type}. Saving...`);
        
        // Save directly via SW to minimize hops for large data
        try {
            const arrayBuffer = await blob.arrayBuffer();
            const resp = await chrome.runtime.sendMessage({
                action: 'saveMediaBlob',
                data: new Uint8Array(arrayBuffer),
                type: blob.type
            });

            if (resp && resp.success) {
                log(`[Offscreen] Media saved successfully: ${resp.id}`);
                chrome.runtime.sendMessage({
                    type: isVideo ? 'VIDEO_CLIP_FINISHED' : 'AUDIO_CLIP_FINISHED',
                    mediaId: resp.id,
                    size: resp.size,
                    mimeType: blob.type
                });
            } else {
                throw new Error(resp?.error || 'Save failed');
            }
        } catch (e) {
            log(`[Offscreen] Failed to save media: ${e.message}`);
            chrome.runtime.sendMessage({ type: 'RECORDING_ERROR', error: 'Failed to save media: ' + e.message });
        }

        stream.getTracks().forEach(t => t.stop());
        const preview = document.getElementById('offscreen-preview');
        if (preview) preview.remove();
    };

    // No timeslice - better for ensuring valid headers at the start of the first chunk
    recorder.start();

    log('[Offscreen] Recorder started');
    chrome.runtime.sendMessage({ type: 'RECORDING_STARTED', isVideo });
}

async function startRecording(streamId, isVideo = false, region = null) {
    if (recorder && recorder.state !== 'inactive') return;

    log('[Offscreen] Starting recording with streamId:', streamId, 'isVideo:', isVideo);
    try {
        const constraints = {
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            }
        };

        if (isVideo) {
            // Modern constraint format
            constraints.video = {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId,
                    maxWidth: 1280,
                    maxHeight: 720
                },
                optional: [
                    { minFrameRate: 30 }
                ]
            };
        }

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        log(`[Offscreen] Stream obtained: ${stream.id}, Active: ${stream.active}`);
        
        // 1. Force 720p if needed and await it
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
            log('[Offscreen] Video track found, checking constraints...');
            const settings = videoTrack.getSettings();
            if (settings.width > 1280 || settings.height > 720) {
                log(`[Offscreen] Current resolution ${settings.width}x${settings.height} > 720p. Forcing...`);
                try {
                    await videoTrack.applyConstraints({
                        width: { ideal: 1280, max: 1280 },
                        height: { ideal: 720, max: 720 }
                    });
                    log('[Offscreen] Constraints applied successfully');
                } catch (e) {
                    log('[Offscreen] applyConstraints failed: ' + e.message);
                }
            }
        }

        // 2. Attach to DOM and wait for real frames
        if (isVideo) {
            const v = document.createElement('video');
            v.id = 'offscreen-preview';
            v.srcObject = stream;
            v.muted = true;
            v.autoplay = true;
            v.style.position = 'fixed';
            v.style.bottom = '0';
            v.style.right = '0';
            v.style.width = '320px';
            v.style.height = '180px';
            v.style.opacity = '0.01';
            v.style.pointerEvents = 'none';
            document.body.appendChild(v);

            log('[Offscreen] Waiting for video dimensions...');
            await new Promise((resolve) => {
                const startTime = Date.now();
                const check = () => {
                    if (v.videoWidth > 0) {
                        log(`[Offscreen] Video dimensions ready: ${v.videoWidth}x${v.videoHeight}`);
                        resolve();
                    } else if (Date.now() - startTime > 3000) {
                        log('[Offscreen] Timeout waiting for video dimensions, starting anyway...');
                        resolve();
                    } else {
                        setTimeout(check, 100);
                    }
                };
                check();
            });
            await v.play().catch(e => log('[Offscreen] Preview playback error: ' + e.message));
        }

        // Small stabilization delay
        await new Promise(r => setTimeout(r, 500));
        
        let finalStream = stream;

        // Apply cropping if region is provided
        if (isVideo && region) {
            log('[Offscreen] Applying cropping to video stream:', JSON.stringify(region));
            const canvas = document.createElement('canvas');
            const dpr = region.devicePixelRatio || 1;
            
            // Use the video element's actual dimensions to calculate the scale
            // tabCapture might be at a different resolution than the CSS pixels
            const v = document.getElementById('offscreen-preview');
            const scaleX = v.videoWidth / (region.viewportWidth || 1280);
            const scaleY = v.videoHeight / (region.viewportHeight || 720);
            
            log(`[Offscreen] Video resolution: ${v.videoWidth}x${v.videoHeight}, Viewport: ${region.viewportWidth}x${region.viewportHeight}, Scale: ${scaleX}, ${scaleY}`);

            canvas.width = region.width * scaleX;
            canvas.height = region.height * scaleY;
            const ctx = canvas.getContext('2d');
            
            const cropStream = canvas.captureStream(30);
            
            let drawInterval = setInterval(() => {
                if (!finalStream.active) {
                    clearInterval(drawInterval);
                    return;
                }
                try {
                    ctx.drawImage(
                        v,
                        region.x * scaleX,
                        region.y * scaleY,
                        region.width * scaleX,
                        region.height * scaleY,
                        0,
                        0,
                        canvas.width,
                        canvas.height
                    );
                } catch (e) {
                    log('[Offscreen] drawImage error:', e.message);
                }
            }, 1000 / 30);
            
            // Reconstruct stream with cropped video and original audio
            const tracks = [];
            const canvasTracks = cropStream.getVideoTracks();
            const audioTracks = stream.getAudioTracks();
            
            log(`[Offscreen] Tracks found - Canvas Video: ${canvasTracks.length}, Original Audio: ${audioTracks.length}`);
            
            if (canvasTracks.length > 0) tracks.push(canvasTracks[0]);
            if (audioTracks.length > 0) tracks.push(audioTracks[0]);
            
            finalStream = new MediaStream(tracks);
            log('[Offscreen] Cropping loop and final stream initialized');
        }

        // Continue playing audio in the tab while recording
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
            const output = new AudioContext();
            const source = output.createMediaStreamSource(new MediaStream(audioTracks));
            source.connect(output.destination);
            log('[Offscreen] Audio playback connected');
        }

        setupRecorder(finalStream, isVideo);
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

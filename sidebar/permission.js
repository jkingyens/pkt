document.getElementById('requestBtn').addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        stream.getTracks().forEach(t => t.stop());
        window.close();
    } catch (err) {
        alert('Permission denied. Please check your browser settings and try again.');
        console.error(err);
    }
});

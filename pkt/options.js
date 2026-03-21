import { initTheme } from './theme.js';

initTheme();

const themeSelect = document.getElementById('theme-select');

chrome.storage.local.get('theme').then(({ theme = 'system' }) => {
    themeSelect.value = theme;
});

themeSelect.addEventListener('change', (e) => {
    const theme = e.target.value;
    chrome.storage.local.set({ theme });
});

const reqBtn = document.getElementById('request-camera-btn');
const statusText = document.getElementById('camera-status');

async function checkPermissions() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(t => t.stop());
        statusText.textContent = '✅ Permission Granted';
        statusText.style.color = '#1e8e3e';
    } catch (e) {
        statusText.textContent = '❌ Permission Not Granted';
        statusText.style.color = 'var(--danger-color)';
    }
}

checkPermissions();

reqBtn.onclick = async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(t => t.stop());
        statusText.textContent = '✅ Permission Granted';
        statusText.style.color = '#1e8e3e';
    } catch (e) {
        alert('Permission denied. Please check your browser settings.');
    }
};

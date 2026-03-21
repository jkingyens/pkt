import { getPackets, savePackets, addPacket, updatePacket, deletePacket } from './storage.js';
import { initTheme } from './theme.js';

initTheme();

let currentPacketId = null;

const rootMenu = document.getElementById('root-menu');
const packetDetail = document.getElementById('packet-detail');
const packetList = document.getElementById('packet-list');
const linkList = document.getElementById('link-list');
const detailTitle = document.getElementById('detail-title');
const modeCheckbox = document.getElementById('mode-checkbox');

detailTitle.onclick = async () => {
    if (!currentPacketId) return;
    const packets = await getPackets();
    const packet = packets.find(p => p.id === currentPacketId);
    if (packet && packet.mode === 'edit') {
        const newName = prompt('New Packet Name:', packet.name);
        if (newName && newName !== packet.name) {
            packet.name = newName;
            detailTitle.textContent = newName;
            await updatePacket(packet);
            chrome.runtime.sendMessage({ action: 'renamePacket', packetId: currentPacketId, name: newName });
        }
    }
};

const shareModal = document.getElementById('share-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const scanBtn = document.getElementById('scan-btn');
const scannerModal = document.getElementById('scanner-modal');
const closeScannerBtn = document.getElementById('close-scanner-btn');
const scannerVideo = document.getElementById('scanner-video');

let scannerStream = null;
let scannerInterval = null;

closeModalBtn.onclick = () => {
    shareModal.classList.add('hidden');
};

closeScannerBtn.onclick = () => {
    stopScanner();
};

window.onclick = (event) => {
    if (event.target === shareModal) {
        shareModal.classList.add('hidden');
    }
    if (event.target === scannerModal) {
        stopScanner();
    }
};

async function renderRootMenu() {
    const packets = await getPackets();
    packetList.innerHTML = '';
    
    if (packets.length === 0) {
        packetList.innerHTML = '<div style="color:#5f6368;font-size:13px;text-align:center;">No packets found.</div>';
    }

    for (const packet of packets) {
        const item = document.createElement('div');
        item.className = 'packet-item';
        
        const titleSpan = document.createElement('span');
        titleSpan.textContent = packet.name;
        item.appendChild(titleSpan);
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.textContent = 'Delete';
        deleteBtn.onclick = async (e) => {
            e.stopPropagation();
            if (confirm(`Delete packet "${packet.name}"?`)) {
                await deletePacket(packet.id);
                renderRootMenu();
            }
        };
        item.appendChild(deleteBtn);

        item.onclick = () => openPacketDetail(packet.id);
        packetList.appendChild(item);
    }
}

async function openPacketDetail(packetId) {
    currentPacketId = packetId;
    const packets = await getPackets();
    const packet = packets.find(p => p.id === packetId);
    if (!packet) return;

    detailTitle.textContent = packet.name;
    detailTitle.classList.toggle('editable', packet.mode === 'edit');
    modeCheckbox.checked = packet.mode === 'edit';
    
    const addTabBtn = document.getElementById('add-tab-btn');
    const shareBtn = document.getElementById('share-btn');
    if (packet.mode === 'edit') {
        addTabBtn.classList.remove('hidden');
        shareBtn.classList.add('hidden');
    } else {
        addTabBtn.classList.add('hidden');
        shareBtn.classList.remove('hidden');
    }
    
    await chrome.storage.local.set({ activePacketId: packetId });
    chrome.runtime.sendMessage({ action: 'openPacketGroup', packetId });

    renderLinkList(packet);

    rootMenu.classList.add('hidden');
    packetDetail.classList.remove('hidden');
}

function renderLinkList(packet, animate = false) {
    const oldRects = {};
    if (animate) {
        for (const child of linkList.children) {
            const id = child.getAttribute('data-id');
            if (id) {
                oldRects[id] = child.getBoundingClientRect();
            }
        }
    }

    linkList.innerHTML = '';
    if (!packet.links || packet.links.length === 0) {
        linkList.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;text-align:center;">No links yet.</div>';
    }

    for (const link of (packet.links || [])) {
        const item = document.createElement('div');
        item.className = 'link-item';
        item.setAttribute('data-id', link.id);
        
        // Thumbnail
        const thumbnail = document.createElement('div');
        thumbnail.className = 'link-thumbnail';
        const img = document.createElement('img');
        img.src = `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(link.url)}&size=128`;
        img.onerror = () => { img.src = 'icons/default_favicon.png'; }; // Placeholder if needed
        thumbnail.appendChild(img);
        item.appendChild(thumbnail);

        // Content
        const content = document.createElement('div');
        content.className = 'link-content';

        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = link.title || link.url;
        content.appendChild(title);
        
        const url = document.createElement('div');
        url.className = 'url';
        url.textContent = link.url;
        content.appendChild(url);
        
        item.appendChild(content);

        // Actions (Delete button)
        if (packet.mode === 'edit') {
            const actions = document.createElement('div');
            actions.style.display = 'flex';
            actions.style.alignItems = 'center';

            const delBtn = document.createElement('button');
            delBtn.textContent = '✕';
            delBtn.style.padding = '0';
            delBtn.style.background = 'transparent';
            delBtn.style.border = 'none';
            delBtn.style.boxShadow = 'none';
            delBtn.style.color = 'var(--danger-color)';
            delBtn.style.fontSize = '16px';
            delBtn.style.cursor = 'pointer';
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                if(confirm('Remove this link from packet?')) {
                    const packets = await getPackets();
                    const p = packets.find(px => px.id === packet.id);
                    if (p) {
                        p.links = p.links.filter(l => l.id !== link.id);
                        await updatePacket(p);
                        chrome.runtime.sendMessage({ action: 'ungroupTabByUrl', packetId: packet.id, url: link.url });
                    }
                }
            };
            actions.appendChild(delBtn);
            item.appendChild(actions);
        }

        item.onclick = () => {
             chrome.runtime.sendMessage({ action: 'openTabInGroup', packetId: packet.id, url: link.url });
        };
        
        linkList.appendChild(item);
    }
    updateActiveHighlight();

    if (animate) {
        const newElements = Array.from(linkList.children);
        newElements.forEach((child) => {
            const id = child.getAttribute('data-id');
            if (id && oldRects[id]) {
                const newRect = child.getBoundingClientRect();
                const deltaY = oldRects[id].top - newRect.top;
                if (deltaY !== 0) {
                    child.style.transform = `translateY(${deltaY}px)`;
                    child.style.transition = 'none';
                }
            }
        });
        
        // Force reflow
        linkList.offsetHeight; 

        newElements.forEach((child) => {
            const id = child.getAttribute('data-id');
            if (id && oldRects[id]) {
                const deltaY = oldRects[id].top - child.getBoundingClientRect().top;
                if (deltaY !== 0 || child.style.transform !== '') {
                    child.style.transition = 'transform 0.3s cubic-bezier(0.2, 0, 0, 1)';
                    child.style.transform = '';
                    
                    child.addEventListener('transitionend', function handler(e) {
                        if (e.propertyName === 'transform') {
                            child.style.transition = '';
                            child.removeEventListener('transitionend', handler);
                        }
                    });
                }
            }
        });
    }
}

async function updateActiveHighlight() {
    if (!currentPacketId) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    const items = linkList.children;
    for (const item of items) {
        const urlDiv = item.querySelector('.url');
        if (urlDiv) {
            const listUrl = urlDiv.textContent;
            if (tab && (tab.url === listUrl || tab.pendingUrl === listUrl)) {
                item.classList.add('active-link');
            } else {
                item.classList.remove('active-link');
            }
        }
    }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    updateActiveHighlight();
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.groupId && tab.groupId !== -1) {
        chrome.runtime.sendMessage({ action: 'getPacketIdForGroup', groupId: tab.groupId }, (response) => {
            if (response && response.packetId && response.packetId !== currentPacketId) {
                openPacketDetail(response.packetId);
            }
        });
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
        updateActiveHighlight();
    }
    if (changeInfo.groupId !== undefined && changeInfo.groupId !== -1) {
        chrome.runtime.sendMessage({ action: 'getPacketIdForGroup', groupId: changeInfo.groupId }, (response) => {
            if (response && response.packetId && response.packetId !== currentPacketId) {
                openPacketDetail(response.packetId);
            }
        });
    }
});

document.getElementById('new-packet-btn').onclick = async () => {
    const packets = await getPackets();
    let i = 0;
    while (packets.some(p => p.name.toLowerCase() === `packet ${i}`)) {
        i++;
    }
    const name = `packet ${i}`;
    const newPacket = {
        id: crypto.randomUUID(),
        name,
        mode: 'edit',
        links: []
    };
    await addPacket(newPacket);
    renderRootMenu();
    openPacketDetail(newPacket.id);
};

document.getElementById('back-btn').onclick = () => {
    currentPacketId = null;
    chrome.storage.local.set({ activePacketId: null });
    packetDetail.classList.add('hidden');
    rootMenu.classList.remove('hidden');
    shareModal.classList.add('hidden');
    renderRootMenu();
};

document.getElementById('mode-checkbox').onchange = async (e) => {
    if (!currentPacketId) return;
    const packets = await getPackets();
    const packet = packets.find(p => p.id === currentPacketId);
    if (packet) {
        packet.mode = e.target.checked ? 'edit' : 'view';
        detailTitle.classList.toggle('editable', packet.mode === 'edit');
        await updatePacket(packet);
        chrome.runtime.sendMessage({ action: 'packetModeChanged', packetId: currentPacketId, mode: packet.mode });
        
        const addTabBtn = document.getElementById('add-tab-btn');
        const shareBtn = document.getElementById('share-btn');
        if (packet.mode === 'edit') {
            addTabBtn.classList.remove('hidden');
            shareBtn.classList.add('hidden');
        } else {
            addTabBtn.classList.add('hidden');
            shareBtn.classList.remove('hidden');
        }
        renderLinkList(packet);
    }
};

document.getElementById('add-tab-btn').onclick = async () => {
    if (!currentPacketId) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && !tab.url.startsWith('chrome://')) {
        const packets = await getPackets();
        const packet = packets.find(p => p.id === currentPacketId);
        if (packet && packet.mode === 'edit') {
            const exists = packet.links.some(l => l.url === tab.url);
            if (!exists) {
                packet.links.push({ url: tab.url, title: tab.title || tab.url, id: crypto.randomUUID() });
                await updatePacket(packet);
            }
            chrome.runtime.sendMessage({ action: 'groupTab', packetId: currentPacketId, tabId: tab.id });
            renderLinkList(packet);
        }
    }
};

document.getElementById('import-btn').onclick = () => {
    document.getElementById('import-file').click();
};
document.getElementById('import-file').onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            handleImportString(e.target.result);
        };
        reader.readAsText(file);
    }
};

async function handleImportString(str) {
    try {
        let content = str.trim();
        if (content.startsWith('pkt:')) {
            content = atob(content.slice(4));
        }

        let imported = JSON.parse(content);
        if (imported) {
            // Minimal format (n: Name, l: Array of URLs)
            if (imported.n && imported.l && Array.isArray(imported.l)) {
                imported = {
                    id: crypto.randomUUID(),
                    name: imported.n,
                    mode: 'view',
                    links: imported.l.map(url => ({
                        id: crypto.randomUUID(),
                        url,
                        title: url
                    }))
                };
            }
            
            // Full format check
            if (imported.id && imported.name && imported.links) {
                const packets = await getPackets();
                const existing = packets.find(p => p.id === imported.id);
                if (existing) {
                    await updatePacket(imported);
                } else {
                    await addPacket(imported);
                }
                renderRootMenu();
                return true;
            }
        }
    } catch (err) {
        console.error('Import error:', err);
    }
    return false;
}

scanBtn.onclick = async () => {
    try {
        console.log('Starting scanner...');
        scannerStream = await navigator.mediaDevices.getUserMedia({ video: true });
        scannerVideo.srcObject = scannerStream;
        await scannerVideo.play();
        scannerModal.classList.remove('hidden');
        console.log('Scanner modal shown');
        
        let isSupported = false;
        if ('BarcodeDetector' in window) {
            const formats = await BarcodeDetector.getSupportedFormats();
            if (formats.includes('qr_code')) {
                isSupported = true;
                const detector = new BarcodeDetector({ formats: ['qr_code'] });
                console.log('BarcodeDetector initialized');
                scannerInterval = setInterval(async () => {
                    try {
                        const barcodes = await detector.detect(scannerVideo);
                        if (barcodes.length > 0) {
                            const rawContent = barcodes[0].rawValue;
                            const success = await handleImportString(rawContent);
                            if (success) {
                                stopScanner();
                            }
                        }
                    } catch (e) {
                        console.error('Scan error:', e);
                    }
                }, 500);
            }
        }
        
        if (!isSupported) {
            alert('BarcodeDetector API for QR codes is not supported in this environment. Please ensure you are using a modern version of Chrome on Mac/Android or enable "Experimental Web Platform features" in chrome://flags.');
            stopScanner();
        }
    } catch (err) {
        if (err.name === 'NotAllowedError' || err.message.includes('Permission dismissed')) {
            if (confirm('Camera permission was denied or dismissed. Would you like to open the Settings page to grant permission there?')) {
                chrome.runtime.openOptionsPage();
            }
        } else {
            alert('Could not access camera: ' + err.message);
        }
    }
};

function stopScanner() {
    if (scannerStream) {
        scannerStream.getTracks().forEach(t => t.stop());
        scannerStream = null;
    }
    if (scannerInterval) {
        clearInterval(scannerInterval);
        scannerInterval = null;
    }
    scannerVideo.srcObject = null;
    scannerModal.classList.add('hidden');
}

document.getElementById('share-btn').onclick = async () => {
    if (!currentPacketId) return;
    const packets = await getPackets();
    const packet = packets.find(p => p.id === currentPacketId);
    if (!packet) return;

    const minimalPacket = {
        n: packet.name,
        l: packet.links.map(l => l.url)
    };
    const packetData = 'pkt:' + btoa(JSON.stringify(minimalPacket));
    
    shareModal.classList.remove('hidden');
    const qrContainer = document.getElementById('qrcode-container');
    qrContainer.innerHTML = ''; 

    const limit = 2500;
    if (packetData.length > limit) {
        const err = document.createElement('div');
        err.className = 'qrcode-error';
        err.textContent = `Too many characters: ${packetData.length} / ${limit} allowed. Try removing some links or shortening titles.`;
        qrContainer.appendChild(err);
        return;
    }

    try {
        new QRCode(qrContainer, {
            text: packetData,
            width: 160,
            height: 160,
            correctLevel: QRCode.CorrectLevel.L
        });
        
        const exportL = document.createElement('a');
        exportL.href = 'data:text/json;charset=utf-8,' + encodeURIComponent(packetData);
        exportL.download = `${packet.name}.json`;
        exportL.textContent = 'Download Basic Packet';
        exportL.style.marginTop = '16px';
        exportL.style.fontSize = '12px';
        exportL.style.fontWeight = '500';
        exportL.style.display = 'block';
        exportL.style.textAlign = 'center';
        exportL.style.color = 'var(--primary-color)';
        exportL.style.textDecoration = 'none';
        const downloadContainer = document.getElementById('qr-download-container');
        downloadContainer.innerHTML = '';
        downloadContainer.appendChild(exportL);
        
    } catch (e) {
        const err = document.createElement('div');
        err.className = 'qrcode-error';
        err.textContent = 'Too many characters to fit within a qrcode';
        qrContainer.appendChild(err);
    }
};

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.packets && currentPacketId) {
        const updatedPacket = changes.packets.newValue.find(p => p.id === currentPacketId);
        if (updatedPacket) {
            renderLinkList(updatedPacket, true);
        }
    }
});

renderRootMenu();

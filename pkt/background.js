import { getPackets, savePackets, updatePacket } from './storage.js';

let currentSessionId = null;
let groupToPacket = null;
let packetToGroup = null;
const sortingGroups = new Set();
const moveDebounceTimers = {};

async function ensureSession() {
    if (currentSessionId !== null && groupToPacket !== null) return;
    const sessionData = await chrome.storage.session.get('sessionId');
    if (sessionData.sessionId) {
        currentSessionId = sessionData.sessionId;
        const local = await chrome.storage.local.get(['groupToPacket', 'packetToGroup']);
        groupToPacket = local.groupToPacket || {};
        packetToGroup = local.packetToGroup || {};
    } else {
        currentSessionId = crypto.randomUUID();
        await chrome.storage.session.set({ sessionId: currentSessionId });
        const local = await chrome.storage.local.get(['groupToPacket', 'packetToGroup']);
        const oldPacketToGroup = local.packetToGroup || {};
        for (const pId in oldPacketToGroup) {
            try {
                const oldGroupId = oldPacketToGroup[pId];
                const tabs = await chrome.tabs.query({ groupId: oldGroupId });
                if (tabs.length > 0) {
                    await chrome.tabs.remove(tabs.map(t => t.id));
                }
            } catch (e) {}
        }
        groupToPacket = {};
        packetToGroup = {};
        await chrome.storage.local.set({ groupToPacket, packetToGroup });
    }
}

async function updateState() {
    await chrome.storage.local.set({ groupToPacket, packetToGroup });
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    ensureSession().then(() => {
        if (msg.action === 'openPacketGroup') {
            openPacket(msg.packetId);
        } else if (msg.action === 'openTabInGroup') {
            openTabInGroup(msg.packetId, msg.url);
        } else if (msg.action === 'groupTab') {
            groupTab(msg.packetId, msg.tabId);
        } else if (msg.action === 'renamePacket') {
            renamePacket(msg.packetId, msg.name);
        } else if (msg.action === 'getPacketIdForGroup') {
            sendResponse({ packetId: groupToPacket[msg.groupId] });
        }
    });
    return true; // Keep message channel open for async
});

async function openPacket(packetId) {
    await ensureSession();
    const packets = await getPackets();
    const packet = packets.find(p => p.id === packetId);
    if (!packet) return;

    let groupId = packetToGroup[packetId];

    if (groupId) {
        try {
            await chrome.tabGroups.get(groupId);
        } catch (e) {
            groupId = null;
        }
    }

    if (!groupId) {
        if (packet.links && packet.links.length > 0) {
            const tabIds = [];
            for (const link of packet.links) {
                const tab = await chrome.tabs.create({ url: link.url, active: false });
                tabIds.push(tab.id);
            }
            groupId = await chrome.tabs.group({ tabIds });
            await chrome.tabGroups.update(groupId, { title: packet.name });
            
            groupToPacket[groupId] = packetId;
            packetToGroup[packetId] = groupId;
            await updateState();
        } else {
            const tab = await chrome.tabs.create({ url: 'chrome://newtab', active: true });
            groupId = await chrome.tabs.group({ tabIds: [tab.id] });
            await chrome.tabGroups.update(groupId, { title: packet.name });
            
            groupToPacket[groupId] = packetId;
            packetToGroup[packetId] = groupId;
            await updateState();
        }
    } else {
        const tabs = await chrome.tabs.query({ groupId });
        if (tabs.length > 0) {
           await chrome.tabs.update(tabs[0].id, { active: true });
           await chrome.windows.update(tabs[0].windowId, { focused: true });
        }
    }
    await sortGroupTabs(packetId, groupId);
    await chrome.storage.local.set({ activePacketId: packetId });
}

async function openTabInGroup(packetId, url) {
    await ensureSession();
    let groupId = packetToGroup[packetId];
    if (groupId) {
        try {
            await chrome.tabGroups.get(groupId);
        } catch (e) {
            groupId = null;
        }
    }

    if (groupId) {
        const tabs = await chrome.tabs.query({ groupId });
        const existingTab = tabs.find(t => t.url === url || t.pendingUrl === url);
        if (existingTab) {
            await chrome.tabs.update(existingTab.id, { active: true });
            await chrome.windows.update(existingTab.windowId, { focused: true });
        } else {
            const tab = await chrome.tabs.create({ url, active: true });
            await chrome.tabs.group({ tabIds: [tab.id], groupId });
            await sortGroupTabs(packetId, groupId);
        }
    } else {
        await openPacket(packetId);
    }
}

async function groupTab(packetId, tabId) {
    await ensureSession();
    const packets = await getPackets();
    const packet = packets.find(p => p.id === packetId);
    if (!packet) return;

    let groupId = packetToGroup[packetId];
    if (groupId) {
        try {
            await chrome.tabGroups.get(groupId);
        } catch(e) {
            groupId = null;
        }
    }

    if (groupId) {
        await chrome.tabs.group({ tabIds: [tabId], groupId });
        await sortGroupTabs(packetId, groupId);
    } else {
        groupId = await chrome.tabs.group({ tabIds: [tabId] });
        await chrome.tabGroups.update(groupId, { title: packet.name });
        groupToPacket[groupId] = packetId;
        packetToGroup[packetId] = groupId;
        await updateState();
    }
}

async function ungroupTabByUrl(packetId, url) {
    await ensureSession();
    const groupId = packetToGroup[packetId];
    if (groupId) {
        try {
            const tabs = await chrome.tabs.query({ groupId });
            const tabToUngroup = tabs.find(t => t.url === url || t.pendingUrl === url);
            if (tabToUngroup) {
                try {
                    await chrome.tabs.ungroup(tabToUngroup.id);
                } catch (e) {}
            }
        } catch (e) {}
    }
}

async function renamePacket(packetId, name) {
    await ensureSession();
    const groupId = packetToGroup[packetId];
    if (groupId) {
        try {
            await chrome.tabGroups.update(groupId, { title: name });
        } catch (e) {}
    }
}

async function sortGroupTabs(packetId, groupId) {
    if (!groupId) return;
    if (sortingGroups.has(groupId)) return;
    sortingGroups.add(groupId);

    try {
        const packets = await getPackets();
        const packet = packets.find(p => p.id === packetId);
        if (!packet || !packet.links) return;

        let tabs = await chrome.tabs.query({ groupId });
        if (tabs.length === 0) return;
        
        let originalOrder = [...tabs].sort((a,b) => a.index - b.index);

        if (packet.mode === 'view') {
            const tabsToUngroup = [];
            const remainingTabs = [];
            for (const t of originalOrder) {
                const u = t.url || t.pendingUrl || '';
                const isInPacket = matchesPacket(packet, u);
                if (!isInPacket && !u.startsWith('chrome://')) {
                    tabsToUngroup.push(t.id);
                } else {
                    remainingTabs.push(t);
                }
            }
            if (tabsToUngroup.length > 0) {
                try {
                    await chrome.tabs.ungroup(tabsToUngroup);
                } catch (e) {}
                tabs = remainingTabs;
                if (tabs.length === 0) return;
                originalOrder = [...tabs];
            }
        }

        tabs.sort((a, b) => {
            const indexA = packet.links.findIndex(l => {
                const u = a.url || a.pendingUrl || '';
                return matchesUrl(u, l.url);
            });
            const indexB = packet.links.findIndex(l => {
                const u = b.url || b.pendingUrl || '';
                return matchesUrl(u, l.url);
            });
            
            const weightA = indexA === -1 ? Number.MAX_SAFE_INTEGER : indexA;
            const weightB = indexB === -1 ? Number.MAX_SAFE_INTEGER : indexB;
            
            if (weightA !== weightB) {
                return weightA - weightB;
            }
            return a.index - b.index;
        });

        let inOrder = true;
        for (let i = 0; i < tabs.length; i++) {
            if (tabs[i].id !== originalOrder[i].id) {
                inOrder = false;
                break;
            }
        }

        if (!inOrder) {
            const startIndex = originalOrder[0].index;
            for (let i = 0; i < tabs.length; i++) {
                try {
                    await chrome.tabs.move(tabs[i].id, { index: startIndex + i });
                } catch (e) {}
            }
        }
    } finally {
        setTimeout(() => sortingGroups.delete(groupId), 300);
    }
}

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
    ensureSession().then(async () => {
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab.groupId && tab.groupId !== -1) {
                if (sortingGroups.has(tab.groupId)) return;

                const packetId = groupToPacket[tab.groupId];
                if (packetId) {
                    const packets = await getPackets();
                    const packet = packets.find(p => p.id === packetId);
                    if (packet && packet.mode === 'view') {
                        if (moveDebounceTimers[tab.groupId]) {
                            clearTimeout(moveDebounceTimers[tab.groupId]);
                        }
                        moveDebounceTimers[tab.groupId] = setTimeout(() => {
                            sortGroupTabs(packetId, tab.groupId);
                        }, 400);
                    } else if (packet && packet.mode === 'edit') {
                        if (moveDebounceTimers[tab.groupId]) {
                            clearTimeout(moveDebounceTimers[tab.groupId]);
                        }
                        moveDebounceTimers[tab.groupId] = setTimeout(() => {
                            syncPacketFromTabs(packetId, tab.groupId);
                        }, 400);
                    }
                }
            }
        } catch(e) {}
    });
});

async function syncPacketFromTabs(packetId, groupId) {
    const packets = await getPackets();
    const packet = packets.find(p => p.id === packetId);
    if (!packet) return;

    const tabs = await chrome.tabs.query({ groupId });
    tabs.sort((a,b) => a.index - b.index);
    
    const newLinks = [];
    const linkPool = [...packet.links];

    for (const t of tabs) {
        const url = t.url || t.pendingUrl || '';
        const matchIdx = linkPool.findIndex(l => url.startsWith(l.url) || l.url.startsWith(url));
        if (matchIdx !== -1) {
            newLinks.push(linkPool[matchIdx]);
            linkPool.splice(matchIdx, 1);
        } else if (!url.startsWith('chrome://') && url !== '') {
            newLinks.push({ url, title: t.title || url, id: crypto.randomUUID() });
        }
    }
    
    // Add back original links that were not in the group
    for (const remaining of linkPool) {
        newLinks.push(remaining);
    }
    
    packet.links = newLinks;
    await updatePacket(packet);
}

function matchesUrl(u, lUrl) {
    if (!u || !lUrl) return false;
    return u.startsWith(lUrl) || lUrl.startsWith(u);
}

function matchesPacket(packet, url) {
    if (!url || url === '' || url === 'about:blank') return false;
    return packet.links.some(l => matchesUrl(url, l.url));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    ensureSession().then(async () => {
        if (changeInfo.groupId !== undefined) {
            const newGroupId = changeInfo.groupId;
            if (newGroupId !== -1) {
                const packetId = groupToPacket[newGroupId];
                if (packetId) {
                    const packets = await getPackets();
                    const packet = packets.find(p => p.id === packetId);
                    if (packet) {
                        if (packet.mode === 'view') {
                            const isInPacket = matchesPacket(packet, tab.url);
                            if (!isInPacket && !tab.url.startsWith('chrome://newtab')) {
                                try {
                                    await chrome.tabs.ungroup(tabId);
                                } catch (e) {}
                            } else {
                                await sortGroupTabs(packetId, newGroupId);
                            }
                        } else if (packet.mode === 'edit') {
                            if (moveDebounceTimers[newGroupId]) {
                                clearTimeout(moveDebounceTimers[newGroupId]);
                            }
                            moveDebounceTimers[newGroupId] = setTimeout(() => {
                                syncPacketFromTabs(packetId, newGroupId);
                            }, 400);
                        }
                    }
                }
            }
        }

        if (changeInfo.url) {
            const groupId = tab.groupId;
            if (groupId && groupId !== -1) {
                const packetId = groupToPacket[groupId];
                if (packetId) {
                    const packets = await getPackets();
                    const packet = packets.find(p => p.id === packetId);
                    if (packet) {
                        if (packet.mode === 'view') {
                            const isInPacket = matchesPacket(packet, changeInfo.url);
                            if (!isInPacket) {
                                try {
                                    await chrome.tabs.ungroup(tabId);
                                } catch (e) {}
                            } else {
                                await sortGroupTabs(packetId, groupId);
                            }
                        } else if (packet.mode === 'edit') {
                            if (moveDebounceTimers[groupId]) {
                                clearTimeout(moveDebounceTimers[groupId]);
                            }
                            moveDebounceTimers[groupId] = setTimeout(() => {
                                syncPacketFromTabs(packetId, groupId);
                            }, 400);
                        }
                    }
                }
            }
        }
    });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    ensureSession().then(async () => {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab.groupId && tab.groupId !== -1) {
            const packetId = groupToPacket[tab.groupId];
            if (packetId) {
                await chrome.storage.local.set({ activePacketId: packetId });
                // Robustness: Sweep the group whenever a tab inside it is activated
                await sortGroupTabs(packetId, tab.groupId);
            }
        }
    });
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    ensureSession().then(async () => {
        const tab = await chrome.tabs.get(tabId);
        if (tab.groupId && tab.groupId !== -1) {
            const packetId = groupToPacket[tab.groupId];
            if (packetId) {
                await sortGroupTabs(packetId, tab.groupId);
            }
        }
    });
});

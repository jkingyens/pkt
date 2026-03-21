export const getPackets = async () => {
  const result = await chrome.storage.local.get('packets');
  return result.packets || [];
};

export const savePackets = async (packets) => {
  await chrome.storage.local.set({ packets });
};

export const addPacket = async (packet) => {
  const packets = await getPackets();
  packets.push(packet);
  await savePackets(packets);
};

export const updatePacket = async (updatedPacket) => {
  const packets = await getPackets();
  const index = packets.findIndex(p => p.id === updatedPacket.id);
  if (index !== -1) {
    packets[index] = updatedPacket;
    await savePackets(packets);
  }
};

export const deletePacket = async (packetId) => {
  let packets = await getPackets();
  packets = packets.filter(p => p.id !== packetId);
  await savePackets(packets);
};

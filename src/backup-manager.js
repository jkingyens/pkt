/**
 * BackupManager - Handles full state export/import for Wildcard
 * Includes chrome.storage.local and BlobStorage media
 */
class BackupManager {
    constructor(blobStorage) {
        this.blobStorage = blobStorage;
    }

    /**
     * Export all extension data to a single JSON object
     */
    async exportFullBackup(onProgress) {
        console.log('[BackupManager] Starting export...');
        const report = (checkpoint, percent) => {
            if (onProgress) onProgress({ checkpoint, percent });
        };
        
        // 1. Get all chrome.storage.local data
        report('Collecting settings...', 5);
        const storageData = await chrome.storage.local.get(null);
        
        // 2. Get all media blobs from IndexedDB
        report('Querying media database...', 10);
        const mediaIds = await this.blobStorage.listKeys();
        const totalMedia = mediaIds.length;
        const serializedMedia = {};
        
        console.log('[BackupManager] Found', totalMedia, 'media items');

        for (let i = 0; i < totalMedia; i++) {
            const id = mediaIds[i];
            const blob = await this.blobStorage.get(id);
            
            if (!blob) {
                console.warn('[BackupManager] Media blob missing for id:', id);
                continue;
            }

            report(`Processing media (${i + 1}/${totalMedia})...`, 10 + Math.floor((i / totalMedia) * 85));
            
            serializedMedia[id] = {
                type: blob.type,
                data: await this.blobToBase64(blob)
            };
        }
        
        report('Assembling backup package...', 98);
        const backup = {
            version: '1.0',
            timestamp: new Date().toISOString(),
            storage: storageData,
            media: serializedMedia
        };
        
        report('Export complete!', 100);
        console.log('[BackupManager] Export complete. Media items:', Object.keys(serializedMedia).length);
        return backup;
    }

    /**
     * Restore extension state from a backup object
     * WARNING: This clears ALL existing data!
     */
    async importFullBackup(backup, onProgress) {
        if (!backup || backup.version !== '1.0') {
            throw new Error('Invalid or unsupported backup format');
        }
        
        console.log('[BackupManager] Starting import...');
        const report = (checkpoint, percent) => {
            if (onProgress) onProgress({ checkpoint, percent });
        };

        // 1. Clear existing storage and media
        report('Clearing current state...', 5);
        await chrome.storage.local.clear();
        await this.blobStorage.clearAll();
        
        // 2. Restore chrome.storage.local
        report('Restoring settings and databases...', 15);
        if (backup.storage) {
            await chrome.storage.local.set(backup.storage);
        }
        
        // 3. Restore media blobs to IndexedDB
        if (backup.media) {
            const mediaIds = Object.keys(backup.media);
            const totalMedia = mediaIds.length;
            
            for (let i = 0; i < totalMedia; i++) {
                const id = mediaIds[i];
                const item = backup.media[id];
                
                report(`Hydrating media (${i + 1}/${totalMedia})...`, 15 + Math.floor((i / totalMedia) * 80));
                
                const blob = await this.base64ToBlob(item.data, item.type);
                await this.blobStorage.put(id, blob);
            }
        }
        
        report('Finalizing restoration...', 98);
        report('Restore complete!', 100);
        console.log('[BackupManager] Import complete.');
    }

    /**
     * Helper: Convert Blob to Base64 string
     */
    async blobToBase64(blob) {
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const len = bytes.byteLength;
        const chunk = 65536; // 64k chunks
        for (let i = 0; i < len; i += chunk) {
            const end = Math.min(i + chunk, len);
            binary += String.fromCharCode.apply(null, bytes.subarray(i, end));
        }
        return btoa(binary);
    }

    /**
     * Helper: Convert Base64 string to Blob
     */
    async base64ToBlob(base64, type) {
        const binStr = atob(base64);
        const len = binStr.length;
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            arr[i] = binStr.charCodeAt(i);
        }
        return new Blob([arr], { type });
    }
}

if (typeof self !== 'undefined') {
    self.BackupManager = BackupManager;
}

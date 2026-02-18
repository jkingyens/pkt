/**
 * Sidebar UI Controller
 * Manages collection list and nested detail view with schema/entry management
 */

class SidebarUI {
    constructor() {
        // Views
        this.listView = document.getElementById('listView');
        this.detailView = document.getElementById('detailView');

        // List view elements
        this.collectionsList = document.getElementById('collectionsList');
        this.template = document.getElementById('collectionTemplate');

        // Detail view elements
        this.detailTitle = document.getElementById('detailTitle');
        this.schemaContent = document.getElementById('schemaContent');
        this.entriesContent = document.getElementById('entriesContent');
        this.entryCount = document.getElementById('entryCount');

        // Modal elements
        this.schemaModal = document.getElementById('schemaModal');
        this.schemaTextarea = document.getElementById('schemaTextarea');

        // State
        this.currentCollection = null;
        this.currentSchema = [];

        this.setupEventListeners();
        this.loadCollections();
    }

    setupEventListeners() {
        // List view
        document.getElementById('createBtn').addEventListener('click', () => this.createCollection());
        document.getElementById('importBtn').addEventListener('click', () => this.importDatabase());

        // Detail view
        document.getElementById('backBtn').addEventListener('click', () => this.showListView());
        document.getElementById('editSchemaBtn').addEventListener('click', () => this.openSchemaModal());
        document.getElementById('detailExportBtn').addEventListener('click', () => this.exportCollection(this.currentCollection));
        document.getElementById('detailSaveBtn').addEventListener('click', () => this.saveCheckpoint(this.currentCollection));
        document.getElementById('detailDeleteBtn').addEventListener('click', () => this.deleteCollection(this.currentCollection));

        // Modal
        document.getElementById('modalSaveBtn').addEventListener('click', () => this.saveSchema());
        document.getElementById('modalCancelBtn').addEventListener('click', () => this.closeSchemaModal());
        document.getElementById('modalCloseBtn').addEventListener('click', () => this.closeSchemaModal());
        this.schemaModal.addEventListener('click', (e) => {
            if (e.target === this.schemaModal) this.closeSchemaModal();
        });
    }

    // ===== NAVIGATION =====

    showListView() {
        this.detailView.classList.remove('active');
        this.listView.classList.add('active');
        this.currentCollection = null;
        this.loadCollections();
    }

    showDetailView(collectionName) {
        this.currentCollection = collectionName;
        this.detailTitle.textContent = collectionName;
        this.listView.classList.remove('active');
        this.detailView.classList.add('active');
        this.loadCollectionDetail(collectionName);
    }

    // ===== COLLECTION LIST =====

    async loadCollections() {
        try {
            const response = await this.sendMessage({ action: 'listCollections' });
            if (response.success) {
                this.renderCollections(response.collections);
            }
        } catch (error) {
            console.error('Failed to load collections:', error);
        }
    }

    renderCollections(collections) {
        if (collections.length === 0) {
            this.collectionsList.innerHTML = `
              <div class="empty-state">
                <div class="empty-icon">🗄️</div>
                <p>No collections yet</p>
                <p class="hint">Create a new collection or import an existing database</p>
              </div>`;
            return;
        }

        this.collectionsList.innerHTML = '';
        collections.forEach(name => {
            const item = this.createCollectionItem(name);
            this.collectionsList.appendChild(item);
        });
    }

    createCollectionItem(name) {
        const clone = this.template.content.cloneNode(true);

        clone.querySelector('.collection-name').textContent = name;

        // Click on header/name area → navigate to detail
        const item = clone.querySelector('.collection-item');
        const header = clone.querySelector('.collection-header');
        header.addEventListener('click', (e) => {
            // Don't navigate if delete button was clicked
            if (!e.target.closest('.delete-btn')) {
                this.showDetailView(name);
            }
        });

        clone.querySelector('.export-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.exportCollection(name);
        });
        clone.querySelector('.save-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.saveCheckpoint(name);
        });
        clone.querySelector('.restore-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.restoreCheckpoint(name);
        });
        clone.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteCollection(name);
        });

        return clone;
    }

    // ===== DETAIL VIEW =====

    async loadCollectionDetail(name) {
        this.schemaContent.innerHTML = '<p class="hint">Loading…</p>';
        this.entriesContent.innerHTML = '<p class="hint">Loading…</p>';
        this.entryCount.textContent = '0';

        try {
            const schemaResp = await this.sendMessage({ action: 'getSchema', name });
            if (schemaResp.success) {
                this.currentSchema = schemaResp.schema;
                this.renderSchema(schemaResp.schema);

                // Load entries for each table
                await this.loadEntries(name, schemaResp.schema);
            }
        } catch (error) {
            console.error('Failed to load collection detail:', error);
            this.schemaContent.innerHTML = '<p class="hint">Failed to load schema.</p>';
        }
    }

    renderSchema(schema) {
        if (!schema.length) {
            this.schemaContent.innerHTML = '<p class="hint">No tables defined yet. Click ✏️ Edit to add a schema.</p>';
            return;
        }

        this.schemaContent.innerHTML = schema.map(({ name, sql }) => `
          <div class="schema-table">
            <div class="schema-table-name">📋 ${name}</div>
            <pre class="schema-sql">${this.escapeHtml(sql)}</pre>
          </div>
        `).join('');
    }

    async loadEntries(collectionName, schema) {
        if (!schema.length) {
            this.entriesContent.innerHTML = '<p class="hint">Define a schema first to see entries.</p>';
            this.entryCount.textContent = '0';
            return;
        }

        try {
            // Load entries for all tables
            let totalCount = 0;
            let html = '';

            for (const { name: tableName } of schema) {
                const resp = await this.sendMessage({
                    action: 'getEntries',
                    name: collectionName,
                    tableName
                });

                if (resp.success) {
                    totalCount += resp.entries.length;
                    if (schema.length > 1) {
                        html += `<div class="schema-table-name" style="margin-bottom:4px;font-size:12px;">📋 ${tableName}</div>`;
                    }
                    if (resp.entries.length === 0) {
                        html += '<p class="hint" style="margin-bottom:8px;">No entries yet.</p>';
                    } else {
                        html += resp.entries.map(id => `
                          <div class="entry-row">
                            <span class="entry-id">#</span>
                            <span class="entry-label">${id}</span>
                          </div>`).join('');
                    }
                }
            }

            this.entryCount.textContent = totalCount;
            this.entriesContent.innerHTML = html || '<p class="hint">No entries yet.</p>';
        } catch (error) {
            console.error('Failed to load entries:', error);
            this.entriesContent.innerHTML = '<p class="hint">Failed to load entries.</p>';
        }
    }

    // ===== SCHEMA MODAL =====

    openSchemaModal() {
        // Pre-fill with existing schema SQL if available
        if (this.currentSchema.length > 0) {
            this.schemaTextarea.value = this.currentSchema.map(t => t.sql).join(';\n\n') + ';';
        } else {
            this.schemaTextarea.value = '';
        }
        this.schemaModal.classList.remove('hidden');
        this.schemaTextarea.focus();
    }

    closeSchemaModal() {
        this.schemaModal.classList.add('hidden');
    }

    async saveSchema() {
        const sql = this.schemaTextarea.value.trim();
        if (!sql) {
            this.showNotification('Please enter a CREATE TABLE statement', 'error');
            return;
        }

        // Validate that there's at least one CREATE TABLE statement
        if (!/CREATE\s+TABLE/i.test(sql)) {
            this.showNotification('No CREATE TABLE statement found', 'error');
            return;
        }

        try {
            const response = await this.sendMessage({
                action: 'setSchema',
                name: this.currentCollection,
                createSQL: sql
            });

            if (response.success) {
                this.closeSchemaModal();
                this.showNotification(`Schema saved for "${this.currentCollection}"`, 'success');
                this.loadCollectionDetail(this.currentCollection);
            } else {
                this.showNotification(`Error: ${response.error}`, 'error');
            }
        } catch (error) {
            this.showNotification('Failed to save schema', 'error');
        }
    }

    // ===== COLLECTION ACTIONS =====

    async createCollection() {
        const name = prompt('Enter collection name:');
        if (!name || !name.trim()) return;

        try {
            const response = await this.sendMessage({ action: 'createCollection', name: name.trim() });
            if (response.success) {
                this.loadCollections();
                this.showNotification(`Collection "${name}" created`, 'success');
            }
        } catch (error) {
            this.showNotification('Failed to create collection', 'error');
        }
    }

    async importDatabase() {
        try {
            const [fileHandle] = await window.showOpenFilePicker({
                types: [{
                    description: 'SQLite Database',
                    accept: { 'application/x-sqlite3': ['.db', '.sqlite', '.sqlite3'] }
                }]
            });

            const file = await fileHandle.getFile();
            const name = prompt('Enter collection name:', file.name.replace(/\.(db|sqlite|sqlite3)$/, ''));
            if (!name || !name.trim()) return;

            const arrayBuffer = await file.arrayBuffer();
            // Convert to plain Array so it survives chrome.runtime.sendMessage serialization
            const data = Array.from(new Uint8Array(arrayBuffer));
            const response = await this.sendMessage({
                action: 'importFromBlob',
                name: name.trim(),
                data
            });

            if (response.success) {
                this.loadCollections();
                this.showNotification(`Database imported as "${name}"`, 'success');
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Import failed:', error);
                this.showNotification('Failed to import database', 'error');
            }
        }
    }

    async exportCollection(name) {
        try {
            const response = await this.sendMessage({ action: 'exportToBlob', name });
            if (response.success) {
                const uint8Array = new Uint8Array(response.data);
                const blob = new Blob([uint8Array], { type: 'application/x-sqlite3' });

                const fileHandle = await window.showSaveFilePicker({
                    suggestedName: `${name}.db`,
                    types: [{ description: 'SQLite Database', accept: { 'application/x-sqlite3': ['.db'] } }]
                });

                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();

                this.showNotification(`Collection "${name}" exported`, 'success');
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Export failed:', error);
                this.showNotification('Failed to export collection', 'error');
            }
        }
    }

    async saveCheckpoint(name) {
        try {
            const response = await this.sendMessage({ action: 'saveCheckpoint', name });
            if (response.success) {
                this.showNotification(`Checkpoint saved for "${name}"`, 'success');
            }
        } catch (error) {
            this.showNotification('Failed to save checkpoint', 'error');
        }
    }

    async restoreCheckpoint(name) {
        if (!confirm(`Restore "${name}" to last checkpoint? Current changes will be lost.`)) return;

        try {
            const response = await this.sendMessage({ action: 'restoreCheckpoint', name });
            if (response.success) {
                if (response.restored) {
                    this.showNotification(`Collection "${name}" restored`, 'success');
                    if (this.currentCollection === name) {
                        this.loadCollectionDetail(name);
                    }
                } else {
                    this.showNotification('No checkpoint found', 'error');
                }
            }
        } catch (error) {
            this.showNotification('Failed to restore checkpoint', 'error');
        }
    }

    async deleteCollection(name) {
        if (!confirm(`Delete collection "${name}"? This cannot be undone.`)) return;

        try {
            const response = await this.sendMessage({ action: 'deleteCollection', name });
            if (response.success) {
                this.showNotification(`Collection "${name}" deleted`, 'success');
                if (this.currentCollection === name) {
                    this.showListView();
                } else {
                    this.loadCollections();
                }
            }
        } catch (error) {
            this.showNotification('Failed to delete collection', 'error');
        }
    }

    // ===== UTILITIES =====

    sendMessage(message) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, response => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(response);
                }
            });
        });
    }

    escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    showNotification(message, type = 'info') {
        console.log(`[${type.toUpperCase()}] ${message}`);

        const notification = document.createElement('div');
        notification.textContent = message;
        notification.style.cssText = `
          position: fixed; top: 16px; right: 16px;
          padding: 10px 16px;
          background: ${type === 'success' ? '#10b981' : '#ef4444'};
          color: white; border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          z-index: 1000; font-size: 13px;
          animation: slideIn 0.25s ease-out;
        `;

        document.body.appendChild(notification);
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.25s ease-out';
            setTimeout(() => notification.remove(), 250);
        }, 3000);
    }
}

// Initialize UI when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new SidebarUI();
});

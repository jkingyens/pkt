/**
 * Sidebar UI Controller
 * Manages collection list and nested detail view with schema/entry management
 */

// Real-world SQLite schemas from popular open source apps
const SCHEMA_PRESETS = {
    buku: `-- buku: command-line bookmark manager
-- https://github.com/jarun/buku
CREATE TABLE bookmarks (
  id        INTEGER PRIMARY KEY,
  URL       TEXT NOT NULL UNIQUE,
  metadata  TEXT DEFAULT '',
  tags      TEXT DEFAULT ',',
  desc      TEXT DEFAULT '',
  flags     INTEGER DEFAULT 0
);

CREATE TABLE tag (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);`,

    newsboat: `-- newsboat: terminal RSS/Atom feed reader
-- https://github.com/newsboat/newsboat
CREATE TABLE rss_feed (
  rssurl       TEXT NOT NULL PRIMARY KEY,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  lastmodified INTEGER NOT NULL DEFAULT 0,
  is_rtl       INTEGER NOT NULL DEFAULT 0,
  etag         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE rss_item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guid        TEXT NOT NULL,
  title       TEXT NOT NULL,
  author      TEXT NOT NULL,
  url         TEXT NOT NULL,
  feedurl     TEXT NOT NULL,
  pubdate     INTEGER NOT NULL,
  content     TEXT NOT NULL,
  unread      INTEGER NOT NULL DEFAULT 1,
  enclosure_url  TEXT,
  enclosure_type TEXT,
  enqueued    INTEGER NOT NULL DEFAULT 0,
  flags       TEXT,
  deleted     INTEGER NOT NULL DEFAULT 0,
  base        TEXT DEFAULT NULL
);`,

    zotero: `-- zotero: reference manager (simplified core tables)
-- https://github.com/zotero/zotero
CREATE TABLE items (
  itemID        INTEGER PRIMARY KEY,
  itemTypeID    INTEGER NOT NULL,
  dateAdded     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dateModified  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  clientDateModified TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  libraryID     INTEGER NOT NULL,
  key           TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0,
  synced        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE creators (
  creatorID   INTEGER PRIMARY KEY,
  firstName   TEXT DEFAULT '',
  lastName    TEXT DEFAULT '',
  fieldMode   INTEGER DEFAULT 0
);

CREATE TABLE itemCreators (
  itemID      INTEGER NOT NULL,
  creatorID   INTEGER NOT NULL,
  creatorTypeID INTEGER NOT NULL DEFAULT 1,
  orderIndex  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (itemID, creatorID, creatorTypeID)
);

CREATE TABLE tags (
  tagID   INTEGER PRIMARY KEY,
  name    TEXT NOT NULL COLLATE NOCASE
);

CREATE TABLE itemTags (
  itemID  INTEGER NOT NULL,
  tagID   INTEGER NOT NULL,
  type    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (itemID, tagID)
);`,

    taskwarrior: `-- taskwarrior: command-line task manager (export schema)
-- https://github.com/GothenburgBitFactory/taskwarrior
CREATE TABLE tasks (
  uuid        TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'pending',
  description TEXT NOT NULL,
  entry       TEXT,
  modified    TEXT,
  due         TEXT,
  until       TEXT,
  wait        TEXT,
  scheduled   TEXT,
  start       TEXT,
  end         TEXT,
  priority    TEXT,
  project     TEXT,
  recur       TEXT,
  mask        TEXT,
  imask       INTEGER,
  parent      TEXT,
  urgency     REAL DEFAULT 0.0
);

CREATE TABLE task_tags (
  task_uuid  TEXT NOT NULL,
  tag        TEXT NOT NULL,
  PRIMARY KEY (task_uuid, tag)
);

CREATE TABLE task_annotations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_uuid  TEXT NOT NULL,
  entry      TEXT NOT NULL,
  description TEXT NOT NULL
);`,

    miniflux: `-- miniflux: minimalist feed reader (simplified)
-- https://github.com/miniflux/v2
CREATE TABLE feeds (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL,
  feed_url           TEXT NOT NULL,
  site_url           TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL DEFAULT '',
  checked_at         TEXT,
  next_check_at      TEXT,
  etag_header        TEXT NOT NULL DEFAULT '',
  last_modified_header TEXT NOT NULL DEFAULT '',
  parsing_error_msg  TEXT NOT NULL DEFAULT '',
  parsing_error_count INTEGER NOT NULL DEFAULT 0,
  scraper_rules      TEXT NOT NULL DEFAULT '',
  rewrite_rules      TEXT NOT NULL DEFAULT '',
  crawler            INTEGER NOT NULL DEFAULT 0,
  category_id        INTEGER,
  username           TEXT NOT NULL DEFAULT '',
  password           TEXT NOT NULL DEFAULT '',
  disabled           INTEGER NOT NULL DEFAULT 0,
  hide_globally      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  feed_id     INTEGER NOT NULL,
  hash        TEXT NOT NULL,
  published_at TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  comments_url TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'unread',
  starred     INTEGER NOT NULL DEFAULT 0,
  reading_time INTEGER NOT NULL DEFAULT 0
);`
};

class SidebarUI {
    constructor() {
        // Views
        this.listView = document.getElementById('listView');
        this.detailView = document.getElementById('detailView');
        this.constructorView = document.getElementById('constructorView');
        this.schemaConstructorView = document.getElementById('schemaConstructorView');

        // List view elements
        this.collectionsList = document.getElementById('collectionsList');
        this.template = document.getElementById('collectionTemplate');

        // Detail view elements
        this.detailTitle = document.getElementById('detailTitle');
        this.schemaContent = document.getElementById('schemaContent');
        this.entriesContent = document.getElementById('entriesContent');
        this.entryCount = document.getElementById('entryCount');

        // Constructor view elements
        this.constructorList = document.getElementById('constructorList');

        // Schema constructor elements
        this.schemaRepoNameInput = document.getElementById('schemaRepoNameInput');
        this.schemaRepoSqlInput = document.getElementById('schemaRepoSqlInput');

        // Schema picker elements
        this.schemaPickerOverlay = document.getElementById('schemaPickerOverlay');
        this.schemaPickerList = document.getElementById('schemaPickerList');

        // Schema SQL viewer elements
        this.schemaSqlViewerOverlay = document.getElementById('schemaSqlViewerOverlay');
        this.schemaSqlViewerTitle = document.getElementById('schemaSqlViewerTitle');
        this.schemaSqlViewerContent = document.getElementById('schemaSqlViewerContent');

        // Modal elements
        this.schemaModal = document.getElementById('schemaModal');
        this.schemaTextarea = document.getElementById('schemaTextarea');

        // State
        this.currentCollection = null;
        this.currentSchema = [];
        this.constructorItems = []; // { title, url }
        this.dragSrcIndex = null;

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

        // Constructor view (packets)
        document.getElementById('constructorBackBtn').addEventListener('click', () => this.showDetailView('packets'));
        document.getElementById('addCurrentTabBtn').addEventListener('click', () => this.addCurrentTab());
        document.getElementById('savePacketBtn').addEventListener('click', () => this.savePacket());
        document.getElementById('discardPacketBtn').addEventListener('click', () => this.discardPacket());

        // Schema constructor view
        document.getElementById('schemaConstructorBackBtn').addEventListener('click', () => this.showDetailView('schemas'));
        document.getElementById('saveSchemaRepoBtn').addEventListener('click', () => this.saveSchemaToRepo());
        document.getElementById('discardSchemaRepoBtn').addEventListener('click', () => this.discardSchemaConstructor());

        // Schema picker
        document.getElementById('fromRepoBtn').addEventListener('click', () => this.openSchemaPicker());
        document.getElementById('schemaPickerCloseBtn').addEventListener('click', () => this.closeSchemaPicker());
        this.schemaPickerOverlay.addEventListener('click', (e) => {
            if (e.target === this.schemaPickerOverlay) this.closeSchemaPicker();
        });

        // Schema SQL viewer
        document.getElementById('schemaSqlViewerCloseBtn').addEventListener('click', () => this.closeSchemaSqlViewer());
        this.schemaSqlViewerOverlay.addEventListener('click', (e) => {
            if (e.target === this.schemaSqlViewerOverlay) this.closeSchemaSqlViewer();
        });

        // Modal
        document.getElementById('modalSaveBtn').addEventListener('click', () => this.saveSchema());
        document.getElementById('modalCancelBtn').addEventListener('click', () => this.closeSchemaModal());
        document.getElementById('modalCloseBtn').addEventListener('click', () => this.closeSchemaModal());
        this.schemaModal.addEventListener('click', (e) => {
            if (e.target === this.schemaModal) this.closeSchemaModal();
        });

        // Preset schema buttons
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = SCHEMA_PRESETS[btn.dataset.preset];
                if (preset) {
                    this.schemaTextarea.value = preset;
                    this.schemaTextarea.focus();
                }
            });
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
        this.constructorView.classList.remove('active');
        this.schemaConstructorView.classList.remove('active');
        this.detailView.classList.add('active');
        this.loadCollectionDetail(collectionName);
    }

    showConstructorView() {
        this.constructorItems = [];
        this.dragSrcIndex = null;
        // Reset save button in case it was left disabled from a previous save
        const saveBtn = document.getElementById('savePacketBtn');
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Packet';
        this.renderConstructorItems();
        this.detailView.classList.remove('active');
        this.listView.classList.remove('active');
        this.constructorView.classList.add('active');
    }

    showSchemaConstructorView() {
        this.schemaRepoNameInput.value = '';
        this.schemaRepoSqlInput.value = '';
        const saveBtn = document.getElementById('saveSchemaRepoBtn');
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Schema';
        this.detailView.classList.remove('active');
        this.listView.classList.remove('active');
        this.constructorView.classList.remove('active');
        this.schemaConstructorView.classList.add('active');
        this.schemaRepoNameInput.focus();
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

        // System collections first (packets, then schemas), then alphabetical
        const sorted = collections.sort((a, b) => {
            if (a === 'packets') return -1;
            if (b === 'packets') return 1;
            if (a === 'schemas') return -1;
            if (b === 'schemas') return 1;
            return a.localeCompare(b);
        });

        sorted.forEach(name => {
            const item = this.createCollectionItem(name);
            this.collectionsList.appendChild(item);
        });
    }

    createCollectionItem(name) {
        const clone = this.template.content.cloneNode(true);

        clone.querySelector('.collection-name').textContent = name;

        if (name === 'packets' || name === 'schemas') {
            clone.querySelector('.collection-item').classList.add('system-collection');
            const deleteBtn = clone.querySelector('.delete-btn');
            if (deleteBtn) {
                deleteBtn.disabled = true;
                deleteBtn.title = `Cannot delete system collection "${name}"`;
            }
        }

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

                const detailDeleteBtn = document.getElementById('detailDeleteBtn');

                // Special handling for system collections
                if (name === 'packets') {
                    document.getElementById('editSchemaBtn').style.display = 'none';
                    detailDeleteBtn.disabled = true;
                    detailDeleteBtn.style.opacity = '0.5';
                    detailDeleteBtn.style.cursor = 'not-allowed';
                    detailDeleteBtn.title = 'Cannot delete system collection "packets"';
                    this.schemaContent.innerHTML = '<p class="hint">🔒 System collection. Schema is locked.</p>';
                    await this.loadPackets();
                } else if (name === 'schemas') {
                    document.getElementById('editSchemaBtn').style.display = 'none';
                    detailDeleteBtn.disabled = true;
                    detailDeleteBtn.style.opacity = '0.5';
                    detailDeleteBtn.style.cursor = 'not-allowed';
                    detailDeleteBtn.title = 'Cannot delete system collection "schemas"';
                    this.schemaContent.innerHTML = '<p class="hint">🔒 System collection. Schema is locked.</p>';
                    await this.loadSchemas();
                } else {
                    document.getElementById('editSchemaBtn').style.display = 'inline-flex';

                    detailDeleteBtn.disabled = false;
                    detailDeleteBtn.style.opacity = '';
                    detailDeleteBtn.style.cursor = '';
                    detailDeleteBtn.title = 'Delete Collection';

                    // Load entries for each table
                    await this.loadEntries(name, schemaResp.schema);
                }
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

    async loadPackets() {
        this.entryCount.textContent = '...';
        this.entriesContent.innerHTML = '<p class="hint">Loading packets...</p>';

        try {
            const response = await this.sendMessage({
                action: 'executeSQL',
                name: 'packets',
                sql: `SELECT rowid, name, urls, created FROM packets ORDER BY created DESC`
            });

            if (response.success && response.result.length > 0) {
                const rows = response.result[0].values;
                this.entryCount.textContent = rows.length;

                // Build header with Add Packet button
                const addBtn = document.createElement('button');
                addBtn.className = 'btn btn-primary btn-sm';
                addBtn.style.marginBottom = '12px';
                addBtn.innerHTML = '＋ Add Packet';
                addBtn.addEventListener('click', () => this.showConstructorView());

                if (rows.length === 0) {
                    this.entriesContent.innerHTML = '';
                    this.entriesContent.appendChild(addBtn);
                    this.entriesContent.insertAdjacentHTML('beforeend', '<p class="hint">No packets yet. Click above to create one.</p>');
                    return;
                }

                const html = rows.map(([rowid, name, urlsJson, created]) => {
                    let urlCount = 0;
                    try {
                        const urls = JSON.parse(urlsJson);
                        urlCount = urls.length;
                    } catch (e) { }

                    const time = new Date(created).toLocaleString();

                    return `
                    <div class="packet-card">
                        <div class="packet-info">
                            <span class="packet-name">${this.escapeHtml(name)} <span class="packet-url-count">${urlCount} URLs</span></span>
                            <span class="packet-meta">Created ${time}</span>
                        </div>
                        <div class="packet-card-actions">
                            <button class="play-btn" title="Open Packet" data-id="${rowid}">▶</button>
                            <button class="packet-delete-btn" title="Delete Packet" data-id="${rowid}">🗑</button>
                        </div>
                    </div>`;
                }).join('');

                this.entriesContent.innerHTML = '';
                this.entriesContent.appendChild(addBtn);
                this.entriesContent.insertAdjacentHTML('beforeend', `<div class="packet-list">${html}</div>`);

                // Add play + delete handlers
                this.entriesContent.querySelectorAll('.play-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const originalText = btn.textContent;
                        btn.textContent = '⏳';
                        try {
                            await this.sendMessage({ action: 'playPacket', id: btn.dataset.id });
                            btn.textContent = '✅';
                            setTimeout(() => btn.textContent = originalText, 1500);
                        } catch (error) {
                            console.error('Play failed:', error);
                            btn.textContent = '❌';
                            this.showNotification('Failed to open packet', 'error');
                            setTimeout(() => btn.textContent = originalText, 1500);
                        }
                    });
                });

                this.entriesContent.querySelectorAll('.packet-delete-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (!confirm('Delete this packet?')) return;
                        try {
                            const resp = await this.sendMessage({ action: 'deletePacket', id: btn.dataset.id });
                            if (!resp || !resp.success) throw new Error(resp?.error || 'Delete failed');
                            await this.loadPackets();
                        } catch (err) {
                            console.error('Delete packet failed:', err);
                            this.showNotification('Failed to delete packet: ' + err.message, 'error');
                        }
                    });
                });
            } else {
                this.entryCount.textContent = '0';
                this.entriesContent.innerHTML = '';
                const addBtn = document.createElement('button');
                addBtn.className = 'btn btn-primary btn-sm';
                addBtn.style.marginBottom = '12px';
                addBtn.innerHTML = '＋ Add Packet';
                addBtn.addEventListener('click', () => this.showConstructorView());
                this.entriesContent.appendChild(addBtn);
                this.entriesContent.insertAdjacentHTML('beforeend', '<p class="hint">No packets yet. Click above to create one.</p>');
            }
        } catch (error) {
            console.error('Failed to load packets:', error);
            this.entriesContent.innerHTML = '<p class="hint">Failed to load packets.</p>';
        }
    }

    // ===== SCHEMAS COLLECTION =====

    async loadSchemas() {
        this.entryCount.textContent = '...';
        this.entriesContent.innerHTML = '<p class="hint">Loading schemas...</p>';

        try {
            const resp = await this.sendMessage({ action: 'listSchemas' });
            if (!resp.success) throw new Error(resp.error || 'Failed to load schemas');

            const schemas = resp.schemas;
            this.entryCount.textContent = schemas.length + 1; // +1 for built-in

            const addBtn = document.createElement('button');
            addBtn.className = 'btn btn-primary btn-sm';
            addBtn.style.marginBottom = '12px';
            addBtn.innerHTML = '\uff0b Add Schema';
            addBtn.addEventListener('click', () => this.showSchemaConstructorView());

            this.entriesContent.innerHTML = '';
            this.entriesContent.appendChild(addBtn);

            // Always show the built-in packets schema
            const BUILTIN_PACKETS_SQL =
                `CREATE TABLE IF NOT EXISTS packets (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  urls    TEXT NOT NULL,  -- JSON array of URL strings
  created TEXT NOT NULL DEFAULT (datetime('now'))
);`;
            const builtinCard = document.createElement('div');
            builtinCard.className = 'schema-repo-card schema-repo-card--builtin';
            builtinCard.innerHTML = `
                <div class="schema-repo-card-info">
                    <div class="schema-repo-card-name">
                        packet <span class="schema-builtin-badge">built-in</span>
                    </div>
                    <div class="schema-repo-card-preview">${this.escapeHtml(BUILTIN_PACKETS_SQL.replace(/\s+/g, ' ').trim().slice(0, 80))}…</div>
                </div>
                <button class="schema-view-sql-btn">View SQL</button>`;
            builtinCard.querySelector('.schema-view-sql-btn').addEventListener('click', () => {
                this.showSchemaSqlViewer('packet', BUILTIN_PACKETS_SQL);
            });
            this.entriesContent.appendChild(builtinCard);

            if (schemas.length === 0) {
                this.entriesContent.insertAdjacentHTML('beforeend', '<p class="hint">No custom schemas yet. Click above to add one.</p>');
                return;
            }

            schemas.forEach(({ id, name, sql }) => {
                const preview = sql.replace(/\s+/g, ' ').trim().slice(0, 80);
                const card = document.createElement('div');
                card.className = 'schema-repo-card';
                card.innerHTML = `
                    <div class="schema-repo-card-info">
                        <div class="schema-repo-card-name">${this.escapeHtml(name)}</div>
                        <div class="schema-repo-card-preview">${this.escapeHtml(preview)}…</div>
                    </div>
                    <div class="packet-card-actions">
                        <button class="schema-view-sql-btn">View SQL</button>
                        <button class="schema-repo-delete-btn" title="Delete Schema" data-id="${id}">🗑</button>
                    </div>`;

                card.querySelector('.schema-view-sql-btn').addEventListener('click', () => {
                    this.showSchemaSqlViewer(name, sql);
                });

                card.querySelector('.schema-repo-delete-btn').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Delete schema "${name}"?`)) return;
                    try {
                        const delResp = await this.sendMessage({ action: 'deleteSchema', id });
                        if (!delResp || !delResp.success) throw new Error(delResp?.error || 'Delete failed');
                        await this.loadSchemas();
                    } catch (err) {
                        console.error('Delete schema failed:', err);
                        this.showNotification('Failed to delete schema: ' + err.message, 'error');
                    }
                });

                this.entriesContent.appendChild(card);
            });
        } catch (error) {
            console.error('Failed to load schemas:', error);
            this.entriesContent.innerHTML = '<p class=\"hint\">Failed to load schemas.</p>';
        }
    }

    async saveSchemaToRepo() {
        const name = this.schemaRepoNameInput.value.trim();
        const sql = this.schemaRepoSqlInput.value.trim();
        if (!name) {
            this.schemaRepoNameInput.focus();
            this.showNotification('Please enter a schema name', 'error');
            return;
        }
        if (!sql) {
            this.schemaRepoSqlInput.focus();
            this.showNotification('Please enter the SQL', 'error');
            return;
        }
        try {
            const saveBtn = document.getElementById('saveSchemaRepoBtn');
            saveBtn.disabled = true;
            saveBtn.textContent = '\u23f3 Saving\u2026';
            const resp = await this.sendMessage({ action: 'saveSchema', name, sql });
            if (!resp || !resp.success) throw new Error(resp?.error || 'Save failed');
            this.showDetailView('schemas');
        } catch (err) {
            console.error('saveSchemaToRepo failed:', err);
            this.showNotification('Failed to save schema: ' + err.message, 'error');
            const saveBtn = document.getElementById('saveSchemaRepoBtn');
            saveBtn.disabled = false;
            saveBtn.textContent = '\ud83d\udcbe Save Schema';
        }
    }

    discardSchemaConstructor() {
        const hasContent = this.schemaRepoNameInput.value.trim() || this.schemaRepoSqlInput.value.trim();
        if (hasContent && !confirm('Discard this schema?')) return;
        this.showDetailView('schemas');
    }

    async openSchemaPicker() {
        try {
            const resp = await this.sendMessage({ action: 'listSchemas' });
            if (!resp.success) throw new Error(resp.error || 'Failed to load schemas');

            const schemas = resp.schemas;
            this.schemaPickerList.innerHTML = '';

            if (schemas.length === 0) {
                this.schemaPickerList.innerHTML = '<p class="schema-picker-empty">No schemas saved yet.<br>Add schemas via the 📂 Schemas collection.</p>';
            } else {
                schemas.forEach(({ id, name, sql }) => {
                    const preview = sql.replace(/\s+/g, ' ').trim().slice(0, 100);
                    const item = document.createElement('div');
                    item.className = 'schema-picker-item';
                    item.innerHTML = `
                        <div class="schema-picker-item-name">${this.escapeHtml(name)}</div>
                        <div class="schema-picker-item-preview">${this.escapeHtml(preview)}\u2026</div>`;
                    item.addEventListener('click', () => {
                        this.schemaTextarea.value = sql;
                        this.closeSchemaPicker();
                    });
                    this.schemaPickerList.appendChild(item);
                });
            }

            this.schemaPickerOverlay.classList.remove('hidden');
        } catch (err) {
            console.error('openSchemaPicker failed:', err);
            this.showNotification('Failed to load schema repository', 'error');
        }
    }

    closeSchemaPicker() {
        this.schemaPickerOverlay.classList.add('hidden');
    }

    showSchemaSqlViewer(name, sql) {
        this.schemaSqlViewerTitle.textContent = name;
        this.schemaSqlViewerContent.textContent = sql;
        this.schemaSqlViewerOverlay.classList.remove('hidden');
    }

    closeSchemaSqlViewer() {
        this.schemaSqlViewerOverlay.classList.add('hidden');
    }

    // ===== PACKET CONSTRUCTOR =====


    async addCurrentTab() {
        try {
            const resp = await this.sendMessage({ action: 'getCurrentTab' });
            if (!resp.success) throw new Error(resp.error || 'Could not get current tab');
            const { title, url } = resp.tab;
            // Avoid duplicates
            if (this.constructorItems.some(item => item.url === url)) {
                this.showNotification('Tab already added', 'error');
                return;
            }
            this.constructorItems.push({ title: title || url, url });
            this.renderConstructorItems();
        } catch (err) {
            console.error('addCurrentTab failed:', err);
            this.showNotification('Could not get current tab', 'error');
        }
    }

    renderConstructorItems() {
        if (this.constructorItems.length === 0) {
            this.constructorList.innerHTML = '<p class="hint constructor-empty">No tabs added yet. Click "Add Current Tab" to start.</p>';
            return;
        }

        this.constructorList.innerHTML = '';
        this.constructorItems.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'constructor-card';
            card.draggable = true;
            card.dataset.index = index;
            card.innerHTML = `
                <span class="drag-handle" title="Drag to reorder">⠿</span>
                <div class="constructor-card-info">
                    <div class="constructor-card-title">${this.escapeHtml(item.title)}</div>
                    <div class="constructor-card-url">${this.escapeHtml(item.url)}</div>
                </div>
                <button class="constructor-remove-btn" title="Remove" data-index="${index}">🗑</button>`;

            // Drag events
            card.addEventListener('dragstart', (e) => {
                this.dragSrcIndex = index;
                card.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });
            card.addEventListener('dragend', () => card.classList.remove('dragging'));
            card.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                card.classList.add('drag-over');
            });
            card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
            card.addEventListener('drop', (e) => {
                e.preventDefault();
                card.classList.remove('drag-over');
                const targetIndex = parseInt(card.dataset.index);
                if (this.dragSrcIndex !== null && this.dragSrcIndex !== targetIndex) {
                    const moved = this.constructorItems.splice(this.dragSrcIndex, 1)[0];
                    this.constructorItems.splice(targetIndex, 0, moved);
                    this.dragSrcIndex = null;
                    this.renderConstructorItems();
                }
            });

            // Remove button
            card.querySelector('.constructor-remove-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.constructorItems.splice(index, 1);
                this.renderConstructorItems();
            });

            this.constructorList.appendChild(card);
        });
    }

    async savePacket() {
        if (this.constructorItems.length === 0) {
            this.showNotification('Add at least one tab first', 'error');
            return;
        }
        const name = window.prompt('Name this packet:');
        if (!name || !name.trim()) return; // user cancelled or left blank
        const urls = this.constructorItems.map(item => item.url);
        try {
            const saveBtn = document.getElementById('savePacketBtn');
            saveBtn.disabled = true;
            saveBtn.textContent = '⏳ Saving…';
            const resp = await this.sendMessage({ action: 'savePacket', name: name.trim(), urls });
            if (!resp || !resp.success) {
                throw new Error(resp?.error || 'Save failed');
            }
            this.showDetailView('packets');
        } catch (err) {
            console.error('savePacket failed:', err);
            this.showNotification('Failed to save packet: ' + err.message, 'error');
            const saveBtn = document.getElementById('savePacketBtn');
            saveBtn.disabled = false;
            saveBtn.textContent = '💾 Save Packet';
        }
    }

    discardPacket() {
        if (this.constructorItems.length > 0) {
            if (!confirm('Discard this packet?')) return;
        }
        this.showDetailView('packets');
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

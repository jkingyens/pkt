/**
 * SQLite Manager - Core API for managing SQLite databases with WebAssembly
 * Provides import/export and save/restore checkpoint functionality
 */

const PACKETS_COLLECTION = 'packets';
const PACKETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS packets (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  urls    TEXT NOT NULL,  -- JSON array of URL strings
  color   TEXT,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const SCHEMAS_COLLECTION = 'schemas';
const SCHEMAS_SCHEMA = `
CREATE TABLE IF NOT EXISTS schemas (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  sql     TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const WITS_COLLECTION = 'wits';
const WITS_SCHEMA = `
CREATE TABLE IF NOT EXISTS wits (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  wit     TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const EVENTS_COLLECTION = 'events';
const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  body         TEXT,
  is_simulated INTEGER DEFAULT 0,
  created      TEXT NOT NULL DEFAULT (datetime('now'))
);`;

const SERVICES_COLLECTION = 'services';
const SERVICES_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS services_fts USING fts5(
  name, 
  icon, 
  description,
  config_id UNINDEXED,
  manifest_permission UNINDEXED
);
CREATE TABLE IF NOT EXISTS configured_services (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  icon        TEXT,
  description TEXT,
  config_id   TEXT UNIQUE NOT NULL,
  manifest_permission TEXT,
  created     TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

class SQLiteManager {
  constructor() {
    this.worker = null;
    this.pendingRequests = new Map();
    this.requestId = 0;
    this._initPromise = null;
    this.databases = new Set(); // track all discovered/known collections
    this._activeDatabases = new Set(); // track active handles in the worker
    this._pendingInit = new Map(); // track in-flight initDatabase calls
  }

  /**
   * Initialize the SQLite worker or proxy
   */
  async init() {
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
        // 1. Core connection setup
        await new Promise((resolve, reject) => {
            const isBackground = typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope;
            
            if (isBackground) {
                const listener = (message) => {
                    if (message.type === 'SQLITE_PROXY_RESPONSE' && message.success && message.id === 'OFFSCREEN_READY') {
                        chrome.runtime.onMessage.removeListener(listener);
                        resolve();
                    }
                };
                chrome.runtime.onMessage.addListener(listener);
                
                const checkReady = async () => {
                  try {
                    await chrome.runtime.sendMessage({ type: 'SQLITE_PROXY_REQUEST', action: 'ping', id: 'ping' });
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve();
                  } catch (e) {
                    setTimeout(checkReady, 500);
                  }
                };
                checkReady();
                return;
            }

            try {
                this.worker = new Worker(chrome.runtime.getURL('src/sqlite-worker.js'), { type: 'module' });
                this.worker.onmessage = (event) => {
                    const { type, id, success, result, error } = event.data;
                    if (type === 'READY') resolve();
                    else if (type === 'ERROR' && !id) reject(new Error(error));
                    else if (id !== undefined) {
                        const handler = this.pendingRequests.get(id);
                        if (handler) {
                            this.pendingRequests.delete(id);
                            if (success) handler.resolve(result);
                            else handler.reject(new Error(error));
                        }
                    }
                };
                this.worker.onerror = (err) => reject(err);
            } catch (e) {
                reject(e);
            }
        });

        // 2. Database discovery (must happen after connection but before init resolves)
        try {
            const existingNames = await this._sendRequest('list', {});
            if (Array.isArray(existingNames)) {
                existingNames.forEach(name => this.databases.add(name));
                console.log('[SQLiteManager] Discovered existing databases:', existingNames);
            }
        } catch (e) {
            console.warn('[SQLiteManager] Initial discovery failed:', e);
        }
    })();

    return this._initPromise;
  }

  async _sendRequest(action, payload) {
    // Avoid recursion during init()
    if (action !== 'list' && action !== 'ping') {
        await this.init();
    }
    
    const id = this.requestId++;
    if (this.worker) {
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.worker.postMessage({ id, action, payload });
        });
    } else {
        // PROXY MODE - Normalize binary data if present in payload
        const serializedPayload = { ...payload };
        if (serializedPayload.data instanceof Uint8Array) {
          serializedPayload.data = Array.from(serializedPayload.data);
        }

        const response = await chrome.runtime.sendMessage({
            type: 'SQLITE_PROXY_REQUEST',
            id,
            action,
            payload: serializedPayload
        });

        console.log(`[SW-Proxy] Response for ${action} ID: ${id}`, response);

        if (!response) {
            console.error(`[SW-Proxy] NO RESPONSE for ${action} ID: ${id}`);
            throw new Error(`No response from SQLite Proxy for action: ${action}`);
        }

        if (!response.success) {
            const isExpectedError = response.error && (response.error.includes('duplicate column') || response.error.includes('no such table'));
            if (!isExpectedError) {
                console.error(`[SW-Proxy] FAILED for ${action} ID: ${id} Error: ${response.error}`);
            } else {
                console.log(`[SW-Proxy] Handled expected migration error for ${action}: ${response.error}`);
            }
            throw new Error(response.error || `Proxy request failed for action: ${action}`);
        }

        // Restore binary data if result is an array and we expect binary (e.g. for 'export')
        let finalResult = response.result;
        if (Array.isArray(finalResult) && (action === 'export' || id === 'export' || action === 'exportToBlob')) {
            finalResult = new Uint8Array(finalResult);
        }

        return finalResult;
    }
  }

  /**
   * Helper: Normalize legacy result format [{columns, values}] to array of objects
   */
  _normalizeRows(result) {
    if (!Array.isArray(result) || result.length === 0) return [];
    
    // Check if result is in legacy format: [{columns: [...], values: [...]}]
    if (result[0] && Array.isArray(result[0].columns) && Array.isArray(result[0].values)) {
        const columns = result[0].columns;
        return result[0].values.map(values => {
            const row = {};
            columns.forEach((col, idx) => {
                row[col] = values[idx];
            });
            return row;
        });
    }
    
    // Already array of objects (or empty)
    return result;
  }

  /**
   * Handle a response from the offscreen proxy (called by Service Worker)
   */
  handleProxyResponse(message) {
      const { id, success, result, error, action } = message;
      const handler = this.pendingRequests.get(id);
      if (!handler) return;

      this.pendingRequests.delete(id);

      if (!success) {
          handler.reject(new Error(error));
          return;
      }

      // Restore binary data if result is an array and we expect binary (e.g. for 'export')
      let finalResult = result;
      if (Array.isArray(result) && (action === 'export' || id === 'export')) {
          finalResult = new Uint8Array(result);
      }

      handler.resolve(finalResult);
  }

  /**
   * Initialize or get an existing database
   * @param {string} collectionName - Name of the collection/database
   */
  async initDatabase(collectionName) {
    if (this._activeDatabases.has(collectionName)) return;
    
    // Concurrency guard: wait for existing init if in progress
    if (this._pendingInit.has(collectionName)) {
      return this._pendingInit.get(collectionName);
    }

    const initPromise = (async () => {
      try {
        await this._sendRequest('open', { name: collectionName });
        this._activeDatabases.add(collectionName);
        this.databases.add(collectionName);
      } finally {
        this._pendingInit.delete(collectionName);
      }
    })();
    
    this._pendingInit.set(collectionName, initPromise);
    return initPromise;
  }

  /**
   * Import a database from a data source
   * @param {string} collectionName - Name for the collection
   * @param {Blob|ArrayBuffer|Uint8Array} data - SQLite database file data
   */
  async importFromBlob(collectionName, data) {
    let uint8Array;
    if (data instanceof Blob) {
      uint8Array = new Uint8Array(await data.arrayBuffer());
    } else if (data instanceof ArrayBuffer) {
      uint8Array = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      uint8Array = data;
    } else {
      throw new Error('Data must be a Blob, ArrayBuffer, or Uint8Array');
    }

    await this._sendRequest('import', { name: collectionName, data: uint8Array });
    this.databases.add(collectionName);
  }

  /**
   * Export a database to a blob
   * @param {string} collectionName - Name of the collection
   * @returns {Promise<Blob>} SQLite database as blob
   */
  async exportToBlob(collectionName) {
    const uint8Array = await this._sendRequest('export', { name: collectionName });
    return new Blob([uint8Array], { type: 'application/x-sqlite3' });
  }

  /**
   * Save database state (checkpoint) to storage
   * @param {string} collectionName - Name of the collection
   * @param {Object} storage - Storage interface
   */
  async saveCheckpoint(collectionName, storage, prefix = 'db_') {
    // With OPFS, we don't strictly NEED checkpoints anymore for persistence,
    // but we can still use this to "mirror" data to chrome.storage.local for backup/sync if desired.
    // For now, let's keep it to allow "legacy" backup to work, but it's redundant.
    const uint8Array = await this._sendRequest('export', { name: collectionName });
    const base64 = this._arrayBufferToBase64(uint8Array);

    if (storage.set) {
      await storage.set({ [`${prefix}${collectionName}`]: base64 });
    } else {
      storage.set(`${prefix}${collectionName}`, base64);
    }
  }

  /**
   * Restore database state from checkpoint
   * @param {string} collectionName - Name of the collection
   * @param {Object} storage - Storage interface
   * @returns {Promise<boolean>} True if restored, false if no checkpoint found
   */
  async restoreCheckpoint(collectionName, storage, prefix = 'db_') {
    let base64;
    if (storage.get) {
      const key = `${prefix}${collectionName}`;
      const result = await storage.get([key]);
      base64 = result[key];
    } else {
      base64 = storage.get(`${prefix}${collectionName}`);
    }

    if (!base64) return false;

    const uint8Array = this._base64ToArrayBuffer(base64);
    await this.importFromBlob(collectionName, uint8Array);
    return true;
  }

  /**
   * Restore all checkpoints from storage
   * @param {Object} storage - Storage interface
   * @returns {Promise<Array<string>>} Array of restored collection names
   */
  async restoreAllCheckpoints(storage, prefix = 'db_') {
    const restoredCollections = [];

    if (storage.get) {
      // Chrome storage API - get all items
      const allItems = await storage.get(null);

      for (const key of Object.keys(allItems)) {
        if (key.startsWith(prefix)) {
          const collectionName = key.replace(prefix, '');
          try {
            // Avoid duplicate restoration if we already restored this collection with a different prefix
            if (restoredCollections.includes(collectionName)) continue;

            const restoredValue = await storage.get(key);
            const base64 = restoredValue[key];
            if (base64) {
               const uint8Array = this._base64ToArrayBuffer(base64);
               await this.importFromBlob(collectionName, uint8Array);
               restoredCollections.push(collectionName);
            }
          } catch (error) {
            console.error(`[SQLiteManager] Failed to restore ${collectionName}:`, error);
          }
        }
      }
    }

    return restoredCollections;
  }

  /**
   * Ensure the 'packets' system collection exists with the correct schema
   */
  async ensurePacketsCollection() {
    await this.initDatabase(PACKETS_COLLECTION);
    const db = this.getDatabase(PACKETS_COLLECTION);
    await db.exec(PACKETS_SCHEMA);
    
    try {
      // Check if color column exists to avoid console errors from ALTER TABLE
      const info = await db.query("PRAGMA table_info(packets)");
      const hasColor = info.some(col => col.name === 'color');
      if (!hasColor) {
        await db.exec("ALTER TABLE packets ADD COLUMN color TEXT");
        console.log('[SQLiteManager] Added missing color column to packets table');
      }
    } catch (e) {
      console.warn('[SQLiteManager] Migration check failed:', e);
    }
  }

  /**
   * Ensure the 'schemas' system collection exists with the correct schema
   */
  async ensureSchemasCollection() {
    await this.initDatabase(SCHEMAS_COLLECTION);
    const db = this.getDatabase(SCHEMAS_COLLECTION);
    await db.exec(SCHEMAS_SCHEMA);
  }

  /**
   * Ensure the 'wits' system collection exists with the correct schema and default entry
   */
  async ensureWitsCollection() {
    await this.initDatabase(WITS_COLLECTION);
    const db = this.getDatabase(WITS_COLLECTION);
    await db.exec(WITS_SCHEMA);

    // Check for defaults
    try {
      const check = await db.exec("SELECT id FROM wits WHERE name = 'chrome:bookmarks'");
      if (!check || !check.length) {
        const defaultWit = `package chrome:bookmarks;

interface bookmarks {
    record bookmark-node {
        id: string,
        parent-id: option<string>,
        title: string,
        url: option<string>,
        children: option<list<bookmark-node>>,
    }
    
    get-tree: func() -> result<list<bookmark-node>, string>;
    create: func(title: string, url: string) -> result<bookmark-node, string>;
}`;
        await db.exec("INSERT INTO wits (name, wit) VALUES (?, ?)", ['chrome:bookmarks', defaultWit]);
      }

      const checkSqlite = await db.exec("SELECT id FROM wits WHERE name = 'user:sqlite'");
      if (!checkSqlite || !checkSqlite.length) {
        const sqliteWit = `package user:sqlite;

interface sqlite {
    record row {
        values: list<string>
    }

    record query-result {
        columns: list<string>,
        rows: list<row>
    }

    execute: func(db: string, sql: string) -> result<u32, string>;
    query: func(db: string, sql: string) -> result<query-result, string>;
}`;
        await db.exec("INSERT INTO wits (name, wit) VALUES (?, ?)", ['user:sqlite', sqliteWit]);
      }
    } catch (e) { console.error('Error ensuring default wits:', e); }
  }

  /**
   * Ensure the 'events' system collection exists with the correct schema
   */
  async ensureEventsCollection() {
    await this.initDatabase(EVENTS_COLLECTION);
    const db = this.getDatabase(EVENTS_COLLECTION);
    await db.exec(EVENTS_SCHEMA);
  }

  /**
   * Ensure the 'services' system collection exists with FTS5 and default entries
   */
  async ensureServicesCollection() {
    await this.initDatabase(SERVICES_COLLECTION);
    const db = this.getDatabase(SERVICES_COLLECTION);
    await db.exec(SERVICES_SCHEMA);
    console.log('[SQLiteManager] Initialized services_fts table');
  }

  /**
   * List all active collections
   * @returns {Array<string>} Array of collection names
   */
  listCollections() {
    return Array.from(this.databases);
  }

  /**
   * Get database proxy for SQL operations
   * @param {string} collectionName - Name of the collection
   * @returns {Object|null} Proxy with async exec/run methods
   */
  getDatabase(collectionName) {
    if (!this.databases.has(collectionName)) return null;
    return {
      exec: async (sql, bind) => {
        await this.initDatabase(collectionName);
        return this._sendRequest('exec', { name: collectionName, sql, bind });
      },
      // query returns normalized row objects
      query: async (sql, bind) => {
        await this.initDatabase(collectionName);
        const result = await this._sendRequest('exec', { name: collectionName, sql, bind });
        return this._normalizeRows(result);
      },
      // Compatibility run method
      run: async (sql, bind) => {
        await this.initDatabase(collectionName);
        return this._sendRequest('exec', { name: collectionName, sql, bind });
      },
      close: () => this.closeDatabase(collectionName)
    };
  }

  /**
   * Close and remove a database
   * @param {string} collectionName - Name of the collection
   */
  async closeDatabase(collectionName) {
    if (this._activeDatabases.has(collectionName)) {
      await this._sendRequest('close', { name: collectionName });
      this._activeDatabases.delete(collectionName);
      // Note: this.databases still retains the name, indicating it's a known collection,
      // but it's no longer actively open.
    }
  }

  /**
   * Delete a collection entirely (removes from storage)
   * @param {string} collectionName - Name of the collection
   * @returns {Promise<boolean>} True if deleted, false if not found
   */
  async deleteCollection(collectionName) {
    if (this.databases.has(collectionName)) {
      await this._sendRequest('close', { name: collectionName }); // Ensure closed before deleting
      this.databases.delete(collectionName);
      this._activeDatabases.delete(collectionName); // Remove from active handles
      await this._sendRequest('delete', { name: collectionName }); // Request actual deletion
      return true;
    }
    return false;
  }

  /**
   * Close all databases
   */
  async closeAll() {
    for (const name of this._activeDatabases) { // Iterate over active databases
      await this.closeDatabase(name);
    }
  }

  /**
   * Wipe all local databases
   */
  async wipe() {
    await this._sendRequest('wipe', {});
    this.databases.clear();
    this._activeDatabases.clear();
  }

  /**
   * Get schema (table definitions) for a collection
   * @param {string} collectionName
   * @returns {Promise<Array<{name: string, sql: string}>>} Array of table definitions
   */
  async getSchema(collectionName) {
    const db = this.getDatabase(collectionName);
    if (!db) throw new Error(`Database '${collectionName}' not found`);

    const result = await db.exec(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    const rows = this._normalizeRows(result);
    return rows.map(row => ({ name: row.name, sql: row.sql }));
  }

  /**
   * Get all row IDs for a table in a collection
   * @param {string} collectionName
   * @param {string} tableName
   * @returns {Promise<Array<number>>} Array of rowids
   */
  async getEntries(collectionName, tableName) {
    const db = this.getDatabase(collectionName);
    if (!db) throw new Error(`Database '${collectionName}' not found`);

    const result = await db.exec(`SELECT rowid FROM "${tableName}" ORDER BY rowid`);
    const rows = this._normalizeRows(result);
    return rows.map(row => row.rowid || row.id);
  }

  /**
   * Get full data for a specific entry
   * @param {string} collectionName
   * @param {string} tableName
   * @param {number|string} rowId
   * @returns {Promise<Object|null>} Entry data or null
   */
  async getEntry(collectionName, tableName, rowId) {
    const db = this.getDatabase(collectionName);
    if (!db) throw new Error(`Database '${collectionName}' not found`);

    const result = await db.exec(`SELECT * FROM "${tableName}" WHERE rowid = ?`, [rowId]);
    const rows = this._normalizeRows(result);
    if (!rows.length) return null;
    return rows[0];
  }

  /**
   * Apply a full schema to a collection.
   */
  async applySchema(collectionName, fullSQL, storage, prefix = 'db_') {
    const db = this.getDatabase(collectionName);
    if (!db) throw new Error(`Database '${collectionName}' not found`);

    // Parse all table names from the new SQL
    const newTableNames = new Set();
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?(\w+)["`']?/gi;
    let match;
    while ((match = tableRegex.exec(fullSQL)) !== null) {
      newTableNames.add(match[1]);
    }

    if (newTableNames.size === 0) {
      throw new Error('No valid CREATE TABLE statements found in the schema');
    }

    // Get existing user tables
    const existing = await this.getSchema(collectionName);
    const existingNames = new Set(existing.map(t => t.name));

    for (const name of existingNames) {
      if (!newTableNames.has(name)) {
        await db.exec(`DROP TABLE IF EXISTS "${name}"`);
      }
    }

    // Split the SQL into individual statements and execute each
    const statements = fullSQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      const nameMatch = stmt.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?(\w+)["`']?/i);
      if (nameMatch) {
        const tableName = nameMatch[1];
        await db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
        await db.exec(stmt);
      }
    }

    // Auto-save checkpoint so schema persists (redundant but kept for backup compatibility)
    if (storage) {
      await this.saveCheckpoint(collectionName, storage, prefix);
    }
  }

  // Helper methods for base64 encoding/decoding
  _arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  _base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}

// Expose globally for importScripts usage in service worker
if (typeof self !== 'undefined') {
  self.SQLiteManager = SQLiteManager;
  self.PACKETS_COLLECTION = PACKETS_COLLECTION;
  self.PACKETS_SCHEMA = PACKETS_SCHEMA;
  self.WITS_COLLECTION = WITS_COLLECTION;
  self.WITS_SCHEMA = WITS_SCHEMA;
  self.EVENTS_COLLECTION = EVENTS_COLLECTION;
  self.EVENTS_SCHEMA = EVENTS_SCHEMA;
  self.SERVICES_COLLECTION = SERVICES_COLLECTION;
  self.SERVICES_SCHEMA = SERVICES_SCHEMA;
}

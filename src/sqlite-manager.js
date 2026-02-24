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

class SQLiteManager {
  constructor(SQL) {
    this.SQL = SQL;
    this.databases = new Map(); // collectionName -> db instance
  }

  /**
   * Initialize or get an existing database
   * @param {string} collectionName - Name of the collection/database
   * @returns {Object} Database instance
   */
  initDatabase(collectionName) {
    if (this.databases.has(collectionName)) {
      return this.databases.get(collectionName);
    }

    const db = new this.SQL.Database();
    this.databases.set(collectionName, db);
    return db;
  }

  /**
   * Import a database from a blob/file
   * @param {string} collectionName - Name for the collection
   * @param {Blob|ArrayBuffer} data - SQLite database file data
   * @returns {Promise<void>}
   */
  async importFromBlob(collectionName, data) {
    let arrayBuffer;

    if (data instanceof Blob) {
      arrayBuffer = await data.arrayBuffer();
    } else if (data instanceof ArrayBuffer) {
      arrayBuffer = data;
    } else {
      throw new Error('Data must be a Blob or ArrayBuffer');
    }

    const uint8Array = new Uint8Array(arrayBuffer);
    const db = new this.SQL.Database(uint8Array);

    // Close existing database if present
    if (this.databases.has(collectionName)) {
      this.databases.get(collectionName).close();
    }

    this.databases.set(collectionName, db);
  }

  /**
   * Export a database to a blob
   * @param {string} collectionName - Name of the collection
   * @returns {Promise<Blob>} SQLite database as blob
   */
  async exportToBlob(collectionName) {
    const db = this.databases.get(collectionName);
    if (!db) {
      throw new Error(`Database '${collectionName}' not found`);
    }

    const uint8Array = db.export();
    return new Blob([uint8Array], { type: 'application/x-sqlite3' });
  }

  /**
   * Save database state (checkpoint) to storage
   * @param {string} collectionName - Name of the collection
   * @param {Object} storage - Storage interface (e.g., chrome.storage.local or Map for Node.js)
   * @returns {Promise<void>}
   */
  async saveCheckpoint(collectionName, storage, prefix = 'db_') {
    const db = this.databases.get(collectionName);
    if (!db) {
      throw new Error(`Database '${collectionName}' not found`);
    }

    const uint8Array = db.export();
    const base64 = this._arrayBufferToBase64(uint8Array);

    if (storage.set) {
      // Chrome storage API
      await storage.set({ [`${prefix}${collectionName}`]: base64 });
    } else {
      // Simple Map for testing
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
      // Chrome storage API
      const key = `${prefix}${collectionName}`;
      const result = await storage.get([key]);
      base64 = result[key];
    } else {
      // Simple Map for testing
      base64 = storage.get(`${prefix}${collectionName}`);
    }

    if (base64 === null || base64 === undefined) {
      return false;
    }

    const uint8Array = this._base64ToArrayBuffer(base64);
    const db = new this.SQL.Database(uint8Array);

    // Close existing database if present
    if (this.databases.has(collectionName)) {
      this.databases.get(collectionName).close();
    }

    this.databases.set(collectionName, db);
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
            const restored = await this.restoreCheckpoint(collectionName, storage, prefix);
            if (restored) {
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
   * @param {Object} storage - Storage interface
   */
  async ensurePacketsCollection() {
    let db = this.databases.get(PACKETS_COLLECTION);
    if (!db) {
      db = await this.initDatabase(PACKETS_COLLECTION);
    }
    db.exec(PACKETS_SCHEMA);
  }

  /**
   * Ensure the 'schemas' system collection exists with the correct schema
   * @param {Object} storage - Storage interface
   */
  async ensureSchemasCollection() {
    let db = this.databases.get(SCHEMAS_COLLECTION);
    if (!db) {
      db = await this.initDatabase(SCHEMAS_COLLECTION);
    }
    db.exec(SCHEMAS_SCHEMA);
  }

  /**
   * Ensure the 'wits' system collection exists with the correct schema and default entry
   * @param {Object} storage - Storage interface
   */
  async ensureWitsCollection() {
    let db = this.databases.get(WITS_COLLECTION);
    if (!db) {
      db = await this.initDatabase(WITS_COLLECTION);
    }
    db.exec(WITS_SCHEMA);

    // Check for defaults
    try {
      const check = db.exec("SELECT rowid FROM wits WHERE name = 'chrome:bookmarks'");
      if (!check.length || !check[0].values.length) {
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
        // Use run with binding parameters to avoid SQL injection/escaping issues
        db.exec("INSERT INTO wits (name, wit) VALUES (?, ?)", ['chrome:bookmarks', defaultWit]);
      }

      const checkSqlite = db.exec("SELECT rowid FROM wits WHERE name = 'user:sqlite'");
      if (!checkSqlite.length || !checkSqlite[0].values.length) {
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
        db.exec("INSERT INTO wits (name, wit) VALUES (?, ?)", ['user:sqlite', sqliteWit]);
      }
    } catch (e) { console.error('Error ensuring default wits:', e); }
  }

  /**
   * List all active collections
   * @returns {Array<string>} Array of collection names
   */
  listCollections() {
    return Array.from(this.databases.keys());
  }

  /**
   * Get database instance for direct SQL operations
   * @param {string} collectionName - Name of the collection
   * @returns {Object|null} Database instance or null
   */
  getDatabase(collectionName) {
    return this.databases.get(collectionName) || null;
  }

  /**
   * Close and remove a database
   * @param {string} collectionName - Name of the collection
   */
  closeDatabase(collectionName) {
    const db = this.databases.get(collectionName);
    if (db) {
      db.close();
      this.databases.delete(collectionName);
    }
  }

  /**
   * Close all databases
   */
  closeAll() {
    for (const [name, db] of this.databases) {
      db.close();
    }
    this.databases.clear();
  }

  /**
   * Get schema (table definitions) for a collection
   * @param {string} collectionName
   * @returns {Array<{name: string, sql: string}>} Array of table definitions
   */
  getSchema(collectionName) {
    const db = this.databases.get(collectionName);
    if (!db) throw new Error(`Database '${collectionName}' not found`);

    const result = db.exec(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    if (!result.length) return [];
    return result[0].values.map(([name, sql]) => ({ name, sql }));
  }

  /**
   * Get all row IDs for a table in a collection
   * @param {string} collectionName
   * @param {string} tableName
   * @returns {Array<number>} Array of rowids
   */
  getEntries(collectionName, tableName) {
    const db = this.databases.get(collectionName);
    if (!db) throw new Error(`Database '${collectionName}' not found`);

    const result = db.exec(`SELECT rowid FROM "${tableName}" ORDER BY rowid`);
    if (!result.length) return [];
    return result[0].values.map(([id]) => id);
  }

  /**
   * Get full data for a specific entry
   * @param {string} collectionName
   * @param {string} tableName
   * @param {number|string} rowId
   * @returns {Object|null} Entry data or null
   */
  getEntry(collectionName, tableName, rowId) {
    const db = this.databases.get(collectionName);
    if (!db) throw new Error(`Database '${collectionName}' not found`);

    const result = db.exec(`SELECT * FROM "${tableName}" WHERE rowid = ?`, [rowId]);
    if (!result.length || !result[0].values.length) return null;

    const columns = result[0].columns;
    const values = result[0].values[0];
    const data = {};
    columns.forEach((col, i) => {
      data[col] = values[i];
    });
    return data;
  }

  /**
   * Apply a full schema to a collection.
   * Parses all CREATE TABLE statements from the provided SQL,
   * drops any existing tables NOT in the new schema, then
   * drops-and-recreates each table that IS in the new schema.
   * @param {string} collectionName
   * @param {string} fullSQL - One or more CREATE TABLE statements
   * @param {Object} storage - Storage interface for auto-save
   */
  async applySchema(collectionName, fullSQL, storage, prefix = 'db_') {
    const db = this.databases.get(collectionName);
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
    const existing = this.getSchema(collectionName);
    const existingNames = new Set(existing.map(t => t.name));

    for (const name of existingNames) {
      if (!newTableNames.has(name)) {
        db.run(`DROP TABLE IF EXISTS "${name}"`);
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
        db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
        db.exec(stmt);
      }
    }

    // Auto-save checkpoint so schema persists
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
}

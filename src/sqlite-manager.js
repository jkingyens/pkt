/**
 * SQLite Manager - Core API for managing SQLite databases with WebAssembly
 * Provides import/export and save/restore checkpoint functionality
 */

export const PACKETS_COLLECTION = 'packets';
export const PACKETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS packets (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  urls    TEXT NOT NULL,  -- JSON array of URL strings
  created TEXT NOT NULL DEFAULT (datetime('now'))
);`;

export const SCHEMAS_COLLECTION = 'schemas';
export const SCHEMAS_SCHEMA = `
CREATE TABLE IF NOT EXISTS schemas (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  sql     TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);`;

export class SQLiteManager {
  constructor(SQL) {
    this.SQL = SQL;
    this.databases = new Map(); // collectionName -> db instance
  }

  /**
   * Initialize or get an existing database
   * @param {string} collectionName - Name of the collection/database
   * @returns {Promise<Object>} Database instance
   */
  async initDatabase(collectionName) {
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
  async saveCheckpoint(collectionName, storage) {
    const db = this.databases.get(collectionName);
    if (!db) {
      throw new Error(`Database '${collectionName}' not found`);
    }

    const uint8Array = db.export();
    const base64 = this._arrayBufferToBase64(uint8Array);

    if (storage.set) {
      // Chrome storage API
      await storage.set({ [`checkpoint_${collectionName}`]: base64 });
    } else {
      // Simple Map for testing
      storage.set(`checkpoint_${collectionName}`, base64);
    }
  }

  /**
   * Restore database state from checkpoint
   * @param {string} collectionName - Name of the collection
   * @param {Object} storage - Storage interface
   * @returns {Promise<boolean>} True if restored, false if no checkpoint found
   */
  async restoreCheckpoint(collectionName, storage) {
    let base64;

    if (storage.get) {
      // Chrome storage API
      const key = `checkpoint_${collectionName}`;
      const result = await storage.get([key]);
      base64 = result[key];
    } else {
      // Simple Map for testing
      base64 = storage.get(`checkpoint_${collectionName}`);
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
  async restoreAllCheckpoints(storage) {
    const restoredCollections = [];

    if (storage.get) {
      // Chrome storage API - get all items
      const allItems = await storage.get(null);

      for (const key of Object.keys(allItems)) {
        if (key.startsWith('checkpoint_')) {
          const collectionName = key.replace('checkpoint_', '');
          try {
            const restored = await this.restoreCheckpoint(collectionName, storage);
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
  async ensurePacketsCollection(storage) {
    let db = this.databases.get(PACKETS_COLLECTION);
    if (!db) {
      db = await this.initDatabase(PACKETS_COLLECTION);
    }
    db.run(PACKETS_SCHEMA);
    if (storage) {
      await this.saveCheckpoint(PACKETS_COLLECTION, storage);
    }
  }

  /**
   * Ensure the 'schemas' system collection exists with the correct schema
   * @param {Object} storage - Storage interface
   */
  async ensureSchemasCollection(storage) {
    let db = this.databases.get(SCHEMAS_COLLECTION);
    if (!db) {
      db = await this.initDatabase(SCHEMAS_COLLECTION);
    }
    db.run(SCHEMAS_SCHEMA);
    if (storage) {
      await this.saveCheckpoint(SCHEMAS_COLLECTION, storage);
    }
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
      `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
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
   * Apply a full schema to a collection.
   * Parses all CREATE TABLE statements from the provided SQL,
   * drops any existing tables NOT in the new schema, then
   * drops-and-recreates each table that IS in the new schema.
   * @param {string} collectionName
   * @param {string} fullSQL - One or more CREATE TABLE statements
   * @param {Object} storage - Storage interface for auto-save
   */
  async applySchema(collectionName, fullSQL, storage) {
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
        db.run(`DROP TABLE IF EXISTS "${tableName}"`);
        db.run(stmt);
      }
    }

    // Auto-save checkpoint so schema persists
    if (storage) {
      await this.saveCheckpoint(collectionName, storage);
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
}

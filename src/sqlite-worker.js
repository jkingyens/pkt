/**
 * SQLite Worker for OPFS persistent storage
 */
import sqlite3InitModule from '../vendor/sqlite/sqlite3.mjs';

const dbs = {};
let sqlite3;

const start = async () => {
    try {
        console.log('[SQLiteWorker] Initializing...');
        sqlite3 = await sqlite3InitModule({
            print: console.log,
            printErr: console.error,
        });

        if ('opfs' in sqlite3) {
            console.log('[SQLiteWorker] OPFS is available.');
        } else {
            console.warn('[SQLiteWorker] OPFS is NOT available. Falling back to memory (transient!).');
        }

        self.postMessage({ type: 'READY' });
    } catch (err) {
        console.error('[SQLiteWorker] Initialization failed:', err);
        self.postMessage({ type: 'ERROR', error: err.message });
    }
};

const getDb = (name) => {
    const db = dbs[name];
    if (!db) throw new Error(`Database not open: ${name}`);
    return db;
};

self.onmessage = async (event) => {
    const { id, action, payload } = event.data;

    try {
        if (!sqlite3) {
            throw new Error('SQLite not initialized');
        }

        switch (action) {
            case 'open': {
                const { name } = payload;
                if (dbs[name]) {
                    try {
                        if (typeof dbs[name].close === 'function') dbs[name].close();
                    } catch (e) {
                        console.warn(`[SQLiteWorker] Error closing database ${name}:`, e);
                    }
                }
                
                if (sqlite3.opfs) {
                    dbs[name] = new sqlite3.oo1.OpfsDb(`/wildcard_${name}.sqlite3`);
                } else {
                    dbs[name] = new sqlite3.oo1.DB(':memory:');
                }
                console.log(`[SQLiteWorker] Database opened: ${name} (VFS: ${dbs[name].filename})`);
                self.postMessage({ id, success: true });
                break;
            }

            case 'exec': {
                const { name, sql, bind } = payload;
                const db = getDb(name);
                const results = [];
                let currentResult = null;

                db.exec({
                    sql,
                    bind,
                    rowMode: 'array',
                    callback: function(row, stmt) {
                        // For compatibility with legacy sql.js format:
                        // Each statement result is an object with {columns, values}
                        if (!currentResult) {
                            currentResult = {
                                columns: stmt.getColumnNames(),
                                values: []
                            };
                            results.push(currentResult);
                        }
                        currentResult.values.push(row);
                    }
                });
                
                self.postMessage({ id, success: true, result: results });
                break;
            }

            case 'export': {
                const { name } = payload;
                const db = dbs[name];
                
                let byteArray;
                if (db instanceof sqlite3.oo1.OpfsDb) {
                    console.log(`[SQLiteWorker] Exporting OPFS database: ${name}`);
                    const root = await navigator.storage.getDirectory();
                    const fileHandle = await root.getFileHandle(`wildcard_${name}.sqlite3`);
                    const file = await fileHandle.getFile();
                    const arrayBuffer = await file.arrayBuffer();
                    byteArray = new Uint8Array(arrayBuffer);
                } else if (db) {
                    console.log(`[SQLiteWorker] Exporting memory/transient database: ${name}`);
                    if (sqlite3.wasm && typeof sqlite3.wasm.exportDb === 'function') {
                        byteArray = sqlite3.wasm.exportDb(db);
                    } else if (sqlite3.capi && typeof sqlite3.capi.sqlite3_js_db_serialize === 'function') {
                        byteArray = sqlite3.capi.sqlite3_js_db_serialize(db.pointer);
                    } else {
                        throw new Error('SQLite serialization not supported in this environment');
                    }
                } else {
                    throw new Error(`Database not open: ${name}`);
                }
                
                self.postMessage({ id, success: true, result: byteArray }, [byteArray.buffer]);
                break;
            }

            case 'import': {
                const { name, data } = payload;
                if (dbs[name]) dbs[name].close();
                
                if (sqlite3.opfs) {
                    const root = await navigator.storage.getDirectory();
                    const fileHandle = await root.getFileHandle(`wildcard_${name}.sqlite3`, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(data);
                    await writable.close();
                    
                    dbs[name] = new sqlite3.oo1.OpfsDb(`/wildcard_${name}.sqlite3`);
                } else {
                    // Memory fallback
                    dbs[name] = new sqlite3.oo1.DB();
                    if (sqlite3.capi && typeof sqlite3.capi.sqlite3_js_db_deserialize === 'function') {
                        sqlite3.capi.sqlite3_js_db_deserialize(dbs[name].pointer, 'main', data, data.length, data.length, 0);
                    } else {
                        // Fallback: If we can't deserialize into a new DB, we might have to re-think memory imports
                        // but usually in memory mode we just create a fresh DB. 
                        // If 'data' was provided, it's a failure if we can't load it.
                        if (data && data.length > 0) {
                            throw new Error('SQLite deserialization (import) not supported in this environment');
                        }
                    }
                }
                self.postMessage({ id, success: true });
                break;
            }

            case 'list': {
                const names = [];
                if (sqlite3.opfs) {
                    const root = await navigator.storage.getDirectory();
                    for await (const name of root.keys()) {
                        if (name.startsWith('wildcard_') && name.endsWith('.sqlite3')) {
                            const collectionName = name.substring(9, name.length - 8);
                            names.push(collectionName);
                        }
                    }
                } else {
                    names.push(...Object.keys(dbs));
                }
                self.postMessage({ id, success: true, result: names });
                break;
            }

            case 'close': {
                const { name } = payload;
                if (dbs[name]) {
                    dbs[name].close();
                    delete dbs[name];
                }
                self.postMessage({ id, success: true });
                break;
            }

            case 'delete': {
                const { name } = payload;
                if (dbs[name]) {
                    dbs[name].close();
                    delete dbs[name];
                }
                if (sqlite3.opfs) {
                    const root = await navigator.storage.getDirectory();
                    try {
                        await root.removeEntry(`wildcard_${name}.sqlite3`);
                        console.log(`[SQLiteWorker] Deleted database file: wildcard_${name}.sqlite3`);
                    } catch (e) {
                        console.warn(`[SQLiteWorker] Could not delete file: ${e.message}`);
                    }
                }
                self.postMessage({ id, success: true });
                break;
            }
            case 'wipe': {
                console.log('[SQLiteWorker] Wiping all OPFS databases...');
                for (const name in dbs) {
                    dbs[name].close();
                    delete dbs[name];
                }
                if (sqlite3.opfs) {
                    const root = await navigator.storage.getDirectory();
                    for await (const name of root.keys()) {
                        if (name.startsWith('wildcard_')) {
                            console.log(`[SQLiteWorker] Deleting ${name}`);
                            await root.removeEntry(name);
                        }
                    }
                }
                self.postMessage({ id, success: true });
                break;
            }

            default:
                throw new Error(`Unknown action: ${action}`);
        }
    } catch (err) {
        console.error(`[SQLiteWorker] Action ${action} failed:`, err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        self.postMessage({ id, success: false, error: errorMsg || `Unknown worker error for ${action}` });
    }
};

start();

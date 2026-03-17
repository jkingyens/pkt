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
                if (dbs[name]) dbs[name].close();
                
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
                const db = getDb(name);
                const byteArray = sqlite3.capi.sqlite3_js_db_serialize(db.pointer);
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
                    dbs[name] = new sqlite3.oo1.DB();
                    sqlite3.capi.sqlite3_js_db_deserialize(dbs[name].pointer, 'main', data, data.length, data.length, 0);
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
        self.postMessage({ id, success: false, error: err.message });
    }
};

start();

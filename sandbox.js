const mocks = {};

window.addEventListener('message', async (e) => {
    const { type, configId, code, methodName, args, callId } = e.data;

    if (type === 'init-mock') {
        try {
            const sqliteProxy = {
                query: (sql, bind) => {
                    return new Promise((resolve) => {
                        const qId = Math.random().toString(36).substr(2, 9);
                        window.parent.postMessage({ type: 'sqlite-query', sql, bind, qId, configId }, '*');
                        function handler(ev) {
                            if (ev.data.type === 'sqlite-result' && ev.data.qId === qId) {
                                window.removeEventListener('message', handler);
                                // Flatten sql.js result format into array of objects
                                const raw = ev.data.result;
                                console.log('[Sandbox] SQL Result (Raw):', raw);
                                
                                const results = (raw && raw.result !== undefined && !Array.isArray(raw)) ? raw.result : raw;
                                console.log('[Sandbox] SQL Result (Normalized):', results);
                                
                                if (!results || !results.length) {
                                    resolve([]);
                                    return;
                                }
                                const firstSet = results[0];
                                if (!firstSet.columns || !firstSet.values) {
                                    resolve([]);
                                    return;
                                }
                                const rows = firstSet.values.map(row => {
                                    const obj = {};
                                    firstSet.columns.forEach((col, i) => {
                                        obj[col] = row[i];
                                    });
                                    return obj;
                                });
                                resolve(rows);
                            }
                        }
                        window.addEventListener('message', handler);
                    });
                },
                exec: (sql, bind) => {
                    return new Promise((resolve) => {
                        const qId = Math.random().toString(36).substr(2, 9);
                        window.parent.postMessage({ type: 'sqlite-exec', sql, bind, qId, configId }, '*');
                        function handler(ev) {
                            if (ev.data.type === 'sqlite-exec-result' && ev.data.qId === qId) {
                                window.removeEventListener('message', handler);
                                // Changes might be nested in result or at top level
                                const changes = ev.data.changes !== undefined ? ev.data.changes : (ev.data.result?.changes || 0);
                                resolve(changes);
                            }
                        }
                        window.addEventListener('message', handler);
                    });
                }
            };
            
            // Evaluate mock code in sandbox
            mocks[configId] = {
                instance: new Function('sqlite', `return ${code}\n`)(sqliteProxy),
                sqlite: sqliteProxy
            };
            window.parent.postMessage({ type: 'mock-initialized', configId }, '*');
        } catch (err) {
            window.parent.postMessage({ type: 'mock-error', configId, error: err.message }, '*');
        }
    } else if (type === 'call-mock') {
        const entry = mocks[configId];
        if (entry && entry.instance) {
            const method = typeof entry.instance[methodName] === 'function' ? entry.instance[methodName] : 
                          (typeof entry.instance[e.data.originalMethodName] === 'function' ? entry.instance[e.data.originalMethodName] : null);
            
            if (method) {
                try {
                    // Pass sqlite proxy as the first argument as expected by LLM-generated mocks
                    const res = method.call(entry.instance, entry.sqlite, ...(args || []));
                    Promise.resolve(res).then(val => {
                        window.parent.postMessage({ type: 'call-result', val, callId }, '*');
                    }).catch(err => {
                        window.parent.postMessage({ type: 'call-error', error: err.message, callId }, '*');
                    });
                } catch (err) {
                    window.parent.postMessage({ type: 'call-error', error: err.message, callId }, '*');
                }
            } else {
                window.parent.postMessage({ type: 'call-error', error: `Method ${methodName} (or ${e.data.originalMethodName}) not found on mock ${configId}`, callId }, '*');
            }
        } else {
            window.parent.postMessage({ type: 'call-error', error: `Mock ${configId} not found in sandbox`, callId }, '*');
        }
    }
});

window.parent.postMessage({ type: 'sandbox-ready' }, '*');

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
                                resolve(ev.data.result);
                            }
                        }
                        window.addEventListener('message', handler);
                    });
                },
                exec: (sql, bind) => {
                    window.parent.postMessage({ type: 'sqlite-exec', sql, bind, configId }, '*');
                }
            };
            
            // Evaluate mock code in sandbox
            mocks[configId] = new Function('sqlite', `return ${code}\n`)(sqliteProxy);
            window.parent.postMessage({ type: 'mock-initialized', configId }, '*');
        } catch (err) {
            window.parent.postMessage({ type: 'mock-error', configId, error: err.message }, '*');
        }
    } else if (type === 'call-mock') {
        const mock = mocks[configId];
        if (mock && typeof mock[methodName] === 'function') {
            try {
                const res = mock[methodName](...(args || []));
                Promise.resolve(res).then(val => {
                    window.parent.postMessage({ type: 'call-result', val, callId }, '*');
                }).catch(err => {
                    window.parent.postMessage({ type: 'call-error', error: err.message, callId }, '*');
                });
            } catch (err) {
                window.parent.postMessage({ type: 'call-error', error: err.message, callId }, '*');
            }
        } else {
            window.parent.postMessage({ type: 'call-error', error: `Method ${methodName} not found on mock ${configId}`, callId }, '*');
        }
    }
});

window.parent.postMessage({ type: 'sandbox-ready' }, '*');

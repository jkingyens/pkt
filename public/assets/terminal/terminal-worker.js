/**
 * Terminal Worker
 * Runs BusyBox WASI in a separate thread with synchronous SAB input
 * Implements persistence for /home using IndexedDB
 */

import { WASI, File, PreopenDirectory, ConsoleStdout, Fd, Directory } from "./index.js";
import * as wasi_defs from "./wasi_defs.js";
import { FSStorage } from "./fs_storage.js";

class SABStdin extends Fd {
    constructor(inputSAB, controlSAB) {
        super();
        this.inputData = new Uint8Array(inputSAB);
        this.controlData = new Int32Array(controlSAB);
    }

    fd_read(size) {
        let writeIdx = Atomics.load(this.controlData, 0);
        let readIdx = Atomics.load(this.controlData, 1);

        if (readIdx >= writeIdx) {
            Atomics.wait(this.controlData, 0, writeIdx);
            writeIdx = Atomics.load(this.controlData, 0);
        }

        const available = writeIdx - readIdx;
        const take = Math.min(available, size);
        const out = new Uint8Array(take);

        for (let i = 0; i < take; i++) {
            out[i] = this.inputData[(readIdx + i) % 4096];
        }

        Atomics.store(this.controlData, 1, readIdx + take);
        return { ret: wasi_defs.ERRNO_SUCCESS, data: out };
    }

    fd_fdstat_get() {
        return {
            ret: 0,
            fdstat: new wasi_defs.Fdstat(wasi_defs.FILETYPE_CHARACTER_DEVICE, 0)
        };
    }
}

// Helper to serialize directory tree
function serializeDir(dir) {
    const result = {};
    for (const [name, entry] of dir.contents.entries()) {
        if (entry instanceof Directory) {
            result[name] = { type: 'dir', contents: serializeDir(entry) };
        } else if (entry instanceof File) {
            result[name] = { type: 'file', data: entry.data };
        }
    }
    return result;
}

// Helper to restore directory tree
function restoreDir(data, parent = null) {
    const contents = new Map();
    const dir = new Directory(contents);
    dir.parent = parent;
    for (const [name, info] of Object.entries(data)) {
        if (info.type === 'dir') {
            const childDir = restoreDir(info.contents, dir);
            contents.set(name, childDir);
        } else if (info.type === 'file') {
            const file = new File(info.data);
            file.parent = dir;
            contents.set(name, file);
        }
    }
    return dir;
}

const storage = new FSStorage();

self.onmessage = async (e) => {
    const { type, packetId, packetData, inputSAB, controlSAB, mockControlSAB, mockDataSAB } = e.data;

    if (type === 'init') {
        const extDirContents = new Map();
        packetData.items.forEach((item, index) => {
            let name = item.name || item.title || `item_${index}`;
            name = name.replace(/[\/\\?%*:|"<>]/g, '_');
            let content = item.type === 'page' ? `URL: ${item.url}\nTitle: ${item.title}\n` : JSON.stringify(item, null, 2);
            extDirContents.set(name, new File(new TextEncoder().encode(content)));
        });

        const rootMap = new Map();
        const root = new Directory(rootMap);

        // 1. etc
        let profileContent = 'export PATH=/bin:/usr/bin:/\nexport PS1="/ \\$ "\nexport HOME=/home\n# Expand tabs to spaces and set erase char\nstty -tabs 2>/dev/null\nstty erase ^H 2>/dev/null\n';
        const etcMap = new Map();
        etcMap.set("profile", new File(new TextEncoder().encode(profileContent)));
        const etc = new Directory(etcMap);
        etc.parent = root;
        rootMap.set("etc", etc);

        // Force emacs mode and shell settings for better line editing
        profileContent += 'set -o emacs 2>/dev/null\nexport TERM=xterm\n';
        etcMap.set("profile", new File(new TextEncoder().encode(profileContent)));

        // 2. home (Persistent)
        let home;
        try {
            const savedHome = await storage.load('home_dir');
            if (savedHome) {
                console.log('Worker: Restoring persistent /home');
                home = restoreDir(savedHome, root);
            } else {
                home = new Directory(new Map());
                home.parent = root;
                home.contents.set(".profile", new File(new TextEncoder().encode(profileContent)));
            }
        } catch (err) {
            console.error('Worker: Error loading persistent /home:', err);
            home = new Directory(new Map());
            home.parent = root;
        }

        // Setup persistence listener
        let saveTimeout;
        home.onMutate = () => {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(async () => {
                try {
                    const data = serializeDir(home);
                    await storage.save('home_dir', data);
                    console.log('Worker: Saved persistent /home');
                } catch (err) {
                    console.error('Worker: Failed to save /home:', err);
                }
            }, 1000); // Debounce saves
        };
        rootMap.set("home", home);

        // 3. bin & ext
        const binMap = new Map();
        const bin = new Directory(binMap);
        bin.parent = root;
        rootMap.set("bin", bin);

        const ext = new Directory(extDirContents);
        ext.parent = root;
        rootMap.set("ext", ext);

        // Populate bin with WASM items
        packetData.items.forEach((item, index) => {
            if (item.type === 'wasm' && item.data) {
                let name = item.name || item.title || `wasm_${index}`;
                name = name.replace(/[\/\\?%*:|"<>]/g, '_');
                try {
                    const binaryString = Atomics.load(new Int32Array(new SharedArrayBuffer(4)), 0) === 0 ? atob(item.data) : atob(item.data); // dummy to ensure no optimize? no need
                    const binStr = atob(item.data);
                    const bytes = new Uint8Array(binStr.length);
                    for (let i = 0; i < binStr.length; i++) {
                        bytes[i] = binStr.charCodeAt(i);
                    }
                    binMap.set(name, new File(bytes));
                } catch (ex) {
                    console.error(`Worker: Failed to decode WASM for ${name}:`, ex);
                }
            }
        });

        // Mocks are now initialized in the sandbox via terminal.js

        const getMockSync = (configId, methodName, args = []) => {
            if (!mockControlSAB || !mockDataSAB) return null;
            
            const mockControlData = new Int32Array(mockControlSAB);
            const mockData = new Uint8Array(mockDataSAB);
            
            const call = { configId, methodName, args };
            const json = JSON.stringify(call);
            const bytes = new TextEncoder().encode(json);
            
            mockData.set(bytes);
            Atomics.store(mockControlData, 1, bytes.length);
            Atomics.store(mockControlData, 0, 1); // state: pending
            Atomics.notify(mockControlData, 0); // Wake up main thread if it's waiting (though it's polling)
            
            // WAIT for main thread to process and signal result (2: success, 3: error)
            while (true) {
                const state = Atomics.load(mockControlData, 0);
                if (state === 2 || state === 3) break; 
                Atomics.wait(mockControlData, 0, state);
            }
            
            const state = Atomics.load(mockControlData, 0);
            if (state === 2) { // state: result_ready
                const resLen = Atomics.load(mockControlData, 1);
                // Copy from SharedArrayBuffer to non-shared buffer for TextDecoder
                const resBytes = new Uint8Array(resLen);
                resBytes.set(mockData.subarray(0, resLen));
                const resJson = new TextDecoder().decode(resBytes);
                const res = JSON.parse(resJson);
                Atomics.store(mockControlData, 0, 0); // back to idle
                return res.val;
            } else {
                console.error(`[Worker] Mock call failed for ${configId}.${methodName}. State: ${state}`);
                const resLen = Atomics.load(mockControlData, 1);
                if (resLen > 0) {
                    const resBytes = new Uint8Array(resLen);
                    resBytes.set(mockData.subarray(0, resLen));
                    const resJson = new TextDecoder().decode(resBytes);
                    console.error(`[Worker] Error details:`, resJson);
                }
                Atomics.store(mockControlData, 0, 0); // back to idle
                return null;
            }
        };

        const stdin = new SABStdin(inputSAB, controlSAB);
        const stdout = new ConsoleStdout((buf) => self.postMessage({ type: 'stdout', data: buf }));
        const stderr = new ConsoleStdout((buf) => self.postMessage({ type: 'stdout', data: buf }));

        const fds = [
            stdin,
            stdout,
            stderr,
            new PreopenDirectory("/", rootMap),
        ];

        const wasmArgs = e.data.wasmBytes ? ["wasm_program"] : ["sh"];
        const wasmEnv = [
            "USER=wildcard",
            "PATH=/bin:/usr/bin:/",
            "HOME=/home",
            "TERM=xterm",
            "PS1=/ \\$ ",
            "ENV=/etc/profile",
            "BB_ASH_STANDALONE=y",
            "ASH_STANDALONE=y"
        ];

        const wasi = new WASI(wasmArgs, wasmEnv, fds);
        let wasmInstance = null;

        const importObject = {
            wasi_snapshot_preview1: wasi.wasiImport,
            env: {
                log: (ptr, len) => {
                    const mem = wasmInstance?.exports?.memory || wasi.inst?.exports?.memory;
                    if (mem) {
                        const bytes = new Uint8Array(mem.buffer, ptr, len);
                        let msg = new TextDecoder().decode(bytes);
                        self.postMessage({ type: 'log', data: msg });
                    }
                }
            },
            "chrome:bookmarks/bookmarks": {
                "get-tree": () => {
                    console.log("[Worker-Host] Calling mock get-tree (Sync SAB)");
                    const res = getMockSync("chrome:bookmarks", "getTree") || getMockSync("chrome:bookmarks/bookmarks", "get-tree");
                    return typeof res === 'number' ? res : 0;
                },
                "get_tree": (...args) => importObject["chrome:bookmarks/bookmarks"]["get-tree"](...args),
                "get-all-bookmarks": () => importObject["chrome:bookmarks/bookmarks"]["get-tree"](),
                "get_all_bookmarks": () => importObject["chrome:bookmarks/bookmarks"]["get-tree"](),
                "create": (details) => {
                    console.log("[Worker-Host] Calling mock create (Sync SAB)");
                    getMockSync("chrome:bookmarks", "create", [details]) || getMockSync("chrome:bookmarks/bookmarks", "create", [details]);
                    return 0;
                }
            },
            "chrome:bookmarks": {
                "get-tree": () => importObject["chrome:bookmarks/bookmarks"]["get-tree"](),
                "get_tree": () => importObject["chrome:bookmarks/bookmarks"]["get-tree"](),
                "get-all-bookmarks": () => importObject["chrome:bookmarks/bookmarks"]["get-tree"](),
                "get_all_bookmarks": () => importObject["chrome:bookmarks/bookmarks"]["get-tree"](),
                "create": (...args) => importObject["chrome:bookmarks/bookmarks"]["create"](...args)
            },
            "user:sqlite/sqlite": {
                "execute": () => 0,
                "query": () => 0
            }
        };

        try {
            let wasmSource;
            if (e.data.wasmBytes) {
                wasmSource = e.data.wasmBytes;
            } else {
                const response = await fetch('busybox.wasm');
                const wasmArrayBuffer = await response.arrayBuffer();
                wasmSource = new Uint8Array(wasmArrayBuffer);
            }

            const { instance } = await WebAssembly.instantiate(wasmSource, importObject);
            wasmInstance = instance;
            wasi.inst = instance;

            if (e.data.zigCode) {
                console.log('Worker: Zig code found in item metadata');
                console.log(e.data.zigCode);
            }

            let executed = false;

            // 1. If we have a specific function name to call that isn't _start/run/main
            const execName = e.data.execName;
            if (execName && instance.exports[execName] && !['_start', 'run', 'main'].includes(execName)) {
                if (instance.exports._initialize) {
                    try { instance.exports._initialize(); } catch (e) { }
                }
                try {
                    const res = instance.exports[execName]();
                    if (res !== undefined) {
                        self.postMessage({ type: 'stdout', data: new TextEncoder().encode(`Result: ${res}\n`) });
                    }
                    executed = true;
                } catch (e) {
                    console.error(`Worker: Error calling "${execName}":`, e);
                }
            }

            // 2. Standard execution flow - MUTUALLY EXCLUSIVE
            if (!executed) {
                // Prioritize 'run' for Zig/Wildcard modules
                if (instance.exports.run) {
                    if (instance.exports._initialize) {
                        try { instance.exports._initialize(); } catch (e) { }
                    }
                    try {
                        instance.exports.run();
                        executed = true;
                    } catch (e) {
                        console.error('Worker: run() threw:', e);
                    }
                }

                // Fallback to standard WASI _start
                if (!executed && instance.exports._start) {
                    try {
                        wasi.start(instance);
                        executed = true;
                    } catch (e) {
                        if (!(e instanceof WASIProcExit && e.code === 0)) {
                            console.warn('Worker: _start() threw:', e);
                        }
                    }
                }

                // Final fallback for main
                if (!executed && instance.exports.main) {
                    try {
                        instance.exports.main();
                        executed = true;
                    } catch (e) {
                        console.error('Worker: main() threw:', e);
                    }
                }
            }

            self.postMessage({ type: 'exit' });
        } catch (err) {
            console.error('Worker: Error:', err);
            if (!e.data.wasmBytes) self.postMessage({ type: 'exit' });
        }
    }
};

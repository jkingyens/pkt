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
    const { type, packetData, inputSAB, controlSAB } = e.data;

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
        const bin = new Directory(new Map());
        bin.parent = root;
        rootMap.set("bin", bin);

        const ext = new Directory(extDirContents);
        ext.parent = root;
        rootMap.set("ext", ext);

        const stdin = new SABStdin(inputSAB, controlSAB);
        const stdout = new ConsoleStdout((buf) => self.postMessage({ type: 'stdout', data: buf }));
        const stderr = new ConsoleStdout((buf) => self.postMessage({ type: 'stdout', data: buf }));

        const fds = [
            stdin,
            stdout,
            stderr,
            new PreopenDirectory("/", rootMap),
        ];

        const wasmArgs = ["sh"];
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

        try {
            const response = await fetch('busybox.wasm');
            const wasmArrayBuffer = await response.arrayBuffer();
            const { instance } = await WebAssembly.instantiate(wasmArrayBuffer, {
                wasi_snapshot_preview1: wasi.wasiImport,
            });
            wasi.start(instance);
        } catch (err) {
            console.error('Worker: Error:', err);
        }
    }
};

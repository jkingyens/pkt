import { compileZigCode } from './zig-compiler.js';

(async () => {
    const params = new URLSearchParams(window.location.search);
    const packetId = params.get('packetId');
    const index = parseInt(params.get('index'));
    const itemName = params.get('name');

    const codeBlock = document.getElementById('code-block');
    const headerText = document.getElementById('header-text');
    const headerApiTags = document.getElementById('header-api-tags');
    const editBtn = document.getElementById('edit-btn');
    const runBtn = document.getElementById('run-btn');
    const loading = document.getElementById('loading');
    const terminalOverlay = document.getElementById('terminal-overlay');
    const terminalIframe = document.getElementById('terminal-iframe');
    const closeTerminalBtn = document.getElementById('close-terminal');

    // Edit Modal Elements
    const editModal = document.getElementById('edit-modal');
    const closeEditModalBtn = document.getElementById('close-edit-modal');
    const editPromptInput = document.getElementById('edit-prompt-input');
    const editApiList = document.getElementById('edit-api-list');
    const apiSearchInput = document.getElementById('api-search-input');
    const apiSearchResults = document.getElementById('api-search-results');
    const regenerateBtn = document.getElementById('regenerate-btn');
    const cancelEditBtn = document.getElementById('cancel-edit-btn');
    const regenStatus = document.getElementById('regen-status');
    const regenStatusText = document.getElementById('regen-status-text');

    let currentItem = null;
    let currentPacketName = '';
    let currentPacketUrls = [];
    let selectedApis = [];
    let packetApis = [];

    const DEFAULT_SYSTEM_INSTRUCTION = `You are an expert Zig developer. 
Your task is to write a Zig file that will be compiled to WebAssembly (Wasm) as a WASI executable.
It will run in a host environment with these WIT interfaces available:
{{WITS_CONTEXT}}

### INSTRUCTIONS:
1. Output ONLY the raw Zig (.zig) source code. No markdown formatting, no explanations, no HTML tags.
2. The module MUST export a 'run' function: 'pub export fn run() i32 { ... }'
3. The module MUST define a dummy 'main' function to satisfy WASI: 'pub fn main() void {}'
4. You can import host functions using extern block syntax. The module name corresponds to the WIT interface.
   Example:
   extern "chrome:bookmarks/bookmarks" fn get_tree() i32;
   extern "user:sqlite/sqlite" fn execute(db: i32, sql: i32, params: i32) i32;

5. Use the standard library if needed via \`const std = @import("std");\`.
6. CRITICAL ZIG SYNTAX: When defining pointers to structs or arrays (e.g. for WIT lists or strings), you MUST use valid Zig pointer syntax like \`[*]const T\` or \`*const T\`. NEVER use \`[*const T]\` as that is invalid syntax.
7. CRITICAL ZIG BUILTINS: You MUST use modern Zig 0.11+ builtins. 
   - DO NOT use \`@intToPtr(T, addr)\`. Use \`@as(T, @ptrFromInt(addr))\` instead.
   - DO NOT use \`@ptrFromInt(T, addr)\` with two arguments. \`@ptrFromInt\` takes EXACTLY ONE argument.
   - DO NOT use \`@ptrCast(T, ptr)\` with two arguments. \`@ptrCast\` takes EXACTLY ONE argument.
   - DO NOT use \`@intCast(T, int)\` with two arguments. \`@intCast\` takes EXACTLY ONE argument.
   - DO NOT use \`@ptrToInt(ptr)\`. Use \`@intFromPtr(ptr)\` instead.`;

    if (!packetId || (isNaN(index) && !itemName)) {
        loading.innerHTML = '<div class="error">Missing information to load code.</div>';
        return;
    }

    function highlightZig(code) {
        if (!code) return '';
        let escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return escaped
            .replace(/(\/\/.*)/g, '<span class="token comment">$1</span>')
            .replace(/(".+?")/g, '<span class="token string">$1</span>')
            .replace(/\b(fn|pub|const|var|return|if|else|switch|for|while|try|catch|break|continue|defer|errdefer|and|or|not|struct|enum|union|error|extern|inline|noinline|comptime|usingnamespace|test|anytype)\b/g, '<span class="token keyword">$1</span>')
            .replace(/\b(u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f16|f32|f64|f80|f128|bool|void|anyerror|anyopaque|type)\b/g, '<span class="token type">$1</span>')
            .replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?=\()/g, '<span class="token function">$1</span>')
            .replace(/\b(\d+)\b/g, '<span class="token number">$1</span>');
    }

    function arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function extractApisFromZig(code) {
        const apis = [];
        const regex = /extern\s+"([^"]+)"/g;
        let match;
        while ((match = regex.exec(code)) !== null) {
            const configId = match[1];
            if (!apis.some(a => a.config_id === configId)) {
                apis.push(enrichApiMetadata({ config_id: configId }));
            }
        }
        return apis;
    }

    function enrichApiMetadata(api) {
        // Find the API definition within the same packet
        const baseConfigId = api.config_id.split('/')[0];
        const packetApi = packetApis.find(a => a.config_id === api.config_id || a.config_id === baseConfigId);
        
        if (packetApi) {
            return {
                ...api,
                name: packetApi.name || api.name || baseConfigId.split(':').pop(),
                mock_prompt: packetApi.mock_prompt || api.mock_prompt || ''
            };
        }
        return {
            ...api,
            name: api.name || baseConfigId.split(':').pop()
        };
    }

    function getApiLabel(api) {
        const name = api.name || api.config_id.split('/').pop().split(':').pop();
        // The user wants: Prompt (Official Name)
        // If mock_prompt is present, it's the "prompt". Otherwise, we use config_id as the prompt?
        // Wait, the sidebar uses mock_prompt (name).
        // If mock_prompt is missing, it shows just name.
        // But the user said "using the prompt and bracketed the official name".
        // This suggests: if it's in the code as chrome:bookmarks/bookmarks, that IS a prompt?
        // No, usually "the prompt" refers to the mock behavior prompt.
        
        return api.mock_prompt ? `${escapeHtml(api.mock_prompt)} (${escapeHtml(name)})` : escapeHtml(name);
    }

    function renderApiChips(container, apis, removable = false) {
        container.innerHTML = '';
        apis.forEach((api, i) => {
            const chip = document.createElement('div');
            chip.className = 'api-tag';
            chip.innerHTML = `<span>🔌 ${getApiLabel(api)}</span>`;
            if (removable) {
                const remove = document.createElement('span');
                remove.className = 'api-tag-remove';
                remove.textContent = '✕';
                remove.onclick = () => {
                    selectedApis.splice(i, 1);
                    renderApiChips(container, selectedApis, true);
                };
                chip.appendChild(remove);
            }
            container.appendChild(chip);
        });
    }

    async function loadItem() {
        const resp = await chrome.runtime.sendMessage({
            action: 'executeSQL',
            name: 'packets',
            sql: `SELECT name, urls FROM packets WHERE id = ?`,
            params: [packetId]
        });

        if (!resp || !resp.success || !resp.result.length) {
            throw new Error('Failed to load packet data');
        }

        const row = resp.result[0].values[0];
        currentPacketName = row[0];
        currentPacketUrls = JSON.parse(row[1]);
        packetApis = currentPacketUrls.filter(u => u.type === 'api');

        if (!isNaN(index)) {
            currentItem = currentPacketUrls[index];
        } else {
            currentItem = currentPacketUrls.find(u => u.name === itemName);
        }

        if (!currentItem || currentItem.type !== 'wasm') {
            throw new Error('Function not found in packet');
        }

        const code = currentItem.zigCode || '// No source code available';
        const displayPrompt = currentItem.prompt || currentItem.name || 'AI Generated Function';

        headerText.textContent = displayPrompt;
        codeBlock.innerHTML = highlightZig(code);

        // Selected APIs
        selectedApis = (currentItem.selectedApis || extractApisFromZig(code)).map(enrichApiMetadata);
        renderApiChips(headerApiTags, selectedApis);
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function normalizeRows(result) {
        if (!result || !result.length || !result[0].columns) return [];
        const columns = result[0].columns;
        return result[0].values.map(values => {
            const row = {};
            columns.forEach((col, i) => row[col] = values[i]);
            return row;
        });
    }

    // Initialize
    try {
        await loadItem();
    } catch (err) {
        loading.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    } finally {
        loading.classList.add('hidden');
    }

    // Edit Logic
    editBtn.onclick = () => {
        editPromptInput.value = currentItem.prompt || '';
        renderApiChips(editApiList, selectedApis, true);
        editModal.classList.remove('hidden');
    };

    closeEditModalBtn.onclick = cancelEditBtn.onclick = () => {
        editModal.classList.add('hidden');
        apiSearchResults.classList.add('hidden');
        apiSearchInput.value = '';
    };

    apiSearchInput.oninput = () => {
        const query = apiSearchInput.value.toLowerCase();
        if (!query) {
            apiSearchResults.classList.add('hidden');
            return;
        }

        const filtered = packetApis.filter(a => 
            a.name.toLowerCase().includes(query) || a.config_id.toLowerCase().includes(query) || (a.mock_prompt && a.mock_prompt.toLowerCase().includes(query))
        );

        if (filtered.length > 0) {
            apiSearchResults.innerHTML = '';
            filtered.forEach(api => {
                const div = document.createElement('div');
                div.className = 'search-result';
                div.innerHTML = `
                    <div class="search-result-name">${getApiLabel(api)}</div>
                    <div class="search-result-id">${api.config_id}</div>
                `;
                div.onclick = () => {
                    if (!selectedApis.some(a => a.config_id === api.config_id)) {
                        selectedApis.push({ name: api.name, config_id: api.config_id, mock_prompt: api.mock_prompt });
                        renderApiChips(editApiList, selectedApis, true);
                    }
                    apiSearchResults.classList.add('hidden');
                    apiSearchInput.value = '';
                };
                apiSearchResults.appendChild(div);
            });
            apiSearchResults.classList.remove('hidden');
        } else {
            apiSearchResults.classList.add('hidden');
        }
    };

    // Regeneration
    regenerateBtn.onclick = async () => {
        try {
            regenStatus.classList.remove('hidden');
            regenerateBtn.disabled = true;

            const originalPrompt = editPromptInput.value.trim();
            if (!originalPrompt) return;

            const settings = await chrome.storage.local.get(['geminiApiKey', 'geminiModel', 'geminiSystemPrompt']);
            
            if (!settings.geminiApiKey || !settings.geminiModel) {
                throw new Error('Please configure Gemini API Key and Model in Sidebar settings');
            }

            // Context
            regenStatusText.textContent = 'Gathering context...';
            const witsResp = await chrome.runtime.sendMessage({ action: 'executeSQL', name: 'wits', sql: "SELECT name, wit FROM wits" });
            const witsContext = witsResp.success && witsResp.result?.[0]?.values?.map(v => `WIT Name: ${v[0]}\nDefinition:\n${v[1]}`).join('\n\n') || 'No WITs';
            
            const dbList = await chrome.runtime.sendMessage({ action: 'listCollections' });
            let dbContext = '';
            if (dbList.success) {
                for (const name of dbList.collections) {
                    if (name === 'undefined' || name.includes('packet_undefined')) continue;
                    const s = await chrome.runtime.sendMessage({ action: 'getSchema', name });
                    if (s.success) {
                        dbContext += `\nCollection: "${name}"\n` + s.schema.map(t => `  Table: "${t.name}"\n    Schema: ${t.sql}`).join('\n');
                    }
                }
            }

            let apiContext = "";
            if (selectedApis.length > 0) {
                apiContext = "\n\nAvailable Mock APIs (Interfaces):\n" + selectedApis.map(a => 
                    `- ${a.name} (${a.config_id})\n  Behavior: ${a.mock_prompt || 'Mock version of ' + a.name}`
                ).join('\n');
            }

            let lastError = null;
            let lastCode = null;

            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    // Gemini Call
                    regenStatusText.textContent = `Calling Gemini (Attempt #${attempt})...`;
                    let systemInstruction = settings.geminiSystemPrompt || DEFAULT_SYSTEM_INSTRUCTION;
                    systemInstruction = systemInstruction.replace('{{WITS_CONTEXT}}', witsContext).replace('{{DATABASE_CONTEXT}}', dbContext);

                    // Augment prompt if this is a retry
                    let finalPrompt = `${originalPrompt}\n\n`;
                    if (attempt > 1 && lastError) {
                        finalPrompt += `IMPORTANT: Your previous attempt failed to compile. Please fix the errors below.\n\nPREVIOUS CODE:\n\`\`\`zig\n${lastCode}\n\`\`\`\n\nCOMPILER ERROR:\n${lastError}`;
                    }

                    const url = `https://generativelanguage.googleapis.com/v1beta/${settings.geminiModel}:generateContent?key=${settings.geminiApiKey}`;
                    const aiResp = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: finalPrompt }] }],
                            system_instruction: { parts: [{ text: systemInstruction + apiContext }] }
                        })
                    });

                    if (!aiResp.ok) throw new Error('Gemini API call failed');
                    const aiData = await aiResp.json();
                    let zigCode = aiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    zigCode = zigCode.replace(/^```zig\n/, '').replace(/^```\n?/, '').replace(/\n```$/, '');
                    lastCode = zigCode;

                    // Compile
                    regenStatusText.textContent = `Compiling Zig (Attempt #${attempt})...`;
                    const wasmBytes = await compileZigCode(zigCode, (s) => { 
                        regenStatusText.textContent = `${s} (Attempt #${attempt})...`; 
                    });

                    // Save
                    regenStatusText.textContent = 'Saving...';
                    const binaryBase64 = arrayBufferToBase64(wasmBytes);
                    
                    currentItem.prompt = originalPrompt;
                    currentItem.zigCode = zigCode;
                    currentItem.data = binaryBase64;
                    currentItem.selectedApis = selectedApis;

                    await chrome.runtime.sendMessage({
                        action: 'savePacket',
                        id: packetId,
                        name: currentPacketName,
                        urls: currentPacketUrls
                    });

                    // Update UI
                    headerText.textContent = originalPrompt;
                    codeBlock.innerHTML = highlightZig(zigCode);
                    renderApiChips(headerApiTags, selectedApis);
                    editModal.classList.add('hidden');
                    
                    // Notify sidebar
                    chrome.runtime.sendMessage({ action: 'PACKET_UPDATED', packetId });
                    return; // Success!

                } catch (error) {
                    lastError = error.message;
                    console.error(`Regeneration failed (Attempt #${attempt}):`, error);

                    if (attempt < 3) {
                        regenStatusText.textContent = `Error in #${attempt}. Retrying...`;
                        await new Promise(r => setTimeout(r, 1000));
                    } else {
                        throw error; // Re-throw to be caught by outer try-catch
                    }
                }
            }

        } catch (err) {
            alert('Regeneration failed: ' + err.message);
        } finally {
            regenStatus.classList.add('hidden');
            regenerateBtn.disabled = false;
        }
    };

    // Run Logic
    runBtn.onclick = () => {
        const execName = currentItem.name || 'Function';
        terminalIframe.src = chrome.runtime.getURL(`public/terminal.html?packetId=${packetId}&exec=${encodeURIComponent(execName)}&embedded=true&track=false`);
        terminalOverlay.classList.add('active');
    };

    closeTerminalBtn.onclick = () => {
        terminalOverlay.classList.remove('active');
        terminalIframe.src = 'about:blank';
    };

    window.addEventListener('message', (e) => {
        if (e.data?.type === 'close-terminal') {
            terminalOverlay.classList.remove('active');
            terminalIframe.src = 'about:blank';
        }
    });

    window.addEventListener('keydown', (e) => {
        if (['input', 'textarea'].includes(document.activeElement.tagName.toLowerCase())) return;
        if (['ArrowRight', 'ArrowLeft', 'Space', 'Enter', 'r', 'R'].includes(e.key)) {
            e.preventDefault();
            chrome.runtime.sendMessage({ type: 'STACK_NAVIGATION', action: e.key });
        }
    });

})();

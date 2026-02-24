import { initZigWASI, runZigCompiler, runZigOutput } from "../src/index.js";
import { WASI, File, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";

document.addEventListener("DOMContentLoaded", () => {
    const codeArea = document.getElementById("code") as HTMLTextAreaElement;
    const compileBtn = document.getElementById("compileBtn") as HTMLButtonElement;
    const outputDiv = document.getElementById("output") as HTMLDivElement;
    const statusDiv = document.getElementById("status") as HTMLDivElement;

    // We cache standard library and zig compiler to avoid re-fetching on every compile
    let stdBuffer: Uint8Array | null = null;
    let compilerBuffer: ArrayBuffer | null = null;

    async function loadDependencies() {
        if (stdBuffer && compilerBuffer) return;

        statusDiv.textContent = "Downloading Zig compiler and stdlib... (this might take a moment)";

        try {
            const [stdRes, zigcRes] = await Promise.all([
                fetch("std.zip"),
                fetch("zig_small.wasm")
            ]);

            const stdBlob = await stdRes.blob();
            const stdArrayBuf = await stdBlob.arrayBuffer();
            stdBuffer = new Uint8Array(stdArrayBuf);

            compilerBuffer = await zigcRes.arrayBuffer();
            statusDiv.textContent = "Dependencies loaded. Ready to compile.";
        } catch (err) {
            statusDiv.textContent = `Error loading dependencies: ${err}`;
            console.error(err);
            throw err;
        }
    }

    compileBtn.addEventListener("click", async () => {
        const zigCode = codeArea.value;
        if (!zigCode.trim()) {
            outputDiv.textContent = "Please enter some Zig code.";
            return;
        }

        compileBtn.disabled = true;
        outputDiv.textContent = "Compiling...";
        statusDiv.textContent = "Initializing WASI...";

        try {
            await loadDependencies();

            statusDiv.textContent = "Compiling Zig code...";
            const wasi = await initZigWASI(stdBuffer!, zigCode);

            await runZigCompiler(compilerBuffer!, wasi);

            // get the output wasm file directly from WASI filesystem
            const preopenDir = wasi.fds[3]; // The working directory in initZigWASI where input.zig is
            // @ts-ignore
            const outputWasmFile = preopenDir.dir.contents.get("input.wasm");

            if (!outputWasmFile || !outputWasmFile.data) {
                throw new Error("Compilation failed (input.wasm not found). Check syntax.");
            }

            statusDiv.textContent = `Compilation successful! Binary size: ${outputWasmFile.data.length} bytes`;
            outputDiv.textContent = "Running output:\n\n";

            // Prepare WASI to run the output and capture stdout/stderr
            // Create a custom WASI to hook into stdout/stderr instead of using the default which logs to console
            const args = ["output.wasm"];
            const env: string[] = [];
            const fds = [
                new OpenFile(new File([])), // stdin
                ConsoleStdout.lineBuffered((msg) => {
                    outputDiv.textContent += `${msg}\n`;
                }), // stdout
                ConsoleStdout.lineBuffered((msg) => {
                    outputDiv.textContent += `[stderr] ${msg}\n`;
                }), // stderr
            ];
            const outputWasi = new WASI(args, env, fds, { debug: false });

            const outputWasmBuffer = new Uint8Array(outputWasmFile.data).buffer;
            await runZigOutput(outputWasmBuffer, outputWasi);

            statusDiv.textContent += " | Execution finished.";
        } catch (err) {
            console.error(err);
            outputDiv.textContent = `Error: ${err}`;
            statusDiv.textContent = "Execution failed.";
        } finally {
            compileBtn.disabled = false;
        }
    });

    // Preheat the dependency cache
    loadDependencies().catch(err => {
        outputDiv.textContent = `Failed to pre-download dependencies.\n${err}`;
    });
});

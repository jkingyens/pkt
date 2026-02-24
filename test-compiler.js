import { readFileSync, writeFileSync } from 'fs';
import { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory, Directory } from '@bjorn3/browser_wasi_shim';
// Note: Can't easily require this without fully resolving imports, I will just mock testing it using the extension's JS context.

/**
 * Build script for SQLite WebAssembly Chrome Extension
 * Copies necessary files to the extension directory
 */

import { copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sourceDir = join(__dirname, 'node_modules/sql.js/dist');
const targetDir = join(__dirname, 'extension');

console.log('🔨 Building SQLite WebAssembly Extension...\n');

// Copy WebAssembly file
console.log('📦 Copying WebAssembly files...');
try {
    copyFileSync(
        join(sourceDir, 'sql-wasm.wasm'),
        join(targetDir, 'sql-wasm.wasm')
    );
    console.log('  ✅ sql-wasm.wasm');

    copyFileSync(
        join(sourceDir, 'sql-wasm.js'),
        join(targetDir, 'sql-wasm.js')
    );
    console.log('  ✅ sql-wasm.js');

    // Transform sqlite-manager.js for the extension:
    // - Strip ES module `export` keyword (incompatible with importScripts)
    // - Add global self.SQLiteManager assignment for the service worker
    let managerSrc = readFileSync(join(__dirname, 'src/sqlite-manager.js'), 'utf8');
    managerSrc = managerSrc.replace(/^export class /m, 'class ');
    managerSrc = managerSrc.replace(/^export const /gm, 'const ');
    // No need to append global self.SQLiteManager assignment - sqlite-manager.js now handles it

    const destSrcDir = join(targetDir, 'src');
    if (!existsSync(destSrcDir)) mkdirSync(destSrcDir, { recursive: true });
    writeFileSync(join(destSrcDir, 'sqlite-manager.js'), managerSrc, 'utf8');
    console.log('  ✅ sqlite-manager.js (transformed for extension)');

} catch (error) {
    console.error('❌ Error copying files:', error.message);
    process.exit(1);
}

console.log('\n✨ Build complete!');
console.log('\n📋 Next steps:');
console.log('  1. Open Chrome and navigate to chrome://extensions/');
console.log('  2. Enable "Developer mode"');
console.log('  3. Click "Load unpacked"');
console.log(`  4. Select the directory: ${targetDir}`);
console.log('  5. Click the extension icon to open the sidebar\n');


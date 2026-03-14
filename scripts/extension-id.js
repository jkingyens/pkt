const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CMD = process.argv[2];
const CACHE_DIR = path.join(__dirname, '..', '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'extension-key.json');
const MANIFEST_PATH = path.join(__dirname, '..', 'manifest.json');

const DEFAULT_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwFDlgsgK+cqG6bF0VURCRnc7a6MBDEb8Z0dPKrc8IYLCQ78IKP9kRTf52zzzk58D0+mhCo5riNNmMYHC5oayLPQMArSyBPCXvHqTqJtTvhHCNEDhIFDw3KksYvgeBePl3Psbk5c/o+sQ5dkoumAgHOa0gJuVvwzhX0SBp+MM5mrOQRNsYG45CNxRUhwlkCeTRKmIkqLOmlbgOxZzNZUaUWo05Sw1aOkiWGKagJ+NFNtvS0VTlgsD7HAuS3rK72pHUQ+F9Jci8Goz3N21gLH+4koCu8xwO4ucXU2HafQeFQ6JhSQtut5knxhZiUhzCM2tR7d7AvZfyHNKGfPJf2pnNQIDAQAB";

function calculateExtensionId(publicKeyDer) {
  const hash = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
  return hash.slice(0, 32).split('').map(c => {
    return String.fromCharCode(parseInt(c, 16) + 97);
  }).join('');
}

function generateKey() {
  console.log(`Generating new RSA key pair, this may take a moment...`);
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' }
  });
  
  const base64Key = publicKey.toString('base64');
  const extensionId = calculateExtensionId(publicKey);
  
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ key: base64Key, id: extensionId }, null, 2));
  console.log(`Generated new extension key.`);
  console.log(`Extension ID: ${extensionId}`);
  console.log(`Cached to: ${CACHE_FILE}`);
  return { key: base64Key, id: extensionId };
}

function applyKey(keyStr) {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`Error: manifest.json not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  manifest.key = keyStr;
  
  // We stringify with 4 spaces to match the current formatting of manifest.json
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 4));
  
  const publicKeyDer = Buffer.from(keyStr, 'base64');
  const extensionId = calculateExtensionId(publicKeyDer);
  console.log(`Applied key to manifest.json.`);
  console.log(`Extension ID: ${extensionId}`);
}

if (CMD === 'generate') {
  generateKey();
} else if (CMD === 'apply') {
  if (fs.existsSync(CACHE_FILE)) {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    applyKey(data.key);
  } else {
    console.error(`Cache file not found at ${CACHE_FILE}. Run 'npm run id:generate' first.`);
    process.exit(1);
  }
} else if (CMD === 'reset') {
  applyKey(DEFAULT_KEY);
  console.log('Reset manifest.json to default extension key.');
} else {
  console.log(`Usage: node extension-id.js [generate|apply|reset]`);
}

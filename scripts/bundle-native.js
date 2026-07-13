/**
 * scripts/bundle-native.js
 *
 * Copies the correct better-sqlite3 prebuilt binary for the target platform
 * into dist/native/ so webpack can copy it into the VSIX.
 *
 * Usage: node scripts/bundle-native.js <platform>
 * Platforms: win32-x64 | linux-x64 | darwin-x64 | linux-arm64
 *
 * better-sqlite3 provides prebuilt .node binaries via the prebuildify format:
 *   node_modules/better-sqlite3/prebuilds/<platform>/node.napi.node
 *
 * The VSIX packaging step (vsce package --target <platform>) bundles these.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const platform = process.argv[2] || (() => {
  const p = os.platform();
  const a = os.arch();
  return `${p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : 'linux'}-${a}`;
})();

const PREBUILDS_DIR = path.join(__dirname, '..', 'node_modules', 'better-sqlite3', 'prebuilds');
const DEST_DIR = path.join(__dirname, '..', 'dist', 'native');

// Map target platform to prebuild folder name
const PLATFORM_MAP = {
  'win32-x64':    'win32-x64',
  'linux-x64':    'linux-x64',
  'darwin-x64':   'darwin-x64',
  'linux-arm64':  'linux-arm64',
};

const prebuildFolder = PLATFORM_MAP[platform];
if (!prebuildFolder) {
  console.error(`Unknown platform: ${platform}`);
  console.error(`Valid platforms: ${Object.keys(PLATFORM_MAP).join(', ')}`);
  process.exit(1);
}

const src = path.join(PREBUILDS_DIR, prebuildFolder);
const dest = path.join(DEST_DIR, prebuildFolder);

if (!fs.existsSync(src)) {
  console.warn(`Prebuilt binary not found at ${src} — skipping`);
  console.warn('User will need to build from source or install Visual Studio Build Tools');
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });

// Copy all .node files from the prebuild directory
const files = fs.readdirSync(src).filter(f => f.endsWith('.node') || f.endsWith('.napi.node'));
for (const file of files) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
  console.log(`Copied: ${file} → dist/native/${prebuildFolder}/`);
}

console.log(`✅ Native binaries bundled for ${platform}`);

/**
 * Global setup for E2E tests.
 * 
 * This runs once before all tests to:
 * 1. Verify the extension is built
 * 2. Verify the native bridge is compiled
 * 3. Verify native messaging is configured
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export default async function globalSetup() {
  console.log('\n🚀 Harbor E2E Test Setup\n');

  // 1. Check extension build
  const extensionDist = path.join(ROOT, 'extension/dist/manifest.json');
  if (!(await fileExists(extensionDist))) {
    console.log('📦 Extension not built. Building...');
    try {
      execSync('npm run build', { 
        cwd: path.join(ROOT, 'extension'),
        stdio: 'inherit',
      });
    } catch (err) {
      throw new Error('Failed to build extension. Run: cd extension && npm install && npm run build');
    }
  } else {
    console.log('✅ Extension build found');
  }

  // 2. Check native bridge
  const bridgePath = path.join(ROOT, 'bridge-rs/target/release/harbor-bridge');
  if (!(await fileExists(bridgePath))) {
    console.log('🔧 Native bridge not built. Building...');
    try {
      execSync('cargo build --release', { 
        cwd: path.join(ROOT, 'bridge-rs'),
        stdio: 'inherit',
      });
    } catch (err) {
      throw new Error('Failed to build native bridge. Run: cd bridge-rs && cargo build --release');
    }
  } else {
    console.log('✅ Native bridge build found');
  }

  // 3. Check native messaging manifest (macOS)
  const os = await import('os');
  const nativeManifestPath = path.join(
    os.homedir(),
    'Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge.json'
  );
  
  if (!(await fileExists(nativeManifestPath))) {
    console.log('⚠️  Native messaging manifest not installed');
    console.log('   Run: cd bridge-rs && ./install.sh');
    console.log('   (Tests may still work if extension doesn\'t need native bridge)\n');
  } else {
    console.log('✅ Native messaging manifest installed');
  }

  console.log('\n✨ Setup complete. Running tests...\n');
}

#!/usr/bin/env node
// Exercise manifest generation without touching browser registrations or HOME.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.chrome.json'), 'utf8'));
const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
  .slice(0, 32).replace(/[0-9a-f]/g, n => String.fromCharCode(97 + parseInt(n, 16)));
assert.equal(id, 'ljnciidcajlichemnbohopnlaonhkpgm');
const source = readFileSync(join(root, 'bridge-rs/install.sh'), 'utf8');
for (const os of ['Darwin', 'Linux']) {
  for (const firefoxOnly of [false, true]) {
    const fixture = mkdtempSync(join(tmpdir(), 'harbor install-'));
    try {
      const firefox = join(fixture, os === 'Darwin'
        ? 'Library/Application Support/Mozilla/NativeMessagingHosts'
        : '.mozilla/native-messaging-hosts');
      const chrome = join(fixture, os === 'Darwin'
        ? 'Library/Application Support/Google/Chrome/NativeMessagingHosts'
        : '.config/google-chrome/NativeMessagingHosts');
      for (const path of [dirname(firefox), dirname(chrome), join(fixture, 'target/release')]) {
        mkdirSync(path, { recursive: true });
      }
      // Redirect only filesystem roots in the fixture copy, retaining installer logic.
      writeFileSync(join(fixture, 'install.sh'), source.replaceAll('$HOME', fixture));
      const binary = join(fixture, 'target/release/harbor-bridge');
      writeFileSync(binary, '#!/bin/bash\nprintf "%s\\n" "$@"\n');
      chmodSync(binary, 0o755);
      execFileSync('bash', ['-c', `uname() { echo ${os}; }; export -f uname; bash "$1" --skip-build "\${@:2}"`,
        'test', join(fixture, 'install.sh'), ...(firefoxOnly ? ['--firefox-only'] : [])]);
      const ff = JSON.parse(readFileSync(join(firefox, 'harbor_bridge.json'), 'utf8'));
      assert.equal(ff.name, 'harbor_bridge');
      assert.deepEqual(ff.allowed_extensions, ['harbor@krikorian.co']);
      assert.equal(ff.type, 'stdio');
      assert.equal(ff.path, join(fixture, 'target/release/harbor-bridge-native'));
      assert.equal(execFileSync(ff.path, ['argument with spaces'], { encoding: 'utf8' }),
        '--native-messaging\nargument with spaces\n');
      if (firefoxOnly) {
        assert.equal(existsSync(join(chrome, 'harbor_bridge.json')), false);
      } else {
        const cr = JSON.parse(readFileSync(join(chrome, 'harbor_bridge.json'), 'utf8'));
        assert.equal(cr.name, 'harbor_bridge');
        assert.equal(cr.type, 'stdio');
        assert.equal(cr.path, ff.path);
        assert.deepEqual(cr.allowed_origins, [`chrome-extension://${id}/`]);
        assert.equal(cr.allowed_extensions, undefined);
      }
      console.log(`PASS ${os}${firefoxOnly ? ' --firefox-only' : ''}`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
}

for (const file of ['bridge-rs/README.md', 'docs/QUICKSTART_CHROME.md', 'docs/USER_GUIDE.md', 'docs/DEVELOPER_GUIDE.md']) {
  const text = readFileSync(join(root, file), 'utf8');
  assert.doesNotMatch(text, /harbor_bridge_host|YOUR_EXTENSION_ID|update native messaging with your extension ID/);
  // Check links in the rewritten Chrome setup page; other guides have pre-existing broken links.
  if (file !== 'docs/QUICKSTART_CHROME.md') continue;
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (target && !/^[a-z]+:/i.test(target)) {
      assert.ok(existsSync(resolve(dirname(join(root, file)), target)), `${file}: missing ${target}`);
    }
  }
}
const guide = readFileSync(join(root, 'docs/QUICKSTART_CHROME.md'), 'utf8');
assert.ok(guide.includes(`chrome-extension://${id}/`));
assert.ok(guide.includes('target/release/harbor-bridge-native'));
console.log('PASS setup documentation content and local file links');

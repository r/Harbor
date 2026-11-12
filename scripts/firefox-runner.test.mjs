import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchFirefox } from './firefox-runner.mjs';

function fixture({ failure, run } = {}) {
  let config;
  let cleanup;
  let exits = 0;
  const runner = {
    registerCleanup(fn) { cleanup = fn; },
    async run() { if (failure) throw failure; if (run) await run(); },
    async exit() { exits++; cleanup(); },
  };
  return {
    dependencies: {
      async getManifest(sourceDir) { return { name: sourceDir }; },
      async createRunner(options) { config = options; return runner; },
      firefoxApp: {}, firefoxClient() {},
    },
    get config() { return config; },
    get exits() { return exits; },
    browserClosed() { cleanup(); },
  };
}

test('loads both Firefox builds in a new profile and closes only its runner', async () => {
  const f = fixture();
  const session = await launchFirefox({ startUrl: 'http://localhost:3457' }, f.dependencies);
  assert.equal(f.config.target, 'firefox-desktop');
  assert.deepEqual(f.config.params.extensions.map(e => e.sourceDir.split('/').slice(-2).join('/')),
    ['extension/dist-firefox', 'web-agents-api/dist-firefox']);
  assert.equal(f.config.params.profilePath, undefined);
  assert.equal(f.config.params.keepProfileChanges, false);
  assert.equal(f.config.params.preInstall, false);
  await session.close();
  await session.close();
  await session.closed;
  assert.equal(f.exits, 1);
});

test('startup failure closes the owned runner and preserves the error', async () => {
  const error = new Error('second addon rejected');
  const f = fixture({ failure: error });
  await assert.rejects(launchFirefox({}, f.dependencies), error);
  assert.equal(f.exits, 1);
});

test('missing build fails before starting Firefox with a build instruction', async () => {
  const f = fixture();
  f.dependencies.getManifest = async () => { throw new Error('missing manifest'); };
  await assert.rejects(launchFirefox({}, f.dependencies), /npm run build/);
  assert.equal(f.config, undefined);
});


test('closing after the browser exits does not try to kill it again', async () => {
  const f = fixture();
  const session = await launchFirefox({}, f.dependencies);
  f.browserClosed();
  await session.closed;
  await session.close();
  assert.equal(f.exits, 0);
});


test('cancellation rejects startup promptly and closes its runner', async () => {
  const controller = new AbortController();
  let releaseStartup;
  const f = fixture({ run: () => new Promise(resolve => { releaseStartup = resolve; }) });
  const error = new Error('startup deadline expired');
  const launching = launchFirefox({ signal: controller.signal }, f.dependencies);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(error);
  await assert.rejects(launching, error);
  assert.equal(f.exits, 1);
  releaseStartup();
});

test('cancellation during OS spawn kills the late browser', async () => {
  const controller = new AbortController();
  let releaseSpawn;
  let kills = 0;
  const f = fixture();
  f.dependencies.firefoxApp.run = () => new Promise(resolve => { releaseSpawn = resolve; });
  f.dependencies.createRunner = async ({ params }) => ({
    registerCleanup() {},
    async run() { await params.firefoxApp.run(); },
    async exit() { throw new Error('not running yet'); },
  });
  const launching = launchFirefox({ signal: controller.signal }, f.dependencies);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('deadline'));
  await assert.rejects(launching, /deadline/);
  releaseSpawn({ firefox: { kill() { kills++; } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(kills, 1);
});


test('an abort triggered while registering cleanup is not missed', async () => {
  const controller = new AbortController();
  let exits = 0;
  const f = fixture();
  f.dependencies.createRunner = async () => ({
    registerCleanup() { controller.abort(new Error('registration cancelled')); },
    async run() { await new Promise(() => {}); },
    async exit() { exits++; throw new Error('no browser'); },
  });
  await assert.rejects(launchFirefox({ signal: controller.signal }, f.dependencies), /registration cancelled/);
  assert.ok(exits > 0);
});

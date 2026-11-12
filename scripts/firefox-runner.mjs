import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// web-ext exposes only a single-extension CLI. Keep its internal API usage here.
// Resolve from the E2E package so dev:firefox needs no second web-ext install.
async function loadWebExt(signal) {
  const require = createRequire(new URL('../tests/e2e/package.json', import.meta.url));
  let base;
  try {
    base = path.dirname(require.resolve('web-ext'));
  } catch (cause) {
    throw new Error('Install the Firefox launcher dependency: npm install --prefix tests/e2e', { cause });
  }
  const load = relative => import(pathToFileURL(path.join(base, 'lib', relative)).href);
  const [runners, app, client, manifest] = await Promise.all([
    load('extension-runners/index.js'), load('firefox/index.js'),
    load('firefox/remote.js'), load('util/manifest.js'),
  ]);
  return {
    createRunner: runners.createExtensionRunner,
    firefoxApp: app,
    firefoxClient: options => client.connectWithMaxRetries(options, {
      connectToFirefox: port => {
        // Stop web-ext's 30-second connection retry loop at cancellation.
        signal?.throwIfAborted();
        return client.connect(port);
      },
    }),
    getManifest: manifest.default,
  };
}

export async function launchFirefox({ startUrl, firefoxBinary = process.env.FIREFOX, signal } = {}, dependencies) {
  const { createRunner, firefoxApp, firefoxClient, getManifest } = dependencies ?? await loadWebExt(signal);
  signal?.throwIfAborted();
  const extensions = [];
  for (const directory of ['extension/dist-firefox', 'web-agents-api/dist-firefox']) {
    const sourceDir = path.join(root, directory);
    try {
      extensions.push({ sourceDir, manifestData: await getManifest(sourceDir) });
    } catch (cause) {
      throw new Error(`Cannot load ${sourceDir}: ${cause.message}. Run npm run build from the repository root.`, { cause });
    }
  }
  signal?.throwIfAborted();
  const runner = await createRunner({
    target: 'firefox-desktop',
    params: {
      extensions, firefoxClient, firefoxBinary, startUrl,
      firefoxApp: {
        ...firefoxApp,
        async createProfile(...args) {
          const profile = await firefoxApp.createProfile(...args);
          // firefox-profile otherwise calls process.exit(130) synchronously,
          // bypassing our awaited shutdown during startup and SIGINT.
          process.removeListener('SIGINT', profile.onSigInt);
          return profile;
        },
        async run(...args) {
          signal?.throwIfAborted();
          const info = await firefoxApp.run(...args);
          // Cancellation may arrive while the OS is spawning Firefox, before
          // web-ext has assigned runningInfo and can service runner.exit().
          if (signal?.aborted) info.firefox.kill();
          return info;
        },
      },
      keepProfileChanges: false, preInstall: false,
      // No profilePath: web-ext creates a temporary profile for this instance.
    },
  });
  signal?.throwIfAborted();
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let exited = false;
  runner.registerCleanup(() => { exited = true; resolveClosed(); });
  let closing;
  const close = () => closing ??= (async () => {
    if (!exited) await runner.exit();
    await closed;
  })().catch(error => {
    // An early abort can precede creation of the browser. Allow late cleanup
    // once startup has progressed far enough to own a process.
    closing = undefined;
    throw error;
  });
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      reject(signal.reason);
      void close().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  const startup = runner.run();
  // Consume late completion after cancellation, including a browser spawned
  // after the deadline. The caller is free to reject at the actual deadline.
  void startup.then(() => {
    if (signal?.aborted) return close();
  }).catch(() => {});
  try {
    await Promise.race([startup, aborted]);
  } catch (error) {
    // Installation can fail after Firefox has already started.
    await close().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  console.log('[firefox] Loaded Harbor and Web Agents API in a temporary profile');
  return { closed, close };
}

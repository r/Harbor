/**
 * Playwright fixture for loading the Harbor extension in Firefox.
 * 
 * Firefox extension loading is complex. This fixture provides:
 * 1. A basic browser context (no extensions) for simple page tests
 * 2. Extension-aware context using web-ext for full integration tests
 */

import { test as base, firefox, type BrowserContext, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn, type ChildProcess, execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path relative to the test fixtures directory
const EXTENSION_PATH = path.resolve(__dirname, '../../../extension/dist');

export type ExtensionFixtures = {
  /** Basic browser context without extensions - for simple page tests */
  browserContext: BrowserContext;
  /** Browser context with the extension loaded via web-ext */
  extensionContext: BrowserContext;
  extensionId: string;
  sidebarPage: Page;
};

/**
 * Check if web-ext is available
 */
function hasWebExt(): boolean {
  try {
    execSync('npx web-ext --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const test = base.extend<ExtensionFixtures>({
  /**
   * Basic browser context without extensions.
   * Use this for tests that just need to load web pages.
   */
  browserContext: async ({}, use) => {
    const context = await firefox.launch({
      headless: false,
      firefoxUserPrefs: {
        'devtools.chrome.enabled': true,
      },
    });
    
    const browserContext = await context.newContext();
    await use(browserContext);
    await browserContext.close();
    await context.close();
  },

  /**
   * Browser context with extensions.
   * 
   * This uses a persistent context with extensions installed via profile.
   * For full extension testing, web-ext is recommended but adds complexity.
   */
  extensionContext: async ({}, use) => {
    // Create a temporary profile directory
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-test-'));
    
    // Write Firefox preferences to enable extension loading
    const prefsContent = [
      'user_pref("xpinstall.signatures.required", false);',
      'user_pref("extensions.autoDisableScopes", 0);',
      'user_pref("extensions.enabledScopes", 15);',
      'user_pref("devtools.chrome.enabled", true);',
      'user_pref("app.update.enabled", false);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    ].join('\n');
    
    await fs.writeFile(path.join(profileDir, 'user.js'), prefsContent);
    
    // Launch Firefox with the profile
    const context = await firefox.launchPersistentContext(profileDir, {
      headless: false,
      firefoxUserPrefs: {
        'xpinstall.signatures.required': false,
        'extensions.autoDisableScopes': 0,
        'extensions.enabledScopes': 15,
      },
    });
    
    await use(context);
    
    // Cleanup
    await context.close();
    try {
      await fs.rm(profileDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  },

  /**
   * Harbor extension UUID - placeholder for now
   */
  extensionId: async ({}, use) => {
    // Extension UUID is assigned dynamically by Firefox
    // For tests that need this, they should load via about:debugging
    await use('extension-not-loaded');
  },

  /**
   * Harbor sidebar page - requires extension to be loaded
   */
  sidebarPage: async ({ extensionContext }, use) => {
    const page = await extensionContext.newPage();
    // Can't navigate to extension page without UUID
    // Tests using this will need to handle the case
    await use(page);
  },
});

export { expect } from '@playwright/test';

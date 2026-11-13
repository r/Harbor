// Exercise the invoice page with controlled model replies in Firefox.
// Usage: start the demo server, then run this file with the demo URL.
import assert from 'node:assert/strict';
import { firefox } from 'playwright';

const url = process.argv[2];
if (!url) throw new Error('Pass the URL of the running AAF invoice demo.');
const browser = await firefox.launch({ channel: 'moz-firefox', executablePath: process.env.FIREFOX });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const chat = page.getByRole('textbox', { name: 'Invoice request' });
  const email = page.locator('[data-agent-field="customer_email"]');
  await email.fill('original@example.org');
  await chat.fill('Create an invoice');
  await chat.press('Enter');
  await page.waitForFunction(() => document.querySelector('#aaf-agent-root').shadowRoot.querySelector('.aaf-msg.error'));
  assert.match(await page.locator('#connection').innerText(), /unavailable/i);
  assert.equal(await email.inputValue(), 'original@example.org');
  assert.equal(await page.evaluate(() => localStorage.getItem('billing-app-invoices')), null);
  const invoice = { customer_email: 'alice@example.com', amount: 120, currency: 'EUR' };
  await page.addInitScript(({ invoice }) => {
    window.audit = { permissions: [], sessions: [], destroyed: 0 };
    window.agent = {
      async requestPermissions({ scopes }) {
        window.audit.permissions.push(scopes);
        return { granted: window.mode !== 'denied', scopes: { 'model:prompt': window.mode === 'denied' ? 'denied' : 'granted-always' } };
      }
    };
    window.ai = {
      async createTextSession(options) {
        window.audit.sessions.push(Object.keys(options));
        return {
          async prompt() {
            const args = window.mode === 'invalid' ? { ...invoice, currency: 'BAD' } : invoice;
            return JSON.stringify({ action: 'invoice.create', args });
          },
          destroy() { window.audit.destroyed++; }
        };
      }
    };
  }, { invoice });
  const response = await page.goto(url);
  assert.equal(response.status(), 200, 'The invoice page must be served.');
  const drafts = () => page.evaluate(() => JSON.parse(localStorage.getItem('billing-app-invoices') || '[]'));
  const send = async mode => {
    await page.evaluate(mode => { window.mode = mode; }, mode);
    await chat.fill('Create an invoice for alice@example.com for 120 EUR.');
    await chat.press('Enter');
  };
  await email.fill('original@example.org');
  await send('denied');
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('denied'));
  assert.equal(await email.inputValue(), 'original@example.org');
  assert.equal(await page.evaluate(() => window.audit.sessions.length), 0);
  await send('invalid');
  await page.waitForFunction(() => window.audit.destroyed > 0 && !document.querySelector('#invoice-fields').disabled);
  assert.equal(await email.inputValue(), 'original@example.org');
  assert.deepEqual(await drafts(), []);
  await send('valid');
  await page.waitForFunction(() => document.querySelector('[data-agent-field="customer_email"]').value === 'alice@example.com');
  assert.equal(await page.locator('#amount').inputValue(), '120');
  assert.equal(await page.locator('#currency').inputValue(), 'EUR');
  assert.deepEqual(await drafts(), []);
  await page.locator('#memo').fill('Reviewed by the user');
  await page.locator('#invoice-form button[type="submit"]').click();
  const rows = await drafts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].memo, 'Reviewed by the user');
  assert.deepEqual([rows[0].customer_email, rows[0].amount, rows[0].currency, rows[0].status],
    [invoice.customer_email, invoice.amount, invoice.currency, 'draft']);
  const audit = await page.evaluate(() => window.audit);
  assert.ok(audit.permissions.every(scopes => scopes.join() === 'model:prompt'));
  assert.ok(audit.sessions.every(keys => keys.join() === 'systemPrompt'));
  assert.equal(audit.sessions.length, audit.destroyed);
  assert.deepEqual(errors, []);
  console.log('Firefox passed permission denial, atomic validation, manual submission, draft storage and session cleanup.');
} finally {
  await browser.close();
}

import { ChatUI, WidgetPlanner, SemanticParser, ManifestValidator, enrichCatalogWithSchema, getInvoices, createInvoice } from './aaf.bundle.js';

const form = document.querySelector('#invoice-form');
const fields = document.querySelector('#invoice-fields');
const status = document.querySelector('#status');
const connection = document.querySelector('#connection');
const count = document.querySelector('#draft-count');
const validator = new ManifestValidator();
let busy = false;
let activeSession = null;

// The backend deliberately supplies only a system prompt. Harbor owns model selection.
const backend = {
  name: () => 'Harbor',
  isAvailable: async () => Boolean(window.ai?.createTextSession && window.agent?.requestPermissions),
  async generate(userPrompt, systemPrompt) {
    let session;
    try {
      session = await window.ai.createTextSession({ systemPrompt });
      activeSession = session;
      return await session.prompt(userPrompt);
    } catch (error) {
      // AAF retries malformed plans, but backend/permission errors must stop immediately.
      throw new Error(`API error: ${error.message}`);
    } finally {
      activeSession = null;
      if (session) {
        try {
          await session.destroy();
        } catch (error) {
          throw new Error(`API error: Could not close the Harbor session. ${error.message}`);
        }
      }
    }
  },
};
const planner = new WidgetPlanner(backend);
const ui = new ChatUI({ onSubmit: handleRequest });
ui.setModels([], '');
ui.shadow.querySelector('.aaf-model-select').remove();
ui.shadow.querySelector('.aaf-input input').setAttribute('aria-label', 'Invoice request');
ui.shadow.querySelector('.aaf-input input').placeholder = 'Create an invoice for alice@example.com for 120 EUR';
const style = document.createElement('style');
style.textContent = `
  :host { display: block; font-family: system-ui, sans-serif; }
  .aaf-toggle { display: none; }
  .aaf-panel { position: static; width: 100%; height: 430px; max-height: none; border: 0; border-radius: 0; box-shadow: none; }
  .aaf-header { background: #265d43; color: white; }
  .aaf-header h2 { font-size: 16px; }
  .aaf-btn-primary, .aaf-msg.user { background: #265d43; }
  .aaf-badge { max-width: 130px; overflow: hidden; text-overflow: ellipsis; }
`;
ui.shadow.appendChild(style);
document.querySelector('#assistant').appendChild(ui.host);
ui.open();
ui.setBadge('Harbor', false);
ui.addMessage('assistant', 'What invoice would you like to prepare? I’ll fill the details for your review.');

const manifestPromise = fetch(new URL('./agent-manifest.json', import.meta.url))
  .then(response => {
    if (!response.ok) throw new Error('Could not load the invoice manifest.');
    return response.json();
  })
  .then(data => {
    // Bind the sample manifest to this deployment, including a GitHub Pages prefix.
    data.site.origin = location.origin;
    data.pages = { [new URL('./', import.meta.url).pathname]: Object.values(data.pages)[0] };
    return validator.loadManifest(data);
  });
// Keep a load failure handled until the next request can show it in the widget.
manifestPromise.catch(() => {});

function refreshCount() {
  count.textContent = String(getInvoices().length);
}

async function handleRequest(text) {
  if (busy) return;
  busy = true;
  ui.setEnabled(false);
  fields.disabled = true;
  ui.addMessage('user', text);
  connection.textContent = 'Connecting to your AI through Harbor…';
  try {
    if (!await backend.isAvailable()) {
      throw new Error('Harbor is unavailable. Load both Harbor extensions in Firefox, configure a provider, then send your request again.');
    }
    const permission = await window.agent.requestPermissions({
      scopes: ['model:prompt'],
      reason: 'Use your chosen AI to prepare invoice details for your review.',
    });
    if (permission.granted !== true) {
      throw new Error('Model permission was denied. Allow this origin in Web Agents API, then send your request again.');
    }
    const manifest = await manifestPromise;
    const catalog = enrichCatalogWithSchema({ actions: new SemanticParser().discoverActions(form), url: location.href, timestamp: new Date().toISOString() }, manifest);
    connection.textContent = 'Preparing invoice details…';
    const { result } = await planner.plan(text, catalog);
    if (result.kind === 'answer') {
      ui.addMessage('assistant', result.text);
    } else {
      if (result.kind !== 'action' || result.request.action !== 'invoice.create') {
        throw new Error('The AI response did not describe an invoice. Please include an email, amount, and currency.');
      }
      const action = validator.getAction(manifest, 'invoice.create');
      if (Object.keys(result.request.args).some(name => !Object.hasOwn(action.inputSchema.properties, name))) {
        throw new Error('The AI returned an unknown invoice field. Please try again.');
      }
      const checked = validator.coerceAndValidate(action, result.request.args);
      if (!checked.valid) throw new Error(`Please check the invoice details. ${checked.errors.join(' ')}`);
      const values = { ...checked.coerced, memo: checked.coerced.memo || '' };
      // Test native email, number, and step constraints before mutating any live field.
      const candidate = form.cloneNode(true);
      candidate.querySelector('fieldset').disabled = false;
      for (const [name, value] of Object.entries(values)) {
        candidate.querySelector(`[data-agent-field="${CSS.escape(name)}"]`).value = String(value);
      }
      if (!candidate.checkValidity()) {
        throw new Error('The invoice details do not meet the form requirements. Check the email and use an amount with at most two decimal places.');
      }
      // Review stops after filling the validated form.
      for (const [name, value] of Object.entries(values)) {
        const input = form.querySelector(`[data-agent-field="${CSS.escape(name)}"]`);
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      status.textContent = 'Awaiting review. Check the details and press Save draft when ready.';
      ui.addMessage('assistant', 'The form is ready for review. Press Save draft to create the invoice.');
    }
    ui.setBadge('Harbor', true);
    connection.textContent = 'Your AI responded through Harbor.';
  } catch (error) {
    ui.setBadge('Unavailable', false);
    connection.textContent = error.message;
    ui.addMessage('error', error.message);
  } finally {
    fields.disabled = false;
    ui.setEnabled(true);
    busy = false;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (busy || !form.reportValidity()) return;
  try {
    const invoice = createInvoice({
      customer_email: form.elements.email.value,
      amount: Number(form.elements.amount.value),
      currency: form.elements.currency.value,
      memo: form.elements.memo.value || '',
    });
    status.textContent = `Draft ${invoice.id} saved locally.`;
    form.reset();
    refreshCount();
  } catch (error) {
    status.textContent = `Could not save draft. ${error.message}`;
  }
});
window.addEventListener('pagehide', () => {
  if (activeSession) Promise.resolve(activeSession.destroy()).catch(() => {});
});
window.addEventListener('storage', refreshCount);
refreshCount();
if (!window.ai?.createTextSession || !window.agent?.requestPermissions) {
  connection.textContent = 'Harbor is unavailable. Load both extensions and configure a provider to use the assistant.';
}

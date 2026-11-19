/**
 * Builds one scope row for the permission prompt (permission-prompt.ts),
 * without ever passing an interpolated string through innerHTML — `title`/
 * `description` can carry an agent name the person typed into the
 * sidebar's "Custom" agent form (sidebar-agents.ts), so a name like
 * `<b>x</b>` must render literally, not as markup. Split out from
 * permission-prompt.ts (which runs page-level side effects at import time)
 * so this is testable on its own, with just a `document.createElement`.
 */
export function buildScopeItem(icon: string, title: string, description: string, risk?: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'scope-item';

  const header = document.createElement('div');
  header.className = 'scope-header';
  const iconEl = document.createElement('span');
  iconEl.className = 'scope-icon';
  iconEl.textContent = icon;
  const titleEl = document.createElement('span');
  titleEl.className = 'scope-title';
  titleEl.textContent = title;
  header.append(iconEl, titleEl);
  if (risk) {
    const riskEl = document.createElement('span');
    riskEl.className = `risk-badge risk-${risk}`;
    riskEl.textContent = risk;
    header.appendChild(riskEl);
  }

  const descriptionEl = document.createElement('div');
  descriptionEl.className = 'scope-description';
  descriptionEl.textContent = description;

  item.append(header, descriptionEl);
  return item;
}

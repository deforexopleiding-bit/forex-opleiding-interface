// modules/klanten-v2/views/tabs/profiel.js
//
// Placeholder voor de Profiel-tab (35 items uit PR #1112 checklist:
// sidebar 13 + main-content 22). Volledig ingevuld in PR-B2.

const K = () => window.KV;

export async function renderProfielTab(rootEl, { customer, profile } = {}) {
  rootEl.innerHTML = `
    <div class="ds-empty" style="padding:48px 20px;">
      <div class="ds-empty-ico" style="background:var(--emerald-soft); color:var(--emerald);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/></svg>
      </div>
      <div class="ds-empty-t">Profiel-tab volgt in PR-B2</div>
      <div class="ds-empty-s">Sidebar (avatar, tags, snelle stats) + main-content (NAW, bedrijf, geboortedatum, notities-preview, koppelingen). 35 items uit de INVENTARIS. Klant-ID: <code>${K().esc(customer?.id || '—')}</code>.</div>
    </div>`;
}

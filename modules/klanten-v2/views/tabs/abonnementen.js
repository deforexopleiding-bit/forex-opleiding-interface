// modules/klanten-v2/views/tabs/abonnementen.js
//
// Placeholder voor de Abonnementen-tab (25 items). Volledig ingevuld in PR-B5.

const K = () => window.KV;

export async function renderAbonnementenTab(rootEl, { customer } = {}) {
  rootEl.innerHTML = `
    <div class="ds-empty" style="padding:48px 20px;">
      <div class="ds-empty-ico" style="background:var(--teal-soft); color:var(--teal);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>
      </div>
      <div class="ds-empty-t">Abonnementen-tab volgt in PR-B5</div>
      <div class="ds-empty-s">Abonnementen-lijst (plan, MRR, start, termijn, status) + line-items + pauze/stop-flow. 25 items uit de INVENTARIS. Klant-ID: <code>${K().esc(customer?.id || '—')}</code>.</div>
    </div>`;
}

// modules/klanten-v2/views/tabs/offertes.js
//
// Placeholder voor de Offertes-tab (17 items). Volledig ingevuld in PR-B4.

const K = () => window.KV;

export async function renderOffertesTab(rootEl, { customer } = {}) {
  rootEl.innerHTML = `
    <div class="ds-empty" style="padding:48px 20px;">
      <div class="ds-empty-ico" style="background:var(--blue-soft); color:var(--blue);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </div>
      <div class="ds-empty-t">Offertes-tab volgt in PR-B4</div>
      <div class="ds-empty-s">Offertes-lijst (nr, traject, totaal, status, datum, verkoper) + actie-knoppen (openen, opnieuw versturen). Read-only, hergebruikt <code>/api/quotations</code>. 17 items uit de INVENTARIS. Klant-ID: <code>${K().esc(customer?.id || '—')}</code>.</div>
    </div>`;
}

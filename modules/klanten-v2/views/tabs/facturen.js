// modules/klanten-v2/views/tabs/facturen.js
//
// Placeholder voor de Facturen-tab (14 items). Volledig ingevuld in PR-B6.
// De factuur-modals (12 + 3 + 5 + 3 + 6 + 14 items volgens PR #1112 body)
// komen in PR-C samen met de andere modals.

const K = () => window.KV;

export async function renderFacturenTab(rootEl, { customer } = {}) {
  rootEl.innerHTML = `
    <div class="ds-empty" style="padding:48px 20px;">
      <div class="ds-empty-ico" style="background:var(--amber-soft); color:var(--amber);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v18l-3-2-2 2-2-2-2 2-2-2-2 2-3-2z"/><path d="M8 9h8M8 13h5"/></svg>
      </div>
      <div class="ds-empty-t">Facturen-tab volgt in PR-B6</div>
      <div class="ds-empty-s">Facturen-lijst (nr, bedrag, open, dagen te laat, status) + row-click naar detail-modal. Modals (detail / betaal / verzenden / credit / update / nieuwe) komen in PR-C. 14 items uit de INVENTARIS. Klant-ID: <code>${K().esc(customer?.id || '—')}</code>.</div>
    </div>`;
}

// modules/klanten-v2/views/tabs/wanbetalers.js
//
// Placeholder voor de Wanbetalers-tab (5 items). Volledig ingevuld in PR-B6.
//
// ⚠ BESCHERMDE ZONE — deze tab is READ-ONLY en toont een subset van de
// wanbetalers-dossier van de klant (tijdlijn + actieve arrangement + open
// facturen). Alle actie-knoppen (aanmaan, voorstel arrangement, escaleren)
// blijven in modules/finance.html sub-view Wanbetalers. Wanneer PR-B6
// wordt gebouwd: alleen /api/customer-dossier + /api/arrangements-list
// (read) gebruiken; NIET de dunning-engine of arrangement-mutation
// endpoints aanraken.

const K = () => window.KV;

export async function renderWanbetalersTab(rootEl, { customer } = {}) {
  rootEl.innerHTML = `
    <div class="ds-empty" style="padding:48px 20px;">
      <div class="ds-empty-ico" style="background:var(--rose-soft); color:var(--rose);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 22h20L12 2z"/><path d="M12 9v5M12 18h.01"/></svg>
      </div>
      <div class="ds-empty-t">Wanbetalers-tab volgt in PR-B6 (read-only)</div>
      <div class="ds-empty-s">Read-only snapshot: dunning-fase + actief arrangement + open facturen + tijdlijn. Mutation-flow blijft in <a href="/modules/finance.html#view-wanbetalers" style="color:var(--m); text-decoration:underline;">Finance › Wanbetalers</a> — beschermde zone. 5 items uit de INVENTARIS. Klant-ID: <code>${K().esc(customer?.id || '—')}</code>.</div>
    </div>`;
}

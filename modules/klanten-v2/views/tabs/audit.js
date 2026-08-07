// modules/klanten-v2/views/tabs/audit.js
//
// Placeholder voor de Audit-tab (5 items). Volledig ingevuld in PR-B6.

const K = () => window.KV;

export async function renderAuditTab(rootEl, { customer } = {}) {
  rootEl.innerHTML = `
    <div class="ds-empty" style="padding:48px 20px;">
      <div class="ds-empty-ico" style="background:var(--slate-soft); color:var(--slate);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="12" y1="12" x2="15" y2="14"/></svg>
      </div>
      <div class="ds-empty-t">Audit-tab volgt in PR-B6</div>
      <div class="ds-empty-s">Audit-trail via <code>/api/customer-audit</code>: created / updated / archived / unarchived / anonymized met actor + timestamp + reason. 5 items uit de INVENTARIS. Klant-ID: <code>${K().esc(customer?.id || '—')}</code>.</div>
    </div>`;
}

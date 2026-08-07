// modules/klanten-v2/views/tabs/communicatie.js
//
// Placeholder voor de Communicatie-tab (19 items: notities 16 +
// WhatsApp/Email placeholders 3). Volledig ingevuld in PR-B3.

const K = () => window.KV;

export async function renderCommunicatieTab(rootEl, { customer } = {}) {
  rootEl.innerHTML = `
    <div class="ds-empty" style="padding:48px 20px;">
      <div class="ds-empty-ico" style="background:var(--violet-soft); color:var(--violet);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </div>
      <div class="ds-empty-t">Communicatie-tab volgt in PR-B3</div>
      <div class="ds-empty-s">Notities (CRUD) + WhatsApp-thread + Email-thread. 19 items uit de INVENTARIS. Klant-ID: <code>${K().esc(customer?.id || '—')}</code>.</div>
    </div>`;
}

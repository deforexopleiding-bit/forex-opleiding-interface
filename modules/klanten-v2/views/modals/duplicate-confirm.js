// modules/klanten-v2/views/modals/duplicate-confirm.js
//
// Duplicate-warning-modal (PR-C4, deel 1 van 2). Tweede-laag veiligheidsnet
// vóór aanmaak: als GET /api/customer-check-duplicate matches vindt op
// email of phone en de user drukt tóch op "Klant aanmaken", tonen we
// deze confirm-modal met de matches + 3 keuzes: openen bestaande /
// toch doorgaan / annuleren.
//
// Endpoint (bestaand, GET-only): /api/customer-check-duplicate
//   ?email=<email>[&phone=<phone>][&exclude_id=<uuid>]
// Auth: verifyAdmin.
// Response: { matches: [{ id, first_name, last_name, email, phone,
//   status, match_reason: 'email'|'phone'|'both' }] }
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

function esc(v) { return K().esc(v); }

function customerName(c) {
  if (!c) return 'Klant';
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || 'Klant';
}
function matchReasonLabel(r) {
  return r === 'both' ? 'email + telefoon' : r === 'email' ? 'email' : r === 'phone' ? 'telefoon' : r || '—';
}

/**
 * Fetch duplicate-matches vóór het tonen van de confirm-modal. Retourneert
 * altijd een array (leeg bij netwerk-fout — dan zetten we door alsof er
 * geen duplicates zijn; UX-keuze: server-fout mag create niet blokkeren).
 */
export async function checkDuplicates({ email, phone, excludeId }) {
  const params = new URLSearchParams();
  if (email) params.set('email', email);
  if (phone) params.set('phone', phone);
  if (excludeId) params.set('exclude_id', excludeId);
  if (!email && !phone) return [];
  try {
    const j = await K().authedJson(`/api/customer-check-duplicate?${params.toString()}`);
    return Array.isArray(j?.matches) ? j.matches : [];
  } catch (e) {
    console.warn('[duplicate-check] fetch fail — laten doorgaan:', e?.message);
    return [];
  }
}

/**
 * openDuplicateConfirmModal({ matches, formData, onProceed, onOpenExisting })
 *   matches         — array uit checkDuplicates()
 *   formData        — de huidige create-form waarden (voor context in de modal)
 *   onProceed()     — user kiest "Toch nieuwe klant aanmaken"
 *   onOpenExisting(id) — user klikt een match-rij
 */
export function openDuplicateConfirmModal({ matches, formData = {}, onProceed, onOpenExisting } = {}) {
  if (!D() || typeof D().openModal !== 'function') return;
  if (!Array.isArray(matches) || !matches.length) {
    // Geen matches → direct doorgaan zonder modal
    if (typeof onProceed === 'function') onProceed();
    return;
  }

  const head = `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Mogelijke duplicaten</div>
        <div class="kv-edit-head-name">${matches.length} vergelijkbare klant${matches.length === 1 ? '' : 'en'} gevonden</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-dup-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;

  const body = `
    <div class="kv-dup-body">
      <div class="kv-dup-explain">
        Er ${matches.length === 1 ? 'is' : 'zijn'} al klant${matches.length === 1 ? '' : 'en'} met vergelijkbare gegevens.
        Kies of je een bestaande wilt openen, of toch een nieuwe klant wilt aanmaken.
      </div>
      <ul class="kv-dup-list">
        ${matches.map((m) => `
          <li class="kv-dup-item">
            <button type="button" class="kv-dup-item-btn" data-kv-dup-open="${esc(m.id)}">
              <div class="kv-dup-item-main">
                <div class="kv-dup-item-name">${esc(customerName(m))}</div>
                <div class="kv-dup-item-sub">
                  ${m.email ? `<span>${esc(m.email)}</span>` : ''}
                  ${m.phone ? `<span>${esc(m.phone)}</span>` : ''}
                </div>
              </div>
              <div class="kv-dup-item-meta">
                <span class="ds-pill ds-pill-warn nodot">match: ${esc(matchReasonLabel(m.match_reason))}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;color:var(--text-3)"><path d="m9 6 6 6-6 6"/></svg>
              </div>
            </button>
          </li>`).join('')}
      </ul>
      <div class="kv-dup-input-summary">
        <div class="kv-dup-input-summary-l">Nieuwe klant zou zijn:</div>
        <div class="kv-dup-input-summary-v">
          <strong>${esc(formData.name || 'Onbekend')}</strong>
          ${formData.email ? ` · ${esc(formData.email)}` : ''}
          ${formData.phone ? ` · ${esc(formData.phone)}` : ''}
        </div>
      </div>
    </div>`;

  const foot = `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-dup-cancel>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-dup-proceed>Toch nieuwe klant aanmaken</button>
    </div>`;

  D().openModal({ head, body, foot });

  const box = document.getElementById('dfoModal');
  box.querySelectorAll('[data-kv-dup-close], [data-kv-dup-cancel]').forEach((b) => {
    b.addEventListener('click', () => D().closeModal());
  });
  box.querySelector('[data-kv-dup-proceed]')?.addEventListener('click', () => {
    D().closeModal();
    if (typeof onProceed === 'function') onProceed();
  });
  box.querySelectorAll('[data-kv-dup-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-kv-dup-open');
      D().closeModal();
      if (typeof onOpenExisting === 'function') onOpenExisting(id);
    });
  });
}

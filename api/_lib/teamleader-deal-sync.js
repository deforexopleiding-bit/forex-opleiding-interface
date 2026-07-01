// api/_lib/teamleader-deal-sync.js
//
// Live TL-status pull voor één deal. Aangeroepen door sales-deal-detail bij
// openen én door de expliciete "Ververs vanuit Teamleader"-knop. Onafhankelijk
// van de (onbetrouwbare) TL-webhook — als TL netjes deal.moved firet doet de
// webhook z'n werk; hier vullen we het gat voor het geval TL niks aflevert.
//
// VEILIG:
//   - UITSLUITEND een READ (deals.info) + smalle UPDATE van de quotation-velden
//     op de deals-rij (tl_quotation_status / accepted_at / signed_at).
//   - RAAKT NOOIT invoices / subscriptions / payments / line_items.
//   - GEEN TL-write.
//   - Fail-soft: TL onbereikbaar/fout → geen throw, retourneert huidige DB-status.
//   - Idempotent: al 'accepted' → geen extra update.
//   - Geen fan-out notificaties (die horen bij de webhook — anders zou elke
//     manuele refresh dubbel notificeren).
//
// Duplicaat van de veilige kern van teamleader-webhook.js handleDealWon, zodat
// een eventuele latere refactor daar het webhook-gedrag 0 diff laat.

import { supabaseAdmin } from '../supabase.js';
import { tlFetch, getActiveToken } from './teamleader-token.js';

/**
 * Live TL-status voor een deal ophalen en (indien nodig) onze quotation-status
 * verversen. Fail-soft.
 *
 * @param {object} deal - Een rij uit de deals-tabel. Vereist: id, tl_deal_id.
 *                       Aanbevolen: tl_quotation_status (voor idempotency-check).
 * @returns {Promise<{
 *   synced: boolean,    // true als we TL echt hebben gesproken
 *   changed: boolean,   // true als we tl_quotation_status hebben aangepast
 *   status: string|null,// nieuwste tl_quotation_status na sync (of huidige DB-status bij no-op)
 *   tl_status?: string|null,
 *   error?: string,
 * }>}
 */
export async function syncDealStatusFromTl(deal) {
  if (!deal || !deal.tl_deal_id) {
    return {
      synced:  false,
      changed: false,
      status:  deal?.tl_quotation_status || null,
    };
  }

  const currentStatus = deal.tl_quotation_status || null;

  let tlStatus = null;
  try {
    const tok = await getActiveToken();
    if (!tok) {
      return { synced: false, changed: false, status: currentStatus, error: 'geen TL-token actief' };
    }
    const r = await tlFetch('/deals.info', {
      method: 'POST',
      body:   JSON.stringify({ id: deal.tl_deal_id }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('[deal-sync] deals.info HTTP', r.status, txt.slice(0, 300));
      return { synced: false, changed: false, status: currentStatus, error: `HTTP ${r.status}` };
    }
    const d = await r.json().catch(() => ({}));
    tlStatus = d.data?.status || null;
  } catch (e) {
    console.warn('[deal-sync] deals.info exception:', e?.message || e);
    return { synced: false, changed: false, status: currentStatus, error: e?.message || 'exception' };
  }

  // Mapping — alleen 'won' -> 'accepted'. Alle andere TL-statussen laten we
  // met rust (bewust conservatief: we mappen alleen het signaal dat de webhook
  // ook zou schrijven). Toekomstige uitbreiding (bv. 'lost' -> 'declined')
  // vereist expliciete afspraak met de sales-flow; niet hier.
  if (tlStatus !== 'won') {
    return { synced: true, changed: false, status: currentStatus, tl_status: tlStatus };
  }

  // Al 'accepted' → idempotent no-op.
  if (String(currentStatus || '').toLowerCase() === 'accepted') {
    return { synced: true, changed: false, status: currentStatus, tl_status: tlStatus };
  }

  const now = new Date().toISOString();
  const { error: updErr } = await supabaseAdmin.from('deals').update({
    tl_quotation_status:      'accepted',
    tl_quotation_accepted_at: now,
    tl_quotation_signed_at:   now,
  }).eq('id', deal.id);
  if (updErr) {
    console.warn('[deal-sync] DB update fail:', updErr.message);
    return { synced: true, changed: false, status: currentStatus, tl_status: tlStatus, error: updErr.message };
  }
  return { synced: true, changed: true, status: 'accepted', tl_status: tlStatus };
}

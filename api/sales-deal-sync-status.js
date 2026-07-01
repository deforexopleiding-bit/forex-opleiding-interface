// api/sales-deal-sync-status.js
//
// POST — expliciete "Ververs vanuit Teamleader"-actie voor de sales-UI.
// Onafhankelijk van de (onbetrouwbare) TL-webhook: doet een live deals.info
// pull per deal en syncet onze tl_quotation_status naar 'accepted' als TL
// bevestigt dat de deal 'won' is.
//
// Body:
//   { deal_id: uuid }   → sync die ene deal.
//   { all: true }       → sync alle deals met tl_deal_id + status != 'accepted'
//                         (cap 100), PARALLEL.
//
// VEILIG: hergebruikt api/_lib/teamleader-deal-sync.js → alleen READ + smalle
// quotation-veld-update. Geen invoices/subscriptions/payments; geen TL-write.
// Fail-soft per deal — één falende sync blokkeert de rest niet.
//
// Permission: sales.deal.view (dezelfde als sales-deal-detail; edit is niet
// nodig want de update is een sync-side-effect van een "read live status").

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { syncDealStatusFromTl } from './_lib/teamleader-deal-sync.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BULK_CAP = 100;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.view'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.view)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const wantAll = body.all === true;
  const dealId  = typeof body.deal_id === 'string' ? body.deal_id.trim() : null;

  try {
    let deals = [];
    if (wantAll) {
      const { data: rows, error } = await supabaseAdmin
        .from('deals')
        .select('id, tl_deal_id, tl_quotation_status')
        .not('tl_deal_id', 'is', null)
        .neq('tl_quotation_status', 'accepted')
        .limit(BULK_CAP);
      if (error) throw new Error('deals fetch: ' + error.message);
      deals = rows || [];
    } else {
      if (!dealId || !UUID_RE.test(dealId)) {
        return res.status(400).json({ error: 'deal_id (uuid) of { all:true } vereist' });
      }
      const { data: row, error } = await supabaseAdmin
        .from('deals')
        .select('id, tl_deal_id, tl_quotation_status')
        .eq('id', dealId)
        .maybeSingle();
      if (error) throw new Error('deal fetch: ' + error.message);
      if (!row) return res.status(404).json({ error: 'Deal niet gevonden' });
      deals = [row];
    }

    if (deals.length === 0) {
      return res.status(200).json({ ok: true, updated: 0, results: [] });
    }

    const results = await Promise.all(deals.map(async (d) => {
      try {
        const r = await syncDealStatusFromTl(d);
        return {
          deal_id:   d.id,
          synced:    !!r.synced,
          changed:   !!r.changed,
          status:    r.status || null,
          tl_status: r.tl_status || null,
          error:     r.error || null,
        };
      } catch (e) {
        return {
          deal_id:   d.id,
          synced:    false,
          changed:   false,
          status:    d.tl_quotation_status || null,
          error:     e?.message || 'exception',
        };
      }
    }));

    const updated = results.filter((x) => x.changed).length;
    return res.status(200).json({
      ok:      true,
      updated,
      count:   results.length,
      results,
    });
  } catch (e) {
    console.error('[sales-deal-sync-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

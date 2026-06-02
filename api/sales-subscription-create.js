// api/sales-subscription-create.js
// POST { deal_id, tl_department_id, first_call_at, subscriptions[], sync_to_tl }
// Wizard 2: maakt meerdere subscriptions (+ optionele bonus) lokaal aan en
// pusht ze best-effort naar TL. Permission: sales.deal.create.
//
// subscriptions[]: {
//   description, start_date, end_date, term_count,
//   line_items: [{ description, amount, vat_percentage }]   // amount = EXCL BTW
// }
// Backwards-compat: een sub zonder line_items mag nog { amount, vat_percentage }
// aanleveren — dat wordt één synthetische regel.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { getOrCreateContact } from './_lib/teamleader-contact.js';
import { taxRateIdFor } from './_lib/teamleader-quotation.js';

// Normaliseer een sub naar een line_items-array (backwards-compat met oude
// single-amount payloads). Returnt altijd een array (mogelijk leeg na filter).
function normalizeLineItems(s) {
  if (Array.isArray(s.line_items) && s.line_items.length) {
    return s.line_items
      .map(li => ({
        description: li.description || s.description || 'Abonnement',
        amount: Number(li.amount) || 0,
        vat_percentage: li.vat_percentage ?? 21,
      }))
      .filter(li => li.amount > 0);
  }
  // Legacy: één regel uit amount + vat_percentage.
  const amt = Number(s.amount) || 0;
  return amt > 0 ? [{ description: s.description || 'Abonnement', amount: amt, vat_percentage: s.vat_percentage ?? 21 }] : [];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.create'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.create)' });
  }

  const { deal_id, tl_department_id, first_call_at, subscriptions = [], sync_to_tl = false } = req.body || {};
  if (!deal_id) return res.status(400).json({ error: 'deal_id vereist' });
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return res.status(400).json({ error: 'minimaal 1 abonnement vereist' });

  try {
    const { data: deal } = await supabaseAdmin.from('deals').select('*').eq('id', deal_id).maybeSingle();
    if (!deal) return res.status(404).json({ error: 'Deal niet gevonden' });
    const departmentId = tl_department_id || deal.tl_department_id || null;

    // Elke sub naar regels normaliseren + valideren dat er een bedrag in zit.
    const subsNorm = subscriptions.map(s => ({ ...s, _lines: normalizeLineItems(s) }));
    for (const s of subsNorm) {
      if (!s._lines.length) return res.status(400).json({ error: `Abonnement "${s.description || ''}" heeft geen regel met bedrag > 0` });
    }

    // Pre-flight: bij TL-sync de tax_rate_id's per regel vóóraf valideren, zodat
    // een ontbrekende env-var een duidelijke 422 geeft VÓÓR er lokaal subs worden
    // aangemaakt (consistent met Wizard 1, geen partial state).
    if (sync_to_tl) {
      try {
        for (const s of subsNorm) for (const li of s._lines) taxRateIdFor(li.vat_percentage, departmentId, deal.sale_type);
      } catch (e) {
        return res.status(422).json({ error: e.message });
      }
    }

    // 1. Deal bijwerken (1e call).
    await supabaseAdmin.from('deals').update({ first_call_at: first_call_at || null }).eq('id', deal_id);

    // 2. Subscriptions lokaal aanmaken. amount = som regels (EXCL); vat_percentage
    //    = tarief van de eerste regel (legacy-kolommen, behouden voor compat).
    const subRows = [];
    for (const s of subsNorm) {
      const totalExcl = s._lines.reduce((sum, li) => sum + (Number(li.amount) || 0), 0);
      const { data: row } = await supabaseAdmin.from('subscriptions').insert({
        deal_id,
        description:        s.description || null,
        amount:            Math.round(totalExcl * 100) / 100,
        vat_percentage:    s._lines[0].vat_percentage ?? 21,
        term_count:        Number(s.term_count) || 1,
        start_date:        s.start_date || null,
        end_date:          s.end_date || null,
        tl_department_id:  departmentId,
        line_items:        s._lines.map(li => ({ description: li.description, amount: li.amount, vat_percentage: li.vat_percentage })),
        status:            'active',
      }).select('*').single();
      if (row) subRows.push(row);
    }

    // 3. Bonus op de eerste 1-termijn-sub (aanbetaling): over het totaalbedrag.
    let bonus = null;
    const downSub = subsNorm.find(s => (Number(s.term_count) || 1) === 1);
    const downAmount = downSub ? downSub._lines.reduce((sum, li) => sum + (Number(li.amount) || 0), 0) : 0;
    if (downAmount > 0 && deal.sales_user_id) {
      const { data: cfg } = await supabaseAdmin.from('sales_bonus_configs')
        .select('percentage, threshold_amount').eq('user_id', deal.sales_user_id)
        .order('active_from', { ascending: false }).limit(1).maybeSingle();
      const pct = cfg?.percentage ?? 3;
      const threshold = cfg?.threshold_amount ?? 1000;
      if (downAmount >= Number(threshold)) {
        const bonusAmount = Math.round(downAmount * Number(pct)) / 100;
        const { data: b } = await supabaseAdmin.from('bonuses').insert({
          deal_id, sales_user_id: deal.sales_user_id, amount: bonusAmount, status: 'pending',
        }).select('*').single();
        bonus = b || { amount: bonusAmount, status: 'pending' };
      }
    }

    // 4. Best-effort TL-push per sub (non-blocking).
    const tlResults = [];
    const tok = sync_to_tl ? await getActiveToken() : null;
    if (sync_to_tl && tok) {
      const { data: customer } = await supabaseAdmin.from('customers').select('*').eq('id', deal.customer_id).maybeSingle();
      let tlContactId = null;
      try { tlContactId = await getOrCreateContact(customer); } catch (e) { console.error('[sub-create] contact:', e.message); }

      // Definitieve billing_cycle-shape (uit live discovery + TL-docs):
      //   periodicity.unit = 'month' (NIET 'monthly'); period (NIET quantity).
      // days_in_advance: factuur X dagen vóór de termijndatum aanmaken (default 7).
      // payment_term verplicht: 14 dagen na factuurdatum.
      const DAYS_IN_ADVANCE = Number(process.env.TEAMLEADER_SUB_DAYS_IN_ADVANCE) || 7;
      const billing_cycle = { periodicity: { unit: 'month', period: 1 }, days_in_advance: DAYS_IN_ADVANCE };
      // invoice_generation correcte oneOf-shape (uit live discovery): book_and_send
      // VEREIST sending_methods. Default factuur automatisch per e-mail versturen
      // (Jeffrey's eis). Zet TEAMLEADER_SUB_AUTOSEND='false' voor enkel boeken.
      const autosend = process.env.TEAMLEADER_SUB_AUTOSEND !== 'false';
      const invoice_generation = autosend
        ? { action: 'book_and_send', sending_methods: [{ method: 'email' }] }
        : { action: 'book' };

      for (let i = 0; i < subRows.length; i++) {
        const row = subRows[i];
        const lines = subsNorm[i]._lines;
        // Tax-rate is in de pre-flight al gevalideerd → hier veilig.
        // LET OP intracommunautair: vat_percentage in DB blijft het echte tarief
        // (bv. 21) voor administratie-helderheid; taxRateIdFor(.., sale_type)
        // mapt naar het INTRA-tarief (0%) zodat TL géén BTW berekent.
        const tlLineItems = lines.map(li => ({
          quantity: 1,
          description: li.description || row.description || 'Abonnement',
          unit_price: { amount: Number(li.amount), currency: 'EUR', tax: 'excluding' },
          tax_rate_id: taxRateIdFor(li.vat_percentage, departmentId, deal.sale_type),
        }));
        const body = {
          invoicee: { customer: { type: 'contact', id: tlContactId } },
          department_id: departmentId,
          starts_on: row.start_date,
          title: row.description || 'Abonnement',
          billing_cycle,
          payment_term: { type: 'after_invoice_date', days: 14 },
          invoice_generation,
          grouped_lines: [{ line_items: tlLineItems }],
        };
        // ends_on uit frontend (start + (term-1) mnd + 2 dagen buffer); ook voor
        // eenmalige subs (term_count=1 → start + 2 dagen).
        if (row.end_date) body.ends_on = row.end_date;

        try {
          const r = await tlFetch('/subscriptions.create', { method: 'POST', body: JSON.stringify(body) });
          if (r.ok) {
            const d = await r.json();
            const tlSubId = d.data?.id;
            if (tlSubId) await supabaseAdmin.from('subscriptions').update({ teamleader_subscription_id: tlSubId }).eq('id', row.id);
            tlResults.push({ sub_id: row.id, tl_sub_id: tlSubId, success: true });
          } else {
            const err = `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
            console.error('[sub-create] subscriptions.create mislukt:', err);
            tlResults.push({ sub_id: row.id, success: false, error: err });
          }
        } catch (e) {
          console.error('[sub-create] exception:', e.message);
          tlResults.push({ sub_id: row.id, success: false, error: e.message });
        }
      }
    }

    return res.status(200).json({
      success: true,
      subscription_ids: subRows.map(r => r.id),
      bonus,
      tl_pushed: tlResults.filter(r => r.success).length,
      tl_failed: tlResults.filter(r => !r.success).length,
      tl_results: tlResults,
    });
  } catch (e) {
    console.error('[sales-subscription-create]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

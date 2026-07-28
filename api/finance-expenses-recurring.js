// api/finance-expenses-recurring.js
// GET → detecteer terugkerende uitgaven (maandelijks/kwartaal/jaarlijks) +
// bespaar-signalen ("mogelijk ongebruikt", "mogelijk dubbel"). Read-only —
// wijzigt niks aan transacties of categorisaties.
// Permission: finance.expenses.view.
//
// Query-params (alle optioneel):
//   from, to      YYYY-MM-DD — beperk historie-venster (default: alle tx)
//
// Response:
//   { recurring: [ { normalized_name, display_name, interval, tx_count,
//                    distinct_months, median_days, avg_amount_cents,
//                    monthly_cents, total_cents, first_date, last_date,
//                    days_since_last, possible_unused, possible_duplicate,
//                    category: {id, slug, label, color} | null } ],
//     total_monthly_cents,
//     insights: { count_total, count_monthly, count_quarterly, count_yearly,
//                 count_possibly_unused, count_possibly_duplicate },
//     period: { from, to },
//     today: 'YYYY-MM-DD' }
//
// Filters (hardcoded voor detectie — geen user-input; interne stromen tellen
// nooit als terugkerende uitgave):
//   - Exclude source='paypal' interne holds via counterparty_name '(intern PayPal)' + '(leeg)'
//   - Exclude interne overboekingen (categorie is_internal=true, bv. ING→PayPal, JB Holding)
//   - Exclude inkomsten (amount_cents >= 0)
//   - Exclude tx die aan een ai_suggest hangen (die telt niet als bevestigd,
//     dus we categoriseren op alleen rule/manual)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { detectRecurringAll, daysSinceEpoch } from './_lib/expenses-recurring.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INTERNAL_NAMES = new Set(['(intern PayPal)', '(leeg)']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

    const supabase = createUserClient(req);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    if (!(await requirePermission(req, 'finance.expenses.view'))) {
      return res.status(403).json({ error: 'Geen rechten (finance.expenses.view)' });
    }

    const q = req.query || {};
    const from = ISO_DATE_RE.test(String(q.from || '')) ? String(q.from) : null;
    const to   = ISO_DATE_RE.test(String(q.to   || '')) ? String(q.to)   : null;

    // Stap 1: fetch ALLE tx (niet alleen amount<0) zodat PayPal +Bij samen
    // met -Af netto in dezelfde tegenpartij-groep valt en Twilio-achtige
    // gevallen (waar autorisatie grotendeels teruggeboekt wordt) correct
    // als netto-uitgave (of geen uitgave) worden herkend.
    const CHUNK = 1000;
    const txs = [];
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let qy = supabaseAdmin
        .from('camt_transactions')
        .select('id, counterparty_name, amount_cents, booking_date')
        .order('booking_date', { ascending: true })
        .range(offset, offset + CHUNK - 1);
      if (from) qy = qy.gte('booking_date', from);
      if (to)   qy = qy.lte('booking_date', to);
      const { data, error } = await qy;
      if (error) throw new Error('camt_transactions: ' + error.message);
      if (!data || !data.length) break;
      txs.push(...data);
      if (data.length < CHUNK) break;
      offset += CHUNK;
    }

    // Stap 2: filter interne PayPal-namen + lege naam + inkomst-groepen.
    // Group-based filter (via counterparty_name): totaal >= 0 = inkomst-groep,
    // skip. Zo verdwijnen klant-inkomsten en compenseren PayPal +Bij's binnen
    // uitgave-groepen (Twilio: -Af + +Bij = netto -0,48 = uitgave-groep, blijft).
    const groupTotals = new Map();
    for (const t of txs) {
      const name = String(t.counterparty_name || '').trim();
      if (!name) continue;
      groupTotals.set(name, (groupTotals.get(name) || 0) + (Number(t.amount_cents) || 0));
    }
    const cleanTxs = txs.filter(t => {
      const name = String(t.counterparty_name || '').trim();
      if (!name) return false;
      if (INTERNAL_NAMES.has(name)) return false;
      // Inkomst-groepen (Bas Express Checkout etc) skippen.
      if ((groupTotals.get(name) || 0) >= 0) return false;
      return true;
    });
    if (cleanTxs.length === 0) {
      return res.status(200).json({
        recurring: [], total_monthly_cents: 0,
        insights: { count_total: 0, count_monthly: 0, count_quarterly: 0, count_yearly: 0, count_possibly_unused: 0, count_possibly_duplicate: 0 },
        period: { from, to }, today: new Date().toISOString().slice(0, 10),
      });
    }

    // Stap 3: fetch categorisaties (alleen rule/manual — ai_suggest telt niet).
    // Zo herkennen we is_internal → excluden en category → tonen naast recurring.
    const idsArr = cleanTxs.map(t => t.id);
    const catByTxId = new Map();
    for (let i = 0; i < idsArr.length; i += 500) {
      const slice = idsArr.slice(i, i + 500);
      const { data } = await supabaseAdmin
        .from('transaction_categorizations')
        .select('camt_transaction_id, category_id, source')
        .in('camt_transaction_id', slice)
        .in('source', ['rule', 'manual']);
      for (const c of (data || [])) catByTxId.set(c.camt_transaction_id, c);
    }

    // Stap 4: fetch category-metadata (voor is_internal check + display).
    const { data: allCats } = await supabaseAdmin
      .from('expense_categories')
      .select('id, slug, label, color, is_internal');
    const catMetaById = new Map((allCats || []).map(c => [c.id, c]));

    // Stap 5: filter interne overboekingen (categorie is_internal=true).
    const nonInternalTxs = cleanTxs.filter(t => {
      const cat = catByTxId.get(t.id);
      if (!cat) return true;
      const meta = catMetaById.get(cat.category_id);
      return !(meta && meta.is_internal === true);
    });

    // Stap 6: draai de detector.
    const today = new Date().toISOString().slice(0, 10);
    const todayDayNum = daysSinceEpoch(today);
    const result = detectRecurringAll(nonInternalTxs, {
      categoryByTxId:   catByTxId,
      categoryMetaById: catMetaById,
      todayDayNum,
    });

    console.log(`[expenses-recurring] tx_scanned=${cleanTxs.length} after_internal=${nonInternalTxs.length} recurring=${result.recurring.length} monthly_total_cents=${result.total_monthly_cents}`);

    return res.status(200).json({
      ...result,
      period: { from, to },
      today,
    });
  } catch (e) {
    console.error('[finance-expenses-recurring]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

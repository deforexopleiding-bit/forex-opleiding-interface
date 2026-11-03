// api/subscription-soort.js
//
// SOORT ABONNEMENT — lezen en wijzigen (mentorcommissie, PR 2).
//
// GET  ?customer_id=<uuid>
//   → { ok, abonnementen: [{ id, deal_id, description, start_date, term_count,
//        status, soort, aanpassing_type, sale_deal_id, voorstel }], sales: [...] }
//   voorstel = backfillvoorstel (stelSoortVoor): zeker of "te controleren".
// POST { subscription_id, soort, aanpassing_type?, sale_deal_id?, reden? }
//   → { ok, abonnement }
//
// Wijzigen mag ook als er al facturen zijn: de soort verandert geen bedrag,
// alleen bij welke sale de betalingen voor de commissie tellen. Al
// vrijgegeven commissie blijft staan (forward-only); de factuurmotor rekent
// bij de volgende run met de nieuwe koppeling.
// Recht: sales.deal.edit (zelfde als abonnement bewerken). Audit in audit_log.
// 503 zolang docs/sql-migrations/2026-11-03-subscriptions-soort.sql niet gedraaid is.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  valideerSoort, stelSoortVoor, soortKolomOntbreekt, SOORT_KOLOMMEN,
} from './_lib/subscription-soort.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEAL_KOLOMMEN = 'id, customer_id, tl_quotation_status, tl_quotation_accepted_at, total_amount, created_at, archived_at, quote_reference';

function getClientIp(req) {
  const xf = req.headers?.['x-forwarded-for'];
  return (typeof xf === 'string' && xf.split(',')[0].trim()) || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET of POST' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.edit)' });
  }

  try {
    if (req.method === 'GET') {
      const customerId = String(req.query?.customer_id || '');
      if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });
      const { data: deals, error: dErr } = await supabaseAdmin.from('deals').select(DEAL_KOLOMMEN).eq('customer_id', customerId);
      if (dErr) throw new Error('deals: ' + dErr.message);
      const ids = (deals || []).map((d) => d.id);
      let subs = [];
      let migratie = true;
      if (ids.length) {
        const basis = 'id, deal_id, description, start_date, end_date, term_count, amount, status, postponed_months, original_start_date, teamleader_subscription_id';
        let { data, error } = await supabaseAdmin.from('subscriptions').select(`${basis}, ${SOORT_KOLOMMEN}`).in('deal_id', ids);
        if (error && soortKolomOntbreekt(error)) {
          migratie = false;
          ({ data, error } = await supabaseAdmin.from('subscriptions').select(basis).in('deal_id', ids));
        }
        if (error) throw new Error('subscriptions: ' + error.message);
        subs = data || [];
      }
      const abonnementen = subs
        .sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || '')))
        .map((s) => ({ ...s, soort: s.soort || null, voorstel: s.soort ? null : stelSoortVoor(s, { deals: deals || [] }) }));
      const sales = (deals || []).filter((d) => String(d.tl_quotation_status || '').toLowerCase() !== 'no_quotation')
        .map((d) => ({ id: d.id, getekend_op: d.tl_quotation_accepted_at || null, status: d.tl_quotation_status, bedrag: d.total_amount, referentie: d.quote_reference || null, gearchiveerd: !!d.archived_at }));
      return res.status(200).json({ ok: true, migratie, abonnementen, sales });
    }

    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const subId = String(b.subscription_id || '');
    if (!UUID_RE.test(subId)) return res.status(400).json({ error: 'subscription_id (uuid) verplicht' });
    if (b.sale_deal_id && !UUID_RE.test(String(b.sale_deal_id))) return res.status(400).json({ error: 'sale_deal_id ongeldig' });

    let { data: sub, error: sErr } = await supabaseAdmin.from('subscriptions').select(`id, deal_id, ${SOORT_KOLOMMEN}`).eq('id', subId).maybeSingle();
    if (sErr && soortKolomOntbreekt(sErr)) {
      return res.status(503).json({ error: 'Migratie 2026-11-03-subscriptions-soort.sql is nog niet gedraaid.', code: 'MIGRATIE_ONTBREEKT' });
    }
    if (sErr) throw new Error('subscription: ' + sErr.message);
    if (!sub) return res.status(404).json({ error: 'Abonnement niet gevonden' });
    const { data: eigen } = await supabaseAdmin.from('deals').select(DEAL_KOLOMMEN).eq('id', sub.deal_id).maybeSingle();
    const customerId = eigen?.customer_id || null;
    const { data: deals, error: dErr } = await supabaseAdmin.from('deals').select(DEAL_KOLOMMEN).eq('customer_id', customerId);
    if (dErr) throw new Error('deals: ' + dErr.message);

    const v = valideerSoort(b, { eigenDealId: sub.deal_id, customerId, dealsVanKlant: deals || [] });
    if (!v.ok) return res.status(400).json({ error: v.fout, code: 'SOORT_ONGELDIG' });
    const patch = {
      ...v.waarde,
      sale_deal_id: v.waarde.sale_deal_id || sub.deal_id,
      soort_bron: 'handmatig',
      soort_gezet_door: user.id,
      soort_gezet_op: new Date().toISOString(),
    };
    const { data: updated, error: uErr } = await supabaseAdmin.from('subscriptions').update(patch).eq('id', subId).select(`id, deal_id, ${SOORT_KOLOMMEN}`).maybeSingle();
    if (uErr) throw new Error('update: ' + uErr.message);

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id,
        action: 'subscription.soort_gezet',
        entity_type: 'subscription',
        entity_id: subId,
        before_json: { soort: sub.soort || null, aanpassing_type: sub.aanpassing_type || null, sale_deal_id: sub.sale_deal_id || null },
        after_json: patch,
        reason_text: b.reden ? String(b.reden).slice(0, 500) : 'Soort abonnement gezet (mentorcommissie)',
        ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[subscription-soort] audit:', e.message); }

    return res.status(200).json({ ok: true, abonnement: updated });
  } catch (e) {
    console.error('[subscription-soort]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

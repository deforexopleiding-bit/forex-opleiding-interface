// api/admin/tl-import-subscriptions.js
// POST → bulk-import van actieve TL-subscriptions + bijbehorende klanten.
// SUPER_ADMIN ONLY. Idempotent (skip op teamleader_subscription_id). Dry-run support.
//
// Body: { dry_run=true, department_id?, limit=100, skip_existing=true }
//
// Per TL-sub: contact ophalen (contacts.info) → customer upsert (op tl_contact_id) →
// ghost-deal (subscriptions.deal_id is NOT NULL) → subscription + line_items.
// Throttle 200ms/TL-call; 429 → exponential backoff (max 3x). 60s Vercel-limit:
// gebruik 'limit' om per run te begrenzen (checkpoint), draai meerdere runs.

import { verifyAdmin, supabaseAdmin } from '../supabase.js';
import { tlFetch, getActiveToken } from '../_lib/teamleader-token.js';
import { getClientIp } from '../_lib/audit-customer.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// TL-call met throttle + 429-backoff.
async function tlCall(path, body, attempt = 0) {
  await sleep(200);
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) { await sleep(2000 * Math.pow(2, attempt)); return tlCall(path, body, attempt + 1); }
  return r;
}

// Reverse tax-map: TL tax_rate_id → onze BTW% (uit env TEAMLEADER_TAX_RATE_ID_*).
function buildReverseTaxMap() {
  const map = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    let m = k.match(/^TEAMLEADER_TAX_RATE_ID_(\d+)(?:_[A-Z]+)?$/);
    if (m) { map[v] = Number(m[1]); continue; }
    if (/^TEAMLEADER_TAX_RATE_ID_(INTRA|OUTSIDE_EU)/.test(k)) map[v] = 0; // verlegd/vrijgesteld
  }
  return map;
}
function lineVat(li, taxMap) {
  const id = li.tax_rate?.id || li.tax_rate_id || null;
  if (id && taxMap[id] != null) return taxMap[id];
  if (li.tax && typeof li.tax.rate === 'number') return Math.round(li.tax.rate * 100);
  return 21;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin mag importeren' });

  const { dry_run = true, department_id = null, limit = 100, skip_existing = true } = req.body || {};
  const maxSubs = Math.min(Number(limit) || 100, 500);

  const tok = await getActiveToken();
  if (!tok) return res.status(400).json({ error: 'Geen actief Teamleader-token' });

  const taxMap = buildReverseTaxMap();
  const totals = { subs_processed: 0, subs_imported: 0, subs_skipped: 0, customers_imported: 0, customers_updated: 0, errors: 0 };
  const details = [];

  try {
    // Onze producten voor tl_product_id → product_id lookup.
    const { data: prods } = await supabaseAdmin.from('products').select('id, tl_product_id');
    const prodByTl = {}; for (const p of prods || []) if (p.tl_product_id) prodByTl[p.tl_product_id] = p.id;

    // 1. Paginate TL subscriptions.list (status=active).
    const tlSubs = [];
    for (let page = 1; tlSubs.length < maxSubs; page++) {
      const filter = { status: ['active'] };
      if (department_id) filter.department_id = department_id;
      const r = await tlCall('/subscriptions.list', { filter, page: { size: 100, number: page } });
      if (!r.ok) { const txt = await r.text().catch(() => ''); return res.status(502).json({ error: `TL subscriptions.list HTTP ${r.status}: ${txt.slice(0, 200)}`, totals }); }
      const data = await r.json();
      const batch = data.data || [];
      tlSubs.push(...batch);
      if (batch.length < 100) break; // laatste pagina
    }
    const work = tlSubs.slice(0, maxSubs);

    // 2. Per sub.
    for (const sub of work) {
      totals.subs_processed++;
      const detail = { tl_sub_id: sub.id, action: 'skipped', customer_action: 'exists', error: null };
      try {
        // a. Bestaat de sub al?
        const { data: existing } = await supabaseAdmin.from('subscriptions').select('id, imported_from_tl_at').eq('teamleader_subscription_id', sub.id).maybeSingle();
        if (existing) {
          if (skip_existing) { totals.subs_skipped++; detail.action = 'skipped'; details.push(detail); continue; }
          if (!dry_run) await supabaseAdmin.from('subscriptions').update({ imported_from_tl_at: new Date().toISOString() }).eq('id', existing.id);
          totals.subs_skipped++; detail.action = 'skipped'; detail.customer_action = 'exists'; details.push(detail); continue;
        }

        // b. Contact ophalen.
        const contactId = sub.invoicee?.customer?.id || sub.invoicee?.id || null;
        if (!contactId) { totals.errors++; detail.action = 'error'; detail.error = 'Geen invoicee-contact op sub'; details.push(detail); continue; }
        const cr = await tlCall('/contacts.info', { id: contactId });
        const cData = cr.ok ? (await cr.json()).data : null;
        const cName = cData ? `${cData.first_name || ''} ${cData.last_name || ''}`.trim() : '(onbekend)';
        detail.customer_name = cName;

        // c. Customer upsert (op tl_contact_id).
        let customerId = null;
        const { data: existCust } = await supabaseAdmin.from('customers').select('id, tl_contact_id').eq('tl_contact_id', contactId).maybeSingle();
        if (existCust) { customerId = existCust.id; detail.customer_action = 'exists'; }
        else if (cData) {
          const addr = (Array.isArray(cData.addresses) ? cData.addresses : []); const a = (addr.find(x => x.type === 'primary') || addr[0] || {}).address || {};
          const line1 = a.line_1 || ''; const mLine = line1.match(/^(.*?)\s+(\d+\s*[a-zA-Z]?)$/);
          const custPayload = {
            first_name: cData.first_name || null, last_name: cData.last_name || null,
            email: cData.emails?.[0]?.email || null, phone: cData.telephones?.[0]?.number || null,
            date_of_birth: cData.birthdate || null,
            address_street: mLine ? mLine[1].trim() : (line1 || null), address_number: mLine ? mLine[2].replace(/\s/g, '') : null,
            address_postal: a.postal_code || null, address_city: a.city || null,
            tl_contact_id: contactId, imported_from_tl_at: new Date().toISOString(), created_by_user_id: admin.user.id,
          };
          if (!dry_run) { const { data: nc, error: ncErr } = await supabaseAdmin.from('customers').insert(custPayload).select('id').single(); if (ncErr) throw new Error('customer insert: ' + ncErr.message); customerId = nc.id; }
          totals.customers_imported++; detail.customer_action = 'created';
        } else { totals.errors++; detail.action = 'error'; detail.error = 'contacts.info faalde'; details.push(detail); continue; }

        // d/e. Line items uit grouped_lines + ghost-deal + subscription.
        const liRows = [];
        for (const g of (sub.grouped_lines || [])) for (const li of (g.line_items || [])) {
          liRows.push({ product_id: (li.product?.id && prodByTl[li.product.id]) || null, description: li.description || 'Regel', amount: Number(li.unit_price?.amount) || 0, vat_percentage: lineVat(li, taxMap) });
        }
        const totalExcl = liRows.reduce((s, l) => s + l.amount, 0);
        if (!dry_run) {
          const { data: gd, error: gdErr } = await supabaseAdmin.from('deals').insert({
            customer_id: customerId, sales_user_id: admin.user.id, source: 'tl_import',
            tl_quotation_status: 'no_quotation', tl_department_id: sub.department_id || department_id || null,
            status: 'active', start_date: sub.starts_on || new Date().toISOString().slice(0, 10), total_amount: Math.round(totalExcl * 100) / 100,
          }).select('id').single();
          if (gdErr) throw new Error('ghost-deal insert: ' + gdErr.message);
          const { error: subErr } = await supabaseAdmin.from('subscriptions').insert({
            deal_id: gd.id, teamleader_subscription_id: sub.id, description: sub.title || 'Geïmporteerd uit TL',
            status: 'active', start_date: sub.starts_on || null, end_date: sub.ends_on || null,
            term_count: 1, amount: Math.round(totalExcl * 100) / 100, vat_percentage: liRows[0]?.vat_percentage ?? 21,
            line_items: liRows, tl_department_id: sub.department_id || department_id || null,
            imported_from_tl_at: new Date().toISOString(),
          });
          if (subErr) throw new Error('subscription insert: ' + subErr.message);
        }
        totals.subs_imported++; detail.action = 'imported';
        if (detail.customer_action === 'exists' && existCust && !existCust.tl_contact_id) totals.customers_updated++;
        details.push(detail);
      } catch (e) { totals.errors++; detail.action = 'error'; detail.error = e.message; details.push(detail); }
    }

    // 3. Audit (ook dry-run, voor geschiedenis).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: admin.user.id, action: dry_run ? 'tl_import.dry_run' : 'tl_import.run', entity_type: 'subscription', entity_id: null,
        after_json: { totals, dry_run, department_id, limit: maxSubs }, reason_text: `TL-import (${dry_run ? 'dry-run' : 'live'}): ${totals.subs_imported} subs, ${totals.customers_imported} klanten, ${totals.errors} errors`, ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[tl-import] audit:', e.message); }

    return res.status(200).json({ dry_run, totals, details });
  } catch (e) {
    console.error('[tl-import]', e.message);
    return res.status(500).json({ error: e.message, totals, details });
  }
}

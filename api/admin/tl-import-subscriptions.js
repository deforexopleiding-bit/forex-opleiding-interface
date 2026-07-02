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
  console.log('[tl-import] taxMap built:', JSON.stringify(map));
  return map;
}
function lineTaxId(li) { return li.tax_rate?.id || li.tax_rate_id || (li.tax?.type === 'taxRate' ? li.tax.id : null) || null; }
function lineVat(li, taxMap) {
  const id = lineTaxId(li);
  const found = !!(id && taxMap[id] != null);
  let mapped;
  if (found) mapped = taxMap[id];
  else if (li.tax && typeof li.tax.rate === 'number') mapped = Math.round(li.tax.rate * 100);
  else mapped = 21;
  console.log('[tl-import] lineVat lookup', JSON.stringify({ taxId: id, foundIn: found, mapped: found ? mapped : 'FALLBACK_' + mapped }));
  return mapped;
}
// Bedrag EXCL BTW per regel (qty meegerekend), defensief over read/create-shapes.
function lineExclTotal(li, vat) {
  const up = li.unit_price;
  let unit = null;
  if (up && typeof up === 'object') unit = Number(up.amount);
  else if (up != null && up !== '') unit = Number(up);
  if (!Number.isFinite(unit)) unit = Number(li.total?.tax_exclusive?.amount ?? li.total?.tax_exclusive ?? li.total?.amount ?? li.amount);
  if (!Number.isFinite(unit)) unit = 0;
  const rate = (Number(vat) || 0) / 100;
  // unit_price.tax === 'including' → bedrag is incl → naar excl.
  if (up && typeof up === 'object' && up.tax === 'including' && rate > 0) unit = unit / (1 + rate);
  const qty = Number(li.quantity) || 1;
  return Math.round(unit * qty * 100) / 100;
}
// billing_cycle → maanden per termijn.
function cycleMonths(bc) {
  const p = bc?.periodicity; if (!p) return null;
  const period = Number(p.period) || 1;
  if (p.unit === 'month') return period;
  if (p.unit === 'year') return period * 12;
  if (p.unit === 'week') return period / 4.345;
  return period;
}
function billingLabel(bc) {
  const m = cycleMonths(bc); if (m == null) return null;
  const near = (x) => Math.abs(m - x) < 0.35;
  if (near(1)) return 'per_month'; if (near(2)) return 'per_2_months'; if (near(3)) return 'per_quarter';
  if (near(6)) return 'per_6_months'; if (near(12)) return 'per_year';
  return `per_${Math.round(m)}_months`;
}
// term_count uit duur (starts→ends) / cyclus. Open-ended (geen ends) → null.
function computeTermCount(starts, ends, bc) {
  if (!ends) return null;
  if (!starts || starts === ends) return 1;
  const d1 = new Date(starts), d2 = new Date(ends);
  const durMonths = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()) + (d2.getDate() - d1.getDate()) / 30;
  const cm = cycleMonths(bc) || 1;
  if (durMonths <= 0) return 1;
  return Math.max(1, Math.ceil(durMonths / cm));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin mag importeren' });

  // 3 TL-calls/sub (list-batch + subscriptions.info + contacts.info) à 200ms throttle
  // → ~60s bij ~80 subs. Default 80 (Vercel 60s-limit); idempotent → draai meerdere runs.
  const { dry_run = true, department_id = null, limit = 80, skip_existing = true } = req.body || {};
  const maxSubs = Math.min(Number(limit) || 80, 500);

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

        // b. Invoicee ophalen — TL invoicee kan een CONTACT of een COMPANY zijn.
        // Kies /contacts.info of /companies.info op basis van customer.type.
        // Onbekend type → default naar 'contact' (backward-compat).
        const invoiceeId    = sub.invoicee?.customer?.id || sub.invoicee?.id || null;
        const invoiceeType  = String(sub.invoicee?.customer?.type || 'contact').toLowerCase() === 'company' ? 'company' : 'contact';
        detail.invoicee_type = invoiceeType;
        if (!invoiceeId) { totals.errors++; detail.action = 'error'; detail.error = 'Geen invoicee-id op sub'; details.push(detail); continue; }

        const infoPath = invoiceeType === 'company' ? '/companies.info' : '/contacts.info';
        const cr = await tlCall(infoPath, { id: invoiceeId });
        let cData = null;
        if (cr.ok) {
          try { cData = (await cr.json())?.data || null; }
          catch (_) { cData = null; }
        }
        if (!cData) {
          const bodyTxt = await cr.text().catch(() => '');
          let errMsg = `${invoiceeType}.info faalde (HTTP ${cr.status})`;
          if (cr.status === 404) errMsg += ' — niet gevonden in TL';
          else if (cr.status === 401 || cr.status === 403) errMsg += ' — geen TL-toegang';
          if (bodyTxt) errMsg += ` :: ${bodyTxt.slice(0, 160)}`;
          totals.errors++; detail.action = 'error'; detail.error = errMsg; details.push(detail); continue;
        }

        // c. Customer upsert. Voor contacts: match op tl_contact_id. Voor
        //    companies: match op tl_company_id (bestaan onbekend — probe via
        //    select; bij "column does not exist" krijgen we duidelijke error).
        const cName = invoiceeType === 'company'
          ? (cData.name || cData.company_name || '(onbekend bedrijf)')
          : `${cData.first_name || ''} ${cData.last_name || ''}`.trim() || '(onbekend contact)';
        detail.customer_name = cName;

        let customerId = null;
        let existCust  = null;
        if (invoiceeType === 'company') {
          const { data, error: probeErr } = await supabaseAdmin
            .from('customers').select('id, tl_company_id').eq('tl_company_id', invoiceeId).maybeSingle();
          if (probeErr) {
            const em = String(probeErr.message || '');
            if (/column .*tl_company_id/i.test(em) || probeErr.code === '42703') {
              totals.errors++; detail.action = 'error';
              detail.error = 'customers.tl_company_id kolom ontbreekt — company-invoicees niet ondersteund tot migratie';
              details.push(detail); continue;
            }
            throw new Error('customer lookup: ' + em);
          }
          existCust = data;
        } else {
          const { data } = await supabaseAdmin
            .from('customers').select('id, tl_contact_id').eq('tl_contact_id', invoiceeId).maybeSingle();
          existCust = data;
        }

        if (existCust) { customerId = existCust.id; detail.customer_action = 'exists'; }
        else {
          let custPayload;
          if (invoiceeType === 'company') {
            // Company-adres kan in address of primary_address zitten; wees defensief.
            const cAddr = cData.address || (Array.isArray(cData.addresses) ? (cData.addresses[0]?.address || cData.addresses[0]) : null) || {};
            custPayload = {
              is_company:      true,
              company_name:    cName,
              email:           cData.emails?.[0]?.email || null,
              phone:           cData.telephones?.[0]?.number || null,
              vat_number:      cData.vat_number || null,
              address_street:  cAddr.line_1 || null,
              address_postal:  cAddr.postal_code || null,
              address_city:    cAddr.city || null,
              tl_company_id:   invoiceeId,
              imported_from_tl_at: new Date().toISOString(),
              created_by_user_id:  admin.user.id,
            };
          } else {
            const addr = (Array.isArray(cData.addresses) ? cData.addresses : []); const a = (addr.find(x => x.type === 'primary') || addr[0] || {}).address || {};
            const line1 = a.line_1 || ''; const mLine = line1.match(/^(.*?)\s+(\d+\s*[a-zA-Z]?)$/);
            custPayload = {
              first_name: cData.first_name || null, last_name: cData.last_name || null,
              email: cData.emails?.[0]?.email || null, phone: cData.telephones?.[0]?.number || null,
              date_of_birth: cData.birthdate || null,
              address_street: mLine ? mLine[1].trim() : (line1 || null), address_number: mLine ? mLine[2].replace(/\s/g, '') : null,
              address_postal: a.postal_code || null, address_city: a.city || null,
              tl_contact_id: invoiceeId, imported_from_tl_at: new Date().toISOString(), created_by_user_id: admin.user.id,
            };
          }
          if (!dry_run) {
            const { data: nc, error: ncErr } = await supabaseAdmin.from('customers').insert(custPayload).select('id').single();
            if (ncErr) {
              // Kolom-mismatch (bv. is_company, company_name, vat_number, tl_company_id):
              // duidelijke melding in de detail-error i.p.v. stille crash.
              const em = String(ncErr.message || '');
              if (/column/i.test(em) || ncErr.code === '42703') {
                totals.errors++; detail.action = 'error'; detail.error = `customer insert (${invoiceeType}): kolom-mismatch → ${em}`;
                details.push(detail); continue;
              }
              throw new Error('customer insert: ' + em);
            }
            customerId = nc.id;
          }
          totals.customers_imported++; detail.customer_action = 'created';
        }

        // d/e. Line items zitten ALLEEN in subscriptions.info (list geeft lege
        // grouped_lines — standaard TL-pattern). Haal de volledige sub op.
        let full = sub;
        try { const ir = await tlCall('/subscriptions.info', { id: sub.id }); if (ir.ok) { const idata = await ir.json(); if (idata.data) full = idata.data; } else console.warn('[tl-import] subscriptions.info', ir.status, sub.id); }
        catch (e) { console.warn('[tl-import] subscriptions.info exception', sub.id, e.message); }
        const liRows = [];
        const taxLookups = [];
        for (const g of (full.grouped_lines || [])) for (const li of (g.line_items || [])) {
          const taxId = lineTaxId(li);
          const vat = lineVat(li, taxMap);
          taxLookups.push({ description: li.description || 'Regel', tax_id: taxId, found: !!(taxId && taxMap[taxId] != null), mapped: vat });
          liRows.push({ product_id: (li.product?.id && prodByTl[li.product.id]) || null, description: li.description || 'Regel', amount: lineExclTotal(li, vat), vat_percentage: vat });
        }
        const totalExcl = Math.round(liRows.reduce((s, l) => s + l.amount, 0) * 100) / 100;
        const termCount = computeTermCount(full.starts_on || sub.starts_on, full.ends_on || sub.ends_on, full.billing_cycle || sub.billing_cycle);
        const billing = billingLabel(full.billing_cycle || sub.billing_cycle);
        // Debug-info per sub (helpt verificatie zonder DB-schrijf bij dry-run).
        detail.debug = { total_excl: totalExcl, vats: liRows.map(l => l.vat_percentage), term_count: termCount, billing_cycle: billing, starts_on: full.starts_on || sub.starts_on, ends_on: full.ends_on || sub.ends_on, taxMap_size: Object.keys(taxMap).length, tax_lookups: taxLookups };
        // Eénmalig de ruwe grouped_lines-structuur loggen (verificatie veldnamen).
        if (!globalThis.__tlImportLoggedShape) { globalThis.__tlImportLoggedShape = true; detail.debug.raw_grouped_lines = full.grouped_lines; console.log('[tl-import] sample grouped_lines', JSON.stringify(full.grouped_lines)); }
        console.log('[tl-import] sub', sub.id, JSON.stringify({ ...detail.debug, raw_grouped_lines: undefined }));
        if (!dry_run) {
          const dept = full.department_id || sub.department_id || department_id || null;
          const starts = full.starts_on || sub.starts_on;
          const { data: gd, error: gdErr } = await supabaseAdmin.from('deals').insert({
            customer_id: customerId, sales_user_id: admin.user.id, source: 'tl_import',
            tl_quotation_status: 'no_quotation', tl_department_id: dept,
            status: 'active', start_date: starts || new Date().toISOString().slice(0, 10), total_amount: totalExcl,
          }).select('id').single();
          if (gdErr) throw new Error('ghost-deal insert: ' + gdErr.message);
          const { error: subErr } = await supabaseAdmin.from('subscriptions').insert({
            deal_id: gd.id, teamleader_subscription_id: sub.id, description: full.title || sub.title || 'Geïmporteerd uit TL',
            status: 'active', start_date: starts || null, end_date: full.ends_on || sub.ends_on || null,
            term_count: termCount, amount: totalExcl, vat_percentage: liRows[0]?.vat_percentage ?? 21,
            billing_cycle: billing, line_items: liRows, tl_department_id: dept,
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

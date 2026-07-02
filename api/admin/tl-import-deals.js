// api/admin/tl-import-deals.js
// POST → bulk-import van Teamleader deals + bijbehorende klanten in de lokale
// `deals`-tabel, zodat de sales-historie compleet is.
// SUPER_ADMIN ONLY. Idempotent (skip op tl_deal_id). Dry-run default.
//
// Body: { dry_run=true, department_id?, limit=60, skip_existing=true }
//
// Per TL-deal:
//   1. /deals.list (paginate) → basis-lijst
//   2. /deals.info per deal → status, value, customer, quotation-refs, lines
//   3. Invoicee/customer resolve (contact/company) → customer upsert
//      (zelfde patroon als tl-import-subscriptions: hergebruikt tl_contact_id
//      en tl_company_id met defensieve kolom-check).
//   4. Optioneel /quotations.info voor de grouped_lines als de deal er 1 heeft
//      en /deals.info zelf geen bruikbare grouped_lines gaf.
//   5. Upsert in `deals` (skip op tl_deal_id) + insert `deal_line_items`
//      (product_id=NULL, gedenormaliseerd product_name/unit_price/qty/vat).
//
// STATUS-MAPPING (TL deal-status.value → tl_quotation_status):
//   'won'  → 'accepted' (+ tl_quotation_accepted_at)
//   'lost' → 'declined'
//   'open' + heeft quotation → 'sent'
//   anders → 'no_quotation'
//
// sales_user_id = importerende super_admin (bewust; bonus loopt via events).
//
// Alleen TL-reads (deals.list/info, contacts/companies.info, quotations.info).
// Geen TL-write. Throttle 200ms/TL-call; 429 → exponential backoff (max 3x).
// 60s Vercel-limit → gebruik `limit` per run; deals kosten 2-3 TL-calls per
// stuk (list-batch + info + optionele quotation.info) → default 60 subs/run.

import { verifyAdmin, supabaseAdmin } from '../supabase.js';
import { tlFetch, getActiveToken } from '../_lib/teamleader-token.js';
import { getClientIp } from '../_lib/audit-customer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const m = k.match(/^TEAMLEADER_TAX_RATE_ID_(\d+)(?:_[A-Z]+)?$/);
    if (m) { map[v] = Number(m[1]); continue; }
    if (/^TEAMLEADER_TAX_RATE_ID_(INTRA|OUTSIDE_EU)/.test(k)) map[v] = 0;
  }
  return map;
}
function lineTaxId(li) { return li.tax_rate?.id || li.tax_rate_id || (li.tax?.type === 'taxRate' ? li.tax.id : null) || null; }
function lineVat(li, taxMap) {
  const id = lineTaxId(li);
  if (id && taxMap[id] != null) return taxMap[id];
  if (li.tax && typeof li.tax.rate === 'number') return Math.round(li.tax.rate * 100);
  return 21;
}
function lineUnitExcl(li, vat) {
  const up = li.unit_price;
  let unit = null;
  if (up && typeof up === 'object') unit = Number(up.amount);
  else if (up != null && up !== '') unit = Number(up);
  if (!Number.isFinite(unit)) unit = Number(li.total?.tax_exclusive?.amount ?? li.total?.tax_exclusive ?? li.total?.amount ?? li.amount);
  if (!Number.isFinite(unit)) unit = 0;
  const rate = (Number(vat) || 0) / 100;
  if (up && typeof up === 'object' && up.tax === 'including' && rate > 0) unit = unit / (1 + rate);
  return Math.round(unit * 100) / 100;
}

// TL-invoicee/customer op de deal → { id, type }. Defensief over shape.
function resolveDealInvoicee(deal) {
  // Meest gangbaar: deal.customer = { type:'contact'|'company', id }
  // Ook mogelijk: deal.lead?.customer of deal.invoicee?.customer.
  const cand = deal.customer || deal.lead?.customer || deal.invoicee?.customer || deal.invoicee || null;
  if (!cand || !cand.id) return { id: null, type: null };
  const type = String(cand.type || 'contact').toLowerCase() === 'company' ? 'company' : 'contact';
  return { id: cand.id, type };
}

// TL deal-status.value ('won'|'lost'|'open') → onze tl_quotation_status.
function mapDealStatus(deal) {
  const raw = String(deal.status?.value || deal.status || '').toLowerCase();
  const hasQuot = !!(deal.quotations && deal.quotations.length) || !!deal.quotation?.id;
  if (raw === 'won') return { tl: 'accepted', hasQuot };
  if (raw === 'lost') return { tl: 'declined', hasQuot };
  return { tl: hasQuot ? 'sent' : 'no_quotation', hasQuot };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin mag importeren' });

  const { dry_run = true, department_id = null, limit = 60, skip_existing = true } = req.body || {};
  const maxDeals = Math.min(Number(limit) || 60, 500);

  const tok = await getActiveToken();
  if (!tok) return res.status(400).json({ error: 'Geen actief Teamleader-token' });

  const taxMap = buildReverseTaxMap();
  const totals = {
    deals_processed: 0, deals_imported: 0, deals_skipped: 0,
    customers_imported: 0, line_items_imported: 0, errors: 0,
  };
  const details = [];

  try {
    // 1. Paginate TL deals.list.
    const tlDeals = [];
    for (let page = 1; tlDeals.length < maxDeals; page++) {
      const filter = {};
      if (department_id) filter.department_id = department_id;
      const r = await tlCall('/deals.list', { filter, page: { size: 100, number: page } });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return res.status(502).json({ error: `TL deals.list HTTP ${r.status}: ${txt.slice(0, 200)}`, totals });
      }
      const data = await r.json();
      const batch = data.data || [];
      tlDeals.push(...batch);
      if (batch.length < 100) break;
    }
    const work = tlDeals.slice(0, maxDeals);

    // 2. Per deal.
    for (const stub of work) {
      totals.deals_processed++;
      const detail = { tl_deal_id: stub.id, action: 'skipped', customer_action: 'exists', error: null };
      try {
        // a. Idempotency op tl_deal_id.
        const { data: existing } = await supabaseAdmin
          .from('deals').select('id, tl_deal_id').eq('tl_deal_id', stub.id).maybeSingle();
        if (existing && skip_existing) {
          totals.deals_skipped++; detail.action = 'skipped'; detail.reason = 'bestaat al';
          details.push(detail); continue;
        }

        // b. /deals.info voor volledige data.
        const ir = await tlCall('/deals.info', { id: stub.id });
        if (!ir.ok) {
          const bodyTxt = await ir.text().catch(() => '');
          let err = `deals.info faalde (HTTP ${ir.status})`;
          if (ir.status === 404) err += ' — niet gevonden in TL';
          else if (ir.status === 401 || ir.status === 403) err += ' — geen TL-toegang';
          if (bodyTxt) err += ` :: ${bodyTxt.slice(0, 160)}`;
          totals.errors++; detail.action = 'error'; detail.error = err; details.push(detail); continue;
        }
        const deal = (await ir.json())?.data || stub;

        // c. Invoicee-resolve → customer upsert.
        const { id: invoiceeId, type: invoiceeType } = resolveDealInvoicee(deal);
        detail.invoicee_type = invoiceeType;
        if (!invoiceeId) {
          totals.errors++; detail.action = 'error'; detail.error = 'Geen customer op deal';
          details.push(detail); continue;
        }
        const infoPath = invoiceeType === 'company' ? '/companies.info' : '/contacts.info';
        const cr = await tlCall(infoPath, { id: invoiceeId });
        let cData = null;
        if (cr.ok) { try { cData = (await cr.json())?.data || null; } catch (_) { cData = null; } }
        if (!cData) {
          const bodyTxt = await cr.text().catch(() => '');
          let err = `${invoiceeType}.info faalde (HTTP ${cr.status})`;
          if (cr.status === 404) err += ' — niet gevonden in TL';
          else if (cr.status === 401 || cr.status === 403) err += ' — geen TL-toegang';
          if (bodyTxt) err += ` :: ${bodyTxt.slice(0, 160)}`;
          totals.errors++; detail.action = 'error'; detail.error = err; details.push(detail); continue;
        }

        const cName = invoiceeType === 'company'
          ? (cData.name || cData.company_name || '(onbekend bedrijf)')
          : `${cData.first_name || ''} ${cData.last_name || ''}`.trim() || '(onbekend contact)';
        detail.customer_name = cName;

        // Customer lookup + insert (identieke shape als tl-import-subscriptions).
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
            const addr = (Array.isArray(cData.addresses) ? cData.addresses : []);
            const a = (addr.find((x) => x.type === 'primary') || addr[0] || {}).address || {};
            const line1 = a.line_1 || ''; const mLine = line1.match(/^(.*?)\s+(\d+\s*[a-zA-Z]?)$/);
            custPayload = {
              first_name: cData.first_name || null, last_name: cData.last_name || null,
              email: cData.emails?.[0]?.email || null, phone: cData.telephones?.[0]?.number || null,
              date_of_birth: cData.birthdate || null,
              address_street: mLine ? mLine[1].trim() : (line1 || null),
              address_number: mLine ? mLine[2].replace(/\s/g, '') : null,
              address_postal: a.postal_code || null, address_city: a.city || null,
              tl_contact_id: invoiceeId,
              imported_from_tl_at: new Date().toISOString(),
              created_by_user_id: admin.user.id,
            };
          }
          if (!dry_run) {
            const { data: nc, error: ncErr } = await supabaseAdmin.from('customers').insert(custPayload).select('id').single();
            if (ncErr) {
              const em = String(ncErr.message || '');
              if (/column/i.test(em) || ncErr.code === '42703') {
                totals.errors++; detail.action = 'error';
                detail.error = `customer insert (${invoiceeType}): kolom-mismatch → ${em}`;
                details.push(detail); continue;
              }
              throw new Error('customer insert: ' + em);
            }
            customerId = nc.id;
          }
          totals.customers_imported++; detail.customer_action = 'created';
        }

        // d. Status-mapping + line items.
        const { tl: tlQuotationStatus, hasQuot } = mapDealStatus(deal);
        const tlQuotationId = deal.quotations?.[0]?.id || deal.quotation?.id || null;

        // Line items: eerst deal.grouped_lines proberen; fallback naar
        // /quotations.info als de deal wel een quotation-id heeft.
        let liRows = [];
        const collectLines = (groups) => {
          const rows = [];
          for (const g of (groups || [])) {
            for (const li of (g.line_items || [])) {
              const vat  = lineVat(li, taxMap);
              const unit = lineUnitExcl(li, vat);
              rows.push({
                product_id:         null,   // catalogus is leeg — gedenormaliseerd
                product_name:       li.product?.name || li.description || 'Regel',
                quantity:           Number(li.quantity) || 1,
                unit_price:         unit,
                vat_percentage:     vat,
                price_includes_vat: false,
                position:           rows.length,
              });
            }
          }
          return rows;
        };
        liRows = collectLines(deal.grouped_lines);
        if (liRows.length === 0 && tlQuotationId) {
          try {
            const qr = await tlCall('/quotations.info', { id: tlQuotationId });
            if (qr.ok) {
              const qData = (await qr.json())?.data || null;
              liRows = collectLines(qData?.grouped_lines);
            } else {
              detail.reason = `quotations.info HTTP ${qr.status}`;
            }
          } catch (e) {
            detail.reason = `quotations.info exception: ${e?.message || e}`;
          }
        }

        // e. total_amount: hergebruik deal.estimated_value/value indien aanwezig,
        //    anders som van line items excl BTW.
        const dealVal = deal.estimated_value?.amount ?? deal.value?.amount ?? null;
        const linesSum = Math.round(liRows.reduce((s, l) => s + Number(l.unit_price) * Number(l.quantity), 0) * 100) / 100;
        const totalAmount = Number.isFinite(Number(dealVal)) && Number(dealVal) > 0 ? Math.round(Number(dealVal) * 100) / 100 : linesSum;

        const acceptedAt = tlQuotationStatus === 'accepted'
          ? (deal.closed_at || deal.status?.updated_at || deal.updated_at || null) : null;

        detail.debug = {
          tl_deal_status: deal.status?.value || null,
          tl_quotation_id: tlQuotationId,
          line_items: liRows.length,
          total_amount: totalAmount,
        };

        if (!dry_run) {
          // f. Deal upsert. Als 'ie al bestond (skip_existing=false), refresh
          //    de kernvelden en re-vervang de line items.
          const dealPayload = {
            customer_id:                 customerId,
            sales_user_id:               admin.user.id,
            source:                      'tl_import',
            tl_deal_id:                  stub.id,
            tl_quotation_id:             tlQuotationId,
            tl_quotation_status:         tlQuotationStatus,
            tl_quotation_accepted_at:    acceptedAt,
            tl_quotation_signed_at:      acceptedAt,
            tl_department_id:            deal.department?.id || department_id || null,
            quote_reference:             deal.reference || deal.quotation_reference || null,
            status:                      'active',
            start_date:                  (deal.created_at || new Date().toISOString()).slice(0, 10),
            total_amount:                totalAmount,
          };
          let dealRowId = existing?.id || null;
          if (existing) {
            const { error: upErr } = await supabaseAdmin.from('deals').update(dealPayload).eq('id', existing.id);
            if (upErr) throw new Error('deal update: ' + upErr.message);
          } else {
            const { data: nd, error: ndErr } = await supabaseAdmin.from('deals').insert(dealPayload).select('id').single();
            if (ndErr) {
              const em = String(ndErr.message || '');
              if (/column/i.test(em) || ndErr.code === '42703') {
                totals.errors++; detail.action = 'error';
                detail.error = `deal insert: kolom-mismatch → ${em}`;
                details.push(detail); continue;
              }
              throw new Error('deal insert: ' + em);
            }
            dealRowId = nd.id;
          }

          // g. Line items: wipe + insert (idempotent per deal).
          if (dealRowId) {
            await supabaseAdmin.from('deal_line_items').delete().eq('deal_id', dealRowId);
            if (liRows.length) {
              const rows = liRows.map((l) => ({ ...l, deal_id: dealRowId }));
              const { error: liErr } = await supabaseAdmin.from('deal_line_items').insert(rows);
              if (liErr) throw new Error('deal_line_items insert: ' + liErr.message);
              totals.line_items_imported += liRows.length;
            }
          }
        } else {
          // Dry-run: tel line items voor rapport.
          totals.line_items_imported += liRows.length;
        }

        totals.deals_imported++;
        detail.action = 'imported';
        details.push(detail);
      } catch (e) {
        totals.errors++; detail.action = 'error'; detail.error = e?.message || String(e);
        details.push(detail);
      }
    }

    // 3. Audit.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: admin.user.id,
        action: dry_run ? 'tl_import_deals.dry_run' : 'tl_import_deals.run',
        entity_type: 'deal', entity_id: null,
        after_json: { totals, dry_run, department_id, limit: maxDeals },
        reason_text: `TL-deals-import (${dry_run ? 'dry-run' : 'live'}): ${totals.deals_imported} deals, ${totals.customers_imported} klanten, ${totals.line_items_imported} regels, ${totals.errors} errors`,
        ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[tl-import-deals] audit:', e.message); }

    return res.status(200).json({ dry_run, totals, details });
  } catch (e) {
    console.error('[tl-import-deals]', e.message);
    return res.status(500).json({ error: e.message, totals, details });
  }
}

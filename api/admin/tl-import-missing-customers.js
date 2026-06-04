// api/admin/tl-import-missing-customers.js
// POST → maak klanten aan die WEL TL-facturen (≥ 2026-01-01) hebben maar nog niet
// in `customers` staan. Particulieren (TL contacts) én bedrijven (TL companies).
// SUPER_ADMIN ONLY. Idempotent (skip op bestaand tl_contact_id / tl_company_id).
//
// Body: { dry_run=true, limit=50, exclude?[] }
//   - dry_run : retourneer de aan-te-maken lijst + tellingen, schrijf NIETS.
//   - limit   : max nieuw aan te maken klanten per run (checkpoint; idempotent → herhaalbaar).
//   - exclude : extra TL-ids (contact/company) om over te slaan (test-contacts).
//
// Flow: scan invoices.list per department → verzamel unieke invoicee-refs
// {id,type} → filter de refs die nog GEEN customer hebben → per ontbrekende ref
// contacts.info/companies.info → customer-insert.
//
// Veld-mapping:
//   CONTACT  → first_name,last_name,email,phone,adres,date_of_birth,tl_contact_id,is_company=false
//   COMPANY  → company_name(name),vat_number,kvk_number(national_registration_number),
//              email,phone,adres,tl_company_id,is_company=true (first/last NULL)

import { verifyAdmin, supabaseAdmin } from '../supabase.js';
import { tlFetch, getActiveToken } from '../_lib/teamleader-token.js';
import { getClientIp } from '../_lib/audit-customer.js';

const SYNC_FROM = '2026-01-01';

const DEPARTMENTS = [
  '09d67371-6947-03f6-bd5e-410dd8636344', // Online
  '0da396bf-1074-0425-ac5c-fa1141b41cb1', // Fysiek
  '9adca043-0ebc-09da-a45e-f21798841cb2', // Retentie
];

// Test-contacts die NOOIT geïmporteerd mogen worden (uitbreidbaar via body.exclude).
const EXCLUDE_IDS = new Set([
  'bf046692-fffd-0d5f-8a74-560c03ed9d81', // Biemold Jeffrey (eigen contact)
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tlCall(path, body, attempt = 0) {
  await sleep(200);
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) { await sleep(2000 * Math.pow(2, attempt)); return tlCall(path, body, attempt + 1); }
  return r;
}

// TL adres-array → onze address_*-velden (line_1 → straat + huisnummer split).
function mapAddress(addresses) {
  const arr = Array.isArray(addresses) ? addresses : [];
  const a = (arr.find(x => x.type === 'primary') || arr[0] || {}).address || {};
  const line1 = a.line_1 || '';
  const m = line1.match(/^(.*?)\s+(\d+\s*[a-zA-Z]?)$/);
  return {
    address_street: m ? m[1].trim() : (line1 || null),
    address_number: m ? m[2].replace(/\s/g, '') : null,
    address_postal: a.postal_code || null,
    address_city: a.city || null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin mag importeren' });

  const body = req.body || {};
  const dry_run = body.dry_run !== false; // default true
  const maxCreate = Math.min(Number(body.limit) || 50, 500);
  const exclude = new Set(EXCLUDE_IDS);
  for (const id of (Array.isArray(body.exclude) ? body.exclude : [])) exclude.add(String(id));

  const tok = await getActiveToken();
  if (!tok) return res.status(400).json({ error: 'Geen actief Teamleader-token' });

  const totals = { invoices_scanned: 0, unique_refs: 0, already_present: 0, excluded: 0, to_create: 0, created: 0, errors: 0, remaining: 0 };
  const created = [];
  const to_create_list = [];

  try {
    // 1. Verzamel unieke invoicee-refs over alle facturen ≥ SYNC_FROM.
    const refs = new Map(); // key `${type}:${id}` → { id, type, name }
    for (const dept of DEPARTMENTS) {
      for (let page = 1; ; page++) {
        const r = await tlCall('/invoices.list', { filter: { department_id: dept, invoice_date_after: SYNC_FROM }, page: { size: 100, number: page }, sort: [{ field: 'invoice_date', order: 'desc' }] });
        if (!r.ok) { const txt = await r.text().catch(() => ''); console.error('[tl-import-missing] invoices.list HTTP', r.status, txt.slice(0, 200)); return res.status(502).json({ error: `TL invoices.list HTTP ${r.status}`, totals }); }
        const data = await r.json();
        const batch = data.data || [];
        for (const inv of batch) {
          totals.invoices_scanned++;
          const id = inv.invoicee?.customer?.id;
          const type = inv.invoicee?.customer?.type || 'contact';
          if (!id) continue;
          const key = `${type}:${id}`;
          if (!refs.has(key)) refs.set(key, { id, type, name: inv.invoicee?.name || null });
        }
        if (batch.length < 100) break;
      }
    }
    totals.unique_refs = refs.size;

    // 2. Filter refs zonder bestaande customer (idempotent) + exclude-lijst.
    const missing = [];
    for (const ref of refs.values()) {
      if (exclude.has(ref.id)) { totals.excluded++; continue; }
      const col = ref.type === 'company' ? 'tl_company_id' : 'tl_contact_id';
      const { data: existing } = await supabaseAdmin.from('customers').select('id').eq(col, ref.id).maybeSingle();
      if (existing) { totals.already_present++; continue; }
      missing.push(ref);
    }
    totals.to_create = missing.length;

    // 3. Per ontbrekende ref: TL-detail ophalen + customer aanmaken (cap op maxCreate).
    for (const ref of missing) {
      if (totals.created >= maxCreate || to_create_list.length >= maxCreate) { totals.remaining = missing.length - (totals.created + (dry_run ? to_create_list.length : 0)); break; }
      try {
        let payload = null, planLabel = ref.name || '(onbekend)';
        if (ref.type === 'company') {
          const cr = await tlCall('/companies.info', { id: ref.id });
          if (!cr.ok) { totals.errors++; if (totals.errors <= 5) console.error('[tl-import-missing] companies.info', cr.status, ref.id); continue; }
          const c = (await cr.json()).data || {};
          payload = {
            is_company: true,
            company_name: c.name || ref.name || 'Onbekend bedrijf',
            vat_number: c.vat_number || null,
            kvk_number: c.national_registration_number || c.registration_number || null,
            email: c.emails?.[0]?.email || null,
            phone: c.telephones?.[0]?.number || null,
            ...mapAddress(c.addresses),
            tl_company_id: ref.id,
            imported_from_tl_at: new Date().toISOString(),
            created_by_user_id: admin.user.id,
          };
          planLabel = payload.company_name;
        } else {
          const cr = await tlCall('/contacts.info', { id: ref.id });
          if (!cr.ok) { totals.errors++; if (totals.errors <= 5) console.error('[tl-import-missing] contacts.info', cr.status, ref.id); continue; }
          const c = (await cr.json()).data || {};
          payload = {
            is_company: false,
            first_name: c.first_name || null,
            last_name: c.last_name || null,
            email: c.emails?.[0]?.email || null,
            phone: c.telephones?.[0]?.number || null,
            date_of_birth: c.birthdate ? String(c.birthdate).slice(0, 10) : null,
            ...mapAddress(c.addresses),
            tl_contact_id: ref.id,
            imported_from_tl_at: new Date().toISOString(),
            created_by_user_id: admin.user.id,
          };
          planLabel = `${c.first_name || ''} ${c.last_name || ''}`.trim() || ref.name || '(onbekend)';
        }

        if (dry_run) {
          to_create_list.push({ name: planLabel, type: ref.type, tl_id: ref.id, source: ref.type === 'company' ? 'companies.info' : 'contacts.info', kvk: payload.kvk_number || null, vat: payload.vat_number || null, email: payload.email || null });
        } else {
          const { error } = await supabaseAdmin.from('customers').insert(payload);
          if (error) { totals.errors++; if (totals.errors <= 5) console.error('[tl-import-missing] insert', ref.id, error.message); continue; }
          totals.created++;
          created.push({ name: planLabel, type: ref.type, tl_id: ref.id });
        }
      } catch (e) {
        totals.errors++;
        if (totals.errors <= 5) console.error('[tl-import-missing] ref', ref.id, e.message);
      }
    }
    if (!totals.remaining) totals.remaining = Math.max(0, missing.length - (dry_run ? to_create_list.length : totals.created));

    // Audit (ook dry-run).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: admin.user.id,
        action: dry_run ? 'tl_import_missing_customers.dry_run' : 'tl_import_missing_customers.run',
        entity_type: 'customer', entity_id: null,
        after_json: { totals, dry_run },
        reason_text: `TL-import ontbrekende klanten (${dry_run ? 'dry-run' : 'live'}): ${dry_run ? to_create_list.length : totals.created} klanten, ${totals.already_present} bestonden al, ${totals.excluded} uitgesloten, ${totals.errors} errors`,
        ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[tl-import-missing] audit:', e.message); }

    return res.status(200).json({ dry_run, totals, to_create: dry_run ? to_create_list : undefined, created: dry_run ? undefined : created });
  } catch (e) {
    console.error('[tl-import-missing]', e.message);
    return res.status(500).json({ error: e.message, totals });
  }
}

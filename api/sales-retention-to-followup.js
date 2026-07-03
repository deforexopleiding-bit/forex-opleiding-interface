// api/sales-retention-to-followup.js
//
// POST { customer_id, end_date?, last_sub_status? } → maak of vind een
// open lead-rij in `follow_up_leads` met source='retention'. Bedoeld
// voor sales om vanuit de Retentie-tab een klant snel als lead te zetten
// zonder de bestaande follow-up/GHL-flow te raken.
//
// Response 200: { ok:true, lead_id, already: false }
// Response 200: { ok:true, lead_id, already: true }   ← lead bestond al
// Response 400: customer_id ontbreekt/ongeldig
// Response 401/403: auth / permission
// Response 404: klant niet gevonden
// Response 501: follow_up_leads-tabel ontbreekt (migratie nodig)
// Response 500: DB-fout
//
// Permission: sales.tab.retentie OF sales.customer.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (sales.tab.retentie of sales.customer.view)' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' ? body.customer_id.trim() : '';
  if (!customerId || !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  }
  // Optionele context vanuit de retentie-rij — puur voor traceability in
  // source_ref. Geen validatie-blokkade als ze ontbreken.
  const ctx = {};
  if (typeof body.end_date === 'string' && body.end_date.trim()) ctx.end_date = body.end_date.trim();
  if (typeof body.last_sub_status === 'string' && body.last_sub_status.trim()) ctx.last_sub_status = body.last_sub_status.trim();

  try {
    // 1) Laad klant voor naam / email / phone.
    const { data: cust, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, is_company, company_name, first_name, last_name, email, phone')
      .eq('id', customerId)
      .maybeSingle();
    if (cErr) throw new Error('customer fetch: ' + cErr.message);
    if (!cust) return res.status(404).json({ error: 'Klant niet gevonden' });

    const leadName = customerDisplayName(cust, null);
    const insertRow = {
      customer_id        : customerId,
      source             : 'retention',
      lead_name          : leadName,
      lead_email         : cust.email || null,
      lead_phone         : cust.phone || null,
      lead_status        : 'nieuw',
      source_ref         : Object.keys(ctx).length ? ctx : null,
      created_by_user_id : user.id,
    };

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('follow_up_leads')
      .insert(insertRow)
      .select('id')
      .maybeSingle();

    if (!insErr && inserted?.id) {
      return res.status(200).json({ ok: true, lead_id: inserted.id, already: false });
    }

    // 42P01 = tabel bestaat niet → migratie nodig.
    if (insErr?.code === '42P01') {
      return res.status(501).json({
        error: 'Tabel follow_up_leads ontbreekt — migratie vereist',
        code : 'MIGRATION_REQUIRED',
      });
    }

    // 23505 = unique-index botsing → er is al een open lead voor deze
    // (customer_id, source). Zoek 'm op en return 'already:true' zodat de
    // UI het als "al gedaan" kan tonen i.p.v. als error.
    if (insErr?.code === '23505') {
      const { data: existing, error: findErr } = await supabaseAdmin
        .from('follow_up_leads')
        .select('id, lead_status, updated_at, created_at')
        .eq('customer_id', customerId)
        .eq('source', 'retention')
        .not('lead_status', 'in', '(verlengd,verloren)')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (findErr) {
        console.error('[sales-retention-to-followup] existing lookup:', findErr.message);
        return res.status(200).json({ ok: true, lead_id: null, already: true });
      }
      return res.status(200).json({
        ok: true, already: true,
        lead_id    : existing?.id || null,
        lead_status: existing?.lead_status || null,
      });
    }

    console.error('[sales-retention-to-followup] insert:', insErr?.message || insErr);
    return res.status(500).json({ error: insErr?.message || 'Insert mislukt' });
  } catch (e) {
    console.error('[sales-retention-to-followup]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

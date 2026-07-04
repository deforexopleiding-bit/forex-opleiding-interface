// api/follow-up-oude-retenties.js
//
// Achterstand-tab voor Sales-cockpit. Toont alle klanten waarvan het
// LAATSTE abonnement AL is afgelopen (maxEnd < vandaag) EN >= 2026-01-01
// (de bovenkant van de retentie-set). Klanten met een nog lopend of
// binnenkort-aflopend abo horen NIET hier — die zitten in de reguliere
// werklijst via sales-retention-to-followup.
//
// GET  ?reden=all|nieuw|opgepakt|afgehandeld (default all)
//      Returnt { items:[{customer_id, name, email, phone, end_date,
//                        lead_id, pickup_status, entity?, mentor_name?}...],
//                counts:{ totaal, nieuw, opgepakt, afgehandeld } }
//      Sortering: end_date DESC (recentst afgelopen eerst).
//
// POST { action:'pickup', customer_id, end_date?, last_sub_status? }
//      → maakt/hergebruikt follow_up_leads-rij (source='retention') met
//        terugbel_datum=now() zodat de lead direct in de werklijst
//        oppakbaar is. Idempotent bij 23505 → returnt bestaande lead.
//        Response: { ok:true, lead_id, already:boolean }
//
// Permissie: sales.tab.retentie OF sales.customer.view.
// Fail-soft: 42P01/42703 → lege lijst met code MIGRATION_REQUIRED.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { chunkedIn, getRetentionGroups, RETENTION_WINDOW_FROM } from './_lib/retention-groups.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLOSED_LEAD_STATUSES = new Set(['verlengd', 'verloren']);

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET')  return handleGet(req, res);
  if (req.method === 'POST') return handlePickup(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── GET: achterstand + status per klant ──────────────────────────────

async function handleGet(req, res) {
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const rawFilter = String(req.query.reden || 'all').trim().toLowerCase();
  const filter = ['all', 'nieuw', 'opgepakt', 'afgehandeld'].includes(rawFilter) ? rawFilter : 'all';
  const ownedByMe = req.query?.owned_by_me === 'true';

  try {
    const { byCust } = await getRetentionGroups({
      ownedByMe,
      ownerUserId: user.id,
    });
    const today = todayIso();

    // FILTER: alleen achterstand — maxEnd < today && maxEnd >= 2026-01-01.
    // Klanten met dekking voorbij de horizon (retained) vallen af.
    const groups = Object.values(byCust).filter((g) =>
      !g.hasActiveCoverageBeyondHorizon &&
      g.maxEnd && g.maxEnd >= RETENTION_WINDOW_FROM && g.maxEnd < today
    );

    if (!groups.length) {
      return res.status(200).json({
        items : [],
        counts: { totaal: 0, nieuw: 0, opgepakt: 0, afgehandeld: 0 },
      });
    }

    // Klantgegevens.
    const custIds = [...new Set(groups.map((g) => g.customer_id))];
    const custById = {};
    try {
      const rows = await chunkedIn(
        'customers', 'id', custIds,
        'id, is_company, company_name, first_name, last_name, email, phone, mentor_user_id',
      );
      for (const c of rows) custById[c.id] = c;
    } catch (e) {
      console.warn('[oude-retenties] customers:', e?.message || e);
    }

    // Bestaande retention-leads per klant. LIMIT 2000 dekt de achterstand.
    let leadByCust = {};
    try {
      const rows = await chunkedIn(
        'follow_up_leads', 'customer_id', custIds,
        'id, customer_id, lead_status, terugbel_datum, created_at, source',
        (q) => q.eq('source', 'retention').order('created_at', { ascending: false }),
      );
      // Meest recente per klant.
      for (const r of rows) {
        if (!leadByCust[r.customer_id]) leadByCust[r.customer_id] = r;
      }
    } catch (e) {
      if (/42P01/i.test(e?.message || '')) {
        return res.status(200).json({
          code : 'MIGRATION_REQUIRED',
          items: [],
          counts: { totaal: 0, nieuw: 0, opgepakt: 0, afgehandeld: 0 },
        });
      }
      console.warn('[oude-retenties] leads:', e?.message || e);
    }

    // Mentor-naam voor context (fail-soft).
    const mentorIds = [...new Set(Object.values(custById).map((c) => c.mentor_user_id).filter(Boolean))];
    const mentorById = {};
    if (mentorIds.length) {
      try {
        const { data } = await supabaseAdmin
          .from('profiles')
          .select('id, full_name')
          .in('id', mentorIds);
        for (const p of (data || [])) mentorById[p.id] = p.full_name;
      } catch (_) {}
    }

    // Bouw items + pickup_status.
    const items = groups.map((g) => {
      const c = custById[g.customer_id] || {};
      const lead = leadByCust[g.customer_id] || null;
      const leadStatus = lead ? String(lead.lead_status || '').toLowerCase() : null;
      let pickup_status = 'nieuw';
      if (lead) {
        if (leadStatus && CLOSED_LEAD_STATUSES.has(leadStatus)) {
          pickup_status = 'afgehandeld';
        } else {
          pickup_status = 'opgepakt';
        }
      }
      return {
        customer_id  : g.customer_id,
        name         : customerDisplayName(c, '—'),
        email        : c.email  || null,
        phone        : c.phone  || null,
        end_date     : g.maxEnd,
        last_sub_status: g.lastStatus || null,
        lead_id      : lead?.id || null,
        lead_status  : leadStatus,
        pickup_status,
        mentor_name  : c.mentor_user_id ? (mentorById[c.mentor_user_id] || null) : null,
      };
    });

    // Sort: recentst-afgelopen eerst (end_date DESC).
    items.sort((a, b) => String(b.end_date || '').localeCompare(String(a.end_date || '')));

    const counts = {
      totaal      : items.length,
      nieuw       : items.filter((it) => it.pickup_status === 'nieuw').length,
      opgepakt    : items.filter((it) => it.pickup_status === 'opgepakt').length,
      afgehandeld : items.filter((it) => it.pickup_status === 'afgehandeld').length,
    };

    const filtered = filter === 'all'
      ? items
      : items.filter((it) => it.pickup_status === filter);

    return res.status(200).json({ items: filtered, counts });
  } catch (e) {
    console.error('[oude-retenties] GET fatal:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// ─── POST: pickup (maak/hergebruik lead + terugbel_datum=now) ─────────

async function handlePickup(req, res) {
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const action = String(body.action || '').trim().toLowerCase();
  const customerId = String(body.customer_id || '').trim();

  if (action !== 'pickup') return res.status(400).json({ error: 'Onbekende action.' });
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id (uuid) vereist' });

  const ctx = {};
  if (typeof body.end_date === 'string' && body.end_date.trim()) ctx.end_date = body.end_date.trim();
  if (typeof body.last_sub_status === 'string' && body.last_sub_status.trim()) {
    ctx.last_sub_status = body.last_sub_status.trim();
  }
  ctx.picked_from = 'oude-retenties';

  try {
    const { data: cust, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, is_company, company_name, first_name, last_name, email, phone')
      .eq('id', customerId)
      .maybeSingle();
    if (cErr) return res.status(500).json({ error: 'customer fetch: ' + cErr.message });
    if (!cust) return res.status(404).json({ error: 'Klant niet gevonden' });

    const leadName = customerDisplayName(cust, null);
    const now = nowIso();

    // Insert; op 23505 (dup) → find + patch terugbel_datum.
    const insertRow = {
      customer_id        : customerId,
      source             : 'retention',
      lead_name          : leadName,
      lead_email         : cust.email || null,
      lead_phone         : cust.phone || null,
      lead_status        : 'nieuw',
      terugbel_datum     : now,
      source_ref         : ctx,
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

    if (insErr?.code === '42P01') {
      return res.status(501).json({
        error: 'Tabel follow_up_leads ontbreekt — migratie vereist',
        code : 'MIGRATION_REQUIRED',
      });
    }

    if (insErr?.code === '42703') {
      // Kolom ontbreekt (waarschijnlijk terugbel_datum in oudere schema).
      // Retry zonder terugbel_datum + source_ref.
      const fallback = { ...insertRow };
      delete fallback.terugbel_datum;
      delete fallback.source_ref;
      const { data: fInserted, error: fErr } = await supabaseAdmin
        .from('follow_up_leads')
        .insert(fallback)
        .select('id')
        .maybeSingle();
      if (!fErr && fInserted?.id) {
        return res.status(200).json({ ok: true, lead_id: fInserted.id, already: false });
      }
      if (fErr?.code === '23505') {
        return await handleDuplicate(res, customerId, now);
      }
      return res.status(500).json({ error: fErr?.message || 'Insert fallback mislukt' });
    }

    if (insErr?.code === '23505') {
      return await handleDuplicate(res, customerId, now);
    }

    console.error('[oude-retenties] insert:', insErr?.message || insErr);
    return res.status(500).json({ error: insErr?.message || 'Insert mislukt' });
  } catch (e) {
    console.error('[oude-retenties] POST fatal:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

async function handleDuplicate(res, customerId, now) {
  // Hergebruik bestaande open retention-lead; patch terugbel_datum=now
  // zodat 'ie op de werklijst direct oppakbaar is.
  const { data: existing, error: findErr } = await supabaseAdmin
    .from('follow_up_leads')
    .select('id, lead_status, terugbel_datum')
    .eq('customer_id', customerId)
    .eq('source', 'retention')
    .not('lead_status', 'in', '(verlengd,verloren)')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findErr || !existing?.id) {
    return res.status(200).json({ ok: true, lead_id: null, already: true });
  }
  // Patch terugbel_datum + snoozed_until=null zodat lead uit sluimerpot komt.
  try {
    await supabaseAdmin
      .from('follow_up_leads')
      .update({ terugbel_datum: now, snoozed_until: null })
      .eq('id', existing.id);
  } catch (_) { /* fail-soft: kolommen kunnen ontbreken */ }
  return res.status(200).json({
    ok         : true,
    already    : true,
    lead_id    : existing.id,
    lead_status: existing.lead_status || null,
  });
}

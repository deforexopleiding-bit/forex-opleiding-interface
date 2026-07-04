// api/follow-up-afgeboekt.js
//
// GET  ?reden=all|no_show|cancelled|verloren|niet_bereikbaar (default all)
//      → { items:[{type,id,name,phone,reden,afgeboekt_op,owner_id,owner_name,source}...],
//          counts:{ all, no_show, cancelled, verloren, niet_bereikbaar } }
//
// POST { type:'lead'|'appointment', id, action:'reactivate' }
//   type='lead'        → follow_up_leads.lead_status='terugbellen',
//                        terugbel_datum=now(), attempts=0, snoozed_until=null.
//                        Log note entry_kind='system' outcome_code='reactivate'.
//   type='appointment' → maak een follow_up_lead (source='manual',
//                        lead_kind='bel', lead_status='terugbellen',
//                        terugbel_datum=now()) met naam/telefoon/email uit
//                        de appointment. Idempotent: als er al een actieve
//                        lead is voor deze GHL-contact of email → hergebruik
//                        (reactiveer die).
//                        De afspraak zelf blijft afgeboekt (status ongewijzigd).
//
// Permissie: sales.tab.retentie of sales.customer.view.
// Owner-gate: sales alleen op eigen items; manager/admin/super_admin overal.
// Schrijft alleen follow_up_leads/appointments/notes; geen GHL/Zoom/events.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADMIN_ROLES = new Set(['super_admin', 'admin', 'manager']);

const LEAD_REDEN_SET = new Set(['verloren', 'niet_bereikbaar']);
const APPT_REDEN_SET = new Set(['no_show', 'cancelled']);
const ALL_REDEN_SET  = new Set(['no_show', 'cancelled', 'verloren', 'niet_bereikbaar']);

async function getProfile(userId) {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id, role, team_member_id')
    .eq('id', userId)
    .maybeSingle();
  return data || null;
}

function isAdminRole(role) {
  return ADMIN_ROLES.has(String(role || ''));
}

function nowIso() { return new Date().toISOString(); }

async function insertSystemNote(leadId, text) {
  // Log een note voor audit-trail. Fail-soft bij ontbrekende kolommen —
  // zelfde defensieve stijl als de rest van de cockpit-endpoints.
  const buildPayload = (opts) => {
    const p = {
      lead_id: leadId,
      note   : String(text || '').slice(0, 4000),
    };
    if (opts.withKind)    p.entry_kind   = 'system';
    if (opts.withOutcome) p.outcome_code = 'reactivate';
    return p;
  };
  const tries = [
    { withKind: true,  withOutcome: true  },
    { withKind: true,  withOutcome: false },
    { withKind: false, withOutcome: false },
  ];
  for (const opts of tries) {
    const { error } = await supabaseAdmin
      .from('follow_up_lead_notes')
      .insert(buildPayload(opts));
    if (!error) return true;
    if (error.code !== '42703') {
      console.warn('[afgeboekt] note insert:', error.message);
      return false;
    }
  }
  return false;
}

async function ownerJoin(items) {
  // Verrijk met eigenaar-naam via profiles-lookup. Verwacht een array met
  // { owner_id } en muteert door owner_name toe te voegen. Fail-soft.
  const ids = [...new Set(items.map((it) => it.owner_id).filter(Boolean))];
  if (!ids.length) return items;
  try {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email')
      .in('id', ids);
    const map = new Map((data || []).map((p) => [
      p.id,
      p.full_name || p.email || null,
    ]));
    return items.map((it) => ({
      ...it,
      owner_name: it.owner_id ? (map.get(it.owner_id) || null) : null,
    }));
  } catch (e) {
    return items.map((it) => ({ ...it, owner_name: null }));
  }
}

// ─── GET: lijst + counts ──────────────────────────────────────────────

async function handleGet(req, res) {
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const profile = await getProfile(user.id);
  const isAdmin = isAdminRole(profile?.role);

  const rawReden = String(req.query.reden || 'all').trim().toLowerCase();
  const filter = ALL_REDEN_SET.has(rawReden) || rawReden === 'all' ? rawReden : 'all';

  // Leads. Fail-soft: 42P01 → MIGRATION_REQUIRED. 42703 op updated_at →
  // fallback op created_at. 42703 op andere kolommen → strippen.
  let leads = [];
  try {
    let leadCols = 'id, lead_name, lead_phone, lead_email, lead_status, owner_id, source, updated_at, last_contact_at, created_at';
    let attempt = 0;
    while (attempt < 3) {
      const q = supabaseAdmin
        .from('follow_up_leads')
        .select(leadCols)
        .in('lead_status', ['verloren', 'niet_bereikbaar'])
        .order('updated_at', { ascending: false })
        .limit(500);
      const { data, error } = await q;
      if (!error) { leads = data || []; break; }
      if (error.code === '42P01') {
        return res.status(200).json({ code: 'MIGRATION_REQUIRED', items: [], counts: emptyCounts() });
      }
      if (error.code === '42703') {
        const msg = String(error.message || '').toLowerCase();
        // Strip kolommen die niet bestaan.
        const droppable = ['last_contact_at', 'updated_at', 'source', 'lead_email'];
        let stripped = false;
        for (const k of droppable) {
          if (msg.includes(k)) {
            leadCols = leadCols.split(',').map((s) => s.trim()).filter((s) => s !== k).join(', ');
            stripped = true; break;
          }
        }
        if (!stripped) { console.warn('[afgeboekt] leads:', error.message); break; }
        attempt++;
        continue;
      }
      console.warn('[afgeboekt] leads:', error.message);
      break;
    }
  } catch (e) {
    console.warn('[afgeboekt] leads fatal:', e?.message || e);
  }

  // Afspraken.
  let appts = [];
  try {
    let apptCols = 'id, lead_name, lead_phone, lead_email, lead_ghl_contact_id, status, owner_id, updated_at, created_at, scheduled_at';
    let attempt = 0;
    while (attempt < 3) {
      const { data, error } = await supabaseAdmin
        .from('follow_up_appointments')
        .select(apptCols)
        .in('status', ['no_show', 'cancelled'])
        .order('updated_at', { ascending: false })
        .limit(500);
      if (!error) { appts = data || []; break; }
      if (error.code === '42P01') {
        return res.status(200).json({ code: 'MIGRATION_REQUIRED', items: [], counts: emptyCounts() });
      }
      if (error.code === '42703') {
        const msg = String(error.message || '').toLowerCase();
        const droppable = ['updated_at', 'lead_ghl_contact_id', 'lead_email'];
        let stripped = false;
        for (const k of droppable) {
          if (msg.includes(k)) {
            apptCols = apptCols.split(',').map((s) => s.trim()).filter((s) => s !== k).join(', ');
            stripped = true; break;
          }
        }
        if (!stripped) { console.warn('[afgeboekt] appts:', error.message); break; }
        attempt++;
        continue;
      }
      console.warn('[afgeboekt] appts:', error.message);
      break;
    }
  } catch (e) {
    console.warn('[afgeboekt] appts fatal:', e?.message || e);
  }

  // Owner-gate: sales ziet alleen eigen items (owner_id = user.id).
  if (!isAdmin) {
    leads = leads.filter((l) => l.owner_id === user.id);
    appts = appts.filter((a) => a.owner_id === user.id);
  }

  const leadItems = leads.map((l) => ({
    type         : 'lead',
    id           : l.id,
    name         : l.lead_name || '(zonder naam)',
    phone        : l.lead_phone || null,
    email        : l.lead_email || null,
    reden        : l.lead_status,   // 'verloren' | 'niet_bereikbaar'
    afgeboekt_op : l.updated_at || l.last_contact_at || l.created_at || null,
    owner_id     : l.owner_id || null,
    source       : l.source || null,
  }));

  const apptItems = appts.map((a) => ({
    type         : 'appointment',
    id           : a.id,
    name         : a.lead_name || '(zonder naam)',
    phone        : a.lead_phone || null,
    email        : a.lead_email || null,
    reden        : a.status,        // 'no_show' | 'cancelled'
    afgeboekt_op : a.updated_at || a.created_at || null,
    owner_id     : a.owner_id || null,
    source       : 'appointment',
    scheduled_at : a.scheduled_at || null,
  }));

  const merged = [...leadItems, ...apptItems];
  merged.sort((x, y) => {
    const tx = x.afgeboekt_op ? Date.parse(x.afgeboekt_op) : 0;
    const ty = y.afgeboekt_op ? Date.parse(y.afgeboekt_op) : 0;
    return ty - tx;
  });

  const counts = {
    all             : merged.length,
    no_show         : merged.filter((it) => it.reden === 'no_show').length,
    cancelled       : merged.filter((it) => it.reden === 'cancelled').length,
    verloren        : merged.filter((it) => it.reden === 'verloren').length,
    niet_bereikbaar : merged.filter((it) => it.reden === 'niet_bereikbaar').length,
  };

  const filtered = filter === 'all'
    ? merged
    : merged.filter((it) => it.reden === filter);

  const enriched = await ownerJoin(filtered);

  return res.status(200).json({ items: enriched, counts });
}

function emptyCounts() {
  return { all: 0, no_show: 0, cancelled: 0, verloren: 0, niet_bereikbaar: 0 };
}

// ─── POST: reactivate ─────────────────────────────────────────────────

async function handlePost(req, res) {
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const profile = await getProfile(user.id);
  const isAdmin = isAdminRole(profile?.role);

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const type   = String(body.type   || '').trim().toLowerCase();
  const id     = String(body.id     || '').trim();
  const action = String(body.action || '').trim().toLowerCase();

  if (!UUID_RE.test(id))     return res.status(400).json({ error: 'Ongeldige id.' });
  if (action !== 'reactivate') return res.status(400).json({ error: 'Onbekende action.' });
  if (type !== 'lead' && type !== 'appointment') {
    return res.status(400).json({ error: 'type moet lead of appointment zijn.' });
  }

  if (type === 'lead') return reactivateLead(res, id, user, isAdmin);
  return reactivateAppointment(res, id, user, isAdmin);
}

async function reactivateLead(res, leadId, user, isAdmin) {
  // Fetch + owner-gate.
  const { data: lead, error: fetchErr } = await supabaseAdmin
    .from('follow_up_leads')
    .select('id, lead_name, owner_id, lead_status')
    .eq('id', leadId)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: 'fetch: ' + fetchErr.message });
  if (!lead)    return res.status(404).json({ error: 'Lead niet gevonden.' });
  if (!isAdmin && lead.owner_id && lead.owner_id !== user.id) {
    return res.status(403).json({ error: 'Geen rechten op deze lead.' });
  }
  if (!LEAD_REDEN_SET.has(String(lead.lead_status || ''))) {
    return res.status(400).json({ error: 'Lead is niet in een afgeboekte staat.' });
  }

  // Update. 42703 op attempts/snoozed_until → strippen en retry.
  let patch = {
    lead_status   : 'terugbellen',
    terugbel_datum: nowIso(),
    attempts      : 0,
    snoozed_until : null,
    updated_at    : nowIso(),
  };
  for (let i = 0; i < 3; i++) {
    const { error } = await supabaseAdmin
      .from('follow_up_leads')
      .update(patch)
      .eq('id', leadId);
    if (!error) break;
    if (error.code === '42703') {
      const msg = String(error.message || '').toLowerCase();
      const droppable = ['attempts', 'snoozed_until', 'updated_at'];
      let stripped = false;
      for (const k of droppable) {
        if (msg.includes(k) && k in patch) { delete patch[k]; stripped = true; }
      }
      if (!stripped) return res.status(500).json({ error: 'update: ' + error.message });
      continue;
    }
    return res.status(500).json({ error: 'update: ' + error.message });
  }

  await insertSystemNote(leadId, 'Opnieuw opgepakt uit afgeboekt');

  return res.status(200).json({
    ok    : true,
    type  : 'lead',
    lead_id: leadId,
  });
}

async function reactivateAppointment(res, apptId, user, isAdmin) {
  const { data: appt, error: fetchErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, lead_phone, lead_email, lead_ghl_contact_id, status, owner_id')
    .eq('id', apptId)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: 'fetch: ' + fetchErr.message });
  if (!appt)    return res.status(404).json({ error: 'Afspraak niet gevonden.' });
  if (!isAdmin && appt.owner_id && appt.owner_id !== user.id) {
    return res.status(403).json({ error: 'Geen rechten op deze afspraak.' });
  }
  if (!APPT_REDEN_SET.has(String(appt.status || ''))) {
    return res.status(400).json({ error: 'Afspraak is niet in een afgeboekte staat.' });
  }

  // Idempotent: check of er al een actieve lead is voor dit contact.
  // Match op ghl_contact_id (source_ref) of email of telefoon. Als hij
  // in afgeboekte staat staat → reactiveer die; anders nieuwe maken.
  const email = String(appt.lead_email || '').trim().toLowerCase();
  const phone = String(appt.lead_phone || '').replace(/\s+/g, '');
  const ghlId = String(appt.lead_ghl_contact_id || '').trim();

  let existing = null;
  try {
    // Zoek op email (case-insensitive) OF telefoon-suffix.
    const orClauses = [];
    if (email) orClauses.push(`lead_email.ilike.${email}`);
    if (phone) orClauses.push(`lead_phone.eq.${phone}`);
    if (orClauses.length) {
      const { data } = await supabaseAdmin
        .from('follow_up_leads')
        .select('id, lead_status, owner_id')
        .or(orClauses.join(','))
        .order('updated_at', { ascending: false, nullsFirst: false })
        .limit(1);
      if (data && data.length) existing = data[0];
    }
  } catch (e) {
    console.warn('[afgeboekt] existing lead search:', e?.message || e);
  }

  // Als er al een lead is: reactiveer die (of laat 'm staan als hij al
  // actief is) — voorkomt duplicates.
  if (existing) {
    if (existing.lead_status && !LEAD_REDEN_SET.has(existing.lead_status)) {
      // Al actief; alleen note toevoegen.
      await insertSystemNote(existing.id, 'Opnieuw opgepakt vanuit afgeboekte afspraak');
      return res.status(200).json({
        ok    : true,
        type  : 'lead_reused',
        lead_id: existing.id,
        message: 'Er bestond al een actieve lead — hergebruikt.',
      });
    }
    // Reactiveer bestaande lead in afgeboekte staat.
    const patch = {
      lead_status   : 'terugbellen',
      terugbel_datum: nowIso(),
      attempts      : 0,
      snoozed_until : null,
      updated_at    : nowIso(),
    };
    let attempt = { ...patch };
    for (let i = 0; i < 3; i++) {
      const { error } = await supabaseAdmin
        .from('follow_up_leads')
        .update(attempt)
        .eq('id', existing.id);
      if (!error) break;
      if (error.code === '42703') {
        const msg = String(error.message || '').toLowerCase();
        const droppable = ['attempts', 'snoozed_until', 'updated_at'];
        let stripped = false;
        for (const k of droppable) {
          if (msg.includes(k) && k in attempt) { delete attempt[k]; stripped = true; }
        }
        if (!stripped) return res.status(500).json({ error: 'lead reactivate: ' + error.message });
        continue;
      }
      return res.status(500).json({ error: 'lead reactivate: ' + error.message });
    }
    await insertSystemNote(existing.id, 'Opnieuw opgepakt vanuit afgeboekte afspraak');
    return res.status(200).json({
      ok    : true,
      type  : 'lead_reused',
      lead_id: existing.id,
    });
  }

  // Nieuwe lead aanmaken.
  const row = {
    customer_id      : null,
    source           : 'manual',
    lead_name        : appt.lead_name || '(zonder naam)',
    lead_email       : appt.lead_email || null,
    lead_phone       : appt.lead_phone || null,
    lead_status      : 'terugbellen',
    terugbel_datum   : nowIso(),
    lead_kind        : 'bel',
    source_ref       : {
      from_appointment: appt.id,
      ghl_contact_id  : ghlId || null,
      reason          : 'reactivate_from_afgeboekt',
    },
    owner_id         : user.id,
  };
  const RICH_KEYS = ['lead_kind', 'owner_id', 'source_ref'];
  let attempt = { ...row };
  let leadId = null;
  for (let i = 0; i < 3; i++) {
    const { data, error } = await supabaseAdmin
      .from('follow_up_leads')
      .insert(attempt)
      .select('id')
      .maybeSingle();
    if (!error) { leadId = data?.id || null; break; }
    if (error.code === '42P01') {
      return res.status(500).json({ error: 'follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
    }
    if (error.code === '42703') {
      const msg = String(error.message || '').toLowerCase();
      let stripped = false;
      for (const k of RICH_KEYS) {
        if (msg.includes(k) && k in attempt) { delete attempt[k]; stripped = true; }
      }
      if (!stripped) return res.status(500).json({ error: 'lead insert: ' + error.message });
      continue;
    }
    return res.status(500).json({ error: 'lead insert: ' + error.message });
  }

  if (leadId) {
    await insertSystemNote(leadId, `Opnieuw opgepakt vanuit afgeboekte afspraak (${appt.status})`);
  }

  return res.status(200).json({
    ok    : true,
    type  : 'lead_created',
    lead_id: leadId,
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET')  return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

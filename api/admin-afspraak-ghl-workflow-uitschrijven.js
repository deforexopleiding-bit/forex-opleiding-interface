// api/admin-afspraak-ghl-workflow-uitschrijven.js
//
// EENMALIG, afgeschermd admin-endpoint (geen cron). Schrijft de bestaande
// opstartsessie-contacten uit de GHL bevestiging/reminder-workflow, zodat GHL
// hun openstaande reminders stopt en onze in-house flow het overneemt.
//
// Doelgroep (exact = wat de reminder-cron oppakt):
//   DISTINCT lead_ghl_contact_id uit follow_up_appointments
//   WHERE status='scheduled' AND scheduled_at > now()
//     AND lead_ghl_contact_id IS NOT NULL
//     AND EXISTS(opstartsessie_submissions.appointment_id = a.id)
//
// Modi:
//   ?list=1           → GET /workflows/?locationId=… (hulp bij vinden workflow-id)
//   dry_run:true      → (DEFAULT) toon de lijst (contact-id, naam, tijd), verwijder niets
//   dry_run:false     → per uniek contact DELETE /contacts/{id}/workflow/{workflowId}
//                       (alleen via POST). Fail-soft per contact; audit-log.
//
// RBAC: admin.meta_templates.manage OF super_admin.
// Raakt de DB verder NIET (geen guards/afspraken wijzigen); leest alleen de
// doelgroep en logt een run-samenvatting naar follow_up_events_log.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const DEFAULT_WORKFLOW_ID = 'e2ca7a28-60ff-48f0-a00d-b644e4f82ab7';
const WF_RE = /^[0-9a-fA-F-]{8,64}$/;

function ghlToken() {
  return process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY || null;
}
function fmtAms(iso) {
  try {
    return new Intl.DateTimeFormat('nl-NL', {
      timeZone: 'Europe/Amsterdam', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
  } catch { return String(iso); }
}
function isFalse(v) {
  return v === false || v === 'false' || v === 0 || v === '0' || v === 'nee';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // ── RBAC: admin.meta_templates.manage OF super_admin ──
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  let toegang = await requirePermission(req, 'admin.meta_templates.manage');
  if (!toegang) {
    const { data: prof } = await supabaseAdmin
      .from('profiles').select('role, is_active').eq('id', user.id).maybeSingle();
    toegang = !!prof && prof.is_active && prof.role === 'super_admin';
  }
  if (!toegang) return res.status(403).json({ error: 'Geen rechten (admin.meta_templates.manage of super_admin)' });

  const q = req.query || {};
  const body = req.body || {};
  const token = ghlToken();

  // ── ?calendars=1 — GHL-agenda's ophalen (read-only, additief). ──
  //    UI-knop "Agenda's (kalenders) ophalen" gebruikt dit om per agenda
  //    id / name / isActive + totaal te tonen. Zelfde RBAC + token-flow
  //    als de bestaande ?list=1-tak. Raakt DB/incasso NIET.
  if (String(q.calendars || '') === '1') {
    if (!token) return res.status(503).json({ error: 'GHL-token ontbreekt (GHL_PIT_TOKEN/GHL_API_KEY)' });
    const loc = process.env.GHL_LOCATION_ID;
    if (!loc) return res.status(503).json({ error: 'GHL_LOCATION_ID ontbreekt' });
    try {
      const r = await fetch(`${GHL_BASE}/calendars/?locationId=${encodeURIComponent(loc)}`, {
        headers: { Authorization: `Bearer ${token}`, Version: '2021-04-15', Accept: 'application/json' },
      });
      const j = await r.json().catch(() => ({}));
      const raw = Array.isArray(j.calendars) ? j.calendars : (Array.isArray(j.data) ? j.data : []);
      const calendars = raw.map((c) => ({
        id: c.id || c.calendarId || null,
        name: c.name || c.title || '—',
        isActive: (c.isActive === true) || (c.status === 'active') || (c.enabled === true),
      })).filter((c) => c.id);
      return res.status(r.ok ? 200 : r.status).json({
        ok: r.ok, calendars, total: calendars.length,
      });
    } catch (e) {
      return res.status(502).json({ error: 'GHL calendars-list fout: ' + (e?.message || e) });
    }
  }

  // ── ?list=1 — workflow-lijst als hulp bij het vinden van het id ──
  if (String(q.list || '') === '1') {
    if (!token) return res.status(503).json({ error: 'GHL-token ontbreekt (GHL_PIT_TOKEN/GHL_API_KEY)' });
    const loc = process.env.GHL_LOCATION_ID;
    if (!loc) return res.status(503).json({ error: 'GHL_LOCATION_ID ontbreekt' });
    try {
      const r = await fetch(`${GHL_BASE}/workflows/?locationId=${encodeURIComponent(loc)}`, {
        headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: 'application/json' },
      });
      const j = await r.json().catch(() => ({}));
      const workflows = (j.workflows || j.data || []).map((w) => ({ id: w.id, name: w.name, status: w.status }));
      return res.status(r.ok ? 200 : r.status).json({ ok: r.ok, workflows });
    } catch (e) {
      return res.status(502).json({ error: 'GHL workflows-list fout: ' + (e?.message || e) });
    }
  }

  // ── Parameters ──
  const workflowId = String(body.workflow_id || q.workflow_id || DEFAULT_WORKFLOW_ID).trim();
  if (!WF_RE.test(workflowId)) return res.status(400).json({ error: 'workflow_id ongeldig' });

  const dryRaw = (body.dry_run !== undefined) ? body.dry_run : (q.dry_run !== undefined ? q.dry_run : true);
  const dryRun = !isFalse(dryRaw); // DEFAULT true

  // Veiligheid: een echte run (verwijderen) mag alleen via POST.
  if (!dryRun && req.method !== 'POST') {
    return res.status(405).json({ error: 'Echte run (dry_run:false) vereist POST' });
  }

  // ── Doelgroep bepalen (read-only) ──
  const nowIso = new Date().toISOString();
  const { data: appts, error: aerr } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_ghl_contact_id, lead_name, scheduled_at')
    .eq('status', 'scheduled')
    .gt('scheduled_at', nowIso)
    .not('lead_ghl_contact_id', 'is', null)
    .limit(1000);
  if (aerr) return res.status(500).json({ error: 'doelgroep-query: ' + aerr.message });

  const rows = appts || [];
  let doel = [];
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const { data: subs, error: serr } = await supabaseAdmin
      .from('opstartsessie_submissions').select('appointment_id').in('appointment_id', ids);
    if (serr) return res.status(500).json({ error: 'scope-query: ' + serr.message });
    const linked = new Set((subs || []).map((s) => s.appointment_id));
    doel = rows.filter((r) => linked.has(r.id));
  }

  // Dedupe op contact (bewaar de vroegste afspraak per contact voor weergave).
  const perContact = new Map();
  for (const r of doel) {
    const c = r.lead_ghl_contact_id;
    if (!c) continue;
    const cur = perContact.get(c);
    if (!cur || new Date(r.scheduled_at) < new Date(cur.scheduled_at)) perContact.set(c, r);
  }
  const contacten = [...perContact.values()]
    .map((r) => ({
      contact_id: r.lead_ghl_contact_id,
      lead_name: r.lead_name,
      scheduled_at: r.scheduled_at,
      gepland_amsterdam: fmtAms(r.scheduled_at),
    }))
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));

  // ── Dry-run: alleen tonen ──
  if (dryRun) {
    return res.status(200).json({ ok: true, dry_run: true, workflow_id: workflowId, totaal: contacten.length, contacten });
  }

  // ── Echte run: per uniek contact uit de workflow verwijderen ──
  if (!token) return res.status(503).json({ error: 'GHL-token ontbreekt (GHL_PIT_TOKEN/GHL_API_KEY)' });

  const summary = { verwijderd: 0, al_weg: 0, fout: 0 };
  const resultaten = [];
  for (const c of contacten) {
    try {
      const r = await fetch(
        `${GHL_BASE}/contacts/${encodeURIComponent(c.contact_id)}/workflow/${encodeURIComponent(workflowId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: 'application/json' } }
      );
      if (r.ok) {
        summary.verwijderd += 1;
        resultaten.push({ contact_id: c.contact_id, status: 'verwijderd' });
      } else if (r.status === 404) {
        summary.al_weg += 1;
        resultaten.push({ contact_id: c.contact_id, status: 'al-weg' });
      } else {
        summary.fout += 1;
        const t = await r.text().catch(() => '');
        resultaten.push({ contact_id: c.contact_id, status: 'fout', http_status: r.status, detail: (t || '').slice(0, 200) });
      }
    } catch (e) {
      summary.fout += 1;
      resultaten.push({ contact_id: c.contact_id, status: 'fout', error: e?.message || String(e) });
    }
  }

  // Audit-log (fail-soft).
  try {
    await supabaseAdmin.from('follow_up_events_log').insert({
      source: 'admin',
      event_type: 'ghl-workflow-uitschrijven',
      payload: { workflow_id: workflowId, totaal: contacten.length, ...summary, door: user.id },
      processed: true,
    });
  } catch (persistErr) {
    console.warn('[admin-afspraak-ghl-workflow-uitschrijven] audit (soft):', persistErr?.message || persistErr);
  }

  return res.status(200).json({ ok: true, dry_run: false, workflow_id: workflowId, totaal: contacten.length, ...summary, resultaten });
}

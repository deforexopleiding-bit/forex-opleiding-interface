// api/cron-events-auto-archive.js
//
// Dagelijkse cron: archiveert events die >3 dagen voorbij zijn (op basis van
// coalesce(ends_at, starts_at)) door status van 'published' naar 'archived'
// te zetten. Doel: het "Gepubliceerd"-tab in modules/events.html toont dan
// alleen actueel-relevante events; oude events verhuizen automatisch naar
// het "Gearchiveerd"-tab.
//
// Regel:
//   - status='published' EN coalesce(ends_at, starts_at) < now() - 3 dagen
//   - Al-afgeronde events (completed_at IS NOT NULL) mogen ook mee — die
//     staan nog op 'published' totdat deze cron ze archiveert. Prima gedrag.
//   - Toekomstige events / events <3 dagen oud blijven op 'published'.
//   - Cancelled / draft / al-archived worden niet aangeraakt.
//
// Webflow-cleanup blijft geregeld door cron-events-cms-cleanup (7-dagen-
// grens op starts_at). Deze cron raakt Webflow/GHL NIET; alleen events.status.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth).
// Methodes: GET (Vercel cron) + POST (handmatige debug-trigger).
// Schedule: dagelijks 03:00 UTC (~04:00 NL winter / 05:00 zomer) — vroeg
// genoeg om vóór de eerste dashboard-refresh van de dag te draaien.

import { checkCronAuth, supabaseAdmin } from './supabase.js';

const CUTOFF_DAYS = 3;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const startedAt = Date.now();
  const summary = {
    cutoff_iso : null,
    candidates : 0,
    archived   : 0,
    errors     : 0,
    error_details: [],
    duration_ms: 0,
  };

  try {
    const cutoffIso = new Date(Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000).toISOString();
    summary.cutoff_iso = cutoffIso;

    // Kandidaten ophalen. coalesce(ends_at, starts_at) < cutoff is niet
    // direct PostgREST-uitdrukbaar; we filteren daarom met een OR:
    //   ends_at.lt.cutoff  OF  (ends_at IS NULL AND starts_at < cutoff)
    // Zo krijgen we exact dezelfde peildatum-semantiek.
    const orExpr = `ends_at.lt.${cutoffIso},and(ends_at.is.null,starts_at.lt.${cutoffIso})`;

    const { data: rows, error: selErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, ends_at, status')
      .eq('status', 'published')
      .or(orExpr)
      .order('starts_at', { ascending: true });

    if (selErr) throw new Error('candidate query: ' + selErr.message);

    summary.candidates = Array.isArray(rows) ? rows.length : 0;

    if (summary.candidates === 0) {
      summary.duration_ms = Date.now() - startedAt;
      return res.status(200).json({ ok: true, ...summary });
    }

    // Per event afzonderlijk updaten in een try/catch — lesson learned 3:
    // nooit early-return op één faal-item.
    for (const ev of rows) {
      try {
        const { error: updErr } = await supabaseAdmin
          .from('events')
          .update({ status: 'archived', updated_at: new Date().toISOString() })
          .eq('id', ev.id)
          .eq('status', 'published'); // race-guard: alleen als 'ie nog published is
        if (updErr) {
          summary.errors++;
          summary.error_details.push({ id: ev.id, error: updErr.message });
          console.error('[cron-events-auto-archive] update', ev.id, updErr.message);
          continue;
        }
        summary.archived++;
      } catch (e) {
        summary.errors++;
        summary.error_details.push({ id: ev.id, error: e?.message || String(e) });
        console.error('[cron-events-auto-archive] exception', ev.id, e?.message || e);
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    summary.duration_ms = Date.now() - startedAt;
    console.error('[cron-events-auto-archive] fatal:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'fatal', ...summary });
  }
}

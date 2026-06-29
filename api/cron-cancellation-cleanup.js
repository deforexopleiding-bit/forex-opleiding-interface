// api/cron-cancellation-cleanup.js
//
// Dagelijkse cron — verplaatst geannuleerde studenten naar 'gearchiveerd'
// zodra hun annulering >7 dagen oud is. Doel: actieve toekomst-/admin-
// lijsten opschonen zonder dat de annulerings-record verloren gaat.
//
// **KRITIEK** — deze cron doet ALLEEN de status-overgang
// 'geannuleerd' → 'gearchiveerd'. GEEN TL-calls (geen credit, geen
// quotations/deals/subscriptions), GEEN Bubble-PATCH, GEEN
// cancellation-record-insert. De daadwerkelijke annulering is al gedaan
// in api/onboarding-cancel.js (Fase 4a). Dit is puur lijst-opschoning.
//
// Auth: checkCronAuth (Authorization: Bearer $CRON_SECRET).
// Methodes: GET (Vercel cron) + POST (debug).
// Schedule: dagelijks 02:30 UTC (zie vercel.json).
//
// Idempotent: alleen rijen die NU status='geannuleerd' hebben krijgen het
// archief-stempel. Al gearchiveerde rijen worden niet opnieuw geraakt.
// Per-item try/catch; één faler stopt de batch niet.
//
// Response: { ok, scanned, archived, errors: [...] }.

import { checkCronAuth, supabaseAdmin } from './supabase.js';

const BATCH_LIMIT = 100;
const ABORT_MS = 50_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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
  const summary = { ok: true, scanned: 0, archived: 0, errors: [] };

  try {
    const cutoffMs = Date.now() - SEVEN_DAYS_MS;
    const cutoffIso = new Date(cutoffMs).toISOString();

    // 1) Haal kandidaat-onboardings met status='geannuleerd' (idempotent: al
    //    gearchiveerde rijen vallen er hier al af).
    const { data: candidates, error: candErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_name, status')
      .eq('status', 'geannuleerd')
      .limit(BATCH_LIMIT * 2);
    if (candErr) throw new Error('onboardings fetch: ' + candErr.message);
    const candList = candidates || [];
    if (candList.length === 0) {
      summary.duration_ms = Date.now() - startedAt;
      console.log('[cron-cancellation-cleanup]', JSON.stringify(summary));
      return res.status(200).json(summary);
    }

    // 2) Haal de meest recente onboarding_cancellations.cancelled_at per
    //    onboarding_id. Eén batched query op .in() + sort desc; we pakken
    //    per onboarding_id de eerste hit (latest).
    const obIds = candList.map((c) => c.id);
    const { data: cancRows, error: cErr } = await supabaseAdmin
      .from('onboarding_cancellations')
      .select('onboarding_id, created_at')
      .in('onboarding_id', obIds)
      .order('created_at', { ascending: false })
      .limit(obIds.length * 4);
    if (cErr) throw new Error('cancellations fetch: ' + cErr.message);
    const latestByOnb = new Map();
    for (const r of (cancRows || [])) {
      if (!r.onboarding_id) continue;
      if (!latestByOnb.has(r.onboarding_id)) latestByOnb.set(r.onboarding_id, r.created_at);
    }

    // 3) Per kandidaat: alleen archiveren als latest cancellation > 7 dagen oud.
    //    Onboardings zonder cancellation-record (oude data of hand-set status)
    //    blijven met rust — geen record = geen leeftijd bekend; veiliger om niet
    //    onverwacht te archiveren.
    let processed = 0;
    for (const ob of candList) {
      if (Date.now() - startedAt > ABORT_MS) {
        summary.errors.push({ phase: 'time_budget', message: 'aborted before completion' });
        break;
      }
      if (processed >= BATCH_LIMIT) break;
      summary.scanned++;
      const cancAtIso = latestByOnb.get(ob.id);
      if (!cancAtIso) continue; // geen record → overslaan
      const cancMs = new Date(cancAtIso).getTime();
      if (!Number.isFinite(cancMs) || cancMs > cutoffMs) continue; // jonger dan 7 dagen
      try {
        // Status-overgang ALLEEN. Geen TL/Bubble/credit. Filter dubbel-checkt
        // dat we niet per ongeluk een al-gearchiveerde of niet-meer-geannuleerde
        // rij raken (race-safe).
        const { error: upErr } = await supabaseAdmin
          .from('onboardings')
          .update({ status: 'gearchiveerd', archived_at: new Date().toISOString() })
          .eq('id', ob.id)
          .eq('status', 'geannuleerd');
        if (upErr) throw new Error(upErr.message);
        summary.archived++;
        processed++;
      } catch (e) {
        summary.errors.push({ onboarding_id: ob.id, message: e?.message || String(e) });
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    if (cutoffIso) summary.cutoff_iso = cutoffIso;
    console.log('[cron-cancellation-cleanup]', JSON.stringify(summary));
    return res.status(200).json(summary);
  } catch (e) {
    console.error('[cron-cancellation-cleanup] fatal', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Interne fout' });
  }
}

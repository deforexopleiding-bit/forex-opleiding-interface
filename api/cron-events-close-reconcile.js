// api/cron-events-close-reconcile.js
//
// Reconcile-cron voor de events auto-close cascade (2026-08-18).
//
// Doel: dicht het gat tussen de DB-trigger (die signups_closed=true flipt
// in de DB zodra confirmed_count >= capacity) en de Node-outbound cascade
// (Webflow unpublish + GHL recompute). Als een endpoint schrijft naar
// event_attendees zonder de shared helper onConfirmedAttendeeMutation aan
// te roepen, flipt de trigger de flag maar blijft Webflow "aanmelden"
// tonen tot een medewerker het manueel triggert.
//
// Kandidaten: events die in de laatste 30 minuten zijn gesloten met
// signups_closed_reason='auto_full', published, met een webflow_item_id.
// Voor elk: closeSignupsOutbound idempotent aanroepen — die is safe om
// herhaaldelijk uit te voeren (Webflow PATCH naar isDraft=true is een
// no-op als het item al draft is; GHL recompute idempotent).
//
// Fail-soft: per-event try/catch, één falend event blokkeert de rest niet.
// Auth: Bearer $CRON_SECRET via checkCronAuth (zelfde patroon als andere
// cron-events-* endpoints).
//
// Schedule: */10 * * * * (elke 10 min in vercel.json).

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { closeSignupsOutbound } from './_lib/event-sync-orchestrator.js';

// Venster waarbinnen we net-gesloten events proberen te reconcilieren.
// Ruim genoeg om ~3 cron-runs te dekken (elk 10 min) zodat een tijdelijk
// gefaalde Webflow-call binnen dat venster ook nog wordt gerepareerd.
const LOOKBACK_MINUTES = 30;
const BATCH_LIMIT      = 25;

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
    candidates:     0,
    reconciled:     0,
    already_synced: 0,
    failed:         0,
    errors:         [],
    duration_ms:    0,
  };

  try {
    const cutoffIso = new Date(Date.now() - LOOKBACK_MINUTES * 60_000).toISOString();

    const { data: rows, error: selErr } = await supabaseAdmin
      .from('events')
      .select('id, title, signups_closed_at, signups_closed_reason, webflow_item_id')
      .eq('signups_closed',        true)
      .eq('signups_closed_reason', 'auto_full')
      .eq('status',                'published')
      .not('webflow_item_id',      'is', null)
      .gte('signups_closed_at',    cutoffIso)
      .order('signups_closed_at',  { ascending: false })
      .limit(BATCH_LIMIT);

    if (selErr) throw new Error('select events: ' + selErr.message);

    summary.candidates = (rows || []).length;

    for (const ev of (rows || [])) {
      try {
        // closeSignupsOutbound is idempotent (Webflow PATCH isDraft=true op
        // een reeds-draft item is no-op; GHL recompute is deterministisch).
        // Als er GEEN drift is, kost dit 1 Webflow-call extra per event per
        // 30 min — acceptabel gezien de bug-impact.
        await closeSignupsOutbound(ev.id);
        summary.reconciled += 1;
      } catch (e) {
        summary.failed += 1;
        summary.errors.push({ event_id: ev.id, error: e?.message || String(e) });
        console.warn(
          `[cron-events-close-reconcile] event ${ev.id} (${ev.title || 'geen titel'}) ` +
          `sync-fail (soft): ${e?.message || e}`
        );
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    return res.status(200).json({ ok: true, summary });
  } catch (e) {
    summary.duration_ms = Date.now() - startedAt;
    console.error('[cron-events-close-reconcile] fatal:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e), summary });
  }
}

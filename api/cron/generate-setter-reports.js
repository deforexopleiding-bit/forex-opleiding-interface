// api/cron/generate-setter-reports.js
//
// Op de 1e van de maand: per actieve setter (setter_config.is_active) een
// concept-maandrapport voor de VORIGE maand (vaste vergoeding + commissie).
// Spiegel van api/cron/generate-monthly-concepts.js (mentoren, 1e vrijdag).
//
// Schedule: dagelijks 06:30 UTC (vercel.json) — een halfuur NA
// cron-setter-cash-release (06:00), zodat commissie op betalingen van de
// laatste dag van de maand al geboekt is. In code: alleen op de 1e (UTC),
// anders no-op. Goedkeuren herberekent het concept sowieso, en achterblijvers
// schuiven naar het volgende rapport (zie _lib/setter-report-core.js).
//
// AUTH: Authorization: Bearer ${CRON_SECRET}.
// Query (vereisen nog steeds het secret):
//   ?force=true      → sla de 1e-van-de-maand-check over
//   ?month=YYYY-MM   → expliciete doelmaand (anders: vorige maand)
//
// Doet NIET: goedkeuren, uitbetalen, mailen. Goedgekeurde/uitbetaalde
// rapporten worden overgeslagen (skipped).
//
// Zonder migratie 2026-10-01-setter-maandrapport.sql → 200
// { skipped: true, reason: 'migratie_ontbreekt' } (geen crash, geen retry-storm).

import { supabaseAdmin, checkCronAuth } from '../supabase.js';
import {
  computeAndUpsertSetterReport, actieveSetters, normalizeMonthStart, previousMonthStart, isEersteVanDeMaandUTC,
} from '../_lib/setter-report-core.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const force = req.query?.force === 'true' || req.query?.force === '1';
  const now = new Date();
  if (!force && !isEersteVanDeMaandUTC(now)) {
    return res.status(200).json({ skipped: true, reason: 'not_first_of_month', now: now.toISOString() });
  }

  let month;
  if (typeof req.query?.month === 'string' && req.query.month.trim()) {
    month = normalizeMonthStart(req.query.month);
    if (!month) return res.status(400).json({ error: 'month moet YYYY-MM zijn' });
  } else {
    month = previousMonthStart(now);
  }

  try {
    const setters = await actieveSetters(supabaseAdmin);
    const generated = [];
    const skipped = [];
    const errors = [];
    for (const sid of setters) {
      try {
        const r = await computeAndUpsertSetterReport({ db: supabaseAdmin, setterId: sid, monthStart: month, actorId: null, skipEmpty: true });
        if (r.skipped) skipped.push({ setter: sid, reason: r.reason });
        else generated.push({ setter: sid, report_id: r.report_id, total: r.total });
      } catch (e) {
        if (e?.code === 'MIGRATIE_ONTBREEKT') throw e;
        console.error(`[cron generate-setter-reports] setter ${sid}: ${e?.message || e}`);
        errors.push({ setter: sid, reason: e?.message || String(e) });
      }
    }
    return res.status(200).json({ ok: true, month, generated, skipped, errors });
  } catch (e) {
    if (e?.code === 'MIGRATIE_ONTBREEKT') {
      console.warn('[cron generate-setter-reports]', e.message);
      return res.status(200).json({ skipped: true, reason: 'migratie_ontbreekt', month });
    }
    console.error('[cron generate-setter-reports]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

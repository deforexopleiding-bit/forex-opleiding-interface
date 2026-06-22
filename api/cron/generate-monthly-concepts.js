// api/cron/generate-monthly-concepts.js
//
// 1e-vrijdag van de maand cron — genereert (of vernieuwt) per actieve mentor
// een concept-rapport voor de VORIGE maand zodat finance/strateeg na de
// maandafsluiting niet meer handmatig "Genereer rapporten" hoeft te klikken.
//
// Schedule: dagelijks 06:00 UTC (zie vercel.json). De code controleert
// vervolgens of het vandaag de eerste vrijdag is; zo niet → no-op.
// Reden: Vercel Hobby/Pro plans staan geen "eerste-vrijdag" cron-expressie
// toe; daily-check-in-code werkt op elk plan.
//
// AUTH: Authorization: Bearer ${CRON_SECRET} (zelfde patroon als andere
// crons in dit project). Geldt ook voor handmatige test-aanroep via curl.
//
// Query (allebei vereisen nog steeds het CRON_SECRET):
//   ?force=true             → slaat de eerste-vrijdag-check over
//   ?month=YYYY-MM          → kies expliciet de doelmaand (anders: VORIGE
//                             maand t.o.v. now). Validatie YYYY-MM.
//
// Wat dit endpoint NIET doet:
//   - Geen mail (komt pas bij approve).
//   - Geen approve / status-wissel — alleen concept-snapshots maken.
//   - Geen ledger-mutatie. computeAndUpsertConcept slaat goedgekeurd /
//     uitbetaald al over (skipped:true in de response), dus zo'n maand
//     wordt niet per ongeluk teruggezet.
//
// Response 200:
//   { ok, month, generated:[mentor_user_id...], skipped:[{mentor, reason}],
//     errors:[{mentor, reason}] }

import { supabaseAdmin } from '../supabase.js';
import { computeAndUpsertConcept } from '../_lib/payout-generate-core.js';

const MONTH_RE = /^(\d{4})-(\d{2})$/;

function normalizeMonthStart(s) {
  if (typeof s !== 'string') return null;
  const m = MONTH_RE.exec(s.trim());
  if (!m) return null;
  const y  = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) return null;
  if (!Number.isInteger(mo) || mo < 1 || mo > 12)  return null;
  return `${y}-${String(mo).padStart(2, '0')}-01`;
}

function previousMonthStart(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0..11; vorige = m-1, met year-wrap.
  const py = (m === 0) ? (y - 1) : y;
  const pm = (m === 0) ? 12      : m;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}

function isFirstFridayUTC(d) {
  return d.getUTCDay() === 5 && d.getUTCDate() <= 7;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // AUTH — zelfde patroon als andere crons (Authorization: Bearer CRON_SECRET).
  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const force = req.query?.force === 'true' || req.query?.force === '1';
  const now   = new Date();

  // Eerste-vrijdag-check (tenzij force).
  if (!force && !isFirstFridayUTC(now)) {
    return res.status(200).json({
      skipped: true,
      reason : 'not_first_friday',
      now    : now.toISOString(),
    });
  }

  // Doelmaand bepalen.
  let month;
  if (typeof req.query?.month === 'string' && req.query.month.trim()) {
    month = normalizeMonthStart(req.query.month);
    if (!month) {
      return res.status(400).json({ error: 'month moet YYYY-MM zijn' });
    }
  } else {
    month = previousMonthStart(now);
  }

  try {
    // Actieve mentoren ophalen.
    const { data: rows, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('user_id, type, is_active')
      .eq('type', 'mentor')
      .eq('is_active', true)
      .not('user_id', 'is', null);
    if (tmErr) throw new Error('team_members fetch: ' + tmErr.message);

    const mentorIds = Array.from(new Set((rows || []).map((r) => r.user_id).filter(Boolean)));
    if (mentorIds.length === 0) {
      return res.status(200).json({
        ok       : true,
        month,
        generated: [],
        skipped  : [],
        errors   : [],
        warning  : 'Geen actieve mentors gevonden',
      });
    }

    const generated = [];
    const skipped   = [];
    const errors    = [];

    // Sequentieel — leesbare logs + niet alle Bubble-roundtrips parallel.
    for (const mid of mentorIds) {
      try {
        const r = await computeAndUpsertConcept({
          mentorUserId: mid,
          monthStart  : month,
          actorId     : null, // cron-actie zonder gebruiker.
        });
        if (r?.skipped) {
          skipped.push({ mentor: mid, reason: r.reason || 'al definitief' });
        } else {
          generated.push(mid);
        }
      } catch (e) {
        console.error(`[cron generate-monthly-concepts] mentor ${mid}: ${e?.message || e}`);
        errors.push({ mentor: mid, reason: e?.message || String(e) });
      }
    }

    return res.status(200).json({
      ok       : true,
      month,
      generated,
      skipped,
      errors,
    });
  } catch (e) {
    console.error('[cron generate-monthly-concepts]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

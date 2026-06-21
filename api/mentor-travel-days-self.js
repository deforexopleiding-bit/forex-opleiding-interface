// api/mentor-travel-days-self.js
//
// SELF-only endpoint waarmee de mentor zelf het aantal reisdagen per maand
// invoert. Strikte self-scope: mentor_user_id is ALTIJD auth.uid() — er is
// geen ?mentor_user_id-param en geen admin-pad. Voor admin-edits (bv. door
// finance) gebruiken we later een aparte endpoint of beheer-UI.
//
// Permission: mentor.module.access.
//
// GET ?period_month=YYYY-MM(-DD)
//   Response 200:
//     { ok, period_month, travel_enabled, day_rate_incl, days, editable, status }
//     editable = (geen payout-rij) OR status === 'concept'.
//     status is mentor_payouts.status van de matchende (uid, maand)-rij of null.
//
// POST { period_month, days (int 0..62) }
//   Validaties / fouten:
//     - !travel_enabled → 403 'reiskosten niet ingeschakeld'
//     - status ∈ {goedgekeurd, uitbetaald} → 403 'rapport al goedgekeurd,
//       niet meer aanpasbaar'
//     - days niet integer ≥ 0 of > 62 → 400
//   Schrijft (uid, monthStart, days, updated_at=now()) naar mentor_travel_days
//   en triggert computeAndUpsertConcept ALLEEN als er al een concept-rij
//   bestaat (zodat de mentor het rapport-totaal direct ziet bijwerken).
//   Bestaat er nog geen rapport-rij dan blijft de invoer staan en wordt 'ie
//   bij de volgende admin-generate vanzelf meegenomen.
//   Response 200: { ok, days, amount_incl }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeAndUpsertConcept } from './_lib/payout-generate-core.js';

const MONTH_RE = /^(\d{4})-(\d{2})(?:-\d{2})?$/;

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function normalizeMonthStart(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(MONTH_RE);
  if (!m) return null;
  const y  = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) return null;
  if (!Number.isInteger(mo) || mo < 1 || mo > 12)  return null;
  return `${y}-${String(mo).padStart(2, '0')}-01`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET or POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  const uid = user.id;

  // period_month uit query of body — zelfde validatie voor beide methodes.
  const rawMonth = req.method === 'GET'
    ? (typeof req.query?.period_month === 'string' ? req.query.period_month.trim() : '')
    : (req.body && typeof req.body.period_month === 'string' ? req.body.period_month.trim() : '');
  const monthStart = normalizeMonthStart(rawMonth);
  if (!monthStart) {
    return res.status(400).json({ error: 'period_month moet YYYY-MM zijn' });
  }

  try {
    // Config + payout-status parallel ophalen — beide nodig in zowel GET als POST.
    const [
      { data: cfg, error: cfgErr },
      { data: payout, error: payErr },
    ] = await Promise.all([
      supabaseAdmin
        .from('mentor_payout_config')
        .select('travel_enabled, travel_day_rate_incl')
        .eq('mentor_user_id', uid)
        .maybeSingle(),
      supabaseAdmin
        .from('mentor_payouts')
        .select('status')
        .eq('mentor_user_id', uid)
        .eq('period_month', monthStart)
        .maybeSingle(),
    ]);
    if (cfgErr) throw new Error('config lookup: ' + cfgErr.message);
    if (payErr) throw new Error('payouts lookup: ' + payErr.message);

    const travelEnabled = !!cfg?.travel_enabled;
    const dayRateIncl   = Number(cfg?.travel_day_rate_incl) || 0;
    const status        = payout?.status || null;
    const isFinal       = status === 'goedgekeurd' || status === 'uitbetaald';
    const editable      = !isFinal; // (geen rij) OF status='concept' OF status='open'

    if (req.method === 'GET') {
      // Days ophalen voor weergave.
      const { data: tdRow, error: tdErr } = await supabaseAdmin
        .from('mentor_travel_days')
        .select('days')
        .eq('mentor_user_id', uid)
        .eq('period_month', monthStart)
        .maybeSingle();
      if (tdErr) throw new Error('travel-days lookup: ' + tdErr.message);
      const days = Number(tdRow?.days) || 0;

      return res.status(200).json({
        ok            : true,
        period_month  : monthStart,
        travel_enabled: travelEnabled,
        day_rate_incl : dayRateIncl,
        days,
        editable,
        status,
      });
    }

    // POST — invoer/wijziging.
    if (!travelEnabled) {
      return res.status(403).json({ error: 'reiskosten niet ingeschakeld' });
    }
    if (isFinal) {
      return res.status(403).json({ error: 'rapport al goedgekeurd, niet meer aanpasbaar' });
    }
    const body = (req.body && typeof req.body === 'object') ? req.body : null;
    const rawDays = body ? body.days : undefined;
    const daysNum = Number(rawDays);
    if (!Number.isFinite(daysNum) || !Number.isInteger(daysNum)) {
      return res.status(400).json({ error: 'days moet een geheel getal zijn' });
    }
    if (daysNum < 0)   return res.status(400).json({ error: 'days moet >= 0 zijn' });
    if (daysNum > 62)  return res.status(400).json({ error: 'days mag niet > 62 zijn' });

    const nowIso = new Date().toISOString();
    const { error: upsertErr } = await supabaseAdmin
      .from('mentor_travel_days')
      .upsert({
        mentor_user_id: uid,
        period_month  : monthStart,
        days          : daysNum,
        updated_at    : nowIso,
      }, { onConflict: 'mentor_user_id,period_month' });
    if (upsertErr) throw new Error('travel-days upsert: ' + upsertErr.message);

    // Recompute alleen als er al een concept-rij bestaat — anders is er nog
    // niets te updaten en zou de eerste generate door de admin getriggerd
    // moeten worden.
    if (status === 'concept') {
      try {
        await computeAndUpsertConcept({
          mentorUserId: uid,
          monthStart,
          actorId     : uid,
        });
      } catch (e) {
        console.warn('[mentor-travel-days-self] recompute faalde:', e?.message || e);
      }
    }

    return res.status(200).json({
      ok          : true,
      days        : daysNum,
      amount_incl : round2(daysNum * dayRateIncl),
    });
  } catch (e) {
    console.error('[mentor-travel-days-self]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

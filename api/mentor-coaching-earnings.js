// api/mentor-coaching-earnings.js
//
// GET → coaching-verdiensten v1: telt 1-op-1 sessies + team-trainingen +
// no-shows binnen een periode en rekent ze om naar bedragen (incl. btw).
// Read-only: sessies uit het LMS (dfo-lms). Een onbereikbare bron geeft een
// fout, nooit stil 0.
//
// PERIODEN VÓÓR 1 OKT 2026 (Bubble dicht sinds okt 2026): de helper telt dan
// alleen het LMS-deel. De respons draagt dan `melding` (uitleg) en
// `uitbetalingen` — de opgeslagen mentor_payouts van die maanden met hun
// coachingbedrag — zodat het scherm het volledige bedrag kan tonen in plaats
// van een te laag getal.
//
// Dual-gate (consistent met andere mentor-endpoints):
//   - ?mentor_user_id=… → admin (mentor.admin.view, die id).
//   - afwezig            → self  (mentor.module.access, auth.uid()).
//
// Query:
//   from=YYYY-MM-DD, to=YYYY-MM-DD (inclusief). Default: huidige maand
//   (1e t/m laatste dag).
//
// Tarieven + telling: zie api/_lib/coaching-earnings.js — die helper is shared
// met mentor-payout-generate zodat rapport-cijfers exact matchen met wat de
// mentor op deze tab ziet.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeCoachingEarnings, OUDE_BRON_EINDE } from './_lib/coaching-earnings.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function firstOfMonthUtc(ref = new Date()) {
  const y = ref.getUTCFullYear();
  const m = String(ref.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function lastOfMonthUtc(ref = new Date()) {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0));
  const mm = String(last.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(last.getUTCDate()).padStart(2, '0');
  return `${last.getUTCFullYear()}-${mm}-${dd}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Dual-gate.
  const requestedMentorId = typeof req.query?.mentor_user_id === 'string'
    ? req.query.mentor_user_id.trim() : '';
  let effectiveUserId;
  let scope;
  if (requestedMentorId) {
    if (!UUID_RE.test(requestedMentorId)) {
      return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
    }
    if (!(await requirePermission(req, 'mentor.admin.view'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.admin.view)' });
    }
    effectiveUserId = requestedMentorId;
    scope = 'admin';
  } else {
    if (!(await requirePermission(req, 'mentor.module.access'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
    }
    effectiveUserId = user.id;
    scope = 'self';
  }

  // Datum-range.
  let from = typeof req.query?.from === 'string' ? req.query.from.trim() : '';
  let to   = typeof req.query?.to   === 'string' ? req.query.to.trim()   : '';
  if (!from || !DATE_RE.test(from)) from = firstOfMonthUtc();
  if (!to   || !DATE_RE.test(to))   to   = lastOfMonthUtc();
  if (from > to) return res.status(400).json({ error: 'from mag niet na to liggen' });

  const debugOn = req.query?.debug === '1';

  try {
    const result = await computeCoachingEarnings({
      mentorUserId: effectiveUserId,
      from,
      to,
    });

    const payload = {
      ok: true,
      scope,
      linked: true,
      from,
      to,
      breakdown : result.breakdown,
      grand_total: result.grand_total,
      bronnen   : result._meta?.bronnen || null,
    };

    // Oude maanden: de opgeslagen uitbetalingen erbij (faalzacht — de melding
    // staat er hoe dan ook).
    if (from < OUDE_BRON_EINDE) {
      payload.melding = result._meta?.melding || null;
      try {
        const { data: pays, error: pErr } = await supabaseAdmin
          .from('mentor_payouts')
          .select('period_month, status, coaching_total, total')
          .eq('mentor_user_id', effectiveUserId)
          .gte('period_month', from.slice(0, 7) + '-01')
          .lt('period_month', OUDE_BRON_EINDE)
          .lte('period_month', to)
          .order('period_month', { ascending: true });
        if (pErr) throw new Error(pErr.message);
        payload.uitbetalingen = pays || [];
        // Totaal MET historie, alleen als het venster op een maandgrens begint
        // (dan dekken de maanduitbetalingen het oude deel precies): het LMS
        // vanaf 1 okt + de opgeslagen coaching van de oude maanden. Gebruikt
        // door het all-time-cijfer op het mentordashboard.
        if (from.endsWith('-01')) {
          const historie = (pays || []).reduce((som, x) => som + (Number(x.coaching_total) || 0), 0);
          let lmsNa = 0;
          if (to >= OUDE_BRON_EINDE) {
            const na = await computeCoachingEarnings({ mentorUserId: effectiveUserId, from: OUDE_BRON_EINDE, to });
            lmsNa = Number(na.grand_total) || 0;
          }
          payload.grand_total_incl_historie = Math.round((historie + lmsNa) * 100) / 100;
        }
      } catch (pe) {
        console.warn('[mentor-coaching-earnings] uitbetalingen lezen:', pe?.message || pe);
        payload.uitbetalingen = null;
        payload.grand_total_incl_historie = null;
      }
    }

    if (debugOn) {
      payload.debug = {
        students_count   : result.students_count,
        sessions_fetched : result.sessions_fetched,
        teamCountRaw     : result.team_count_raw,
        meta             : result._meta,
      };
    }

    return res.status(200).json(payload);
  } catch (e) {
    console.error('[mentor-coaching-earnings]', e?.message || e);
    if (e?.code === 'LMS_NIET_GECONFIGUREERD' || e?.code === 'LMS_ONBEREIKBAAR') {
      return res.status(502).json({ error: 'Sessies uit het LMS konden niet gelezen worden — ' + e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

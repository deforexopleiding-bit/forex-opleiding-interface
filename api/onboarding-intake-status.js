// api/onboarding-intake-status.js
//
// Lazy sidecar-endpoint voor de dure Bubble-afgeleide intake-velden. Sinds
// perf-refactor (mei 2026) blokkeren admin-future-students-list.js en
// onboarding-detail.js NIET meer op fetchOneOnOneForMentor — die live
// Bubble-call gebeurt hier, ná het initiële render.
//
// Auth: geen nieuwe RBAC-key; hergebruikt getOnboardingScope zodat een
// view_own-only-mentor alleen zijn eigen onboardings mag opvragen. seesAll
// mag alles.
//
// Body (POST) OF query (GET):
//   { onboarding_ids: [uuid, ...] }
//
// Response 200: { ok:true, items: [{
//     onboarding_id,
//     intake_status,          // string | null  (deriveIntakeStatus, incl. handmatige mentor_intake_status)
//     planned_call_at,        // ISO | null
//     last_completed_at,      // ISO | null
//     last_noshow_at,         // ISO | null
// }, ...],
//   bubble_warnings?: [{ mentor_user_id, warning }] }
//
// Semantiek: identiek aan de per-rij afleiding die admin-future-students-list.js
// vroeger inline deed (r286-299) én onboarding-detail.js (r219-235). Zelfde
// deriveIntakeStatus / fetchOneOnOneForMentor.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
import { haalSessieOverzichtPerStudent, BRON_GELEZEN } from './_lib/dfo-lms-sessies.js';
import { deriveIntakeStatus } from './_lib/intake-status.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 500;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET or POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll && !scopeInfo.seesOwn) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin of onboarding.view_own)' });
  }

  // Ids parsen (POST body of GET query). Comma-lijst OF array beide OK.
  let rawIds = null;
  if (req.method === 'POST') {
    const body = req.body || {};
    rawIds = body.onboarding_ids;
  } else {
    const q = req.query || {};
    rawIds = q.onboarding_ids;
  }
  const idsArr = Array.isArray(rawIds)
    ? rawIds
    : (typeof rawIds === 'string' ? rawIds.split(',') : []);
  const ids = Array.from(new Set(
    idsArr
      .map((v) => (v == null ? '' : String(v).trim()))
      .filter((v) => UUID_RE.test(v))
  ));
  if (ids.length === 0) return res.status(200).json({ ok: true, items: [] });
  if (ids.length > MAX_IDS) {
    return res.status(400).json({ error: `Maximaal ${MAX_IDS} onboarding_ids per request` });
  }

  try {
    // 1) Onboarding-rijen ophalen. Ownership-guard: view_own-only ziet alleen
    //    zijn eigen rijen; seesAll ziet alles. We filteren serverside met .in +
    //    mentor_user_id-eq, en verifieren daarna dat count matched (defense).
    let rowsQuery = supabaseAdmin
      .from('onboardings')
      .select('id, mentor_user_id, bubble_user_id, mentor_intake_status')
      .in('id', ids);
    if (!scopeInfo.seesAll) {
      rowsQuery = rowsQuery.eq('mentor_user_id', scopeInfo.userId);
    }
    const { data: rows, error: rowsErr } = await rowsQuery;
    if (rowsErr) throw new Error('onboardings fetch: ' + rowsErr.message);
    const visible = Array.isArray(rows) ? rows : [];

    // 2) Sessie-overzicht per student, RECHTSTREEKS uit het LMS.
    //
    // De vorige versie haalde de sessies per MENTOR uit Bubble en zocht de
    // student daarin op. Dat had twee problemen: de mentoren werken sinds
    // augustus 2026 in het LMS (dus Bubble is leeg), en een student van een
    // mentor zonder Bubble-koppeling viel sowieso buiten beeld.
    //
    // We kijken nu per STUDENT, via onboardings.bubble_user_id →
    // hlms_student.bubble_user_id. Die brug is gemeten aanwezig: 299 van de
    // 304 studentrijen dragen 'm, en die waarden zijn uniek.
    const bubbleIds = visible.map((r) => r.bubble_user_id).filter(Boolean);
    const bron = await haalSessieOverzichtPerStudent({ bubbleUserIds: bubbleIds });

    const bronGelezen = bron.bron_status === BRON_GELEZEN;
    if (!bronGelezen) {
      console.warn('[onboarding-intake-status] sessies niet gelezen ('
        + bron.bron_status + '): ' + (bron.fout || 'reden onbekend'));
    }

    // 3) Per zichtbare onboarding → afleiden.
    const items = visible.map((r) => {
      const bu = r.bubble_user_id ? String(r.bubble_user_id) : null;
      const v  = (bronGelezen && bu) ? (bron.perStudent.get(bu) || null) : null;
      const plannedIso = v?.next   || null;
      const doneIso    = v?.done   || null;
      const noshowIso  = v?.noshow || null;

      // KON DE BRON NIET GELEZEN WORDEN, dan leiden we NIETS af.
      // Zouden we dat wel doen, dan komt elke student op 'nog_te_benaderen'
      // (rang 4) en dus BOVENAAN de probleemlijst — ook iemand die dertien
      // sessies achter de rug heeft. Dat is niet leeg maar onwaar, en het
      // zet iemand tot een verkeerde handeling aan: bellen wie al lang bezig
      // is. Liever geen status dan een verzonnen status; de aanroeper houdt
      // dan gewoon zijn vorige waarde.
      const intake = bronGelezen
        ? deriveIntakeStatus({
            hasCompletedSession:  !!doneIso,
            hasMentor:            !!r.mentor_user_id,
            mentor_intake_status: r.mentor_intake_status || null,
            hasNoshow:            !!noshowIso,
            hasFutureCall:        !!plannedIso,
          })
        : null;

      return {
        onboarding_id:     r.id,
        intake_status:     intake,
        planned_call_at:   plannedIso,
        last_completed_at: doneIso,
        last_noshow_at:    noshowIso,
      };
    });

    // De BRON-STATUS gaat altijd mee: zonder dat is 'overal null' niet te
    // onderscheiden van 'niemand heeft een sessie'.
    const payload = { ok: true, bron: 'hlms_sessie', bron_status: bron.bron_status, items };
    if (!bronGelezen) payload.bron_fout = bron.fout || 'reden onbekend';
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[onboarding-intake-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

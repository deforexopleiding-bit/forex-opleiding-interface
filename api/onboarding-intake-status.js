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
import { fetchOneOnOneForMentor } from './_lib/bubble-1on1.js';
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

    // 2) Unieke mentors → bubble_user_id opzoeken (team_members).
    const mentorUids = Array.from(new Set(
      visible.map((r) => r.mentor_user_id).filter(Boolean)
    ));
    const mentorBubbleByUid = new Map();
    if (mentorUids.length > 0) {
      try {
        const { data: tms, error: tmErr } = await supabaseAdmin
          .from('team_members')
          .select('user_id, bubble_user_id, is_active')
          .in('user_id', mentorUids)
          .eq('is_active', true);
        if (tmErr) {
          console.warn('[onboarding-intake-status] team_members fetch:', tmErr.message);
        } else {
          for (const t of (tms || [])) {
            if (t?.user_id && t.bubble_user_id) {
              mentorBubbleByUid.set(t.user_id, String(t.bubble_user_id).trim());
            }
          }
        }
      } catch (e) {
        console.warn('[onboarding-intake-status] team_members exception:', e?.message || e);
      }
    }

    // 3) fetchOneOnOneForMentor per unieke mentor, PARALLEL. Zelfde patroon
    //    als admin-future-students-list.js gebruikte. Fail-soft per mentor:
    //    één falende Bubble-call blokkeert de rest niet — die onboardings
    //    krijgen null-velden.
    const oneOnOneByMentor = new Map();
    const bubbleWarnings = [];
    await Promise.all(Array.from(mentorBubbleByUid.entries()).map(async ([uid, bubbleId]) => {
      try {
        const r = await fetchOneOnOneForMentor(bubbleId);
        oneOnOneByMentor.set(uid, {
          next: r.nextPlannedByMember,
          done: r.earliestCompletedByMember,
          ns:   r.lastNoshowByMember,
        });
        if (r.warning) bubbleWarnings.push({ mentor_user_id: uid, warning: r.warning });
      } catch (e) {
        console.warn('[onboarding-intake-status] 1on1 mentor fail:', uid, e?.message || e);
        bubbleWarnings.push({ mentor_user_id: uid, warning: 'fetch-fail' });
      }
    }));

    // 4) Per zichtbare onboarding → afleiden.
    const items = visible.map((r) => {
      const ooo = r.mentor_user_id ? oneOnOneByMentor.get(r.mentor_user_id) : null;
      const bu  = r.bubble_user_id ? String(r.bubble_user_id) : null;
      const plannedIso = (ooo && bu) ? (ooo.next.get(bu) || null) : null;
      const doneIso    = (ooo && bu) ? (ooo.done.get(bu) || null) : null;
      const noshowIso  = (ooo && bu) ? (ooo.ns.get(bu)   || null) : null;
      const intake = deriveIntakeStatus({
        hasCompletedSession:  !!doneIso,
        hasMentor:            !!r.mentor_user_id,
        mentor_intake_status: r.mentor_intake_status || null,
        hasNoshow:            !!noshowIso,
        hasFutureCall:        !!plannedIso,
      });
      return {
        onboarding_id:     r.id,
        intake_status:     intake,
        planned_call_at:   plannedIso,
        last_completed_at: doneIso,
        last_noshow_at:    noshowIso,
      };
    });

    const payload = { ok: true, items };
    if (bubbleWarnings.length > 0) payload.bubble_warnings = bubbleWarnings;
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[onboarding-intake-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

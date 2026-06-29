// api/admin-future-students-list.js
//
// GET — Admin/manager-overzicht van ALLE toekomstige studenten over alle
// mentoren, met afgeleide intake-status (Fase 1-prioriteit) + laatste update +
// problemen-bovenaan-rank. Geen schemawijziging.
//
// Permission-gate: gelijk aan onboardings-admin-list.js. Een seesOwn-only
// gebruiker (mentor) krijgt 403 — die heeft z'n eigen toekomst-tab al in
// mentor-students.html. Alleen seesAll mag dit endpoint zien.
//
// 1-op-1 status-afleiding wordt per UNIEKE mentor één keer uit Bubble gehaald
// (niet per student) en gedeeld via api/_lib/bubble-1on1.js — exact dezelfde
// classificatie als api/mentor-1on1-sessions.js.
//
// Response 200: { future: [ {
//   onboarding_id, customer_name, mentor_user_id, mentor_name,
//   start_date, paid, bubble_user_id, mentor_intake_status,
//   created_at,
//   intake_status, intake_rank, days_since_update,
//   last_update: { kind, status, note, at } | null,
//   planned_call_at,                   // ISO of null
// } ] }
//
// Sort default: rank asc (problemen bovenaan), tie-break op start_date asc
// (dichtstbijzijnde eerst), daarna customer_name.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
import { fetchOneOnOneForMentor } from './_lib/bubble-1on1.js';
import { deriveIntakeStatus, intakeStatusRank } from './_lib/intake-status.js';

function daysBetween(fromIso, toMs) {
  if (!fromIso) return null;
  const t = new Date(fromIso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((toMs - t) / (24 * 60 * 60 * 1000));
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

  // Gate identiek aan onboardings-admin-list.js, maar alleen seesAll mag —
  // deze view is bewust admin/manager-only. Mentor heeft eigen toekomst-tab.
  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin vereist).' });
  }

  try {
    // ── 1) Onboardings ophalen (niet-gearchiveerd, niet-test) ────────────
    const { data: rows, error: rowErr } = await supabaseAdmin
      .from('onboardings')
      .select(`id, customer_id, customer_name, mentor_user_id,
               status, start_date, created_at,
               bubble_user_id, mentor_intake_status,
               intake_handled_at, intake_handled_by`)
      .neq('status', 'gearchiveerd')
      .eq('is_test', false)
      .order('created_at', { ascending: false })
      .limit(2000);
    if (rowErr) throw new Error('onboardings fetch: ' + rowErr.message);
    const list = rows || [];
    if (list.length === 0) {
      return res.status(200).json({ future: [] });
    }

    // ── 2) Mentor-naam + bubble_user_id per uniek mentor_user_id ─────────
    const mentorIds = Array.from(new Set(list.map((r) => r.mentor_user_id).filter(Boolean)));
    const mentorNameByUid   = new Map();
    const mentorBubbleByUid = new Map();
    if (mentorIds.length > 0) {
      const { data: tmRows, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('user_id, name, bubble_user_id, is_active')
        .in('user_id', mentorIds);
      if (tmErr) throw new Error('team_members fetch: ' + tmErr.message);
      for (const r of (tmRows || [])) {
        if (!r.user_id) continue;
        if (r.name) mentorNameByUid.set(r.user_id, r.name);
        if (r.bubble_user_id && r.is_active !== false) {
          mentorBubbleByUid.set(r.user_id, String(r.bubble_user_id).trim());
        }
      }
    }

    // ── 3) Paid-vlag per uniek customer_id (zelfde pattern als admin-list)
    const customerIds = Array.from(new Set(list.map((r) => r.customer_id).filter(Boolean)));
    const paidSet = new Set();
    if (customerIds.length > 0) {
      const { data: invs, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select('customer_id')
        .in('customer_id', customerIds)
        .eq('status', 'paid')
        .limit(5000);
      if (invErr) throw new Error('invoices fetch: ' + invErr.message);
      for (const r of (invs || [])) {
        if (r.customer_id) paidSet.add(r.customer_id);
      }
    }

    // ── 4) Mentor-updates: één batched query, meest recente per onboarding
    const obIds = list.map((r) => r.id);
    const lastUpdateByOnb = new Map();
    if (obIds.length > 0) {
      const { data: ups, error: upErr } = await supabaseAdmin
        .from('onboarding_mentor_updates')
        .select('onboarding_id, kind, status, note, created_at')
        .in('onboarding_id', obIds)
        .order('created_at', { ascending: false })
        .limit(10000);
      if (upErr) throw new Error('mentor_updates fetch: ' + upErr.message);
      // Eerste hit per onboarding_id is de meest recente (we sorteerden desc).
      for (const u of (ups || [])) {
        const k = u.onboarding_id;
        if (!k || lastUpdateByOnb.has(k)) continue;
        lastUpdateByOnb.set(k, {
          kind:   u.kind   || null,
          status: u.status || null,
          note:   u.note   || null,
          at:     u.created_at || null,
        });
      }
    }

    // ── 5) 1-op-1 fetchen — één call per UNIEKE mentor (niet per student) ─
    // Per mentor → fetchOneOnOneForMentor levert 3 Maps. We bewaren ze in
    // een Map<mentor_user_id, { next, done, ns }> en gebruiken ze hieronder
    // bij de status-afleiding per onboarding.
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
        // Eén falende mentor mag de hele lijst niet breken — die rijen
        // krijgen gewoon 'nog_te_benaderen' tenzij er een handmatige status
        // is. Loggen + doorgaan.
        console.warn('[admin-future-students-list] 1on1 mentor fail:', uid, e?.message || e);
        bubbleWarnings.push({ mentor_user_id: uid, warning: 'fetch-fail' });
      }
    }));

    // ── 6) Output bouwen ──────────────────────────────────────────────────
    // Fase 3b: `handled` is afgeleid, NIET permanent. Een onboarding telt als
    // afgehandeld zolang er sinds intake_handled_at GEEN nieuwere activiteit
    // is op de student (mentor-update / no-show / completed-call). PLANNED
    // calls tellen NIET — die zijn toekomst-gedateerd en zouden anders direct
    // de afhandeling weer opheffen.
    const nowMs = Date.now();
    const future = list.map((r) => {
      const ooo = r.mentor_user_id ? oneOnOneByMentor.get(r.mentor_user_id) : null;
      const bu  = r.bubble_user_id ? String(r.bubble_user_id) : null;
      const plannedIso = (ooo && bu) ? (ooo.next.get(bu) || null) : null;
      const doneIso    = (ooo && bu) ? (ooo.done.get(bu) || null) : null;
      const noshowIso  = (ooo && bu) ? (ooo.ns.get(bu)   || null) : null;

      const intake = deriveIntakeStatus({
        hasCompletedSession:  !!doneIso,
        mentor_intake_status: r.mentor_intake_status || null,
        hasNoshow:            !!noshowIso,
        hasFutureCall:        !!plannedIso,
      });
      const baseRank = intakeStatusRank(intake);
      const last = lastUpdateByOnb.get(r.id) || null;
      const daysSince = last ? daysBetween(last.at, nowMs) : null;

      // Afgehandeld-check: handle_at moet niet null zijn EN er moet GEEN
      // latere activiteit zijn (max van updates/no-show/completed).
      let handled = false;
      const handledAtIso = r.intake_handled_at || null;
      if (handledAtIso) {
        const handledMs = new Date(handledAtIso).getTime();
        const latestActivityMs = Math.max(
          last && last.at ? new Date(last.at).getTime() : 0,
          noshowIso       ? new Date(noshowIso).getTime() : 0,
          doneIso         ? new Date(doneIso).getTime()   : 0,
        );
        handled = Number.isFinite(handledMs) && handledMs >= latestActivityMs;
      }
      // Effective rank — afgehandelde rijen vallen uit de "problemen bovenaan"
      // groep (rank 0-3) en komen op tier 8 (boven gestart=9, onder rest).
      const effRank = handled ? 8 : baseRank;

      return {
        onboarding_id:        r.id,
        customer_name:        r.customer_name || null,
        mentor_user_id:       r.mentor_user_id || null,
        mentor_name:          r.mentor_user_id ? (mentorNameByUid.get(r.mentor_user_id) || null) : null,
        start_date:           r.start_date || null,
        paid:                 paidSet.has(r.customer_id),
        bubble_user_id:       bu,
        mentor_intake_status: r.mentor_intake_status || null,
        created_at:           r.created_at,
        intake_status:        intake,
        intake_rank:          effRank,
        intake_rank_base:     baseRank,
        handled,
        intake_handled_at:    handledAtIso,
        intake_handled_by:    r.intake_handled_by || null,
        days_since_update:    daysSince,
        last_update:          last,
        planned_call_at:      plannedIso,
      };
    });

    // Default sort: effective rank asc → start_date asc → customer_name.
    future.sort((a, b) => {
      if (a.intake_rank !== b.intake_rank) return a.intake_rank - b.intake_rank;
      const ad = a.start_date || '9999-99-99';
      const bd = b.start_date || '9999-99-99';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return String(a.customer_name || '').localeCompare(String(b.customer_name || ''), 'nl');
    });

    const payload = { future };
    if (bubbleWarnings.length > 0) payload.bubble_warnings = bubbleWarnings;
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[admin-future-students-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

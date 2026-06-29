// api/admin-future-students-list.js
//
// GET — Admin/manager-instroom-overzicht van ÁLLE onboardings (Fase A van
// instroom-pijplijn). Bevat de hele trechter: nog-geen-mentor → nog te
// benaderen → intake-statussen → gestart → geannuleerd/gearchiveerd.
//
// Permission-gate: gelijk aan onboardings-admin-list.js. Een seesOwn-only
// gebruiker (mentor) krijgt 403 — die heeft z'n eigen toekomst-tab al in
// mentor-students.html. Alleen seesAll mag dit endpoint zien.
//
// Query params (allemaal optioneel):
//   ?scope=active|archived   default 'active' (status != 'gearchiveerd')
//   ?q=<string>              ilike op customer_name
//   ?mentor_user_id=<uuid>   exacte mentor-filter (of 'none' voor no-mentor)
//   ?traject_id=<uuid>       exacte traject-filter
//
// 1-op-1 status-afleiding wordt per UNIEKE mentor één keer uit Bubble gehaald
// (niet per student) en gedeeld via api/_lib/bubble-1on1.js — exact dezelfde
// classificatie als api/mentor-1on1-sessions.js.
//
// Bedenktijd + waiver: gebatchte deals-lookup per uniek customer_id (mirror
// van onboardings-admin-list.js). Wizard-structuur 1× per request.
//
// Response 200: { future, rows, ... }
//   Beide arrays bevatten dezelfde rij-shape; `rows` is een alias voor
//   backward-compat met de hub (onboarding-overzicht.js loadList).
//
// Sort default: rank asc (problemen bovenaan), tie-break op start_date asc
// (dichtstbijzijnde eerst), daarna customer_name.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
import { fetchOneOnOneForMentor } from './_lib/bubble-1on1.js';
import { deriveIntakeStatus, intakeStatusRank } from './_lib/intake-status.js';
import {
  findWaiverConsentKey,
  findAvailabilityBlock,
  buildAvailabilityView,
} from './_lib/onboarding-wizard-default.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeIlike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

function daysBetween(fromIso, toMs) {
  if (!fromIso) return null;
  const t = new Date(fromIso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((toMs - t) / (24 * 60 * 60 * 1000));
}

// Identiek aan computeBedenktijd in onboardings-admin-list.js — kleine
// helper, niet de moeite om naar _lib te extraheren tot er een derde
// gebruiker komt.
function computeBedenktijd(waiver, offerteOp) {
  const vervaltOp = offerteOp ? new Date(new Date(offerteOp).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString() : null;
  const waived = !!(waiver && waiver.agreed);
  if (waived && offerteOp) {
    return { status:'vervallen', reason:'afstand',    waived_at:(waiver.at||null), offerte_op:offerteOp, vervalt_op:vervaltOp };
  }
  if (offerteOp && new Date().toISOString() > vervaltOp) {
    return { status:'vervallen', reason:'verstreken', waived_at:null,              offerte_op:offerteOp, vervalt_op:vervaltOp };
  }
  if (offerteOp) {
    return { status:'lopend',    reason:null,         waived_at:null,              offerte_op:offerteOp, vervalt_op:vervaltOp };
  }
  return   { status:'onbekend',  reason:null,         waived_at:(waived?waiver.at:null), offerte_op:null,  vervalt_op:null };
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

  // Query params (allemaal optioneel — backward-compat met onboardings-admin-list).
  const scopeRaw = typeof req.query?.scope === 'string' ? req.query.scope.trim().toLowerCase() : '';
  const scope = (scopeRaw === 'archived') ? 'archived' : 'active';
  const qRaw  = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
  const mentorFilter  = typeof req.query?.mentor_user_id === 'string' ? req.query.mentor_user_id.trim() : '';
  const trajectFilter = typeof req.query?.traject_id === 'string' ? req.query.traject_id.trim() : '';
  // 'none' = expliciet filteren op onboardings zonder mentor (de no-mentor-tier).
  const wantNoMentor = (mentorFilter.toLowerCase() === 'none');
  if (mentorFilter && !wantNoMentor && !UUID_RE.test(mentorFilter)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid of "none") ongeldig' });
  }
  if (trajectFilter && !UUID_RE.test(trajectFilter)) {
    return res.status(400).json({ error: 'traject_id (uuid) ongeldig' });
  }

  try {
    // ── 1) Onboardings ophalen ───────────────────────────────────────────
    // Default scope 'active' = niet-gearchiveerd; 'archived' = expliciet
    // gearchiveerd. 'geannuleerd' valt in beide gevallen niet onder
    // gearchiveerd (terminal rank 10 + gedimd in actief).
    let q = supabaseAdmin
      .from('onboardings')
      .select(`id, customer_id, customer_name, traject_id, mentor_user_id,
               status, current_step, answers,
               start_date, created_at,
               started_at, completed_at, assigned_at, archived_at, token,
               bubble_provisioned, bubble_provisioned_at, bubble_provision_error,
               bubble_user_id, mentor_intake_status,
               intake_handled_at, intake_handled_by,
               traject:onboarding_trajecten(label, type, calls, duur_maanden)`)
      .eq('is_test', false)
      .order('created_at', { ascending: false })
      .limit(2000);
    if (scope === 'archived') q = q.eq('status', 'gearchiveerd');
    else                       q = q.neq('status', 'gearchiveerd');
    if (wantNoMentor)          q = q.is('mentor_user_id', null);
    else if (mentorFilter)     q = q.eq('mentor_user_id', mentorFilter);
    if (trajectFilter)         q = q.eq('traject_id',     trajectFilter);
    if (qRaw)                  q = q.ilike('customer_name', `%${escapeIlike(qRaw)}%`);
    const { data: rows, error: rowErr } = await q;
    if (rowErr) throw new Error('onboardings fetch: ' + rowErr.message);
    const list = rows || [];
    if (list.length === 0) {
      return res.status(200).json({ future: [], rows: [] });
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

    // ── 4b) Wizard-structuur 1× — voor waiverKey + availabilityBlock ─────
    let waiverKey         = null;
    let availabilityBlock = null;
    try {
      const { data: wiz, error: wizErr } = await supabaseAdmin
        .from('onboarding_wizard')
        .select('published_structure')
        .eq('id', 1)
        .maybeSingle();
      if (wizErr) {
        console.warn('[admin-future-students-list] wizard fetch:', wizErr.message);
      } else {
        const pub = wiz?.published_structure;
        waiverKey         = findWaiverConsentKey(pub);
        availabilityBlock = findAvailabilityBlock(pub);
      }
    } catch (e) {
      console.warn('[admin-future-students-list] wizard exception:', e?.message || e);
    }

    // ── 4c) Deals-lookup per uniek customer_id — voor bedenktijd ─────────
    const dealByCust = {};
    if (customerIds.length > 0) {
      try {
        const { data: dls, error: dlErr } = await supabaseAdmin
          .from('deals')
          .select('customer_id, tl_quotation_accepted_at, tl_quotation_signed_at')
          .in('customer_id', customerIds)
          .not('tl_quotation_accepted_at', 'is', null)
          .order('tl_quotation_accepted_at', { ascending: false });
        if (dlErr) {
          console.warn('[admin-future-students-list] deals fetch:', dlErr.message);
        } else {
          for (const d of (dls || [])) {
            if (d?.customer_id && !dealByCust[d.customer_id]) dealByCust[d.customer_id] = d;
          }
        }
      } catch (e) {
        console.warn('[admin-future-students-list] deals exception:', e?.message || e);
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
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const future = list.map((r) => {
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
      // Cancelled = terminal status 'geannuleerd' uit api/onboarding-cancel.js
      // (Fase 4a). Effective rank 10 = onder gestart=9 en afgehandeld=8 → valt
      // helemaal onderaan in de lijst (visueel gedimd in de UI).
      const cancelled = String(r.status || '').toLowerCase() === 'geannuleerd';
      // Effective rank — afgehandeld→8, geannuleerd→10, anders intake-rank
      // (waar nog_geen_mentor=-1 al bovenaan komt).
      const effRank = cancelled ? 10 : (handled ? 8 : baseRank);

      // Hub-velden: traject + waiver + bedenktijd + availability + bubble.
      const t = r.traject || null;
      const ans = (r.answers && typeof r.answers === 'object') ? r.answers : {};
      const waiver = waiverKey
        ? { agreed: ans[waiverKey] === true, at: ans[waiverKey + '_at'] || null }
        : null;
      const availability = availabilityBlock ? buildAvailabilityView(availabilityBlock, ans) : null;
      const dealRow = r.customer_id ? (dealByCust[r.customer_id] || null) : null;
      const offerteOp = dealRow ? (dealRow.tl_quotation_signed_at || dealRow.tl_quotation_accepted_at || null) : null;
      const bedenktijd = computeBedenktijd(waiver, offerteOp);

      return {
        // Identifiers — beide vormen voor backward-compat:
        id:                   r.id,
        onboarding_id:        r.id,
        customer_id:          r.customer_id,
        customer_name:        r.customer_name || null,
        // Traject + voortgang:
        traject_id:           r.traject_id,
        traject_label:        t?.label || null,
        traject_type:         t?.type  || null,
        calls:                t?.calls || null,
        current_step:         r.current_step || null,
        // Mentor:
        mentor_user_id:       r.mentor_user_id || null,
        mentor_name:          r.mentor_user_id ? (mentorNameByUid.get(r.mentor_user_id) || null) : null,
        // Onboarding-status + datums:
        status:               r.status,
        start_date:           r.start_date || null,
        created_at:           r.created_at,
        started_at:           r.started_at,
        completed_at:         r.completed_at,
        assigned_at:          r.assigned_at,
        archived_at:          r.archived_at,
        token:                r.token,
        // Betaling + bedenktijd + beschikbaarheid:
        paid:                 paidSet.has(r.customer_id),
        waiver,
        bedenktijd,
        availability,
        // Bubble-provisioning:
        bubble_provisioned:    r.bubble_provisioned === true,
        bubble_provisioned_at: r.bubble_provisioned_at || null,
        bubble_provision_error: r.bubble_provision_error || null,
        bubble_user_id:        bu,
        // Intake (Fase 1+ + Fase A nog_geen_mentor):
        mentor_intake_status: r.mentor_intake_status || null,
        intake_status:        intake,
        intake_rank:          effRank,
        intake_rank_base:     baseRank,
        handled,
        cancelled,
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

    // `rows` is een alias voor backward-compat met de hub
    // (onboarding-overzicht.js loadList leest `d.rows`); `future` blijft
    // voor consumenten die op de Fase 2-naam aanhaken.
    const payload = { future, rows: future };
    if (bubbleWarnings.length > 0) payload.bubble_warnings = bubbleWarnings;
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[admin-future-students-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

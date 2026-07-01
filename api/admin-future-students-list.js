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
// fetchOneOnOneForMentor verwijderd — lazy via /api/onboarding-intake-status.
import { deriveIntakeStatus, intakeStatusRank } from './_lib/intake-status.js';
import {
  findAvailabilityBlock,
  buildAvailabilityView,
} from './_lib/onboarding-wizard-default.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeIlike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

// Spiegel van findWaiverConsentKey in api/onboardings-admin-list.js en
// api/onboarding-detail.js — niet geëxporteerd uit _lib, hier inline om
// dezelfde shape te leveren zonder die endpoints te wijzigen.
function findWaiverConsentKey(structure) {
  if (!structure || typeof structure !== 'object') return null;
  const pages = Array.isArray(structure.pages) ? structure.pages : [];
  for (const p of pages) {
    for (const b of (p?.blocks || [])) {
      if (!b || !b.is_waiver) continue;
      if (b.type === 'file_download' && b.consent_key) return b.consent_key;
      if (b.type === 'consent'       && b.key)         return b.key;
    }
  }
  return null;
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

    // Input-sets voor de 5 afgeleide queries. Bouwen we één keer vóór de
    // Promise.all zodat elk blok z'n eigen ids kan gebruiken.
    const mentorIds   = Array.from(new Set(list.map((r) => r.mentor_user_id).filter(Boolean)));
    const customerIds = Array.from(new Set(list.map((r) => r.customer_id).filter(Boolean)));
    const obIds       = list.map((r) => r.id);

    // 5 afgeleide queries PARALLEL via Promise.all. Elk blok behoudt z'n
    // eigen fail-soft/throw-gedrag identiek aan de sequentiële versie:
    //   - team_members / invoices gooien op DB-fout (propageert naar 500).
    //   - mentor_updates / wizard / deals zijn fail-soft (returnen empty).
    const [
      mentorMaps,
      paidSet,
      lastUpdateByOnb,
      wizardMeta,
      dealByCust,
    ] = await Promise.all([
      // ── 2) Mentor-naam + bubble_user_id per uniek mentor_user_id ────────
      (async () => {
        const nameMap   = new Map();
        const bubbleMap = new Map();
        if (mentorIds.length === 0) return { nameMap, bubbleMap };
        const { data: tmRows, error: tmErr } = await supabaseAdmin
          .from('team_members')
          .select('user_id, name, bubble_user_id, is_active')
          .in('user_id', mentorIds);
        if (tmErr) throw new Error('team_members fetch: ' + tmErr.message);
        for (const r of (tmRows || [])) {
          if (!r.user_id) continue;
          if (r.name) nameMap.set(r.user_id, r.name);
          if (r.bubble_user_id && r.is_active !== false) {
            bubbleMap.set(r.user_id, String(r.bubble_user_id).trim());
          }
        }
        return { nameMap, bubbleMap };
      })(),
      // ── 3) Paid-vlag per uniek customer_id ─────────────────────────────
      (async () => {
        const set = new Set();
        if (customerIds.length === 0) return set;
        const { data: invs, error: invErr } = await supabaseAdmin
          .from('invoices')
          .select('customer_id')
          .in('customer_id', customerIds)
          .eq('status', 'paid')
          .limit(5000);
        if (invErr) throw new Error('invoices fetch: ' + invErr.message);
        for (const r of (invs || [])) {
          if (r.customer_id) set.add(r.customer_id);
        }
        return set;
      })(),
      // ── 4) Mentor-updates: batched, meest recente per onboarding ───────
      (async () => {
        const map = new Map();
        if (obIds.length === 0) return map;
        const { data: ups, error: upErr } = await supabaseAdmin
          .from('onboarding_mentor_updates')
          .select('onboarding_id, kind, status, note, created_at')
          .in('onboarding_id', obIds)
          .order('created_at', { ascending: false })
          .limit(10000);
        if (upErr) throw new Error('mentor_updates fetch: ' + upErr.message);
        for (const u of (ups || [])) {
          const k = u.onboarding_id;
          if (!k || map.has(k)) continue;
          map.set(k, {
            kind:   u.kind   || null,
            status: u.status || null,
            note:   u.note   || null,
            at:     u.created_at || null,
          });
        }
        return map;
      })(),
      // ── 4b) Wizard-structuur 1× — voor waiverKey + availabilityBlock ────
      (async () => {
        try {
          const { data: wiz, error: wizErr } = await supabaseAdmin
            .from('onboarding_wizard')
            .select('published_structure')
            .eq('id', 1)
            .maybeSingle();
          if (wizErr) {
            console.warn('[admin-future-students-list] wizard fetch:', wizErr.message);
            return { waiverKey: null, availabilityBlock: null };
          }
          const pub = wiz?.published_structure;
          return {
            waiverKey:         findWaiverConsentKey(pub),
            availabilityBlock: findAvailabilityBlock(pub),
          };
        } catch (e) {
          console.warn('[admin-future-students-list] wizard exception:', e?.message || e);
          return { waiverKey: null, availabilityBlock: null };
        }
      })(),
      // ── 4c) Deals-lookup per uniek customer_id — voor bedenktijd ───────
      (async () => {
        const obj = {};
        if (customerIds.length === 0) return obj;
        try {
          const { data: dls, error: dlErr } = await supabaseAdmin
            .from('deals')
            .select('customer_id, tl_quotation_accepted_at, tl_quotation_signed_at')
            .in('customer_id', customerIds)
            .not('tl_quotation_accepted_at', 'is', null)
            .order('tl_quotation_accepted_at', { ascending: false });
          if (dlErr) {
            console.warn('[admin-future-students-list] deals fetch:', dlErr.message);
            return obj;
          }
          for (const d of (dls || [])) {
            if (d?.customer_id && !obj[d.customer_id]) obj[d.customer_id] = d;
          }
          return obj;
        } catch (e) {
          console.warn('[admin-future-students-list] deals exception:', e?.message || e);
          return obj;
        }
      })(),
    ]);

    const mentorNameByUid   = mentorMaps.nameMap;
    const mentorBubbleByUid = mentorMaps.bubbleMap; // eslint-disable-line no-unused-vars
    const { waiverKey, availabilityBlock } = wizardMeta;

    // ── 5) 1-op-1 fetchen — VERWIJDERD uit het kritieke pad ────────────────
    // De live Bubble-call fetchOneOnOneForMentor was seconden traag en
    // blokkeerde het volledige lijst-antwoord. Sinds de perf-refactor
    // draait die logica in /api/onboarding-intake-status en wordt lazy
    // opgehaald door de frontend na render. Deze endpoint returnt de auto-
    // afgeleide intake-velden nu als null; de client patcht ze in.
    //
    // De handmatige mentor_intake_status blijft wél direct uit de DB
    // komen (r.mentor_intake_status) en drijft de basissortering.

    // ── 6) Output bouwen ──────────────────────────────────────────────────
    // Fase 3b: `handled` is afgeleid, NIET permanent. Een onboarding telt als
    // afgehandeld zolang er sinds intake_handled_at GEEN nieuwere activiteit
    // is op de student (mentor-update / no-show / completed-call). PLANNED
    // calls tellen NIET — die zijn toekomst-gedateerd en zouden anders direct
    // de afhandeling weer opheffen.
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const future = list.map((r) => {
      const bu = r.bubble_user_id ? String(r.bubble_user_id) : null;
      // Base intake gebruikt UITSLUITEND DB-signalen (handmatige status +
      // hasMentor). De 3 Bubble-afgeleide signalen (doneIso/noshowIso/
      // plannedIso) worden lazy opgehaald via /api/onboarding-intake-status
      // en client-side ingepatcht.
      const intake = deriveIntakeStatus({
        hasCompletedSession:  false,
        hasMentor:            !!r.mentor_user_id,
        mentor_intake_status: r.mentor_intake_status || null,
        hasNoshow:            false,
        hasFutureCall:        false,
      });
      const baseRank = intakeStatusRank(intake);
      const last = lastUpdateByOnb.get(r.id) || null;
      const daysSince = last ? daysBetween(last.at, nowMs) : null;

      // Afgehandeld-check: handle_at moet niet null zijn EN er moet GEEN
      // latere activiteit zijn (mentor-updates). NB: Bubble-afgeleide signalen
      // (no-shows / completed calls) tellen hier initieel NIET mee — die
      // komen lazy binnen via /api/onboarding-intake-status en de frontend
      // kan `handled` daar op recomputen.
      let handled = false;
      const handledAtIso = r.intake_handled_at || null;
      if (handledAtIso) {
        const handledMs = new Date(handledAtIso).getTime();
        const latestActivityMs = last && last.at ? new Date(last.at).getTime() : 0;
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
        // Bubble-afgeleide velden verwijderd uit het kritieke pad — worden
        // lazy nageladen via /api/onboarding-intake-status. Keys blijven
        // bestaan zodat de frontend niet breekt.
        planned_call_at:      null,
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
    // bubble_warnings verplaatst naar /api/onboarding-intake-status.
    return res.status(200).json({ future, rows: future });
  } catch (e) {
    console.error('[admin-future-students-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

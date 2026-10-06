// api/_lib/onboarding-overzicht-rijen.js
//
// DE RIJEN VAN HET ONBOARDINGOVERZICHT — één bouwer voor twee lezers:
//   - api/admin-future-students-list.js (het CRM-scherm, met gebruikers-JWT);
//   - api/lms-onboarding-overzicht.js   (het LMS, machine-route met x-dfo-secret).
//
// Verhuisd uit admin-future-students-list.js (5 oktober 2026) ZONDER
// gedragswijziging: het LMS hoort exact te tonen wat het CRM toont, en dat
// kan alleen als er één bouwer is. Nieuw is alleen het veld
// `dfo_lms_student_id`, zodat het LMS een rij aan zijn student kan koppelen.
//
// Gooit bij een leesfout op de verplichte bronnen; de aanroeper maakt er een
// 500 van. Faalzachte bronnen (wizard, deals, factuurstand) blijven faalzacht.

import { wizardVoltooid, onboardingAfgesloten, afgeslotenOp } from './onboarding-einde.js';
import { supabaseAdmin } from '../supabase.js';
import { deriveIntakeStatus, intakeStatusRank } from './intake-status.js';
import { computeBedenktijd, findWaiverConsentKey } from './onboarding-bedenktijd.js';
import { factuurstandPerKlant } from './factuurstand-spiegel.js';
import {
  findAvailabilityBlock,
  buildAvailabilityView,
} from './onboarding-wizard-default.js';

function escapeIlike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

function daysBetween(fromIso, toMs) {
  if (!fromIso) return null;
  const t = new Date(fromIso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((toMs - t) / (24 * 60 * 60 * 1000));
}

/**
 * @param {{ scope?: 'active'|'archived', qRaw?: string, mentorFilter?: string,
 *           wantNoMentor?: boolean, trajectFilter?: string }} opts
 * @returns {Promise<object[]>} de rijen, gesorteerd zoals het CRM-scherm
 */
export async function bouwOverzichtRijen(opts = {}) {
  const scope = opts.scope === 'archived' ? 'archived' : 'active';
  const qRaw = opts.qRaw || '';
  const mentorFilter = opts.mentorFilter || '';
  const wantNoMentor = !!opts.wantNoMentor;
  const trajectFilter = opts.trajectFilter || '';
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
               bubble_user_id, mentor_intake_status, dfo_lms_student_id,
               intake_handled_at, intake_handled_by,
               auto_afgerond_op, auto_afgerond_sessie_id, auto_afgerond_sessie_op, auto_afgerond_sessie_titel,
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
    if (list.length === 0) return [];

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
      factuurByCust,
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
      // ── 4d) De factuurstand per klant — DEZELFDE telling als de spiegel ──
      // naar het LMS (api/_lib/factuurstand-spiegel.js). Vier toestanden in
      // plaats van betaald/niet betaald. Faalzacht: lukt het lezen niet, dan
      // krijgt elke rij `factuur: null` en zegt de kolom "onbekend" — nooit
      // "open" en nooit een 500 voor het hele overzicht.
      (async () => {
        try {
          return await factuurstandPerKlant(customerIds);
        } catch (e) {
          console.error('[admin-future-students-list] factuurstand:', e?.message || e);
          return null;
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
        // `status = 'afgerond'` = WIZARD voltooid. Écht afgesloten is pas wat
        // een sessie afsloot (onboarding-einde.js, 6 okt 2026). Elk scherm
        // leest `afgesloten`, nooit de status, voor "onboarding afgerond".
        wizard_voltooid:      wizardVoltooid(r),
        afgesloten:           onboardingAfgesloten(r),
        afgesloten_op:        afgeslotenOp(r),
        afgesloten_sessie_op: onboardingAfgesloten(r) ? (r.auto_afgerond_sessie_op || null) : null,
        afgesloten_sessie_titel: onboardingAfgesloten(r) ? (r.auto_afgerond_sessie_titel || null) : null,
        assigned_at:          r.assigned_at,
        archived_at:          r.archived_at,
        token:                r.token,
        // Betaling + bedenktijd + beschikbaarheid:
        paid:                 paidSet.has(r.customer_id),
        // De ENE factuurstand: toestand + aantallen + label + ernst. De kolom
        // Betaling leest alleen dit veld. `null` = niet gelezen (onbekend).
        factuur:              factuurByCust ? (factuurByCust.get(String(r.customer_id)) || null) : null,
        waiver,
        bedenktijd,
        availability,
        // Bubble-provisioning:
        bubble_provisioned:    r.bubble_provisioned === true,
        bubble_provisioned_at: r.bubble_provisioned_at || null,
        bubble_provision_error: r.bubble_provision_error || null,
        bubble_user_id:        bu,
        // Het LMS-student-id (dfo-lms): de brug voor het LMS-overzicht.
        dfo_lms_student_id:    r.dfo_lms_student_id || null,
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
    return future;
}

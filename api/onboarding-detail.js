// api/onboarding-detail.js
//
// ADMIN — volledige onboarding-detailrij inclusief vragenlijst-antwoorden
// (jsonb), traject-info, mentor-naam en paid-vlag.
//
// Permission: onboarding.admin.
//
// Query:
//   ?id=<uuid>   (verplicht)
//
// Response 200:
//   { ok:true, onboarding:{ ...alle kolommen..., traject_label, traject_type,
//                           calls, duur_maanden, mentor_name, paid } }
// 404 bij onbekend id.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
import {
  findAvailabilityBlock,
  buildAvailabilityView,
} from './_lib/onboarding-wizard-default.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Loop door alle blokken van de gepubliceerde structuur en pak de
// consent_key van het EERSTE file_download/consent-blok met is_waiver=true.
// Geeft null wanneer geen waiver-blok bestaat.
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

// Berekent bedenktijd-status. waiver={agreed,at}|null, offerteOp=iso|null.
// Vervallen bij: (a) afstand-waiver, of (b) offerte+14d verstreken.
// Read-time pure functie — geen DB, geen cron; alle callers krijgen
// dezelfde shape.
function computeBedenktijd(waiver, offerteOp) {
  let vervaltOp = null;
  if (offerteOp) {
    const d = new Date(offerteOp);
    if (!isNaN(d)) { d.setDate(d.getDate() + 14); vervaltOp = d.toISOString(); }
  }
  const waived = waiver && waiver.agreed === true;
  if (waived)
    return { status:'vervallen', reason:'afstand',    waived_at:(waiver.at||null), offerte_op:offerteOp, vervalt_op:vervaltOp };
  if (vervaltOp && Date.now() > new Date(vervaltOp).getTime())
    return { status:'vervallen', reason:'verstreken', waived_at:null,              offerte_op:offerteOp, vervalt_op:vervaltOp };
  if (vervaltOp)
    return { status:'lopend',    reason:null,         waived_at:null,              offerte_op:offerteOp, vervalt_op:vervaltOp };
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

  // Fase 2a: scope-uitbreiding. Beide rollen mogen één detail opvragen,
  // maar een view_own-only-user mag uitsluitend z'n eigen onboardings —
  // die check doen we NA de DB-fetch (zie ownership-guard hieronder).
  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll && !scopeInfo.seesOwn) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin of onboarding.view_own)' });
  }

  const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    const { data: row, error: rowErr } = await supabaseAdmin
      .from('onboardings')
      .select(`id, customer_id, customer_name, traject_id, mentor_user_id,
               status, current_step, answers, token,
               started_at, completed_at, assigned_at, archived_at, start_date,
               created_by, created_at,
               bubble_provisioned, bubble_provisioned_at, bubble_provision_error, bubble_user_id,
               invite_sent_at,
               credentials_email_sent_at, credentials_wa_sent_at,
               mentor_intake_status,
               intake_handled_at, intake_handled_by,
               traject:onboarding_trajecten(label, type, calls, duur_maanden)`)
      .eq('id', id)
      .maybeSingle();
    if (rowErr) throw new Error('onboarding fetch: ' + rowErr.message);
    if (!row)  return res.status(404).json({ error: 'Onboarding niet gevonden' });

    // Fase 2a: ownership-guard. Een view_own-only-user mag uitsluitend
    // z'n eigen onboardings opvragen. Bewust 403 ipv 404 zodat de mentor
    // ziet dat de row bestaat maar niet zijn/haar is (geen info-leak via
    // raden van uuid's; alle uuid's zijn al 122-bit onkraakbaar).
    // seesAll-pad blijft ongewijzigd: skipt deze guard volledig.
    if (!scopeInfo.seesAll && row.mentor_user_id !== scopeInfo.userId) {
      return res.status(403).json({ error: 'Geen toegang tot deze onboarding' });
    }

    // Mentor-naam ophalen indien toegewezen.
    let mentorName = null;
    if (row.mentor_user_id) {
      const { data: tm, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('name')
        .eq('user_id', row.mentor_user_id)
        .maybeSingle();
      if (tmErr) throw new Error('team_member fetch: ' + tmErr.message);
      mentorName = tm?.name || null;
    }

    // Paid-vlag: heeft de klant ≥1 invoice met status='paid'.
    let paid = false;
    if (row.customer_id) {
      const { data: inv, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select('id')
        .eq('customer_id', row.customer_id)
        .eq('status', 'paid')
        .limit(1)
        .maybeSingle();
      if (invErr) throw new Error('invoices fetch: ' + invErr.message);
      paid = !!inv;
    }

    // Klant-contact: e-mail + telefoon voor mailto/tel-links in de
    // detail-modal. Fail-soft — lookup-fout mag de detail niet breken.
    let custEmail = null;
    let custPhone = null;
    if (row.customer_id) {
      try {
        const { data: cust } = await supabaseAdmin
          .from('customers')
          .select('email, phone')
          .eq('id', row.customer_id)
          .maybeSingle();
        custEmail = cust?.email || null;
        custPhone = cust?.phone || null;
      } catch (e) {
        console.warn('[onboarding-detail] customer contact fetch:', e?.message || e);
      }
    }

    // GEPUBLICEERDE wizard-structuur 1× per request laden voor twee
    // afgeleide velden:
    //   - waiver: consent_key uit het EERSTE blok met is_waiver=true.
    //   - availability: het EERSTE blok van type 'availability',
    //     gemapped naar label-vorm via buildAvailabilityView.
    // Fail-soft: bij DB-glitch of geen gepubliceerde structuur →
    // beide velden blijven null.
    let waiver       = null;
    let availability = null;
    try {
      const { data: wiz, error: wizErr } = await supabaseAdmin
        .from('onboarding_wizard')
        .select('published_structure')
        .eq('id', 1)
        .maybeSingle();
      if (wizErr) {
        console.warn('[onboarding-detail] wizard config fetch:', wizErr.message);
      } else {
        const pub = wiz?.published_structure;
        const ans = (row.answers && typeof row.answers === 'object') ? row.answers : {};
        const waiverKey = findWaiverConsentKey(pub);
        if (waiverKey) {
          waiver = {
            agreed : ans[waiverKey] === true,
            at     : ans[waiverKey + '_at'] || null,
          };
        }
        const availabilityBlock = findAvailabilityBlock(pub);
        availability = availabilityBlock ? buildAvailabilityView(availabilityBlock, ans) : null;
      }
    } catch (e) {
      console.warn('[onboarding-detail] wizard config exception:', e?.message || e);
    }

    // Bedenktijd (trigger b): meest recente getekende/geaccepteerde offerte
    // van deze klant. signed_at wint van accepted_at als beide gevuld zijn.
    // Geen deal of geen accepted_at → offerteOp blijft null → bedenktijd
    // status 'onbekend' (tenzij waiver al gezet → 'vervallen/afstand').
    let offerteOp = null;
    if (row.customer_id) {
      try {
        const { data: dl } = await supabaseAdmin
          .from('deals')
          .select('tl_quotation_accepted_at, tl_quotation_signed_at')
          .eq('customer_id', row.customer_id)
          .not('tl_quotation_accepted_at', 'is', null)
          .order('tl_quotation_accepted_at', { ascending: false })
          .limit(1).maybeSingle();
        if (dl) offerteOp = dl.tl_quotation_signed_at || dl.tl_quotation_accepted_at || null;
      } catch (e) {
        console.warn('[onboarding-detail] offerte fetch:', e?.message || e);
      }
    }
    const bedenktijd = computeBedenktijd(waiver, offerteOp);

    // Intake-status afleiding (Fase 2 read-only). Pakt bubble_user_id van de
    // toegewezen mentor + bubble_user_id van de student → 1-op-1 maps → past
    // de Fase-1 prioriteit toe (gedeelde helper). Fail-soft: Bubble-fout
    // betekent dat we terugvallen op enkel het handmatige veld + null voor
    // de afgeleide auto-statussen.
    let intake_status      = null;
    let planned_call_at    = null;
    let last_completed_at  = null;
    let last_noshow_at     = null;
    if (row.mentor_user_id) {
      try {
        const { data: mtm } = await supabaseAdmin
          .from('team_members')
          .select('bubble_user_id, is_active')
          .eq('user_id', row.mentor_user_id)
          .eq('is_active', true)
          .maybeSingle();
        const mentorBubble = mtm?.bubble_user_id ? String(mtm.bubble_user_id).trim() : null;
        if (mentorBubble && row.bubble_user_id) {
          const { fetchOneOnOneForMentor } = await import('./_lib/bubble-1on1.js');
          const ooo = await fetchOneOnOneForMentor(mentorBubble);
          const bu  = String(row.bubble_user_id);
          planned_call_at   = ooo.nextPlannedByMember.get(bu)       || null;
          last_completed_at = ooo.earliestCompletedByMember.get(bu) || null;
          last_noshow_at    = ooo.lastNoshowByMember.get(bu)        || null;
        }
        const { deriveIntakeStatus } = await import('./_lib/intake-status.js');
        intake_status = deriveIntakeStatus({
          hasCompletedSession:  !!last_completed_at,
          mentor_intake_status: row.mentor_intake_status || null,
          hasNoshow:            !!last_noshow_at,
          hasFutureCall:        !!planned_call_at,
        });
      } catch (e) {
        console.warn('[onboarding-detail] intake-status derive:', e?.message || e);
        // Fail-soft: alleen handmatige status of nog_te_benaderen.
        try {
          const { deriveIntakeStatus } = await import('./_lib/intake-status.js');
          intake_status = deriveIntakeStatus({
            hasCompletedSession:  false,
            mentor_intake_status: row.mentor_intake_status || null,
            hasNoshow:            false,
            hasFutureCall:        false,
          });
        } catch (_) {}
      }
    }

    // Mentor-update tijdlijn (Fase 2 admin read-only weergave). Asc op
    // created_at zodat de frontend rechtstreeks chronologisch kan tonen.
    let mentorUpdates = [];
    try {
      const { data: ups, error: upErr } = await supabaseAdmin
        .from('onboarding_mentor_updates')
        .select('kind, status, note, created_at, created_by')
        .eq('onboarding_id', row.id)
        .order('created_at', { ascending: true })
        .limit(500);
      if (upErr) {
        console.warn('[onboarding-detail] mentor_updates fetch:', upErr.message);
      } else {
        mentorUpdates = (ups || []).map((u) => ({
          kind:       u.kind || null,
          status:     u.status || null,
          note:       u.note || null,
          created_at: u.created_at || null,
          created_by: u.created_by || null,
        }));
      }
    } catch (e) {
      console.warn('[onboarding-detail] mentor_updates exception:', e?.message || e);
    }

    const t = row.traject || null;
    return res.status(200).json({
      ok: true,
      onboarding: {
        id             : row.id,
        customer_id    : row.customer_id,
        customer_name  : row.customer_name || null,
        email          : custEmail,
        phone          : custPhone,
        traject_id     : row.traject_id,
        traject_label  : t?.label         || null,
        traject_type   : t?.type          || null,
        calls          : t?.calls         || null,
        duur_maanden   : t?.duur_maanden  || null,
        mentor_user_id : row.mentor_user_id || null,
        mentor_name    : mentorName,
        status         : row.status,
        current_step   : row.current_step || null,
        answers        : row.answers || null,
        paid,
        waiver,
        bedenktijd,
        availability,
        token          : row.token,
        started_at     : row.started_at,
        completed_at   : row.completed_at,
        assigned_at    : row.assigned_at,
        archived_at    : row.archived_at,
        start_date     : row.start_date || null,
        created_by     : row.created_by || null,
        created_at     : row.created_at,
        bubble_provisioned     : row.bubble_provisioned === true,
        bubble_provisioned_at  : row.bubble_provisioned_at || null,
        bubble_provision_error : row.bubble_provision_error || null,
        bubble_user_id            : row.bubble_user_id || null,
        invite_sent_at            : row.invite_sent_at || null,
        credentials_email_sent_at : row.credentials_email_sent_at || null,
        credentials_wa_sent_at    : row.credentials_wa_sent_at || null,
        mentor_intake_status      : row.mentor_intake_status || null,
        mentor_updates            : mentorUpdates,
        intake_status             : intake_status || null,
        planned_call_at           : planned_call_at || null,
        last_completed_at         : last_completed_at || null,
        last_noshow_at            : last_noshow_at || null,
        intake_handled_at         : row.intake_handled_at || null,
        intake_handled_by         : row.intake_handled_by || null,
        // Afgehandeld is NIET permanent — pas geldig als er sinds
        // intake_handled_at geen nieuwere activiteit (mentor-update / no-show
        // / completed-call) is. PLANNED call telt NIET (toekomst-gedateerd).
        handled                   : (function () {
          if (!row.intake_handled_at) return false;
          const handledMs = new Date(row.intake_handled_at).getTime();
          let latest = 0;
          for (const u of mentorUpdates) {
            const t = u.created_at ? new Date(u.created_at).getTime() : 0;
            if (t > latest) latest = t;
          }
          if (last_noshow_at) {
            const t = new Date(last_noshow_at).getTime();
            if (t > latest) latest = t;
          }
          if (last_completed_at) {
            const t = new Date(last_completed_at).getTime();
            if (t > latest) latest = t;
          }
          return Number.isFinite(handledMs) && handledMs >= latest;
        })(),
      },
    });
  } catch (e) {
    console.error('[onboarding-detail]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

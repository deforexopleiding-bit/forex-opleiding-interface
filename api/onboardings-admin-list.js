// api/onboardings-admin-list.js
//
// ADMIN — lijst van onboardings met traject-info, toegewezen mentor en
// paid-vlag (heeft klant ≥1 invoice met status='paid'). Sorteer nieuwste
// eerst.
//
// Permission: onboarding.admin.
//
// Query (alle optioneel):
//   ?scope=active|archived   (active = status != 'gearchiveerd' [default];
//                             archived = status='gearchiveerd')
//   ?mentor_user_id=<uuid>
//   ?traject_id=<uuid>
//   ?q=<string>              (ilike op customer_name)
//
// Response 200:
//   { ok:true, rows:[ {
//       id, customer_id, customer_name,
//       traject_id, traject_label, traject_type, calls,
//       mentor_user_id, mentor_name,
//       status, current_step, paid,
//       started_at, completed_at, assigned_at, archived_at, created_at,
//       token
//   } ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
import {
  findAvailabilityBlock,
  buildAvailabilityView,
} from './_lib/onboarding-wizard-default.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeIlike(s) {
  return String(s || '').replace(/([%_,])/g, '\\$1');
}

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
// Gedupliceerd naast api/onboarding-detail.js' computeBedenktijd zodat
// beide endpoints dezelfde shape leveren (zelfde pattern als
// findWaiverConsentKey hierboven).
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

  // Fase 2a: scope-uitbreiding. seesAll == oude onboarding.admin-pad
  // (manager/super_admin). seesOwn == nieuwe onboarding.view_own (mentor
  // ziet alleen eigen studenten).
  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll && !scopeInfo.seesOwn) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin of onboarding.view_own)' });
  }

  const scopeRaw = typeof req.query?.scope === 'string' ? req.query.scope.trim().toLowerCase() : '';
  const scope = (scopeRaw === 'archived') ? 'archived' : 'active';

  // mentor_user_id-query-param mag alleen door seesAll-users gezet worden.
  // Een view_own-only user die per ongeluk OF expres ?mentor_user_id=<andere>
  // meestuurt mag NOOIT andermans rijen zien — daarom forceren we 'm hieronder
  // op userId, ongeacht wat de query zegt.
  const mentorFilter = typeof req.query?.mentor_user_id === 'string' ? req.query.mentor_user_id.trim() : '';
  if (scopeInfo.seesAll && mentorFilter && !UUID_RE.test(mentorFilter)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
  }
  const trajectFilter = typeof req.query?.traject_id === 'string' ? req.query.traject_id.trim() : '';
  if (trajectFilter && !UUID_RE.test(trajectFilter)) {
    return res.status(400).json({ error: 'traject_id (uuid) ongeldig' });
  }
  const qRaw = typeof req.query?.q === 'string' ? req.query.q.trim() : '';

  try {
    let q = supabaseAdmin
      .from('onboardings')
      .select(`id, customer_id, customer_name, traject_id, mentor_user_id,
               status, current_step, answers, started_at, completed_at, assigned_at,
               start_date,
               archived_at, created_at, token,
               bubble_provisioned, bubble_provisioned_at, bubble_provision_error, bubble_user_id,
               traject:onboarding_trajecten(label, type, calls)`)
      .order('created_at', { ascending: false })
      .limit(1000)
      // Fase 3b — verberg test-onboardings (automation-tester) uit de echte
      // admin-lijst. Test-rijen zijn herkenbaar aan customer_name-prefix
      // 'TEST · ' maar de is_test boolean is autoritatief.
      .eq('is_test', false);
    if (scope === 'archived') q = q.eq('status', 'gearchiveerd');
    else                       q = q.neq('status', 'gearchiveerd');
    // Fase 2a: data-isolatie. Een view_own-only-user krijgt ALTIJD een
    // hard server-side filter op z'n eigen userId, ongeacht of de client
    // (per ongeluk of expres) een ander mentor_user_id meestuurt. Voor
    // seesAll-users blijft het bestaande gedrag: optionele filter via
    // ?mentor_user_id=. Volgorde is belangrijk — eerst gate, dan optionele
    // admin-filter zou onnodig zijn want de userId-filter is al strenger.
    if (!scopeInfo.seesAll) {
      q = q.eq('mentor_user_id', scopeInfo.userId);
    } else if (mentorFilter) {
      q = q.eq('mentor_user_id', mentorFilter);
    }
    if (trajectFilter) q = q.eq('traject_id',     trajectFilter);
    if (qRaw)          q = q.ilike('customer_name', `%${escapeIlike(qRaw)}%`);

    const { data: rows, error: rowErr } = await q;
    if (rowErr) throw new Error('onboardings fetch: ' + rowErr.message);
    const list = rows || [];

    // Mentor-naam ophalen per uniek mentor_user_id — zelfde pattern als
    // assessments-admin-list / funded-certs-admin-list.
    const mentorIds = Array.from(new Set(list.map((r) => r.mentor_user_id).filter(Boolean)));
    const nameMap = new Map();
    if (mentorIds.length > 0) {
      const { data: tmRows, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('user_id, name')
        .in('user_id', mentorIds);
      if (tmErr) throw new Error('team_members fetch: ' + tmErr.message);
      for (const r of (tmRows || [])) {
        if (r.user_id && r.name) nameMap.set(r.user_id, r.name);
      }
    }

    // Paid-vlag per uniek customer_id: bestaat er ≥1 invoice met status='paid'?
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

    // GEPUBLICEERDE wizard-structuur 1× per request laden voor twee
    // afgeleide velden per row:
    //   - waiverKey: consent_key van het EERSTE blok met is_waiver=true.
    //   - availabilityBlock: het EERSTE blok van type 'availability'
    //     (gebruikt om antwoorden naar labels te resolven).
    // Geen gepubliceerde structuur / geen blok → respectievelijke vlag
    // blijft null en elke row krijgt waiver=null / availability=null.
    let waiverKey         = null;
    let availabilityBlock = null;
    try {
      const { data: wiz, error: wizErr } = await supabaseAdmin
        .from('onboarding_wizard')
        .select('published_structure')
        .eq('id', 1)
        .maybeSingle();
      if (wizErr) {
        console.warn('[onboardings-admin-list] wizard config fetch:', wizErr.message);
      } else {
        const pub = wiz?.published_structure;
        waiverKey         = findWaiverConsentKey(pub);
        availabilityBlock = findAvailabilityBlock(pub);
      }
    } catch (e) {
      console.warn('[onboardings-admin-list] wizard config exception:', e?.message || e);
    }

    // Gebatchte deals-lookup voor bedenktijd (trigger b): per uniek
    // customer_id de meest recente getekende/geaccepteerde offerte.
    // Fail-soft: bij DB-glitch blijft dealByCust leeg en valt elke row
    // terug op offerteOp=null → bedenktijd status 'onbekend' (of
    // 'vervallen/afstand' als de waiver al gezet is).
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
          console.warn('[onboardings-admin-list] deals fetch:', dlErr.message);
        } else {
          for (const d of (dls || [])) {
            if (d?.customer_id && !dealByCust[d.customer_id]) dealByCust[d.customer_id] = d; // eerste = meest recent
          }
        }
      } catch (e) {
        console.warn('[onboardings-admin-list] deals exception:', e?.message || e);
      }
    }

    const out = list.map((r) => {
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
        id             : r.id,
        customer_id    : r.customer_id,
        customer_name  : r.customer_name || null,
        traject_id     : r.traject_id,
        traject_label  : t?.label || null,
        traject_type   : t?.type  || null,
        calls          : t?.calls || null,
        mentor_user_id : r.mentor_user_id || null,
        mentor_name    : r.mentor_user_id ? (nameMap.get(r.mentor_user_id) || null) : null,
        status         : r.status,
        current_step   : r.current_step || null,
        paid           : paidSet.has(r.customer_id),
        waiver,
        bedenktijd,
        availability,
        started_at     : r.started_at,
        completed_at   : r.completed_at,
        assigned_at    : r.assigned_at,
        start_date     : r.start_date || null,
        archived_at    : r.archived_at,
        created_at     : r.created_at,
        token          : r.token,
        bubble_provisioned     : r.bubble_provisioned === true,
        bubble_provisioned_at  : r.bubble_provisioned_at || null,
        bubble_provision_error : r.bubble_provision_error || null,
        bubble_user_id         : r.bubble_user_id || null,
      };
    });

    return res.status(200).json({ ok: true, rows: out });
  } catch (e) {
    console.error('[onboardings-admin-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

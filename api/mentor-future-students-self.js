// api/mentor-future-students-self.js
//
// SELF — onboardings die aan de ingelogde mentor zijn toegewezen en nog
// niet gearchiveerd. Voedt de "Toekomstige studenten"-tab in het mentor-
// dashboard.
//
// Permission: mentor.module.access.
//
// Response 200: rijke shape (spiegel van api/admin-future-students-list per-row)
//   { ok:true, students:[ {
//       onboarding_id, customer_name, customer_email, customer_phone,
//       traject_label, traject_type, traject_calls, traject_duur_maanden,
//       status, current_step, current_step_index, total_steps,
//       paid, bedenktijd:{ status, vervalt_op, ... },
//       availability,
//       started_at, completed_at, created_at, start_date,
//       bubble_user_id, bubble_provisioned, bubble_provisioned_at, bubble_provision_error,
//       mentor_intake_status,
//       credentials_email_sent_at,
//       answers,
//       updates:[{ kind, status, note, created_at, created_by }]
//   } ] }  // sort: created_at desc

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  findAvailabilityBlock,
  buildAvailabilityView,
} from './_lib/onboarding-wizard-default.js';

// Spiegel van findWaiverConsentKey + computeBedenktijd in
// api/admin-future-students-list.js (zelfde semantiek; geen _lib-export).
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
// Bouwt een leesbare vraag→antwoord-lijst uit de gepubliceerde wizard-
// structuur. Per blok pakken we (label, value) waarbij value uit answers
// komt op block.key of block.consent_key. Skipt blocks zonder bruikbare
// key/label, lege antwoorden, of techn-only blocks (file_download zonder
// answer-payload, layout-blocks). availability is een aparte sectie in
// de UI — we leveren 'm hier dus NIET nog eens als regel.
const SKIP_BLOCK_TYPES = new Set([
  'availability', 'instructions', 'rich_text', 'heading', 'image',
  'divider', 'spacer', 'video', 'pdf', 'card', 'page_break',
]);
function buildAnswersView(structure, answers) {
  if (!structure || typeof structure !== 'object') return [];
  if (!answers   || typeof answers   !== 'object') return [];
  const pages = Array.isArray(structure.pages) ? structure.pages : [];
  const out = [];
  for (const p of pages) {
    for (const b of (p?.blocks || [])) {
      if (!b || (b.type && SKIP_BLOCK_TYPES.has(b.type))) continue;
      const k = b.key || b.consent_key || null;
      if (!k) continue;
      // Label-fallback: title → label → question → text → key.
      const labelRaw = b.title || b.label || b.question || b.text || k;
      const label = String(labelRaw).trim();
      if (!label) continue;
      const v = answers[k];
      if (v == null) continue;
      if (typeof v === 'string' && v.trim() === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      let display = '';
      let isBool = false;
      if (typeof v === 'boolean') {
        display = v ? 'Ja' : 'Nee';
        isBool = true;
      } else if (Array.isArray(v)) {
        display = v.map((x) => (x == null ? '' : String(x))).filter(Boolean).join(', ');
      } else if (typeof v === 'object') {
        try { display = JSON.stringify(v); } catch { display = ''; }
      } else {
        display = String(v);
      }
      if (!display) continue;
      out.push({
        key:    k,
        label,
        value:  display,
        type:   b.type || null,
        is_bool: isBool,
      });
    }
  }
  return out;
}
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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  try {
    const { data: rows, error: rowErr } = await supabaseAdmin
      .from('onboardings')
      .select(`id, customer_id, customer_name, status, current_step,
               answers,
               started_at, completed_at, created_at, start_date,
               bubble_user_id, mentor_intake_status,
               bubble_provisioned, bubble_provisioned_at, bubble_provision_error,
               credentials_email_sent_at, token,
               traject:onboarding_trajecten(label, type, calls, duur_maanden)`)
      .eq('mentor_user_id', user.id)
      .neq('status', 'gearchiveerd')
      .order('created_at', { ascending: false })
      .limit(500);
    if (rowErr) throw new Error('onboardings fetch: ' + rowErr.message);
    const list = rows || [];

    // Tijdlijn per onboarding — één batched query, geen N+1. Sort ascending zodat
    // de frontend ze chronologisch kan tonen (oudst eerst) en synth-events
    // (call ingepland / call gestart) er gewoon tussengevoegd kunnen worden.
    const updatesByOnb = new Map();
    const obIds = list.map((r) => r.id).filter(Boolean);
    if (obIds.length > 0) {
      const { data: ups, error: upErr } = await supabaseAdmin
        .from('onboarding_mentor_updates')
        .select('onboarding_id, kind, status, note, created_at, created_by')
        .in('onboarding_id', obIds)
        .order('created_at', { ascending: true })
        .limit(10000);
      if (upErr) throw new Error('mentor_updates fetch: ' + upErr.message);
      for (const u of (ups || [])) {
        const key = u.onboarding_id;
        if (!key) continue;
        if (!updatesByOnb.has(key)) updatesByOnb.set(key, []);
        updatesByOnb.get(key).push({
          kind:       u.kind || null,
          status:     u.status || null,
          note:       u.note || null,
          created_at: u.created_at || null,
          created_by: u.created_by || null,
        });
      }
    }

    // Paid-vlag per unieke customer_id — zelfde pattern als onboardings-admin-list.
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

    // Availability-blok + waiver-key 1× per request resolven uit de
    // GEPUBLICEERDE wizard-structuur. We berekenen daarmee ook bedenktijd
    // per row (zelfde semantiek als api/admin-future-students-list.js).
    let availabilityBlock = null;
    let waiverKey         = null;
    let totalSteps        = null; // voor wizard-voortgang in de popup
    let publishedStructure = null; // voor buildAnswersView per row
    try {
      const { data: wiz, error: wizErr } = await supabaseAdmin
        .from('onboarding_wizard')
        .select('published_structure')
        .eq('id', 1)
        .maybeSingle();
      if (wizErr) {
        console.warn('[mentor-future-students-self] wizard config fetch:', wizErr.message);
      } else {
        const pub = wiz?.published_structure;
        publishedStructure = pub || null;
        availabilityBlock = findAvailabilityBlock(pub);
        waiverKey         = findWaiverConsentKey(pub);
        const pages = Array.isArray(pub?.pages) ? pub.pages : [];
        totalSteps = pages.length || null;
      }
    } catch (e) {
      console.warn('[mentor-future-students-self] wizard config exception:', e?.message || e);
    }

    // Klantgegevens (email + phone) batched op customer_id.
    const customerMap = new Map();
    if (customerIds.length > 0) {
      try {
        const { data: custs, error: custErr } = await supabaseAdmin
          .from('customers')
          .select('id, email, phone, first_name, last_name')
          .in('id', customerIds);
        if (custErr) {
          console.warn('[mentor-future-students-self] customers fetch:', custErr.message);
        } else {
          for (const c of (custs || [])) customerMap.set(c.id, c);
        }
      } catch (e) {
        console.warn('[mentor-future-students-self] customers exception:', e?.message || e);
      }
    }

    // Deal-lookup voor bedenktijd: meest recente getekende/geaccepteerde
    // offerte per customer_id (zelfde pattern als admin-future-students-list).
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
          console.warn('[mentor-future-students-self] deals fetch:', dlErr.message);
        } else {
          for (const d of (dls || [])) {
            if (d?.customer_id && !dealByCust[d.customer_id]) dealByCust[d.customer_id] = d;
          }
        }
      } catch (e) {
        console.warn('[mentor-future-students-self] deals exception:', e?.message || e);
      }
    }

    const students = list.map((r) => {
      const ans = (r.answers && typeof r.answers === 'object') ? r.answers : {};
      const availability = availabilityBlock ? buildAvailabilityView(availabilityBlock, ans) : null;
      const t = r.traject || null;
      const cust = customerMap.get(r.customer_id) || null;
      const waiver = waiverKey
        ? { agreed: ans[waiverKey] === true, at: ans[waiverKey + '_at'] || null }
        : null;
      const dealRow = r.customer_id ? (dealByCust[r.customer_id] || null) : null;
      const offerteOp = dealRow ? (dealRow.tl_quotation_signed_at || dealRow.tl_quotation_accepted_at || null) : null;
      const bedenktijd = computeBedenktijd(waiver, offerteOp);
      const answersView = publishedStructure ? buildAnswersView(publishedStructure, ans) : [];
      return {
        onboarding_id        : r.id,
        customer_name        : r.customer_name || null,
        customer_email       : cust?.email || null,
        customer_phone       : cust?.phone || null,
        traject_label        : t?.label || null,
        traject_type         : t?.type  || null,
        traject_calls        : t?.calls || null,
        traject_duur_maanden : t?.duur_maanden || null,
        status               : r.status,
        current_step         : r.current_step || null,
        total_steps          : totalSteps,
        paid                 : paidSet.has(r.customer_id),
        waiver,
        bedenktijd,
        availability,
        started_at           : r.started_at,
        completed_at         : r.completed_at,
        start_date           : r.start_date || null,
        created_at           : r.created_at || null,
        token                : r.token || null,
        bubble_user_id       : r.bubble_user_id || null,
        bubble_provisioned     : r.bubble_provisioned === true,
        bubble_provisioned_at  : r.bubble_provisioned_at || null,
        bubble_provision_error : r.bubble_provision_error || null,
        credentials_email_sent_at : r.credentials_email_sent_at || null,
        mentor_intake_status : r.mentor_intake_status || null,
        answers              : ans,
        answers_view         : answersView,
        updates              : updatesByOnb.get(r.id) || [],
      };
    });

    return res.status(200).json({ ok: true, students });
  } catch (e) {
    console.error('[mentor-future-students-self]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

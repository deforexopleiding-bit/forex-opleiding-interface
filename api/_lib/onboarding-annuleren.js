// api/_lib/onboarding-annuleren.js
//
// DE ANNULERING VAN EEN STUDENT — één uitvoering voor twee knoppen
// (Maxim, 6 oktober 2026):
//   - "Student annuleren" in het CRM-detailscherm (api/onboarding-cancel.js);
//   - "Student annuleren" in Hoofdmentor › Onboarding in het LMS
//     (api/lms-onboarding-annuleren.js, machine-route met x-dfo-secret).
// Verhuisd uit onboarding-cancel.js ZONDER de bestaande stappen te wijzigen.
//
// ── DE STAPPEN ──────────────────────────────────────────────────────────
//   a) facturen crediteren in Teamleader (niet betaald, geen concept, niet
//      volledig gecrediteerd) — ALLE facturen van de klant;
//   b) abonnementen deactiveren (Teamleader + lokaal 'cancelled');
//   c) offertes/deals: quotations.delete + deals.lose + lokaal gearchiveerd;
//   d) (vervallen 9 okt 2026: Bubble-einddatum/login uit — Bubble gaat dicht;
//      de toegang sluit nu alleen nog in het LMS, stap i);
//   e) onboardings.status = 'geannuleerd';
//   f) record in onboarding_cancellations (met alle stappen);
//   g) interne meldingen (app, niet naar de klant);
//   h) NIEUW: lopende onboarding-automaties stoppen — anders kon een
//      geannuleerde klant nog mails/WhatsApps van een lopende automatie krijgen;
//   i) NIEUW: de toegang tot het LMS dicht — hlms_student.eind_datum op
//      gisteren, hetzelfde mechanisme als "Toegang intrekken" in het LMS
//      (alleen als de einddatum later ligt of leeg is; de vorige waarde komt in
//      de stappen, om te kunnen herstellen);
//   j) NIEUW: het antwoord op "Discord verwijderd?" (alleen vanuit het LMS
//      gevraagd) op de tijdlijn; bij "nee" een open kaart "Discord nog
//      verwijderen" bij de administratie in het LMS.
// Elke stap heeft zijn eigen try/catch; één mislukte stap stopt de rest niet.
// Er gaat NIETS rechtstreeks naar de klant.
//
// IDEMPOTENT: al geannuleerd → { already_cancelled: true }, niets opnieuw.

import { supabaseAdmin } from '../supabase.js';
import { tlFetch, getActiveToken } from './teamleader-token.js';
import { createNotification } from './notify.js';
import { spiegelNaActie } from './onboarding-spiegel.js';
import { getDfoLmsClient } from './dfo-lms-db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tlCall(path, body, attempt = 0) {
  await sleep(150);
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) {
    await sleep(2000 * Math.pow(2, attempt));
    return tlCall(path, body, attempt + 1);
  }
  return r;
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function inclPerTerm(sub) {
  const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (lines.length > 0) {
    return lines.reduce((sum, li) =>
      sum + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100), 0);
  }
  return (Number(sub.amount) || 0) * (1 + (Number(sub.vat_percentage) || 0) / 100);
}


// Welke facturen crediteren we?
//   - status NIET 'concept'  (creditten kan niet, finance-invoice-credit weigert 409)
//   - status NIET 'paid'     (al volledig betaald — crediteren = onnodige boekhoud-actie)
//   - credited_amount < amount_total (niet al volledig gecrediteerd; voorkomt dubbele credits ook
//     wanneer de orchestrator twee keer ongelukkig aangeroepen wordt op een rij die net door een
//     andere admin handmatig is gecrediteerd)
function shouldCreditInvoice(inv) {
  const status = String(inv?.status || '').toLowerCase();
  if (!status) return false;
  if (status === 'concept' || status === 'paid') return false;
  const total    = Number(inv?.amount_total)    || 0;
  const credited = Number(inv?.credited_amount) || 0;
  if (total <= 0) return false;
  if (credited + 0.01 >= total) return false; // 1ct tolerantie (consistent met arrangements-propose)
  return true;
}

export async function gatherContext(onboardingId) {
  // 1) onboarding zelf
  const { data: ob, error: obErr } = await supabaseAdmin
    .from('onboardings')
    .select('id, customer_id, customer_name, mentor_user_id, bubble_user_id, dfo_lms_student_id, status')
    .eq('id', onboardingId)
    .maybeSingle();
  if (obErr) throw new Error('onboarding fetch: ' + obErr.message);
  if (!ob) return { ob: null };
  const customerId = ob.customer_id || null;

  // 2) facturen — alle van deze klant, te crediteren = subset.
  let invoices = [];
  if (customerId) {
    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select('id, tl_invoice_id, invoice_number, amount_total, credited_amount, status')
      .eq('customer_id', customerId)
      .limit(500);
    if (error) throw new Error('invoices fetch: ' + error.message);
    invoices = (data || []).filter(shouldCreditInvoice);
  }

  // 3) abonnementen — actief (status != 'cancelled').
  let subscriptions = [];
  if (customerId) {
    // Subscriptions koppelen via deal → customer. Variant op sales-subscriptions-list.
    const { data: deals } = await supabaseAdmin
      .from('deals')
      .select('id')
      .eq('customer_id', customerId)
      .limit(200);
    const dealIds = (deals || []).map((d) => d.id);
    if (dealIds.length > 0) {
      const { data: subs, error: subErr } = await supabaseAdmin
        .from('subscriptions')
        .select('id, deal_id, description, amount, vat_percentage, term_count, status, teamleader_subscription_id, line_items')
        .in('deal_id', dealIds)
        .neq('status', 'cancelled')
        .limit(200);
      if (subErr) throw new Error('subscriptions fetch: ' + subErr.message);
      subscriptions = subs || [];
    }
  }

  // 4) offertes/deals — niet al-gearchiveerde.
  let deals = [];
  if (customerId) {
    const { data, error } = await supabaseAdmin
      .from('deals')
      .select('id, tl_deal_id, tl_quotation_id, quote_reference, archived_at')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .limit(200);
    if (error) throw new Error('deals fetch: ' + error.message);
    deals = data || [];
  }

  const subscription_value = r2(
    subscriptions.reduce((sum, s) => sum + inclPerTerm(s), 0),
  );

  return { ob, invoices, subscriptions, deals, subscription_value };
}


/** Gisteren als kalenderdag in Brussel (YYYY-MM-DD). PURE. */
export function gisterenBrussel(nu = new Date()) {
  const vandaag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(nu);
  const d = new Date(vandaag + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Moet de LMS-einddatum naar gisteren? Alleen als ze leeg is of later ligt. PURE. */
export function moetToegangDicht(eindDatum, gisteren) {
  if (!eindDatum) return true;
  return String(eindDatum).slice(0, 10) > gisteren;
}

/** De samenvatting voor het bevestigingsvenster — leest alleen. */
export async function annuleringVoorbeeld(onboardingId) {
  const ctx = await gatherContext(onboardingId);
  if (!ctx.ob) return null;
  return {
    preview:             true,
    already_cancelled:   String(ctx.ob.status || '').toLowerCase() === 'geannuleerd',
    customer_name:       ctx.ob.customer_name || null,
    lms_student_id:      ctx.ob.dfo_lms_student_id || null,
    invoices: ctx.invoices.map((i) => ({
      id: i.id, invoice_number: i.invoice_number, amount_total: r2(i.amount_total),
      credited_amount: r2(i.credited_amount || 0), status: i.status, will_credit: true,
    })),
    subscriptions: ctx.subscriptions.map((s) => ({
      id: s.id, description: s.description, amount_incl: r2(inclPerTerm(s)), status: s.status,
    })),
    subscription_value: ctx.subscription_value,
    offertes: ctx.deals.map((d) => ({ id: d.id, tl_quotation_reference: d.quote_reference })),
  };
}

/**
 * Voer de annulering uit.
 * @param {{ onboardingId: string, reden: string, doorUserId: string, doorLabel?: string,
 *           discordVerwijderd?: boolean|null, via?: string }} p
 * @returns {Promise<{status: number, body: object}>}
 */
export async function voerAnnuleringUit({ onboardingId, reden, doorUserId, doorLabel = null, discordVerwijderd = null, via = 'crm' }) {
  const ctx = await gatherContext(onboardingId);
  if (!ctx.ob) return { status: 404, body: { error: 'Onboarding niet gevonden.' } };
  if (String(ctx.ob.status || '').toLowerCase() === 'geannuleerd') {
    return { status: 200, body: { ok: true, already_cancelled: true } };
  }
  const reasonRaw = typeof reden === 'string' ? reden.trim() : '';
  if (!reasonRaw) return { status: 400, body: { error: 'reason is verplicht bij execute.' } };
  const reason = reasonRaw.slice(0, 2000);
  const user = { id: doorUserId };

    const steps = {
      automaties_gestopt:     { ok: false },
      lms_toegang:            { ok: false },
      discord:                { ok: true, skipped: true },
      invoices_credit:        { ok: false, results: [] },
      subscriptions_deactivate: { ok: false, results: [] },
      offertes_cancel:        { ok: false, results: [] },
      onboarding_status:      { ok: false },
      cancellation_record:    { ok: false },
      notify_mentor:          { ok: false },
    };

    // a) Facturen crediteren — per factuur try/catch, falende factuur stopt
    //    de loop NIET (anderen worden alsnog gecrediteerd).
    {
      const out = [];
      let allOk = true;
      for (const inv of ctx.invoices) {
        const rec = { invoice_id: inv.id, invoice_number: inv.invoice_number, tl_invoice_id: inv.tl_invoice_id || null };
        try {
          if (!inv.tl_invoice_id) { rec.ok = false; rec.error = 'geen TL-id'; allOk = false; out.push(rec); continue; }
          const r = await tlCall('/invoices.credit', { id: inv.tl_invoice_id, description: 'Onboarding annulering' });
          if (!r.ok) {
            const txt = await r.text().catch(() => '');
            rec.ok = false;
            rec.error = `TL HTTP ${r.status}: ${(txt || '').slice(0, 200)}`;
            allOk = false;
          } else {
            let creditId = null;
            try { creditId = (await r.json())?.data?.id || null; } catch {}
            rec.ok = true;
            rec.tl_credit_note_id = creditId;
          }
        } catch (e) {
          rec.ok = false;
          rec.error = e?.message || String(e);
          allOk = false;
        }
        out.push(rec);
      }
      steps.invoices_credit = { ok: allOk, results: out };
    }

    // b) Abonnement(en) deactiveren — TL + lokaal status='cancelled'.
    {
      const out = [];
      let allOk = true;
      for (const sub of ctx.subscriptions) {
        const rec = { subscription_id: sub.id, teamleader_subscription_id: sub.teamleader_subscription_id || null };
        try {
          if (sub.teamleader_subscription_id) {
            const r = await tlCall('/subscriptions.deactivate', { id: sub.teamleader_subscription_id });
            if (!r.ok) {
              const txt = await r.text().catch(() => '');
              rec.tl_ok = false;
              rec.tl_error = `HTTP ${r.status}: ${(txt || '').slice(0, 200)}`;
              // Geen TL-deactivatie maar wel doorgaan met lokaal stopzetten
              // (consistent met sales-subscription-delete force-pad).
            } else {
              rec.tl_ok = true;
            }
          } else {
            rec.tl_skipped = true;
          }
          const { error: upErr } = await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'cancelled' })
            .eq('id', sub.id);
          if (upErr) { rec.local_ok = false; rec.local_error = upErr.message; allOk = false; }
          else       { rec.local_ok = true;  rec.ok = true; }
          if (rec.tl_ok === false) allOk = false;
        } catch (e) {
          rec.ok = false; rec.error = e?.message || String(e); allOk = false;
        }
        out.push(rec);
      }
      steps.subscriptions_deactivate = { ok: allOk, results: out };
    }

    // c) Offertes/deals annuleren — TL best-effort + lokaal archived_at.
    {
      const out = [];
      let allOk = true;
      const tlTok = await getActiveToken().catch(() => null);
      for (const deal of ctx.deals) {
        const rec = { deal_id: deal.id, tl_deal_id: deal.tl_deal_id || null, tl_quotation_id: deal.tl_quotation_id || null };
        try {
          if (tlTok && deal.tl_quotation_id) {
            try {
              const r = await tlCall('/quotations.delete', { id: deal.tl_quotation_id });
              rec.tl_quotation_ok = r.ok;
              if (!r.ok) rec.tl_quotation_error = `HTTP ${r.status}`;
            } catch (e) { rec.tl_quotation_ok = false; rec.tl_quotation_error = e?.message || String(e); }
          }
          if (tlTok && deal.tl_deal_id) {
            try {
              const r = await tlCall('/deals.lose', { id: deal.tl_deal_id });
              rec.tl_deal_ok = r.ok;
              if (!r.ok) rec.tl_deal_error = `HTTP ${r.status}`;
            } catch (e) { rec.tl_deal_ok = false; rec.tl_deal_error = e?.message || String(e); }
          }
          const nowIso = new Date().toISOString();
          const { error: upErr } = await supabaseAdmin
            .from('deals')
            .update({ archived_at: nowIso, tl_quotation_declined_at: nowIso })
            .eq('id', deal.id);
          if (upErr) { rec.local_ok = false; rec.local_error = upErr.message; allOk = false; }
          else       { rec.local_ok = true;  rec.ok = true; }
        } catch (e) {
          rec.ok = false; rec.error = e?.message || String(e); allOk = false;
        }
        out.push(rec);
      }
      steps.offertes_cancel = { ok: allOk, results: out };
    }

    // e) onboardings.status='geannuleerd'.
    try {
      const { error: upErr } = await supabaseAdmin
        .from('onboardings')
        .update({ status: 'geannuleerd' })
        .eq('id', onboardingId);
      if (upErr) throw new Error(upErr.message);
      steps.onboarding_status = { ok: true };
    } catch (e) {
      steps.onboarding_status = { ok: false, error: e?.message || String(e) };
    }

    // f) Cancellation-record met snapshot. KRITIEK voor audit + omzet-impact.
    let cancellationId = null;
    try {
      const { data: rec, error: insErr } = await supabaseAdmin
        .from('onboarding_cancellations')
        .insert({
          onboarding_id:      onboardingId,
          customer_id:        ctx.ob.customer_id || null,
          customer_name:      ctx.ob.customer_name || null,
          cancelled_by:       user.id,
          reason,
          subscription_value: ctx.subscription_value,
          steps,
        })
        .select('id')
        .single();
      if (insErr) throw new Error(insErr.message);
      cancellationId = rec?.id || null;
      steps.cancellation_record = { ok: true, id: cancellationId };
    } catch (e) {
      steps.cancellation_record = { ok: false, error: e?.message || String(e) };
    }


    // h) Lopende onboarding-automaties stoppen (6 okt 2026, Maxim).
    try {
      const nowIso = new Date().toISOString();
      const { data: gestopt, error: autErr } = await supabaseAdmin
        .from('onboarding_automation_runs')
        .update({ status: 'cancelled', next_run_at: null, last_error: 'onboarding geannuleerd', updated_at: nowIso })
        .eq('onboarding_id', onboardingId)
        .eq('status', 'active')
        .select('id');
      if (autErr) throw new Error(autErr.message);
      steps.automaties_gestopt = { ok: true, aantal: (gestopt || []).length };
    } catch (e) {
      steps.automaties_gestopt = { ok: false, error: e?.message || String(e) };
    }

    // i) De LMS-toegang dicht: eind_datum op gisteren (6 okt 2026, Maxim).
    let lmsStudentId = ctx.ob.dfo_lms_student_id || null;
    try {
      const lms = getDfoLmsClient();
      if (!lms) {
        steps.lms_toegang = { ok: false, error: 'LMS-koppeling niet geconfigureerd' };
      } else {
        // Historische koppelsleutel (uit Bubble geïmporteerde studenten zonder
        // dfo_lms_student_id op de onboarding) — alleen een DB-lookup, geen Bubble.
        if (!lmsStudentId && ctx.ob.bubble_user_id) {
          const { data: viaBubble } = await lms.from('hlms_student').select('id').eq('bubble_user_id', ctx.ob.bubble_user_id).limit(2);
          if ((viaBubble || []).length === 1) lmsStudentId = viaBubble[0].id;
        }
        if (!lmsStudentId) {
          steps.lms_toegang = { ok: true, skipped: true, reason: 'geen-lms-student' };
        } else {
          const { data: st, error: stErr } = await lms.from('hlms_student').select('id, eind_datum').eq('id', lmsStudentId).maybeSingle();
          if (stErr) throw new Error(stErr.message);
          if (!st) {
            steps.lms_toegang = { ok: true, skipped: true, reason: 'lms-student-niet-gevonden' };
          } else {
            const gisteren = gisterenBrussel();
            if (!moetToegangDicht(st.eind_datum, gisteren)) {
              steps.lms_toegang = { ok: true, skipped: true, reason: 'al-verlopen', eind_datum: st.eind_datum };
            } else {
              const { error: upErr } = await lms.from('hlms_student').update({ eind_datum: gisteren }).eq('id', lmsStudentId);
              if (upErr) throw new Error(upErr.message);
              steps.lms_toegang = { ok: true, student_id: lmsStudentId, eind_datum: gisteren, vorige_eind_datum: st.eind_datum || null };
            }
          }
        }
      }
    } catch (e) {
      steps.lms_toegang = { ok: false, error: e?.message || String(e) };
    }

    // j) Discord (alleen gevraagd vanuit het LMS).
    if (discordVerwijderd === true || discordVerwijderd === false) {
      const door = doorLabel || 'onbekend';
      try {
        const { error: tlErr } = await supabaseAdmin.from('onboarding_mentor_updates').insert({
          onboarding_id: onboardingId, kind: 'note', status: null, created_by: doorUserId || null,
          note: 'Geannuleerd door ' + door + (via === 'lms' ? ' via het LMS' : '') + '. Uit de Discord verwijderd: '
            + (discordVerwijderd ? 'ja' : 'nee — taak "Discord nog verwijderen" bij de administratie') + '.',
        });
        if (tlErr) throw new Error(tlErr.message);
        steps.discord = { ok: true, verwijderd: discordVerwijderd, door, op: new Date().toISOString() };
      } catch (e) {
        steps.discord = { ok: false, verwijderd: discordVerwijderd, error: e?.message || String(e) };
      }
      if (discordVerwijderd === false) {
        try {
          const kaart = await maakDiscordKaart({ studentId: lmsStudentId, naam: ctx.ob.customer_name, door });
          steps.discord.taak = kaart;
        } catch (e) {
          steps.discord.taak = { ok: false, error: e?.message || String(e) };
        }
      }
    }

    // De record kreeg de stappen tot f); werk hem bij met h) tot j).
    if (cancellationId) {
      const { error: recErr } = await supabaseAdmin.from('onboarding_cancellations').update({ steps }).eq('id', cancellationId);
      if (recErr) console.error('[onboarding-annuleren] stappen bijwerken: ' + recErr.message);
    }

    // g) Mentor- + management-melding (in de app), fail-soft.
    steps.notify_mentor = ctx.ob.mentor_user_id ? { ok: true } : { ok: true, skipped: true, reason: 'geen-mentor' };
    const custNameCancel = ctx.ob.customer_name || 'De student';
    if (ctx.ob.mentor_user_id) {
      createNotification({
        toUserId:   ctx.ob.mentor_user_id,
        type:       'onboarding.cancelled',
        title:      'Student geannuleerd' + (ctx.ob.customer_name ? (' · ' + ctx.ob.customer_name) : ''),
        body:       custNameCancel,
        linkUrl:    '/modules/mentor-onboarding.html',
        entityType: 'onboarding',
        entityId:   onboardingId,
        createdBy:  doorUserId,
      }).catch(() => {});
    }
    createNotification({
      toRole:     ['manager', 'super_admin'],
      type:       'onboarding.cancelled',
      title:      'Student geannuleerd' + (ctx.ob.customer_name ? (' · ' + ctx.ob.customer_name) : ''),
      body:       custNameCancel,
      linkUrl:    '/modules/onboarding-hub.html',
      entityType: 'onboarding',
      entityId:   onboardingId,
      createdBy:  doorUserId,
    }).catch(() => {});

    // Spiegel naar het LMS: bij een annulering een verwijdering.
    await spiegelNaActie(ctx.ob.id, 'onboarding-cancel');

    return { status: 200, body: { ok: true, cancellation_id: cancellationId, subscription_value: ctx.subscription_value, steps } };
}

/**
 * De kaart "Discord nog verwijderen" bij de administratie in het LMS: een
 * gewone kaart in de bak `admin`, die Dave afvinkt in zijn lijst.
 */
async function maakDiscordKaart({ studentId, naam, door }) {
  if (!studentId) return { ok: false, error: 'geen LMS-student: maak de taak met de hand aan' };
  const lms = getDfoLmsClient();
  if (!lms) return { ok: false, error: 'LMS-koppeling niet geconfigureerd' };
  const nu = new Date().toISOString();
  const tekst = (naam || 'Deze student') + ' is geannuleerd door ' + (door || 'onbekend')
    + ', maar nog NIET uit de Discord verwijderd. Verwijder hem en vink dit af.';
  const { data, error } = await lms.from('hlms_signaal').insert({
    onderwerp: 'student', student_id: studentId, soort: 'discord_verwijderen', zwaarte: 'oranje',
    status: 'nieuw', bron: 'handmatig', bak: 'admin', eerste_op: nu, laatst_gezien_op: nu,
    bewijs: { reden: tekst, gemeld_op: nu, melding: 'discord_verwijderen' },
  }).select('id').single();
  if (error) throw new Error(error.message);
  const { error: gErr } = await lms.from('hlms_signaal_gebeurtenis').insert({ signaal_id: data.id, soort: 'geopend', tekst });
  if (gErr) console.warn('[onboarding-annuleren] tijdlijn van de kaart: ' + gErr.message);
  return { ok: true, signaal_id: data.id };
}

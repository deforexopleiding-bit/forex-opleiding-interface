// api/cron-toegang-aanvragen.js
//
// DEEL C — Cron-motor van de WhatsApp-gate. Draait elke minuut (vercel.json).
// Verwerkt public.toegang_aanvragen:
//   1) Bevestiging (na ~2 min na aanmelding) — WA-template + e-mail
//   2) Reminders op bevestiging+2u / +24u / +48u
//   3) Vervallen: 24u na 48u-reminder zonder reactie → status='vervallen'
//   4) Dag-6 check-in (alleen 7-daagse, status='gereageerd' + provisioned)
//
// Regels — spiegelt cron-leadsonderhoud.js:
//   - Nacht-venster: niets tussen 21:00 en 08:00 (Amsterdam)
//   - Droogloopstand default AAN; live pas als TOEGANG_AANVRAGEN_LIVE === '1'
//   - Fail-soft per rij; één fout mag de rest van de batch niet blokkeren
//
// Template-namen (aan te dienen in Meta Business Manager door Jeffrey):
//   bevestig_toegang_a    (call_geboekt=true;  vars: [voornaam])
//   bevestig_toegang_b    (call_geboekt=false; vars: [voornaam, call_link])
//   reminder_toegang_2u   (vars: [voornaam])
//   reminder_toegang_24u  (vars: [voornaam])
//   reminder_toegang_48u  (vars: [voornaam])
//   dag6_checkin_a        (call_geboekt=true;  vars: [voornaam])
//   dag6_checkin_b        (call_geboekt=false; vars: [voornaam, call_link])
//
// 0 incasso-writes.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { sendTemplate, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { sendWelkomMail } from './mailer.js';
import { logOutboundWa } from './_lib/wa-outbound-log.js';

const NACHT_START_HOUR = 21;
const NACHT_EIND_HOUR  = 8;
const VERVALLEN_UREN_NA_48U = 24;   // na 48u-reminder + 24u zonder reactie → vervallen
const DAG6_UREN = 6 * 24;

// Statische call-link (voorlopig). Per-bron dynamisch = latere optie.
const CALL_LINK = 'https://deforexopleiding.nl/agenda';

// v=5 (2026-08-28): expliciete afzendlijn = welkom-nummer via bestaande
// whatsapp_module_config-rij module='leadsonderhoud' (label "Esmee" —
// phone_number_id 1232908829908396 = DFO Welkom 0644642495).
//
// Waarom NIET module='welkom' upserten: de omgekeerde lookup
// getModuleContextByPhoneNumberId (module-context.js) verwacht een UNIEK
// phone_number_id. Een tweede rij met hetzelfde nummer zou de inbound-
// routing van bestaande Esmee-flows (via inbox-webhook) ambigu maken en
// stilletjes breken (maybeSingle zou random één rij pakken).
//
// Reacties komen via GHL binnen op ditzelfde welkom-nummer (Esmee/leadsonderhoud
// is er al voor geconfigureerd) → thread-consistentie is gegarandeerd.
// Fallback: WELKOM_WHATSAPP_PHONE_NUMBER_ID env als noodpad bij DB-lookup-fout.
async function resolveWelkomPhoneId() {
  try {
    const { data } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'leadsonderhoud')
      .eq('is_active', true)
      .maybeSingle();
    if (data?.phone_number_id) return String(data.phone_number_id).trim();
  } catch (e) {
    console.warn('[cron-toegang-aanvragen] leadsonderhoud-phone lookup (soft):', e?.message || e);
  }
  return process.env.WELKOM_WHATSAPP_PHONE_NUMBER_ID || null;
}

// ── E-mail-templates (named constants, makkelijk aanpasbaar) ───────────
// Body-generatoren: (voornaam, callMoment?) → { subject, text, html }
const MAIL_BEVESTIGING_A = (voornaam, callMoment) => {
  const naam = voornaam || 'daar';
  const moment = callMoment || 'het geplande moment';
  return {
    subject: 'Nog één stapje — check je WhatsApp ✅',
    text:
      `Hoi ${naam},\n\n` +
      `Je aanvraag is binnen, en je opstartsessie staat genoteerd voor ${moment}. ` +
      `We hebben je zojuist een berichtje via WhatsApp gestuurd — reageer daar even op ` +
      `(een "ja" volstaat), dan ontvang je meteen je persoonlijke inloggegevens in je mailbox.\n\n` +
      `Tot snel! Team De Forex Opleiding`,
    html:
      `<p>Hoi ${naam},</p>` +
      `<p>Je aanvraag is binnen, en je opstartsessie staat genoteerd voor <b>${moment}</b>. ` +
      `We hebben je zojuist een berichtje via WhatsApp gestuurd — reageer daar even op ` +
      `(een "ja" volstaat), dan ontvang je meteen je persoonlijke inloggegevens in je mailbox.</p>` +
      `<p>Tot snel!<br>Team De Forex Opleiding</p>`,
  };
};

const MAIL_BEVESTIGING_B = (voornaam) => {
  const naam = voornaam || 'daar';
  return {
    subject: 'Nog één stapje — check je WhatsApp ✅',
    text:
      `Hoi ${naam},\n\n` +
      `Je aanvraag is binnen! We hebben je zojuist een berichtje via WhatsApp gestuurd — ` +
      `reageer daar even op (een "ja" volstaat), dan ontvang je meteen je persoonlijke ` +
      `inloggegevens in je mailbox.\n\n` +
      `Heb je nog geen kennismakingscall ingepland? Doe dat hier even, dan halen we samen ` +
      `het meeste uit je start: ${CALL_LINK}\n\n` +
      `Tot zo! Team De Forex Opleiding`,
    html:
      `<p>Hoi ${naam},</p>` +
      `<p>Je aanvraag is binnen! We hebben je zojuist een berichtje via WhatsApp gestuurd — ` +
      `reageer daar even op (een "ja" volstaat), dan ontvang je meteen je persoonlijke ` +
      `inloggegevens in je mailbox.</p>` +
      `<p>Heb je nog geen kennismakingscall ingepland? Doe dat <a href="${CALL_LINK}">hier</a> ` +
      `even, dan halen we samen het meeste uit je start.</p>` +
      `<p>Tot zo!<br>Team De Forex Opleiding</p>`,
  };
};

const MAIL_DAG6_A = (voornaam) => {
  const naam = voornaam || 'daar';
  return {
    subject: 'Morgen je laatste dag — hoe was het?',
    text:
      `Hoi ${naam},\n\n` +
      `Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ` +
      `ervaren hebt — reageer gerust even, ik hoor het graag!\n\n` +
      `Groet, Team De Forex Opleiding`,
    html:
      `<p>Hoi ${naam},</p>` +
      `<p>Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ` +
      `ervaren hebt — reageer gerust even, ik hoor het graag!</p>` +
      `<p>Groet,<br>Team De Forex Opleiding</p>`,
  };
};

const MAIL_DAG6_B = (voornaam) => {
  const naam = voornaam || 'daar';
  return {
    subject: 'Morgen je laatste dag — hoe was het?',
    text:
      `Hoi ${naam},\n\n` +
      `Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ` +
      `ervaren hebt — reageer gerust even, ik hoor het graag!\n\n` +
      `En wil je er echt mee verder? Plan hier een gratis opstartsessie in, dan kijken we ` +
      `samen wat bij je past: ${CALL_LINK}\n\n` +
      `Groet, Team De Forex Opleiding`,
    html:
      `<p>Hoi ${naam},</p>` +
      `<p>Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ` +
      `ervaren hebt — reageer gerust even, ik hoor het graag!</p>` +
      `<p>En wil je er echt mee verder? Plan <a href="${CALL_LINK}">hier</a> een gratis ` +
      `opstartsessie in, dan kijken we samen wat bij je past.</p>` +
      `<p>Groet,<br>Team De Forex Opleiding</p>`,
  };
};

// Fail-soft lookup: haal het geplande call-moment op voor een aanvraag met
// call_geboekt=true. Match op telefoon (last-9-digits) tegen
// follow_up_appointments met scheduled_at in de toekomst. Retourneert een
// leesbare NL-string of null. Zelfde last-9-pattern als de webhook-hook.
async function haalCallMoment(a) {
  const digits = String(a.telefoon || '').replace(/\D/g, '');
  if (!digits) return null;
  const last9 = digits.slice(-9);
  try {
    const { data } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('scheduled_at, lead_phone')
      .gte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(50);
    const match = (data || []).find((r) => {
      const rd = String(r.lead_phone || '').replace(/\D/g, '');
      return rd && (rd === digits || rd.slice(-9) === last9);
    });
    if (!match?.scheduled_at) return null;
    return new Date(match.scheduled_at).toLocaleString('nl-NL', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam',
    });
  } catch (e) {
    console.warn('[cron-toegang-aanvragen] callMoment lookup (soft):', e?.message || e);
    return null;
  }
}

// Template-config per moment/variant.
const TEMPLATES = {
  // bevestig_a is approved met 2 variabelen ({{1}}=voornaam, {{2}}=call-moment).
  // Fallback-vars hier (zonder callMoment-lookup) valt terug op 'het geplande
  // moment' zodat Meta niet 132000 (aantal-vars-mismatch) reject. De bev-loop
  // roept haalCallMoment(a) 1× aan en geeft dan een varsOverride mee zodat de
  // echte call-datum gebruikt wordt.
  bevestig_a:   { name: 'bevestig_toegang_a',  vars: (a) => [a.voornaam || 'daar', 'het geplande moment'] },
  bevestig_b:   { name: 'bevestig_toegang_b',  vars: (a) => [a.voornaam || 'daar', process.env.OPSTARTSESSIE_CALL_URL || 'https://deforexopleiding.nl/agenda'] },
  reminder_2u:  { name: 'reminder_toegang_2u', vars: (a) => [a.voornaam || 'daar'] },
  reminder_24u: { name: 'reminder_toegang_24u',vars: (a) => [a.voornaam || 'daar'] },
  reminder_48u: { name: 'reminder_toegang_48u_v3',vars: (a) => [a.voornaam || 'daar'] },
  dag6_a:       { name: 'dag6_checkin_a',      vars: (a) => [a.voornaam || 'daar'] },
  dag6_b:       { name: 'dag6_checkin_b',      vars: (a) => [a.voornaam || 'daar', process.env.OPSTARTSESSIE_CALL_URL || 'https://deforexopleiding.nl/agenda'] },
};

function aanUit(v) {
  return ['1','true','aan','on','ja'].includes(String(v||'').trim().toLowerCase());
}

// Amsterdam-uur (respecteert DST).
function amsUur(ms) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam', hourCycle: 'h23', hour: '2-digit',
  });
  return Number(dtf.format(new Date(ms)));
}

function isNacht(nowMs) {
  const u = amsUur(nowMs);
  return u >= NACHT_START_HOUR || u < NACHT_EIND_HOUR;
}

async function stuurWa(a, cfg, live, welkomPhoneId, varsOverride) {
  if (!live) {
    console.log('[cron-toegang-aanvragen] DROOG:', cfg.name, '->', a.telefoon, '(via welkom:', !!welkomPhoneId, ')');
    return { ok: true, dry: true };
  }
  if (!welkomPhoneId) {
    // Defensieve check: zonder welkom-phone_number_id zou een send naar het
    // finance-nummer gaan (bug-gedrag). SKIP + log — is minder erg dan de
    // bug opnieuw reproduceren.
    console.warn('[cron-toegang-aanvragen] welkom phone_number_id niet resolvable (whatsapp_module_config + env-fallback beide leeg) — SKIP send om nummer-mismatch te voorkomen');
    return { ok: false, skipped: true, error: 'welkom-phone-id-ontbreekt' };
  }
  // v=7 (2026-08-28): varsOverride ondersteunt template-vars die een async
  // lookup vereisen (bv. bevestig_toegang_a: {{2}}=call-moment via
  // haalCallMoment(a) in de bev-loop). Zonder override: fallback op de
  // synchronous cfg.vars(a) — backward-compat voor reminders/dag6/etc.
  const variables = Array.isArray(varsOverride) ? varsOverride : cfg.vars(a);
  try {
    const { wamid } = await sendTemplate({
      to: a.telefoon,
      templateName: cfg.name,
      languageCode: 'nl',
      variables,
      phoneNumberId: welkomPhoneId,     // v=4: expliciete welkom-lijn (DB-lookup)
    });
    // v=9 (2026-08-30) — log outbound naar whatsapp_messages. De helper rendert
    // zelf de body uit whatsapp_meta_templates.body_text + vars-substitutie
    // (via templateName + templateVariables). `body` hieronder is enkel de
    // fallback als de template niet vindbaar/rendereerbaar is.
    const varsAsMap = {};
    variables.forEach((v, i) => { varsAsMap[String(i + 1)] = String(v); });
    const fallbackBody = `WhatsApp-template '${cfg.name}' — ${variables.join(' · ')}`;
    await logOutboundWa(supabaseAdmin, {
      toPhone: a.telefoon,
      phoneNumberId: welkomPhoneId,
      body: fallbackBody,
      wamid,
      templateName: cfg.name,
      templateVariables: varsAsMap,
      source: 'toegang-gate-cron',
    });
    return { ok: true, wamid, template: cfg.name };
  } catch (e) {
    if (e instanceof MetaNotConfiguredError) {
      return { ok: false, skipped: true, error: 'meta-niet-geconfigureerd', template: cfg.name };
    }
    // v=6 (2026-08-28): rijkere error-info uit Meta throwErr zodat we in
    // de cron-summary + persisted trace exact zien wat Meta reject'te
    // (bv. code 132001 template-niet-bestaand, 131047 24u-venster-verlopen,
    // 132000 aantal-vars-mismatch). Bron: _lib/meta-whatsapp.js
    // metaPostMessage hangt deze velden aan de Error.
    return {
      ok: false, error: e?.message || String(e),
      template: cfg.name,
      http_status: e?.httpStatus ?? null,
      meta_code: e?.metaCode ?? null,
      meta_subcode: e?.metaSubcode ?? null,
      meta_message: e?.metaMessage ?? null,
      meta_details: e?.metaDetails ?? null,
      meta_fbtrace: e?.metaFbtrace ?? null,
    };
  }
}

async function stuurMail(a, subject, text, html, live) {
  if (!live) { console.log('[cron-toegang-aanvragen] DROOG mail ->', a.email, subject); return { ok: true, dry: true }; }
  try {
    const r = await sendWelkomMail({ to: a.email, subject, text, html: html || `<p>${text}</p>` });
    return { ok: !!r?.success, messageId: r?.messageId || null, error: r?.error || null };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  // v=2 (2026-08-28) FIX: checkCronAuth retourneert een OBJECT {ok, status?, body?},
  // niet een boolean. Vorige versie deed `if (authRes !== true) return 401` →
  // ALTIJD 401 (want authRes is een object, nooit letterlijk true). Gevolg:
  // elke Vercel-cron-invocation kreeg 401, cron draaide effectief nooit,
  // toegang_aanvragen.status='wachtend' bleef eeuwig hangen ondanks aanwezige
  // rij + LIVE=1 + deploy. Nu identiek aan cron-leadsonderhoud.js:66-67.
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const live = aanUit(process.env.TOEGANG_AANVRAGEN_LIVE);
  const now  = new Date();
  const nowMs = now.getTime();
  // v=4 (2026-08-28): eenmaal per run resolve — hergebruikt in alle
  // stuurWa-aanroepen. DB-lookup op whatsapp_module_config (module='welkom').
  const welkomPhoneId = await resolveWelkomPhoneId();
  const summary = {
    live, dry: !live,
    welkom_phone: welkomPhoneId ? 'ok' : 'ontbreekt',
    bevestiging: 0, reminders_2u: 0, reminders_24u: 0, reminders_48u: 0,
    vervallen: 0, dag6: 0, provisioning_calls: 0,
    errors: [],
    items: [],   // v=6: per-lead outcome (id/wa/mail/step) voor observability
  };

  // Nacht-guard geldt alleen voor het VERZENDEN, niet voor status-transities
  // zoals 'vervallen' (die is stille administratie).
  const nachtNu = isNacht(nowMs);

  // ── Atomic claim/unclaim helpers (v=10 2026-08-30) ─────────────────────
  // Concurrent cron-runs kunnen dezelfde rij tegelijk SELECTen zolang de
  // guard-kolom (bevestiging_sent_at / reminder_*_at / dag6_sent_at) nog
  // NULL is. Vóór v=10 werd de guard PAS NA de send gezet → race-window
  // → duplicate Meta-sends bij runs die overlappen (bv. cron elke minuut +
  // 50 rijen × 1-3s Meta-round-trip = run > 60s → 2-3 parallelle runs
  // pikken dezelfde rij op).
  //
  // Fix: atomic claim — probeer de kolom te zetten met een WHERE-guard
  // die eist dat 'ie NULL is. Postgres UPDATE is atomair per-rij: 2
  // concurrent UPDATEs met identieke WHERE zien allebei het pre-image,
  // maar Postgres serialiseert → tweede krijgt 0 rows RETURNING. De
  // race-loser retourneert null en slaat de send stil over.
  //
  // Bij een send-fout wordt de guard weer op NULL gezet zodat een volgende
  // run 'em opnieuw kan proberen (voorkomt dat een transiente Meta-fout
  // een lead z'n bevestiging/reminder kost).
  async function claimRow(id, kolom) {
    try {
      const { data, error } = await supabaseAdmin
        .from('toegang_aanvragen')
        .update({ [kolom]: new Date().toISOString() })
        .eq('id', id)
        .is(kolom, null)                          // ← atomic guard
        .select('id')
        .maybeSingle();
      if (error) {
        console.warn(`[cron-toegang-aanvragen] claim ${kolom} fail (soft):`, error.message);
        return false;
      }
      return !!(data && data.id);
    } catch (e) {
      console.warn(`[cron-toegang-aanvragen] claim ${kolom} exception (soft):`, e?.message || e);
      return false;
    }
  }
  async function unclaimRow(id, kolom) {
    try {
      await supabaseAdmin
        .from('toegang_aanvragen')
        .update({ [kolom]: null })
        .eq('id', id);
    } catch (e) {
      console.warn(`[cron-toegang-aanvragen] unclaim ${kolom} exception (soft):`, e?.message || e);
    }
  }

  // ── 1) BEVESTIGING (created_at + 2 min) ────────────────────────────────
  if (!nachtNu) try {
    const grens = new Date(nowMs - 2 * 60 * 1000).toISOString();
    const { data: rows } = await supabaseAdmin
      .from('toegang_aanvragen')
      .select('id, voornaam, email, telefoon, soort, call_geboekt, created_at')
      .eq('status', 'wachtend')
      .is('bevestiging_sent_at', null)
      .lte('created_at', grens)
      .limit(50);
    for (const a of (rows || [])) {
      // Atomic claim VÓÓR de sends. Race-loser (andere concurrent cron-run
      // die dezelfde rij zag) krijgt hier `false` en slaat de rij over.
      const gotClaim = await claimRow(a.id, 'bevestiging_sent_at');
      if (!gotClaim) continue;

      const cfg = a.call_geboekt ? TEMPLATES.bevestig_a : TEMPLATES.bevestig_b;
      // v=7 (2026-08-28): Flow A callMoment 1× ophalen — hergebruikt voor
      // ZOWEL WA-template ({{2}}) ALS mail. bevestig_toegang_a is approved
      // met 2 variabelen ({{1}}=voornaam, {{2}}=call-moment); vorige versie
      // gaf er maar 1 mee → Meta 132000 rejection. Voor B geen wijziging
      // (1 variabele, klopt met approved template).
      let callMoment = null;
      let waVarsOverride;
      if (a.call_geboekt) {
        callMoment = await haalCallMoment(a);
        waVarsOverride = [a.voornaam || 'daar', callMoment || 'het geplande moment'];
      }
      const wa  = await stuurWa(a, cfg, live, welkomPhoneId, waVarsOverride);
      // Mail A/B via named constants. A hergebruikt callMoment (fail-soft
      // fallback in MAIL_BEVESTIGING_A: 'het geplande moment').
      let mailPayload;
      if (a.call_geboekt) {
        mailPayload = MAIL_BEVESTIGING_A(a.voornaam, callMoment);
      } else {
        mailPayload = MAIL_BEVESTIGING_B(a.voornaam);
      }
      const mail = await stuurMail(a, mailPayload.subject, mailPayload.text, mailPayload.html, live);
      const okAny = wa.ok || mail.ok;
      // v=6: onafhankelijk WA+mail. Per-item rijk resultaat naar summary.items
      // (wamid + mail-messageId + meta-code bij fail) zodat we via admin-endpoint
      // kunnen zien wat Meta/SMTP zei — óók bij ok:true, want dat is alleen
      // 'API-accepted', geen bewijs van bezorging aan user.
      summary.items.push({
        id: a.id, step: 'bevestiging', voornaam: a.voornaam, soort: a.soort, call_geboekt: !!a.call_geboekt,
        wa  : { ok: wa.ok, template: wa.template || null, wamid: wa.wamid || null,
                error: wa.error || null, meta_code: wa.meta_code || null, meta_details: wa.meta_details || null,
                meta_fbtrace: wa.meta_fbtrace || null, http_status: wa.http_status || null },
        mail: { ok: mail.ok, messageId: mail.messageId || null, error: mail.error || null },
        bev_flag_gezet: okAny,
      });
      if (okAny) {
        summary.bevestiging++;
      } else {
        // Beide kanalen faalden → rollback claim zodat een volgende run
        // opnieuw probeert. Voorkomt dat een transiente Meta+SMTP-fout
        // de bevestiging permanent skipt.
        await unclaimRow(a.id, 'bevestiging_sent_at');
        summary.errors.push({ id: a.id, step: 'bevestiging', wa: wa.error, mail: mail.error });
      }
    }
  } catch (e) { summary.errors.push({ step: 'bevestiging-loop', error: e?.message || String(e) }); }

  // ── 2) REMINDERS ────────────────────────────────────────────────────────
  if (!nachtNu) for (const [uren, kolom, cfgKey, counter] of [
    [ 2, 'reminder_2u_at',  'reminder_2u',  'reminders_2u'  ],
    [24, 'reminder_24u_at', 'reminder_24u', 'reminders_24u' ],
    [48, 'reminder_48u_at', 'reminder_48u', 'reminders_48u' ],
  ]) try {
    const grens = new Date(nowMs - uren * 3600 * 1000).toISOString();
    const { data: rows } = await supabaseAdmin
      .from('toegang_aanvragen')
      .select('id, voornaam, telefoon, call_geboekt, bevestiging_sent_at')
      .eq('status', 'wachtend')
      .not('bevestiging_sent_at', 'is', null)
      .is(kolom, null)
      .lte('bevestiging_sent_at', grens)
      .limit(50);
    for (const a of (rows || [])) {
      // Atomic claim VÓÓR de send. Race-loser slaat over.
      const gotClaim = await claimRow(a.id, kolom);
      if (!gotClaim) continue;

      const wa = await stuurWa(a, TEMPLATES[cfgKey], live, welkomPhoneId);
      if (wa.ok) {
        summary[counter]++;
      } else {
        // Rollback: reminder faalde → guard weer op NULL zodat 'ie
        // in de volgende run opnieuw wordt geprobeerd.
        await unclaimRow(a.id, kolom);
        summary.errors.push({ id: a.id, step: `reminder-${uren}u`, error: wa.error });
      }
    }
  } catch (e) { summary.errors.push({ step: `reminder-loop-${uren}`, error: e?.message || String(e) }); }

  // ── 3) VERVALLEN — 24u na 48u-reminder zonder reactie ──────────────────
  try {
    const grens = new Date(nowMs - VERVALLEN_UREN_NA_48U * 3600 * 1000).toISOString();
    const { data: rows } = await supabaseAdmin
      .from('toegang_aanvragen')
      .select('id')
      .eq('status', 'wachtend')
      .not('reminder_48u_at', 'is', null)
      .lte('reminder_48u_at', grens)
      .limit(200);
    for (const a of (rows || [])) {
      await supabaseAdmin.from('toegang_aanvragen')
        .update({ status: 'vervallen', vervallen_at: new Date().toISOString() })
        .eq('id', a.id);
      summary.vervallen++;
    }
  } catch (e) { summary.errors.push({ step: 'vervallen-loop', error: e?.message || String(e) }); }

  // ── 4) DAG-6 CHECK-IN (alleen 7-daagse, gereageerd + provisioned) ─────
  if (!nachtNu) try {
    const grens = new Date(nowMs - DAG6_UREN * 3600 * 1000).toISOString();
    const { data: rows } = await supabaseAdmin
      .from('toegang_aanvragen')
      .select('id, voornaam, email, telefoon, call_geboekt, provisioned_at')
      .eq('status', 'gereageerd')
      .eq('soort', '7-daagse')
      .not('provisioned_at', 'is', null)
      .is('dag6_sent_at', null)
      .lte('provisioned_at', grens)
      .limit(50);
    for (const a of (rows || [])) {
      // Atomic claim VÓÓR WA+mail. Race-loser slaat over. Bij dubbele
      // sends van dag-6 zou een lead 2 identieke check-in-berichten
      // krijgen — zelfde race-familie als de bevestiging + reminders.
      const gotClaim = await claimRow(a.id, 'dag6_sent_at');
      if (!gotClaim) continue;

      // WA + mail parallel (fail-soft per kanaal).
      const cfg = a.call_geboekt ? TEMPLATES.dag6_a : TEMPLATES.dag6_b;
      const wa  = await stuurWa(a, cfg, live, welkomPhoneId);
      const mailPayload = a.call_geboekt ? MAIL_DAG6_A(a.voornaam) : MAIL_DAG6_B(a.voornaam);
      const mail = await stuurMail(a, mailPayload.subject, mailPayload.text, mailPayload.html, live);
      const okAny = wa.ok || mail.ok;
      if (okAny) {
        summary.dag6++;
      } else {
        // Beide kanalen faalden → rollback zodat de dag-6 in de volgende
        // run opnieuw wordt geprobeerd.
        await unclaimRow(a.id, 'dag6_sent_at');
        summary.errors.push({ id: a.id, step: 'dag6', wa: wa.error, mail: mail.error });
      }
    }
  } catch (e) { summary.errors.push({ step: 'dag6-loop', error: e?.message || String(e) }); }

  // v=6 (2026-08-28): persist summary naar follow_up_events_log ALLEEN als
  // er echt iets is gebeurd (items/errors > 0 of reminders/dag6/vervallen
  // getriggerd). Vermijdt een lege trace elke minuut wanneer er niks te
  // doen is. Fail-soft — cron-response gaat altijd door.
  const heeftActie = (summary.items?.length || 0) > 0
    || (summary.errors?.length || 0) > 0
    || summary.reminders_2u > 0 || summary.reminders_24u > 0 || summary.reminders_48u > 0
    || summary.dag6 > 0 || summary.vervallen > 0;
  if (heeftActie) {
    try {
      await supabaseAdmin
        .from('follow_up_events_log')
        .insert({
          source:     'cron',
          event_type: 'toegang-cron-run',
          payload:    summary,
          processed:  true,
        });
    } catch (persistErr) {
      console.warn('[cron-toegang-aanvragen] summary-persist (soft):', persistErr?.message || persistErr);
    }
  }

  return res.status(200).json(summary);
}

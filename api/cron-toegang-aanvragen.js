// api/cron-toegang-aanvragen.js
//
// DEEL C — Cron-motor van de WhatsApp-gate. Draait elke minuut (vercel.json).
// Verwerkt public.toegang_aanvragen:
//   1)  Bevestiging (na ~2 min na aanmelding) — WA-template + e-mail
//   2)  Reminders op bevestiging+2u / +24u / +48u
//   2b) Provisioning retry — belProvisioning opnieuw voor rijen die op
//       status='gereageerd' + provisioned_at NULL + provisioned_error <> NULL
//       staan (typisch: gate-timeout). Window 72u, atomic claim,
//       verstuurt bij succes alsnog de welkom-WA.
//   3)  Vervallen: 24u na 48u-reminder zonder reactie → status='vervallen'
//   4)  Dag-6 check-in (alleen 7-daagse, status='gereageerd' + provisioned)
//
// Regels:
//   - 24/7 draaien: geen nacht-venster meer (2026-09-10 verwijderd; late
//     aanmeldingen kregen anders pas de ochtend erna hun bevestiging + de
//     hele reminder-cadans schoof mee op)
//   - Droogloopstand default AAN; live pas als TOEGANG_AANVRAGEN_LIVE === '1'
//   - Fail-soft per rij; één fout mag de rest van de batch niet blokkeren
//
// Template-namen (aan te dienen in Meta Business Manager door Jeffrey):
//   bevestig_toegang_a    (call_geboekt=true;  vars: [voornaam])
//   bevestig_toegang_b    (call_geboekt=false; vars: [voornaam] — statische URL-knop)
//   reminder_toegang_2u   (vars: [voornaam])
//   reminder_toegang_24u  (vars: [voornaam])
//   reminder_toegang_48u  (vars: [voornaam])
//   dag6_checkin_a        (call_geboekt=true;  vars: [voornaam])
//   dag6_checkin_b        (call_geboekt=false; vars: [voornaam, call_link])
//
// 0 incasso-writes.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { sendTemplate, sendText, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { sendWelkomMail, sendMail, getAdminRecipients, wrapEmailHtml } from './mailer.js';
import { logOutboundWa } from './_lib/wa-outbound-log.js';
import { belProvisioning } from './_lib/toegang-provisioning-caller.js';
// E-mail-builders (welkom/bevestiging + dag-6) staan als pure render-functies in
// een gedeelde module, zodat de E-mails-tab er ook een echte preview van rendert.
import { mailBevestigingA, mailBevestigingB, mailDag6A, mailDag6B } from './_lib/toegang-cron-mails.js';

// 2026-09-10 — Nacht-venster verwijderd. Bevestigingen + reminders + dag-6
// draaien 24/7. `cron-leadsonderhoud` blijft z'n eigen stille uren houden
// (aparte drip-motor met andere semantiek); die aanpassing is bewust NIET
// doorgevoerd hier.
const VERVALLEN_UREN_NA_48U = 24;   // na 48u-reminder + 24u zonder reactie → vervallen
const DAG6_UREN = 6 * 24;

// Retry-window voor provisioning-fails. Voorbij 72u draaien we niet meer
// automatisch — te oude leads moeten via de admin-UI/handmatig ingrijpen.
const PROVISIONING_RETRY_WINDOW_UREN = 72;
// Klein per tick zodat een backlog nooit het tijdsbudget van de */2-cron
// (bevestigingen/reminders) kan opeten. Bij een retry-only tick van 5 ×
// max 20s = 100s ruimte; nog steeds ruim binnen 300s Vercel-limit met
// marge voor de overige loops. Drains vanzelf over meerdere ticks.
const PROVISIONING_RETRY_BATCH_LIMIT = 5;

// Cap + exponentiële backoff (2026-09-17). Na PROVISIONING_RETRY_MAX_ATTEMPTS
// pogingen zonder succes zetten we provisioning_gaveup_at en verzenden éénmalig
// een admin-alarm-mail. Voorheen bonkte een structureel falende lead elke
// */2-min tick door tot reacted_at 72u oud was — ~2160 identieke pogingen,
// zonder mens-signaal. Backoff: wait tussen poging N-1 en N is
// min(60 * 2^(N-1), 3600) sec → 60s, 2m, 4m, 8m, 16m, 32m, 60m; totaal
// ~2u 3min vóór opgeven, ruim binnen het 72u-venster.
const PROVISIONING_RETRY_MAX_ATTEMPTS = 7;
const PROVISIONING_RETRY_BASE_BACKOFF_SEC = 60;
const PROVISIONING_RETRY_MAX_BACKOFF_SEC = 3600;
// Iets ruimer selecteren dan het batch-limit, zodat we client-side kunnen
// filteren op backoff-ready zonder een tweede DB-hop.
const PROVISIONING_RETRY_CANDIDATE_LIMIT = 20;
// Alarm-mail: max notify's per tick — bij een piek in gaveups niet in één
// keer 20 mails uitspuwen. Fail-soft per rij.
const PROVISIONING_GAVEUP_NOTIFY_LIMIT = 10;

/** Backoff in seconden op basis van het aantal reeds gedane pogingen. */
function backoffSecVoorAttempts(attempts) {
  const exp = Math.pow(2, Math.max(0, attempts));
  return Math.min(PROVISIONING_RETRY_BASE_BACKOFF_SEC * exp, PROVISIONING_RETRY_MAX_BACKOFF_SEC);
}

/** HTML-safe escape voor waarden in de gaveup-alarm-mail. */
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
  // bevestig_b is APPROVED met 1 body-placeholder ({{1}}=voornaam) + een
  // STATISCHE URL-knop (deforexopleiding.nl/agenda, 0 parameters). Dus maar 1
  // body-param meesturen — 2 gaf Meta 132000 (param-count mismatch).
  bevestig_b:   { name: 'bevestig_toegang_b',  vars: (a) => [a.voornaam || 'daar'] },
  reminder_2u:  { name: 'reminder_toegang_2u', vars: (a) => [a.voornaam || 'daar'] },
  reminder_24u: { name: 'reminder_toegang_24u',vars: (a) => [a.voornaam || 'daar'] },
  reminder_48u: { name: 'reminder_toegang_48u_v3',vars: (a) => [a.voornaam || 'daar'] },
  dag6_a:       { name: 'dag6_checkin_a',      vars: (a) => [a.voornaam || 'daar'] },
  dag6_b:       { name: 'dag6_checkin_b',      vars: (a) => [a.voornaam || 'daar', process.env.OPSTARTSESSIE_CALL_URL || 'https://deforexopleiding.nl/agenda'] },
};

function aanUit(v) {
  return ['1','true','aan','on','ja'].includes(String(v||'').trim().toLowerCase());
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
    provisioning_retries: 0, provisioning_retry_ok: 0, provisioning_retry_fail: 0,
    provisioning_retry_backoff_wait: 0,   // 2026-09-17: kandidaten die nog niet mochten
    provisioning_gaveup_new: 0,            // 2026-09-17: rijen die deze tick 'gaveup' werden
    provisioning_gaveup_notified: 0,       // 2026-09-17: verstuurde admin-alarms
    provisioning_gaveup_notify_fail: 0,    // 2026-09-17: alarm-verzending mislukt
    errors: [],
    items: [],   // v=6: per-lead outcome (id/wa/mail/step) voor observability
  };

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
  try {
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
      // Mail A/B via de pure builders. A hergebruikt callMoment (fail-soft
      // fallback in mailBevestigingA: 'het geplande moment').
      let mailPayload;
      if (a.call_geboekt) {
        mailPayload = mailBevestigingA(a.voornaam, callMoment);
      } else {
        mailPayload = mailBevestigingB(a.voornaam);
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
  for (const [uren, kolom, cfgKey, counter] of [
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

  // ── 2b) PROVISIONING RETRY — leads die op status='gereageerd' hangen
  //        met provisioned_at IS NULL + provisioned_error <> NULL. Typisch
  //        pattern: gate flipte de rij naar 'gereageerd', maar de
  //        belProvisioning-call timeoutte (of gaf 5xx) → geen inlogmail en
  //        geen "je bent binnen"-WA. Zonder deze retry blijft de lead in
  //        het luchtledige tot iemand handmatig ingrijpt.
  //
  //   Selectie-eisen:
  //     * status = 'gereageerd'
  //     * provisioned_at IS NULL         (nooit dubbel provisionen)
  //     * provisioned_error IS NOT NULL  (fault-signaal van de gate)
  //     * provisioning_gaveup_at IS NULL (2026-09-17: nog niet opgegeven)
  //     * reacted_at >= now - 72u        (voorbij dit venster handmatig ingrijpen)
  //     * limit CANDIDATE_LIMIT per tick; client-side filter op backoff-ready
  //
  //   Cap + backoff (2026-09-17):
  //     * Max PROVISIONING_RETRY_MAX_ATTEMPTS (7) pogingen per rij.
  //     * Backoff-tijd = min(60 * 2^attempts_gedaan, 3600) sec sinds
  //       provisioning_last_attempt_at (of onmiddellijk als NULL).
  //     * Overslaan als niet backoff-ready → wachten tot volgende tick.
  //     * Op de 7e mislukking → provisioning_gaveup_at + gaveup_reason gezet.
  //       Éénmalige admin-alarm-mail verstuurd in stap 2c.
  //
  //   Atomic claim: zet provisioned_error=NULL + increment
  //   provisioning_attempts + provisioning_last_attempt_at=now(), met
  //   WHERE-guard (provisioned_at IS NULL AND provisioned_error IS NOT NULL
  //   AND provisioning_gaveup_at IS NULL). Twee concurrent runs krijgen maar
  //   één winnaar op de UPDATE (Postgres serialiseert); de race-loser
  //   retourneert 0 rows en slaat de rij stil over. Ok-flow zet daarna
  //   provisioned_at (nog een IS NULL guard tegen race met een parallel-
  //   webhook die inmiddels ook slaagde), en verstuurt exact dezelfde
  //   "Top <naam>! ✅ Je inloggegevens…" welkom-WA als inbox-webhook.js.
  if (live) try {
    const grens = new Date(nowMs - PROVISIONING_RETRY_WINDOW_UREN * 3600 * 1000).toISOString();
    const { data: rows } = await supabaseAdmin
      .from('toegang_aanvragen')
      .select('id, voornaam, email, telefoon, soort, provisioned_error, reacted_at, provisioning_attempts, provisioning_last_attempt_at')
      .eq('status', 'gereageerd')
      .is('provisioned_at', null)
      .not('provisioned_error', 'is', null)
      .is('provisioning_gaveup_at', null)
      .gte('reacted_at', grens)
      .order('reacted_at', { ascending: true })
      .limit(PROVISIONING_RETRY_CANDIDATE_LIMIT);

    // Client-side backoff-filter: rij mag pas geretriet worden als er
    // sinds provisioning_last_attempt_at genoeg tijd verstreken is (of als
    // die kolom NULL is — dan is dit de eerste cron-retry na de webhook).
    const backoffReady = [];
    for (const row of (rows || [])) {
      const attemptsDone = row.provisioning_attempts || 0;
      const lastAt = row.provisioning_last_attempt_at
        ? new Date(row.provisioning_last_attempt_at).getTime() : 0;
      const backoffMs = backoffSecVoorAttempts(attemptsDone) * 1000;
      const ready = lastAt === 0 || (nowMs - lastAt) >= backoffMs;
      if (ready) backoffReady.push(row);
      else       summary.provisioning_retry_backoff_wait++;
    }

    // Neem eerst maximaal BATCH_LIMIT ready-rijen. Drains vanzelf over
    // meerdere ticks bij een backlog.
    const teDoen = backoffReady.slice(0, PROVISIONING_RETRY_BATCH_LIMIT);

    for (const row of teDoen) {
      // Atomic claim: verhoog attempts + zet last_attempt_at + nul error.
      // Race-guard blijft: alleen als provisioned_at IS NULL EN gaveup NULL.
      const nieuweAttempts = (row.provisioning_attempts || 0) + 1;
      const attemptTs = new Date().toISOString();
      const { data: claim } = await supabaseAdmin
        .from('toegang_aanvragen')
        .update({
          provisioned_error           : null,
          provisioning_attempts       : nieuweAttempts,
          provisioning_last_attempt_at: attemptTs,
        })
        .eq('id', row.id)
        .is('provisioned_at', null)
        .is('provisioning_gaveup_at', null)
        .not('provisioned_error', 'is', null)
        .select('id')
        .maybeSingle();
      if (!claim?.id) continue;

      summary.provisioning_retries++;
      const r = await belProvisioning({
        email: row.email, voornaam: row.voornaam, soort: row.soort,
      });

      if (r.ok) {
        // Race-safe: guard tegen parallel-webhook die intussen ook slaagde.
        // Alleen als WIJ de provisioned_at-flag zetten (from NULL → now),
        // sturen we ook de welkom-WA. Anders is die al eerder verstuurd.
        const { data: updated, error: guardErr } = await supabaseAdmin
          .from('toegang_aanvragen')
          .update({
            provisioned_at   : new Date().toISOString(),
            provisioned_error: null,
          })
          .eq('id', row.id)
          .is('provisioned_at', null)
          .select('id')
          .maybeSingle();

        if (!guardErr && updated?.id) {
          summary.provisioning_retry_ok++;
          // Welkom-WA — spiegelt inbox-webhook.js:1562-1590. Fail-soft:
          // provisioning is al gelukt, de inlogmail is al onderweg via
          // dfo-website; de bevestigings-WA is nice-to-have.
          try {
            if (!welkomPhoneId) {
              console.warn('[cron-toegang-aanvragen] retry-ok maar welkomPhoneId ontbreekt — WA-skip:', row.id);
            } else if (!row.telefoon) {
              console.warn('[cron-toegang-aanvragen] retry-ok maar telefoon ontbreekt — WA-skip:', row.id);
            } else {
              const naam = row.voornaam || 'daar';
              const wabody =
                `Top ${naam}! ✅ Je inloggegevens zijn direct per mail naar je toegestuurd.\n\n` +
                `Nog een vraagje, ben je ook al bekend met traden of is dit volledig nieuw?`;
              const sendRes = await sendText({ to: row.telefoon, body: wabody, phoneNumberId: welkomPhoneId });
              await logOutboundWa(supabaseAdmin, {
                toPhone      : row.telefoon,
                phoneNumberId: welkomPhoneId,
                body         : wabody,
                wamid        : sendRes?.wamid || null,
                source       : 'toegang-provisioning-retry-cron',
              });
            }
          } catch (waErr) {
            if (waErr instanceof MetaNotConfiguredError) {
              console.warn('[cron-toegang-aanvragen] welkom-WA meta niet geconfigureerd (soft):', row.id);
            } else {
              console.warn('[cron-toegang-aanvragen] welkom-WA (soft):', row.id, waErr?.message || waErr);
            }
          }
        } else {
          // Race verloren: parallel-webhook heeft 'em al geprovisioneerd
          // en de welkom-WA al verstuurd. Niet nogmaals.
          console.log('[cron-toegang-aanvragen] retry: parallel-provisioning al gelukt — skip WA:', row.id);
        }
      } else {
        summary.provisioning_retry_fail++;
        const fout = (r.error || 'onbekend').slice(0, 500);

        // Als we deze poging op of over de cap zaten → OPGEVEN.
        // Zet provisioning_gaveup_at + reason, houd provisioned_error zichtbaar
        // (zodat de leadsonderhoud-UI het "⚠"-badge blijft tonen ook nadat
        // een handmatige reset later provisioned_error null'd — reason blijft
        // dan als kopie staan).
        if (nieuweAttempts >= PROVISIONING_RETRY_MAX_ATTEMPTS) {
          await supabaseAdmin.from('toegang_aanvragen')
            .update({
              provisioned_error         : fout,
              provisioning_gaveup_at    : new Date().toISOString(),
              provisioning_gaveup_reason: fout,
            })
            .eq('id', row.id);
          summary.provisioning_gaveup_new++;
        } else {
          // Fout terug op de rij zodat een volgende tick opnieuw kan proberen
          // (mits nog binnen 72u-venster + backoff-ready).
          await supabaseAdmin.from('toegang_aanvragen')
            .update({ provisioned_error: fout })
            .eq('id', row.id);
        }
      }
    }
  } catch (e) {
    summary.errors.push({ step: 'provisioning-retry-loop', error: e?.message || String(e) });
  }

  // ── 2c) PROVISIONING GAVEUP NOTIFY — éénmalige admin-alarm-mail voor
  //        rijen die zojuist (of eerder) definitief zijn opgegeven. Selectie:
  //        provisioning_gaveup_at IS NOT NULL AND provisioning_gaveup_notified
  //        = false. Verstuurt naar de bestaande admin-recipients (dezelfde
  //        set als follow-up-admin-daily/-weekly: super_admin + manager
  //        profielen met een geldig e-mailadres). Idempotent via de
  //        notified-flag; race-veilig via een gecombineerde UPDATE-guard.
  if (live) try {
    const { data: gaveupRows } = await supabaseAdmin
      .from('toegang_aanvragen')
      .select('id, voornaam, email, soort, telefoon, provisioning_gaveup_reason, provisioning_gaveup_at, provisioning_attempts, reacted_at')
      .not('provisioning_gaveup_at', 'is', null)
      .eq('provisioning_gaveup_notified', false)
      .order('provisioning_gaveup_at', { ascending: true })
      .limit(PROVISIONING_GAVEUP_NOTIFY_LIMIT);

    if ((gaveupRows || []).length > 0) {
      const recipients = await getAdminRecipients(supabaseAdmin);
      for (const row of gaveupRows) {
        // Atomic claim op de notified-flag vóór verzenden, om te voorkomen
        // dat twee cron-runs dezelfde mail sturen. Race-loser (flag was al
        // true) krijgt 0 rows en slaat over.
        const { data: claim } = await supabaseAdmin
          .from('toegang_aanvragen')
          .update({ provisioning_gaveup_notified: true })
          .eq('id', row.id)
          .eq('provisioning_gaveup_notified', false)
          .select('id')
          .maybeSingle();
        if (!claim?.id) continue;

        if (recipients.length === 0) {
          // Geen admin-adres beschikbaar → notify-fail, zet flag terug
          // zodat een volgende tick 't opnieuw probeert (bv. nadat er
          // een super_admin/manager aan profiles is toegevoegd).
          summary.provisioning_gaveup_notify_fail++;
          await supabaseAdmin.from('toegang_aanvragen')
            .update({ provisioning_gaveup_notified: false })
            .eq('id', row.id);
          summary.errors.push({ step: 'gaveup-notify', id: row.id,
            error: 'geen admin-recipients gevonden (super_admin/manager profielen leeg)' });
          continue;
        }

        const attempts = row.provisioning_attempts ?? PROVISIONING_RETRY_MAX_ATTEMPTS;
        const reden    = String(row.provisioning_gaveup_reason || 'onbekend').slice(0, 500);
        const subject  = `⚠ Toegang-provisioning opgegeven na ${attempts}× — ${row.voornaam || row.email || row.id}`;
        const text =
`Toegang-provisioning is definitief opgegeven voor:

  Voornaam : ${row.voornaam || '(onbekend)'}
  E-mail   : ${row.email || '(onbekend)'}
  Soort    : ${row.soort || '(onbekend)'}
  Telefoon : ${row.telefoon || '(onbekend)'}
  Pogingen : ${attempts} × ${PROVISIONING_RETRY_MAX_ATTEMPTS} (cap bereikt)
  Reageerde: ${row.reacted_at || '(onbekend)'}
  Gaveup   : ${row.provisioning_gaveup_at}

Laatste error:
${reden}

Handmatige actie is nodig — controleer de lead in Leadsonderhoud → Toegang-aanvragen (row-id ${row.id}) en corrigeer waar nodig.`;
        const html = wrapEmailHtml('⚠ Toegang-provisioning opgegeven', `
<p style="margin:0 0 12px;font-size:14px;color:#111827">De cron heeft <b>${attempts}× tevergeefs</b> geprobeerd toegang te provisioneren voor deze lead. Handmatige actie is nodig.</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13.5px;line-height:1.55">
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Voornaam</td><td style="padding:3px 0;font-weight:600">${escapeHtml(row.voornaam || '(onbekend)')}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">E-mail</td><td style="padding:3px 0;font-weight:600">${escapeHtml(row.email || '(onbekend)')}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Soort</td><td style="padding:3px 0">${escapeHtml(row.soort || '(onbekend)')}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Telefoon</td><td style="padding:3px 0">${escapeHtml(row.telefoon || '(onbekend)')}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Pogingen</td><td style="padding:3px 0">${attempts} × ${PROVISIONING_RETRY_MAX_ATTEMPTS} (cap bereikt)</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Reageerde op</td><td style="padding:3px 0">${escapeHtml(row.reacted_at || '(onbekend)')}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Opgegeven op</td><td style="padding:3px 0">${escapeHtml(row.provisioning_gaveup_at)}</td></tr>
</table>
<p style="margin:14px 0 6px;color:#6b7280;font-size:12px">Laatste error:</p>
<pre style="margin:0;padding:10px 12px;background:#fee2e2;border-radius:6px;color:#7f1d1d;font-size:12px;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(reden)}</pre>
<p style="margin:16px 0 0;font-size:13px;color:#374151">Controleer de lead in Leadsonderhoud → Toegang-aanvragen (row-id <code>${escapeHtml(row.id)}</code>) en corrigeer waar nodig.</p>
`);
        let anySent = false;
        for (const rec of recipients) {
          const rr = await sendMail({ to: rec.email, subject, text, html });
          if (rr && rr.success) anySent = true;
          else console.warn('[cron-toegang-aanvragen] gaveup-alarm mail-fail:', rec.email, rr?.error || '(onbekend)');
        }
        if (anySent) {
          summary.provisioning_gaveup_notified++;
        } else {
          // Alle recipients faalden → zet flag terug, volgende tick nieuwe poging.
          await supabaseAdmin.from('toegang_aanvragen')
            .update({ provisioning_gaveup_notified: false })
            .eq('id', row.id);
          summary.provisioning_gaveup_notify_fail++;
        }
      }
    }
  } catch (e) {
    summary.errors.push({ step: 'provisioning-gaveup-notify-loop', error: e?.message || String(e) });
  }

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
  try {
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
      const mailPayload = a.call_geboekt ? mailDag6A(a.voornaam) : mailDag6B(a.voornaam);
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

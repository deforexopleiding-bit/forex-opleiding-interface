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

const NACHT_START_HOUR = 21;
const NACHT_EIND_HOUR  = 8;
const VERVALLEN_UREN_NA_48U = 24;   // na 48u-reminder + 24u zonder reactie → vervallen
const DAG6_UREN = 6 * 24;

// Statische call-link (voorlopig). Per-bron dynamisch = latere optie.
const CALL_LINK = 'https://deforexopleiding.nl/agenda';

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
  bevestig_a:   { name: 'bevestig_toegang_a',  vars: (a) => [a.voornaam || 'daar'] },
  bevestig_b:   { name: 'bevestig_toegang_b',  vars: (a) => [a.voornaam || 'daar', process.env.OPSTARTSESSIE_CALL_URL || 'https://deforexopleiding.nl/agenda'] },
  reminder_2u:  { name: 'reminder_toegang_2u', vars: (a) => [a.voornaam || 'daar'] },
  reminder_24u: { name: 'reminder_toegang_24u',vars: (a) => [a.voornaam || 'daar'] },
  reminder_48u: { name: 'reminder_toegang_48u',vars: (a) => [a.voornaam || 'daar'] },
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

async function stuurWa(a, cfg, live) {
  if (!live) {
    console.log('[cron-toegang-aanvragen] DROOG:', cfg.name, '->', a.telefoon);
    return { ok: true, dry: true };
  }
  try {
    const { wamid } = await sendTemplate({
      to: a.telefoon,
      templateName: cfg.name,
      languageCode: 'nl',
      variables: cfg.vars(a),
    });
    return { ok: true, wamid };
  } catch (e) {
    if (e instanceof MetaNotConfiguredError) {
      return { ok: false, skipped: true, error: 'meta-niet-geconfigureerd' };
    }
    return { ok: false, error: e?.message || String(e) };
  }
}

async function stuurMail(a, subject, text, html, live) {
  if (!live) { console.log('[cron-toegang-aanvragen] DROOG mail ->', a.email, subject); return { ok: true, dry: true }; }
  try {
    const r = await sendWelkomMail({ to: a.email, subject, text, html: html || `<p>${text}</p>` });
    return { ok: !!r?.success, error: r?.error || null };
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
  const summary = { live, dry: !live, bevestiging: 0, reminders_2u: 0, reminders_24u: 0, reminders_48u: 0, vervallen: 0, dag6: 0, provisioning_calls: 0, errors: [] };

  // Nacht-guard geldt alleen voor het VERZENDEN, niet voor status-transities
  // zoals 'vervallen' (die is stille administratie).
  const nachtNu = isNacht(nowMs);

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
      const cfg = a.call_geboekt ? TEMPLATES.bevestig_a : TEMPLATES.bevestig_b;
      const wa  = await stuurWa(a, cfg, live);
      // Mail A/B via named constants. Voor A: call-moment fail-soft ophalen
      // uit follow_up_appointments (match op telefoon last-9-digits).
      // Als niet gevonden: MAIL_BEVESTIGING_A valt terug op 'het geplande moment'.
      let mailPayload;
      if (a.call_geboekt) {
        const callMoment = await haalCallMoment(a);
        mailPayload = MAIL_BEVESTIGING_A(a.voornaam, callMoment);
      } else {
        mailPayload = MAIL_BEVESTIGING_B(a.voornaam);
      }
      const mail = await stuurMail(a, mailPayload.subject, mailPayload.text, mailPayload.html, live);
      const okAny = wa.ok || mail.ok;
      if (okAny) {
        await supabaseAdmin.from('toegang_aanvragen')
          .update({ bevestiging_sent_at: new Date().toISOString() })
          .eq('id', a.id);
        summary.bevestiging++;
      } else {
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
      const wa = await stuurWa(a, TEMPLATES[cfgKey], live);
      if (wa.ok) {
        await supabaseAdmin.from('toegang_aanvragen')
          .update({ [kolom]: new Date().toISOString() })
          .eq('id', a.id);
        summary[counter]++;
      } else {
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
      // WA + mail parallel (fail-soft per kanaal). Guard zetten zodra
      // MINSTENS ÉÉN kanaal geslaagd is — voorkomt herhaling in volgende
      // cron-run als één kanaal tijdelijk faalt.
      const cfg = a.call_geboekt ? TEMPLATES.dag6_a : TEMPLATES.dag6_b;
      const wa  = await stuurWa(a, cfg, live);
      const mailPayload = a.call_geboekt ? MAIL_DAG6_A(a.voornaam) : MAIL_DAG6_B(a.voornaam);
      const mail = await stuurMail(a, mailPayload.subject, mailPayload.text, mailPayload.html, live);
      const okAny = wa.ok || mail.ok;
      if (okAny) {
        await supabaseAdmin.from('toegang_aanvragen')
          .update({ dag6_sent_at: new Date().toISOString() })
          .eq('id', a.id);
        summary.dag6++;
      } else {
        summary.errors.push({ id: a.id, step: 'dag6', wa: wa.error, mail: mail.error });
      }
    }
  } catch (e) { summary.errors.push({ step: 'dag6-loop', error: e?.message || String(e) }); }

  return res.status(200).json(summary);
}

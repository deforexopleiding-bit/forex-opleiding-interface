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

async function stuurMail(a, subject, text, live) {
  if (!live) { console.log('[cron-toegang-aanvragen] DROOG mail ->', a.email, subject); return { ok: true, dry: true }; }
  try {
    const r = await sendWelkomMail({ to: a.email, subject, text, html: `<p>${text}</p>` });
    return { ok: !!r?.success, error: r?.error || null };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const authRes = checkCronAuth(req);
  if (authRes !== true) return res.status(401).json(authRes);

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
      const mail = await stuurMail(a, `Welkom bij ${a.soort === '7-daagse' ? 'de 7-daagse challenge' : 'de mini-cursus'}!`, `Hoi ${a.voornaam || 'daar'}! Reageer op onze WhatsApp om je toegang te ontvangen.`, live);
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
      .select('id, voornaam, telefoon, call_geboekt, provisioned_at')
      .eq('status', 'gereageerd')
      .eq('soort', '7-daagse')
      .not('provisioned_at', 'is', null)
      .is('dag6_sent_at', null)
      .lte('provisioned_at', grens)
      .limit(50);
    for (const a of (rows || [])) {
      const cfg = a.call_geboekt ? TEMPLATES.dag6_a : TEMPLATES.dag6_b;
      const wa  = await stuurWa(a, cfg, live);
      if (wa.ok) {
        await supabaseAdmin.from('toegang_aanvragen')
          .update({ dag6_sent_at: new Date().toISOString() })
          .eq('id', a.id);
        summary.dag6++;
      } else {
        summary.errors.push({ id: a.id, step: 'dag6', error: wa.error });
      }
    }
  } catch (e) { summary.errors.push({ step: 'dag6-loop', error: e?.message || String(e) }); }

  return res.status(200).json(summary);
}

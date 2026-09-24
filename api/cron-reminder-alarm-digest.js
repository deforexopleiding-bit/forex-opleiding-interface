// api/cron-reminder-alarm-digest.js
//
// Dagelijkse samenvatting van mislukte afspraak-berichten (1×/dag, ~08:00 NL).
// Vervangt de oude per-poging-alarmmails uit cron-reminder-alarm (tak a).
//
// Inhoud:
//   1) NIEUW OPGEGEVEN — afspraken die sinds de vorige samenvatting een
//      give-up- (bevestiging_gaveup_at) of onbezorgbaar-marker
//      (lead_email_undeliverable_at) kregen. Dit is de actielijst.
//   2) MISLUKTE VERZENDINGEN — afspraak_bericht_faillog sinds de vorige
//      samenvatting, gegroepeerd per afspraak × moment × kanaal.
// Per regel: naam, e-mail/telefoon, reden, aantal pogingen, afspraak-id,
// CRM-link en (indien bekend) GHL-contactlink om het adres te corrigeren.
//
// Venster: vanaf de vorige GESLAAGDE samenvatting (max 72u terug), anders 24u.
// Mislukt het mailen, dan schuift het venster niet op en valt niets weg.
// Tweede trigger binnen 20u → overslaan (tenzij ?force=1).
//
// PUUR lezen + mailen + één state-rij in follow_up_events_log. 0 writes op
// afspraken, 0 incasso.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import { detectEmailTypo } from './_lib/send-error-classify.js';

const ALARM_EMAIL = process.env.ALARM_EMAIL || 'jeffreybiemold@gmail.com';
const ALARM_FROM  = 'welkom@deforexopleiding.nl';
const CRM_BASE    = (process.env.PUBLIC_BASE_URL || 'https://crm.deforexopleiding.nl').replace(/\/+$/, '');
const GHL_LOC     = process.env.GHL_LOCATION_ID || null;
const STATE_TYPE  = 'reminder-alarm-digest';
const H = 3600000;
const MIN_INTERVAL_MS = 20 * H;
const MAX_TERUG_MS    = 72 * H;

const MOMENT_LABEL = { bevestiging: 'Bevestiging', r24: '24u-reminder', r2: '2u-reminder', r30: '30m-reminder', zoom5: 'Zoom-5min', r5: 'Zoom-5min' };

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nl = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'short' }) : '—');
const kanaalNorm = (k) => (k === 'email' ? 'mail' : (k || '?'));

function crmLink() { return `${CRM_BASE}/modules/klanten-v2/#followup`; }
function ghlLink(contactId) {
  return (GHL_LOC && contactId) ? `https://app.gohighlevel.com/v2/location/${GHL_LOC}/contacts/detail/${contactId}` : null;
}
function suggestieVoor(appt) {
  const t = detectEmailTypo(appt?.lead_email);
  return t ? t.suggestie : null;
}

async function haalAfspraken(ids) {
  const map = new Map();
  const lijst = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < lijst.length; i += 200) {
    const { data, error } = await supabaseAdmin.from('follow_up_appointments')
      .select('id, lead_name, lead_email, lead_phone, lead_ghl_contact_id, scheduled_at, status, lead_email_undeliverable_at, lead_email_undeliverable_reason, bevestiging_gaveup_at, bevestiging_gaveup_reason, bevestiging_mail_attempts, bevestiging_wa_attempts')
      .in('id', lijst.slice(i, i + 200));
    if (error) throw new Error('afspraken-query: ' + error.message);
    for (const a of data || []) map.set(a.id, a);
  }
  return map;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const force = String(req.query?.force || '') === '1';
  const out = { at: nowIso, mailed: false };

  try {
    // ── Venster bepalen op basis van de vorige geslaagde samenvatting ──
    const { data: vorige } = await supabaseAdmin.from('follow_up_events_log')
      .select('payload, received_at')
      .eq('event_type', STATE_TYPE)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const vorigeTot = vorige?.payload?.tot ? Date.parse(vorige.payload.tot) : null;
    if (!force && vorigeTot && nowMs - vorigeTot < MIN_INTERVAL_MS) {
      out.skipped = 'al verstuurd binnen 20u';
      return res.status(200).json(out);
    }
    const vanafMs = vorigeTot && nowMs - vorigeTot <= MAX_TERUG_MS ? vorigeTot : nowMs - 24 * H;
    const vanaf = new Date(vanafMs).toISOString();
    out.venster = { vanaf, tot: nowIso };

    // ── 1) Nieuw opgegeven ──
    const { data: opg, error: opgErr } = await supabaseAdmin.from('follow_up_appointments')
      .select('id')
      .or(`bevestiging_gaveup_at.gte.${vanaf},lead_email_undeliverable_at.gte.${vanaf}`)
      .limit(500);
    if (opgErr) throw new Error('opgegeven-query: ' + opgErr.message);
    const opgIds = (opg || []).map((r) => r.id);

    // ── 2) Faillog, gegroepeerd ──
    const { data: fl, error: flErr } = await supabaseAdmin.from('afspraak_bericht_faillog')
      .select('appointment_id, moment, kanaal, reason, created_at')
      .gte('created_at', vanaf)
      .order('created_at', { ascending: true })
      .limit(5000);
    if (flErr) throw new Error('faillog-query: ' + flErr.message);
    const groepen = new Map();
    for (const r of fl || []) {
      const key = `${r.appointment_id || '?'}|${r.moment || '?'}|${kanaalNorm(r.kanaal)}`;
      const g = groepen.get(key) || { appointment_id: r.appointment_id, moment: r.moment, kanaal: kanaalNorm(r.kanaal), n: 0, eerste: r.created_at, laatste: r.created_at, reden: r.reason };
      g.n += 1; g.laatste = r.created_at; g.reden = r.reason || g.reden;
      groepen.set(key, g);
    }
    out.faillog_rijen = (fl || []).length;
    out.groepen = groepen.size;
    out.nieuw_opgegeven = opgIds.length;

    if (groepen.size === 0 && opgIds.length === 0) {
      out.leeg = true;
      await supabaseAdmin.from('follow_up_events_log').insert({
        source: 'cron', event_type: STATE_TYPE, processed: true,
        payload: { tot: nowIso, vanaf, leeg: true },
      });
      return res.status(200).json(out);
    }

    const afspraken = await haalAfspraken([...opgIds, ...[...groepen.values()].map((g) => g.appointment_id)]);

    // ── Mail opbouwen (tekst + html) ──
    const txt = [];
    const html = [];
    const kop = `Reminder-samenvatting ${nl(vanaf)} – ${nl(nowIso)}`;
    txt.push(kop, '');
    html.push(`<h2 style="font:600 16px system-ui;margin:0 0 12px">${esc(kop)}</h2>`);

    const blokLinks = (a) => {
      const g = ghlLink(a?.lead_ghl_contact_id);
      return {
        txt: `CRM: ${crmLink()}${g ? `  ·  GHL-contact: ${g}` : ''}`,
        html: `<a href="${esc(crmLink())}">Open in CRM (Opvolging)</a>${g ? ` · <a href="${esc(g)}">Corrigeer in GHL</a>` : ''}`,
      };
    };

    if (opgIds.length) {
      txt.push(`NIEUW OPGEGEVEN — actie nodig (${opgIds.length})`);
      html.push(`<h3 style="font:600 14px system-ui;margin:16px 0 8px;color:#b42318">Nieuw opgegeven — actie nodig (${opgIds.length})</h3><ul style="font:13px system-ui;padding-left:18px">`);
      for (const id of opgIds) {
        const a = afspraken.get(id) || { id };
        const reden = a.lead_email_undeliverable_reason || a.bevestiging_gaveup_reason || 'onbekend';
        const sug = suggestieVoor(a);
        const l = blokLinks(a);
        txt.push(`• ${a.lead_name || '?'} — ${a.lead_email || 'geen e-mail'} / ${a.lead_phone || 'geen tel'}`);
        txt.push(`  Afspraak ${nl(a.scheduled_at)} (${a.status || '?'}) · id ${id}`);
        txt.push(`  Reden: ${reden}`);
        if (sug) txt.push(`  Mogelijk bedoeld: ${sug}  (NIET automatisch aangepast)`);
        txt.push(`  ${l.txt}`, '');
        html.push(`<li style="margin-bottom:10px"><b>${esc(a.lead_name || '?')}</b> — ${esc(a.lead_email || 'geen e-mail')} / ${esc(a.lead_phone || 'geen tel')}<br>`
          + `Afspraak ${esc(nl(a.scheduled_at))} (${esc(a.status || '?')}) · <code>${esc(id)}</code><br>`
          + `Reden: ${esc(reden)}<br>`
          + (sug ? `Mogelijk bedoeld: <b>${esc(sug)}</b> <i>(niet automatisch aangepast)</i><br>` : '')
          + `${l.html}</li>`);
      }
      html.push('</ul>');
    }

    if (groepen.size) {
      const lijst = [...groepen.values()].sort((x, y) => y.n - x.n);
      txt.push(`MISLUKTE VERZENDINGEN (${lijst.length} afspraak/moment/kanaal-combinaties, ${out.faillog_rijen} pogingen)`);
      html.push(`<h3 style="font:600 14px system-ui;margin:16px 0 8px">Mislukte verzendingen (${lijst.length} combinaties, ${out.faillog_rijen} pogingen)</h3><ul style="font:13px system-ui;padding-left:18px">`);
      for (const g of lijst) {
        const a = afspraken.get(g.appointment_id) || {};
        const status = a.lead_email_undeliverable_at ? 'mail onbezorgbaar — gestopt'
          : a.bevestiging_gaveup_at ? 'opgegeven — gestopt'
          : 'wordt nog geprobeerd (met cap)';
        const label = `${MOMENT_LABEL[g.moment] || g.moment}/${g.kanaal}`;
        const l = blokLinks(a);
        txt.push(`• ${a.lead_name || '?'} — ${a.lead_email || 'geen e-mail'} / ${a.lead_phone || 'geen tel'}`);
        txt.push(`  ${label}: ${g.n}× mislukt (${nl(g.eerste)} – ${nl(g.laatste)}) · ${status}`);
        txt.push(`  Reden: ${g.reden || 'onbekend'}`);
        txt.push(`  Afspraak-id ${g.appointment_id || '?'} · ${l.txt}`, '');
        html.push(`<li style="margin-bottom:10px"><b>${esc(a.lead_name || '?')}</b> — ${esc(a.lead_email || 'geen e-mail')} / ${esc(a.lead_phone || 'geen tel')}<br>`
          + `${esc(label)}: <b>${g.n}×</b> mislukt (${esc(nl(g.eerste))} – ${esc(nl(g.laatste))}) · ${esc(status)}<br>`
          + `Reden: ${esc(g.reden || 'onbekend')}<br>`
          + `Afspraak-id <code>${esc(g.appointment_id || '?')}</code> · ${l.html}</li>`);
      }
      html.push('</ul>');
    }

    txt.push('— Dagelijkse samenvatting van cron-reminder-alarm-digest. Real-time alarmen komen alleen nog bij een stilgevallen cron of onverklaard niet-verstuurde reminders.');
    html.push('<p style="font:12px system-ui;color:#667085">Dagelijkse samenvatting van cron-reminder-alarm-digest. Real-time alarmen komen alleen nog bij een stilgevallen cron of onverklaard niet-verstuurde reminders.</p>');

    const subject = `Reminder-samenvatting: ${opgIds.length} nieuw opgegeven, ${groepen.size} mislukte combinatie${groepen.size === 1 ? '' : 's'}`;
    let mailRes = { ok: false, reason: 'niet verstuurd' };
    try {
      mailRes = await sendEmailViaSmtp({ fromMailbox: ALARM_FROM, to: ALARM_EMAIL, subject, text: txt.join('\n'), html: html.join('\n') });
    } catch (e) {
      mailRes = { ok: false, reason: e?.message || String(e) };
    }
    out.mailed = !!mailRes.ok;
    if (!mailRes.ok) {
      out.mail_error = mailRes.reason || 'onbekend';
      console.error('[cron-reminder-alarm-digest] mail mislukt:', out.mail_error);
      return res.status(200).json(out); // venster schuift niet op → volgende run neemt alles mee
    }

    const { error: stErr } = await supabaseAdmin.from('follow_up_events_log').insert({
      source: 'cron', event_type: STATE_TYPE, processed: true,
      payload: { tot: nowIso, vanaf, faillog_rijen: out.faillog_rijen, groepen: groepen.size, nieuw_opgegeven: opgIds.length },
    });
    if (stErr) console.error('[cron-reminder-alarm-digest] state-write:', stErr.message);
  } catch (e) {
    out.fatal = e?.message || String(e);
    console.error('[cron-reminder-alarm-digest]', out.fatal);
  }
  return res.status(200).json(out);
}

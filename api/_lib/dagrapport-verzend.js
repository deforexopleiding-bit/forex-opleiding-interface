// api/_lib/dagrapport-verzend.js
//
// Bezorging van het dagrapport: PDF privé in Supabase Storage, een korte
// redirect-token voor de WhatsApp-knop, verzending via een goedgekeurd
// 360dialog-template (tekst + URL-knop) en/of e-mail met de PDF als bijlage.
//
// Schakelaars + instellingen staan in app_settings (operator kan aan/uit zonder
// deploy). READ-ONLY voor rapportdata; schrijft alleen de PDF + een link-rij.

import crypto from 'node:crypto';
import { sendTemplate } from './meta-whatsapp.js';
import { WA_NUMMERS } from './wa-nummers.js';
import { sendMail, wrapEmailHtml, getAdminRecipients } from '../mailer.js';

const BUCKET = 'dagrapporten';
const DEFAULTS = {
  dagrapport_whatsapp_enabled: true,
  dagrapport_email_enabled: true,
  dagrapport_recipient_msisdn: '+31655270212',
  dagrapport_wa_template: 'dfo_dagrapport',
  dagrapport_wa_taal: 'nl',
  dagrapport_base_url: 'https://crm.deforexopleiding.nl',
};

export async function leesConfig(db) {
  const keys = Object.keys(DEFAULTS);
  const cfg = { ...DEFAULTS };
  try {
    const { data } = await db.from('app_settings').select('key, value').in('key', keys);
    for (const row of data || []) {
      if (row && row.key in cfg && row.value != null) cfg[row.key] = row.value;
    }
  } catch (e) {
    console.warn('[dagrapport-verzend] app_settings lezen mislukt, defaults gebruikt:', e?.message || e);
  }
  return cfg;
}

// Upload de PDF en registreer een korte token die de redirect-endpoint later
// omzet naar een verse signed URL. Return { token, path } of null bij fout.
export async function uploadEnToken(db, buffer, datumIso) {
  const token = crypto.randomBytes(16).toString('hex');
  const path = `${datumIso}/dagrapport-${Date.now()}.pdf`;
  const up = await db.storage.from(BUCKET).upload(path, buffer, { contentType: 'application/pdf', upsert: true });
  if (up.error) throw new Error('storage upload: ' + up.error.message);
  const ins = await db.from('dagrapport_links').insert({ token, storage_path: path, datum: datumIso });
  if (ins.error) throw new Error('dagrapport_links insert: ' + ins.error.message);
  return { token, path };
}

// Verstuur het WhatsApp-template met de datum (body {{1}}) en de token (URL-knop).
// Afzendlijn = hoofdnummer (360dialog). Fail-soft: gooit bij echte fout zodat de
// cron het logt, maar laat e-mail onafhankelijk slagen.
export async function verzendWhatsapp(cfg, { datumLabel, token }) {
  const to = String(cfg.dagrapport_recipient_msisdn || '').trim();
  if (!to) throw new Error('geen ontvangernummer (dagrapport_recipient_msisdn)');

  const hoofd = WA_NUMMERS.find((n) => n.sleutel === 'hoofdnummer');
  const pnId = hoofd ? process.env[hoofd.phone_number_id_env] : null;

  const components = [
    { type: 'body', parameters: [{ type: 'text', text: String(datumLabel) }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(token) }] },
  ];

  // Target de hoofdlijn: liefst via haar phone_number_id, anders via module
  // 'opvolging' (die routeert ook naar het hoofdnummer).
  const opts = {
    to,
    templateName: cfg.dagrapport_wa_template,
    languageCode: cfg.dagrapport_wa_taal,
    components,
  };
  if (pnId) opts.phoneNumberId = pnId; else opts.module = 'opvolging';

  const { wamid } = await sendTemplate(opts);
  return { wamid };
}

// Verstuur de e-mail met de PDF als bijlage + korte samenvatting naar de
// admin-ontvangers (zelfde doelgroep als het bestaande rapport).
export async function verzendEmail(db, buffer, data) {
  const recipients = await getAdminRecipients(db);
  if (!recipients.length) return { sent: 0, reason: 'geen admin-recipients' };

  const subject = `Dagrapport ${data.datumLabel}`;
  const html = bouwEmailHtml(data);
  const text = bouwEmailText(data);
  const attachments = [{ filename: `dagrapport-${data.datumIso}.pdf`, content: buffer, contentType: 'application/pdf' }];

  const resultaten = [];
  for (const r of recipients) {
    const res = await sendMail({ to: r.email, subject, text, html, attachments });
    resultaten.push({ email: r.email, success: res.success, error: res.error });
  }
  return { sent: resultaten.filter((r) => r.success).length, total: recipients.length, resultaten };
}

function bouwEmailHtml(d) {
  const b1 = d.blok1 || {}; const b3 = d.blok3 || {};
  const eur = (n) => (n == null ? 'n.v.t.' : '€ ' + Number(n).toLocaleString('nl-NL'));
  const g = (n) => (n == null ? 'n.v.t.' : Number(n).toLocaleString('nl-NL'));
  const body = `
    <p style="margin:0 0 16px; color:#374151; font-size:14px;">Het dagrapport van <strong>${escapeHtmlMail(d.datumLabel)}</strong> zit als PDF in de bijlage.</p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse; font-size:14px;">
      <tr><td style="padding:6px 0; color:#374151;">Sales vandaag</td><td style="text-align:right; font-weight:600;">${g(b1.salesVandaag)}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Omzet getekend (incl. btw)</td><td style="text-align:right; font-weight:600;">${eur(b1.omzetInclBtw)}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Calls afgerond</td><td style="text-align:right; font-weight:600;">${g(b3.afgerond)}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Klant geworden</td><td style="text-align:right; font-weight:600;">${g(b3.uitkomsten ? b3.uitkomsten.klantGeworden : null)}</td></tr>
    </table>
    <p style="margin:16px 0 0; color:#6b7280; font-size:13px;">Alle details, belwerk en leads staan in de bijgevoegde PDF.</p>`;
  const footer = `<p style="margin:0; color:#6b7280; font-size:12px;">Agency Command Center · Dagrapport<br>De Forex Opleiding NL B.V.</p>`;
  return wrapEmailHtml(`Dagrapport ${d.datumLabel}`, body, { footerHtml: footer });
}

function bouwEmailText(d) {
  const b1 = d.blok1 || {}; const b3 = d.blok3 || {};
  const g = (n) => (n == null ? 'n.v.t.' : String(n));
  return `Dagrapport ${d.datumLabel}

Het volledige rapport zit als PDF in de bijlage.

Sales vandaag: ${g(b1.salesVandaag)}
Omzet getekend (incl. btw): ${b1.omzetInclBtw == null ? 'n.v.t.' : '€ ' + b1.omzetInclBtw}
Calls afgerond: ${g(b3.afgerond)}
Klant geworden: ${g(b3.uitkomsten ? b3.uitkomsten.klantGeworden : null)}

Agency Command Center - Dagrapport
De Forex Opleiding NL B.V.`;
}

function escapeHtmlMail(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

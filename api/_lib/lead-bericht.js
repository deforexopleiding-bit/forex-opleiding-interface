// api/_lib/lead-bericht.js
//
// "Stuur bericht" (fase 1, 2026-10-09) — 1-op-1 naar een lead, vanuit Leads en
// Leadsonderhoud → Contacten. Twee kanalen:
//
//   WhatsApp — alleen ECHT goedgekeurde templates op de lead-lijn: live bij
//     360dialog voor de WABA van die lijn (goedgekeurdeTemplatesOpLijn), NIET de
//     status in whatsapp_meta_templates (die is van de oude WABA). Versturen via
//     sendTemplate; loggen via logOutboundWa (zoekt óf maakt het gesprek → het
//     bericht staat in de draad, ook bij een eerste contact).
//   E-mail — vrije HTML uit de editor, server-side opgeschoond, variabelen
//     ingevuld, in de huisstijl-shell (mail-shell-lead.js), verstuurd als
//     welkom@ (mailAfzender). Gelogd in email_replies met from=welkom@ en
//     to=lead — precies wat de Gesprekken-draad als uitgaande mail toont.
//
// Geen massaverzending (fase 2).

import { sendTemplate, templateStatusOpLijn, goedgekeurdeTemplatesOpLijn } from './meta-whatsapp.js';
import { logOutboundWa } from './wa-outbound-log.js';
import { sendEmailViaSmtp } from './send-email-core.js';
import { haalLijn, mailAfzender } from './leadsonderhoud-gesprekken.js';
import { renderLeadMail, htmlNaarTekst } from './mail-shell-lead.js';

export const E164_RE = /^\+[1-9]\d{7,14}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const STANDAARD_BOEKINGSLINK = 'https://www.deforexopleiding.nl/agenda';
export const MAIL_VARIABELEN = Object.freeze(['voornaam', 'achternaam', 'naam', 'email', 'boekingslink']);
const HANDTEKENING = 'Met vriendelijke groet,\n\nTeam - De Forex Opleiding';
const MAX_VAR = 500;

// ── Lead-variabelen (puur) ───────────────────────────────────────────────────

/** De waarden die in mail en WhatsApp invulbaar zijn. */
export function leadVariabelen(lead, { boekingslink } = {}) {
  const l = lead || {};
  const voornaam = String(l.voornaam || '').trim();
  const achternaam = String(l.achternaam || '').trim();
  return {
    voornaam,
    achternaam,
    naam: [voornaam, achternaam].filter(Boolean).join(' '),
    email: String(l.email || '').trim().toLowerCase(),
    boekingslink: String(boekingslink || '').trim() || STANDAARD_BOEKINGSLINK,
  };
}

// ── WhatsApp (puur) ──────────────────────────────────────────────────────────

const VOORNAAM_SLEUTEL = /^((lead|klant|attendee|customer|contact)\.)?(voornaam|first_?name)$/i;

/**
 * Per positie {{n}}: label + voorgestelde waarde.
 *   1. meta_param_mapping uit de CRM-tabel (als die er is) — voornaam-sleutels
 *      worden automatisch ingevuld;
 *   2. zonder mapping: een template met precies één variabele, of {{1}} direct
 *      na een aanhef (Hoi/Hey/Hallo/Beste/Dag/Hi) → voornaam.
 * Alles blijft bewerkbaar in de modal.
 */
export function waVariabelenVoorstel(template, vars, mapping = null) {
  const n = Number(template?.aantal_vars) || 0;
  const body = String(template?.body || '');
  const uit = [];
  for (let pos = 1; pos <= n; pos++) {
    const sleutel = mapping && typeof mapping === 'object' ? (mapping[String(pos)] || null) : null;
    let auto = false;
    if (sleutel) auto = VOORNAAM_SLEUTEL.test(String(sleutel));
    else if (n === 1) auto = true;
    else if (pos === 1) auto = new RegExp(`(^|\\s)(hoi|hey|hallo|beste|dag|hi)\\s+\\{\\{${pos}\\}\\}`, 'i').test(body);
    uit.push({
      pos,
      label: auto ? 'Voornaam' : (sleutel ? String(sleutel).replace(/^\w+\./, '').replace(/_/g, ' ') : `Variabele {{${pos}}}`),
      waarde: auto ? (vars?.voornaam || '') : '',
      auto,
    });
  }
  return uit;
}

// De lead-WABA wordt gedeeld met het klantnummer: daar staan ook aanmaningen,
// facturen, onboarding en interne meldingen. Die horen niet in "Stuur bericht"
// aan een lead (verkeerde context, kan een lead een factuurherinnering sturen).
const GEEN_LEAD_TEMPLATE = /^(aanmaning_|meerdere_facturen_|betaalherinnering|opvolging_geen_reactie|welkom_onboarding|interne_|nieuwe_lead$)/;

/** Hoort dit template in de lead-modal? (puur) */
export function isLeadTemplate(naam) {
  return !GEEN_LEAD_TEMPLATE.test(String(naam || ''));
}

/** Kan dit template 1-op-1 met alleen body-variabelen verstuurd worden? */
export function waVerstuurbaar(template) {
  if (!template) return { ok: false, reden: 'Onbekend template' };
  if (template.header_format && template.header_format !== 'TEXT') return { ok: false, reden: 'Template met media-kop wordt nog niet ondersteund' };
  if (template.header_heeft_var) return { ok: false, reden: 'Template met variabele in de kop wordt nog niet ondersteund' };
  return { ok: true };
}

export function renderWaTekst(body, variabelen) {
  return String(body || '').replace(/\{\{(\d+)\}\}/g, (m, n) => {
    const v = variabelen?.[Number(n) - 1];
    return v == null || v === '' ? m : String(v);
  });
}

// ── E-mail (puur) ────────────────────────────────────────────────────────────

const TOEGESTAAN = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote', 'div', 'span']);
const GEVAARLIJK = 'script|style|iframe|object|embed|noscript|template|svg|math|title|head';

/**
 * HTML uit de editor opschonen: alleen een vaste set tags, geen attributen
 * behalve een veilige href op <a> (http/https/mailto of een {{variabele}}).
 * script/style/iframe e.d. inclusief inhoud weg.
 */
export function schoonHtml(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(new RegExp(`<(${GEVAARLIJK})\\b[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '');
  s = s.replace(new RegExp(`<\\/?(${GEVAARLIJK})\\b[^>]*>`, 'gi'), '');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (tag, naam, attrs) => {
    const t = naam.toLowerCase();
    if (!TOEGESTAAN.has(t)) return '';
    if (tag.startsWith('</')) return t === 'br' ? '' : `</${t}>`;
    if (t === 'br') return '<br>';
    if (t === 'a') {
      const m = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || '');
      const href = m ? String(m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
      const veilig = /^(https?:\/\/|mailto:)/i.test(href) || /^\{\{\s*\w+\s*\}\}$/.test(href);
      return veilig ? `<a href="${href.replace(/"/g, '&quot;')}" style="color:#10284A;text-decoration:underline">` : '<a>';
    }
    return `<${t}>`;
  });
  return s.trim();
}

const escHtml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** {{naam}}-tokens die niet bestaan (dan niet versturen — anders ziet de lead "{{x}}"). */
export function onbekendeVariabelen(tekst) {
  const namen = [...String(tekst || '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
  return [...new Set(namen.filter((n) => !MAIL_VARIABELEN.includes(n)))];
}

/** Vul {{variabelen}} in. html=true → waarden HTML-escapen. */
export function vulMailVariabelen(tekst, vars, { html = false } = {}) {
  return String(tekst || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    if (!(k in vars)) return m;
    return html ? escHtml(vars[k]) : String(vars[k]);
  });
}

// ── Versturen ────────────────────────────────────────────────────────────────

export class LeadBerichtFout extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}

/** Live templates op de lead-lijn + voorstel per template. */
export async function waTemplatesVoorLead(sb, lead, vars) {
  const lijn = await haalLijn();
  if (!lijn.phoneNumberId) return { ok: false, reden: 'GEEN_LIJN', templates: [] };
  const live = await goedgekeurdeTemplatesOpLijn(lijn.phoneNumberId);
  if (!live.ok) return { ok: false, reden: live.reden, templates: [] };
  const leadTemplates = live.templates.filter((t) => isLeadTemplate(t.name));
  const namen = leadTemplates.map((t) => t.name);
  const mappingOp = new Map();
  if (namen.length) {
    const { data, error } = await sb.from('whatsapp_meta_templates')
      .select('name, language, meta_param_mapping, updated_at').in('name', namen).order('updated_at', { ascending: false });
    if (error) console.warn('[lead-bericht] mapping lezen mislukt:', error.message);
    for (const r of data || []) {
      const k = `${r.name}|${r.language}`;
      if (!mappingOp.has(k) && r.meta_param_mapping?.body) mappingOp.set(k, r.meta_param_mapping.body);
    }
  }
  return {
    ok: true,
    phone_number_id: lijn.phoneNumberId,
    waba_id: live.waba_id || null,
    lijn: lijn.label || null,
    templates: leadTemplates.map((t) => ({
      ...t,
      verstuurbaar: waVerstuurbaar(t),
      variabelen: waVariabelenVoorstel(t, vars, mappingOp.get(`${t.name}|${t.language}`) || null),
    })),
  };
}

export async function verstuurWaTemplate(sb, { lead, templateNaam, taal = 'nl', variabelen = [], agent = null }) {
  const tel = String(lead?.telefoon_e164 || '').trim();
  if (!E164_RE.test(tel)) throw new LeadBerichtFout(409, 'GEEN_GELDIG_NUMMER', 'Deze lead heeft geen geldig telefoonnummer.');
  const lijn = await haalLijn();
  if (!lijn.phoneNumberId) throw new LeadBerichtFout(409, 'GEEN_LIJN', 'Geen WhatsApp-lijn ingesteld voor leads.');
  const live = await goedgekeurdeTemplatesOpLijn(lijn.phoneNumberId);
  if (!live.ok) throw new LeadBerichtFout(503, 'TEMPLATES_ONBEKEND', 'Kon de goedgekeurde templates niet ophalen. Probeer het zo opnieuw.');
  if (!isLeadTemplate(templateNaam)) throw new LeadBerichtFout(409, 'GEEN_LEAD_TEMPLATE', `Template "${templateNaam}" is niet bedoeld voor leads (factuur/onboarding/intern).`);
  const t = live.templates.find((x) => x.name === templateNaam && x.language === taal);
  if (!t) {
    const status = await templateStatusOpLijn(lijn.phoneNumberId, templateNaam, taal);
    throw new LeadBerichtFout(409, 'TEMPLATE_NIET_GOEDGEKEURD', `Template "${templateNaam}" is niet goedgekeurd op de lead-lijn (${status || 'onbekend'}).`);
  }
  const v = waVerstuurbaar(t);
  if (!v.ok) throw new LeadBerichtFout(409, 'TEMPLATE_NIET_ONDERSTEUND', v.reden);
  const waarden = (Array.isArray(variabelen) ? variabelen : []).map((x) => String(x ?? '').trim().slice(0, MAX_VAR));
  if (waarden.length !== t.aantal_vars) throw new LeadBerichtFout(400, 'VARIABELEN', `Template verwacht ${t.aantal_vars} variabele(n), ontvangen ${waarden.length}.`);
  const leeg = waarden.findIndex((x) => !x);
  if (leeg >= 0) throw new LeadBerichtFout(400, 'VARIABELE_LEEG', `Variabele {{${leeg + 1}}} is leeg.`);

  let wamid = null;
  try {
    const r = await sendTemplate({ to: tel.replace(/^\+/, ''), templateName: t.name, languageCode: t.language, variables: waarden, phoneNumberId: lijn.phoneNumberId });
    wamid = r?.wamid || null;
  } catch (e) {
    console.error('[lead-bericht] WA versturen mislukt', { lead: lead.id, template: t.name, fout: e?.message || e });
    throw new LeadBerichtFout(502, 'WA_FOUT', 'WhatsApp versturen mislukt: ' + String(e?.message || e).slice(0, 300));
  }
  const tekst = renderWaTekst(t.body, waarden);
  const log = await logOutboundWa(sb, {
    toPhone: tel, phoneNumberId: lijn.phoneNumberId, body: tekst, wamid,
    templateName: t.name, templateVariables: Object.fromEntries(waarden.map((x, i) => [i + 1, x])), source: 'lead-bericht',
  });
  if (!log?.ok) console.error('[lead-bericht] in de draad loggen mislukt', { lead: lead.id, fout: log?.error });
  const { error: blErr } = await sb.from('berichten_log').insert({
    lead_id: lead.id, traject: lead.traject || null, soort: 'handmatig-template', kanaal: 'whatsapp',
    // berichten_log heeft GEEN meta_template-kolom (die insert faalde) — de wamid in extern_id.
    naar: tel, agent: agent || 'handmatig', status: 'ok', verstuurd_op: new Date().toISOString(), extern_id: wamid,
  });
  if (blErr) console.warn('[lead-bericht] berichten_log (WA) mislukt:', blErr.message);
  return { ok: true, wamid, conversation_id: log?.conv_id || null, in_draad: !!log?.ok };
}

export async function verstuurMail(sb, { lead, onderwerp, html, boekingslink, userId = null }) {
  const naar = String(lead?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(naar)) throw new LeadBerichtFout(409, 'GEEN_GELDIG_EMAIL', 'Deze lead heeft geen geldig e-mailadres.');
  const ruwOnderwerp = String(onderwerp || '').trim();
  if (!ruwOnderwerp) throw new LeadBerichtFout(400, 'ONDERWERP_LEEG', 'Onderwerp ontbreekt.');
  const schoon = schoonHtml(html);
  if (!htmlNaarTekst(schoon).trim()) throw new LeadBerichtFout(400, 'BERICHT_LEEG', 'Het bericht is leeg.');
  const onbekend = onbekendeVariabelen(ruwOnderwerp + ' ' + schoon);
  if (onbekend.length) throw new LeadBerichtFout(400, 'ONBEKENDE_VARIABELEN', `Onbekende variabele(n): ${onbekend.map((x) => '{{' + x + '}}').join(', ')}.`, { onbekend });

  const vars = leadVariabelen(lead, { boekingslink });
  const subject = vulMailVariabelen(ruwOnderwerp, vars).slice(0, 200);
  const bodyHtml = vulMailVariabelen(schoon, vars, { html: true });
  const tekst = htmlNaarTekst(bodyHtml) + '\n\n' + HANDTEKENING;
  const afzender = mailAfzender();
  const r = await sendEmailViaSmtp({ fromMailbox: afzender, to: naar, subject, text: tekst, html: renderLeadMail({ bodyHtml }) });
  if (!r?.ok) {
    console.error('[lead-bericht] mail versturen mislukt', { lead: lead.id, code: r?.code, fout: r?.reason });
    if (r?.code === 'SMTP_NOT_CONFIGURED') throw new LeadBerichtFout(503, 'MAIL_NIET_GECONFIGUREERD', 'Afzender-mailbox niet geconfigureerd.');
    throw new LeadBerichtFout(502, 'MAIL_FOUT', 'E-mail versturen mislukt: ' + String(r?.reason || 'onbekend').slice(0, 300));
  }
  const nu = new Date().toISOString();
  // email_replies = wat de Gesprekken-draad als uitgaande mailbubbel toont
  // (leadsonderhoud-gesprek-berichten: from ILIKE welkom@ + to = lead).
  const { error: erErr } = await sb.from('email_replies').insert({
    email_id: null, email_subject: subject, final_reply: tekst,
    from_address: afzender, to_address: naar, sent_at: nu, sent_by_id: userId,
  });
  if (erErr) console.error('[lead-bericht] email_replies (draad) mislukt:', erErr.message);
  // soort 'handmatig-antwoord': de draad slaat die in berichten_log over (de bubbel
  // komt al uit email_replies) — zelfde afspraak als leadsonderhoud-gesprek-mailantwoord.
  const { error: blErr } = await sb.from('berichten_log').insert({
    lead_id: lead.id, soort: 'handmatig-antwoord', kanaal: 'mail', naar, traject: lead.traject || null,
    agent: 'handmatig', status: 'verstuurd', verstuurd_op: nu, extern_id: r.messageId || null,
  });
  if (blErr) console.warn('[lead-bericht] berichten_log (mail) mislukt:', blErr.message);
  return { ok: true, messageId: r.messageId || null, in_draad: !erErr, onderwerp: subject };
}

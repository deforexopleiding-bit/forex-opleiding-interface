// api/lead-melding.js
// Nieuwe-lead-melding via WhatsApp naar een eigen meldingsnummer.
//
// De website (dfo-website) roept dit endpoint server-naar-server aan zodra er
// een nieuwe lead is aangemaakt. De Meta-token blijft hier in het CRM; de
// website heeft alleen dit ene, smalle secret nodig (least privilege — een lek
// van dit secret laat hooguit lead-meldingen versturen, geen andere endpoints).
//
// Auth:
//   x-internal-token == LEAD_MELDING_SECRET   (verplicht)
//
// Body:
//   { naam: string, traject: string, lead_id?: uuid, bron?: string,
//     score?: string, kwalificatie?: string, drempel?: string }
//     naam    -> WhatsApp-template {{1}}  (voor- + achternaam van de lead)
//     traject -> WhatsApp-template {{2}}  (traject of soort, bv. '7-daagse')
//     bron    -> WhatsApp-template {{3}}  (funnelvariant, bv. 'webinar-v1'):
//                leads.bron via lead_id, anders body.bron, anders 'onbekend'
//     score/kwalificatie/drempel -> OPTIONEEL, alleen benut in de e-mail
//       (vragenlijst-verrijking).
//
// Verstuurt op DEZELFDE trigger twee onafhankelijke, fail-soft kanalen:
//   1) WhatsApp naar LEAD_MELDING_NUMMER (default +31655270212) via de env-default
//      afzendlijn, met de eerste bruikbare UTILITY-template uit TEMPLATE_KETEN:
//        interne_nieuwe_lead_v2_nl (3 params, leesbaar: Naam/Traject/Bron)
//        → interne_nieuwe_lead_nl  (2 params)
//        → nieuwe_lead             (2 params, staat bij Meta op MARKETING)
//      Door naar de volgende ALLEEN bij een templateprobleem (Meta 132xxx: bestaat
//      niet / nog niet goedgekeurd), zodat de melding nooit stilvalt zolang een
//      nieuwe template in review is. 2026-10-29: 'nieuwe_lead' viel onder Meta's
//      marketinggrens per ontvanger. Indienen: Admin → Integraties → Lead-melding
//      (api/admin-lead-melding-template.js). Override van de eerste: env
//      LEAD_MELDING_TEMPLATE;
//   2) interne e-mail (verrijkt) VANAF welkom@deforexopleiding.nl NAAR
//      LEAD_MELDING_EMAIL (default leads@deforexopleiding.nl) via
//      mailer.sendWelkomMail (welkom@-transport, IMAP_PASS_WELKOM vereist).
//
// Response:
//   200  { ok:true,  whatsapp:{…}, email:{…} }   (>= 1 kanaal geslaagd)
//   400  body-validatie
//   401  geen LEAD_MELDING_SECRET-match
//   405  geen POST
//   502  { ok:false, whatsapp:{…}, email:{…} }   (beide kanalen faalden)
//   503  LEAD_MELDING_SECRET niet geconfigureerd

import { sendTemplate, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { sendWelkomMail, wrapEmailHtml } from './mailer.js';
import { supabaseAdmin } from './supabase.js';

// Volgorde van de templates (zie de kop). Aantal variabelen per template.
export const TEMPLATE_KETEN = Object.freeze(['interne_nieuwe_lead_v2_nl', 'interne_nieuwe_lead_nl', 'nieuwe_lead']);
const AANTAL_VARS = Object.freeze({ interne_nieuwe_lead_v2_nl: 3 });
const TAAL = 'nl';
// Meta 132xxx = templateprobleem (bestaat niet / nog niet goedgekeurd / gepauzeerd).
const isTemplateProbleem = (e) => String(e?.metaCode || '').startsWith('132') || /\b132\d{3}\b/.test(String(e?.message || ''));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keten met env LEAD_MELDING_TEMPLATE (indien gezet) vooraan. PURE. */
export function templateKeten(env = process.env) {
  const eerste = String(env.LEAD_MELDING_TEMPLATE || '').trim();
  return eerste ? [eerste, ...TEMPLATE_KETEN.filter((t) => t !== eerste)] : [...TEMPLATE_KETEN];
}

/**
 * WhatsApp-parameter veilig maken (PURE): Meta weigert regeleinden, tabs en 4+
 * spaties op rij in een variabele, en een lege variabele. Leeg → fallback.
 */
export function waParam(v, fallback = '') {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 100);
  return s || fallback;
}

/** leads.bron van deze lead (de funnelvariant). Fail-soft: null bij twijfel. */
async function leesBron(leadId) {
  if (!UUID_RE.test(String(leadId || ''))) return null;
  try {
    const { data, error } = await supabaseAdmin.from('leads').select('bron').eq('id', leadId).maybeSingle();
    if (error) { console.warn('[lead-melding] leads.bron lezen mislukt (soft):', error.message); return null; }
    return data?.bron || null;
  } catch (e) {
    console.warn('[lead-melding] leads.bron lezen exception (soft):', e?.message || e);
    return null;
  }
}
const STANDAARD_NUMMER = '+31655270212';
// Verzendlijn: standaard de bestaande Esmee-lijn (leadsonderhoud, actief onder
// WABA 990429800401598). Override via env LEAD_MELDING_AFZENDLIJN.
const STANDAARD_AFZENDLIJN = '1232908829908396';
// Interne e-mail-ontvanger van de lead-melding (override via env LEAD_MELDING_EMAIL).
const STANDAARD_MAIL = 'leads@deforexopleiding.nl';
const MAX_LEN = 200; // knip absurd lange waarden af (WhatsApp-param-limiet + hygiëne)

function schoon(v) {
  return typeof v === 'string' ? v.trim().slice(0, MAX_LEN) : '';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Bouwt de interne lead-melding-mail. naam/traject verplicht; score/kwalificatie/
// drempel optioneel (verrijking uit de vragenlijst). Retourneert {subject,text,html}.
function bouwLeadMail({ naam, traject, bron, score, kwalificatie, drempel }) {
  const subject = `Nieuwe lead: ${naam}${traject ? ` — ${traject}` : ''}`;
  const rijen = [
    ['Naam', naam],
    ['Traject', traject],
  ];
  if (bron)         rijen.push(['Bron', bron]);
  if (score)        rijen.push(['Vragenlijst-score', score]);
  if (kwalificatie) rijen.push(['Kwalificatie', drempel ? `${kwalificatie} (drempel ${drempel})` : kwalificatie]);

  const text = 'Nieuwe lead binnengekomen.\n\n'
    + rijen.map(([k, v]) => `${k}: ${v}`).join('\n');

  const bodyHtml = `<p style="margin:0 0 16px">Nieuwe lead binnengekomen.</p>
    <table cellpadding="0" cellspacing="0" border="0" style="font-size:15px; line-height:1.6">
      ${rijen.map(([k, v]) =>
        `<tr><td style="padding:2px 16px 2px 0; color:#666; white-space:nowrap"><b>${escapeHtml(k)}</b></td>`
        + `<td style="padding:2px 0">${escapeHtml(v)}</td></tr>`).join('')}
    </table>`;

  return { subject, text, html: wrapEmailHtml(subject, bodyHtml) };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth: eigen gedeeld secret ----
  const tokenHeader = req.headers['x-internal-token'] || null;
  const verwacht = process.env.LEAD_MELDING_SECRET || null;
  if (!verwacht) {
    return res.status(503).json({ error: 'LEAD_MELDING_SECRET niet geconfigureerd' });
  }
  if (!tokenHeader || tokenHeader !== verwacht) {
    return res.status(401).json({ error: 'Unauthorized (x-internal-token vereist)' });
  }

  // ---- Body (naam + traject verplicht; verrijking optioneel) ----
  const body = req.body || {};
  const naam = schoon(body.naam);
  const traject = schoon(body.traject);
  if (!naam) return res.status(400).json({ error: 'naam vereist' });
  if (!traject) return res.status(400).json({ error: 'traject vereist' });
  // Optionele verrijking uit de vragenlijst (B2): score, kwalificatie
  // (toegelaten/afgewezen) en drempel. Alleen in de e-mail benut; het
  // WhatsApp-template blijft 2 params (nieuw template nodig om die te verrijken).
  const score        = schoon(body.score);
  const kwalificatie = schoon(body.kwalificatie);
  const drempel      = schoon(body.drempel);
  // Funnelvariant: leads.bron (gezaghebbend) → meegestuurde bron → 'onbekend'.
  const bron = waParam(await leesBron(body.lead_id), waParam(body.bron, 'onbekend'));

  const to = process.env.LEAD_MELDING_NUMMER || STANDAARD_NUMMER;
  const phoneNumberId = process.env.LEAD_MELDING_AFZENDLIJN || STANDAARD_AFZENDLIJN;

  // ---- Kanaal 1: WhatsApp (eerste bruikbare template uit de keten). Fail-soft. ----
  let whatsapp = { ok: false };
  const params = [waParam(naam, 'onbekend'), waParam(traject, 'onbekend'), bron];
  const verstuur = (templateName) => sendTemplate({
    to,
    templateName,
    languageCode: TAAL,
    // {{1}}=naam, {{2}}=traject, en bij de v2-template {{3}}=bron.
    variables: params.slice(0, AANTAL_VARS[templateName] || 2),
    phoneNumberId,              // Esmee-lijn (of env-override)
  });
  try {
    const keten = templateKeten();
    let template = null;
    let wamid = null;
    for (let i = 0; i < keten.length; i++) {
      try {
        ({ wamid } = await verstuur(keten[i]));
        template = keten[i];
        break;
      } catch (e1) {
        if (i === keten.length - 1 || !isTemplateProbleem(e1)) throw e1;
        console.warn(`[lead-melding] template '${keten[i]}' nog niet bruikbaar, verder met '${keten[i + 1]}':`, e1.message);
      }
    }
    whatsapp = { ok: true, wamid, template };
  } catch (e) {
    if (e instanceof MetaNotConfiguredError) {
      whatsapp = { ok: false, skipped: true, reason: 'meta-not-configured' };
      console.error('[lead-melding] Meta niet geconfigureerd:', e.message);
    } else {
      whatsapp = { ok: false, error: e.message };
      console.error('[lead-melding] WhatsApp versturen mislukt:', e.message);
    }
  }

  // ---- Kanaal 2: interne e-mail VANAF welkom@ NAAR leads@ (verrijkt). Fail-soft. ----
  let email = { ok: false };
  const mailTo = process.env.LEAD_MELDING_EMAIL || STANDAARD_MAIL;
  try {
    const { subject, text, html } = bouwLeadMail({ naam, traject, bron, score, kwalificatie, drempel });
    const r = await sendWelkomMail({ to: mailTo, subject, text, html });
    email = (r && r.success)
      ? { ok: true, messageId: r.messageId }
      : { ok: false, error: (r && r.error) || 'onbekende mailfout' };
    if (!email.ok) console.error('[lead-melding] e-mail versturen mislukt:', email.error);
  } catch (e) {
    email = { ok: false, error: e.message };
    console.error('[lead-melding] e-mail versturen mislukt:', e.message);
  }

  // 200 zodra minstens één kanaal lukte; anders 502. Kanalen zijn onafhankelijk.
  const status = (whatsapp.ok || email.ok) ? 200 : 502;
  return res.status(status).json({ ok: status === 200, whatsapp, email });
}

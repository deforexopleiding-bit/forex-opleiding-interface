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
//   { naam: string, traject: string }
//     naam    -> template {{1}}  (voor- + achternaam van de lead)
//     traject -> template {{2}}  (traject of soort, bv. '7-daagse')
//
// Verzendt template 'nieuwe_lead' (UTILITY, nl, 2 params) naar
// LEAD_MELDING_NUMMER (default +31655270212) via de env-default afzendlijn.
//
// Response:
//   200  { ok:true, wamid }
//   400  body-validatie
//   401  geen LEAD_MELDING_SECRET-match
//   405  geen POST
//   502  Meta API-fout
//   503  LEAD_MELDING_SECRET / Meta WhatsApp niet geconfigureerd

import { sendTemplate, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';

const TEMPLATE_NAAM = 'nieuwe_lead';
const TAAL = 'nl';
const STANDAARD_NUMMER = '+31655270212';
// Verzendlijn: standaard de bestaande Esmee-lijn (leadsonderhoud, actief onder
// WABA 990429800401598). Override via env LEAD_MELDING_AFZENDLIJN.
const STANDAARD_AFZENDLIJN = '1232908829908396';
const MAX_LEN = 200; // knip absurd lange waarden af (WhatsApp-param-limiet + hygiëne)

function schoon(v) {
  return typeof v === 'string' ? v.trim().slice(0, MAX_LEN) : '';
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

  // ---- Body ----
  const body = req.body || {};
  const naam = schoon(body.naam);
  const traject = schoon(body.traject);
  if (!naam) return res.status(400).json({ error: 'naam vereist' });
  if (!traject) return res.status(400).json({ error: 'traject vereist' });

  const to = process.env.LEAD_MELDING_NUMMER || STANDAARD_NUMMER;
  const phoneNumberId = process.env.LEAD_MELDING_AFZENDLIJN || STANDAARD_AFZENDLIJN;

  try {
    const { wamid } = await sendTemplate({
      to,
      templateName: TEMPLATE_NAAM,
      languageCode: TAAL,
      variables: [naam, traject], // exact 2 params: {{1}}=naam, {{2}}=traject
      phoneNumberId,              // Esmee-lijn (of env-override)
    });
    return res.status(200).json({ ok: true, wamid });
  } catch (e) {
    if (e instanceof MetaNotConfiguredError) {
      console.error('[lead-melding] Meta niet geconfigureerd:', e.message);
      return res.status(503).json({ error: 'Meta WhatsApp niet geconfigureerd' });
    }
    console.error('[lead-melding] versturen mislukt:', e.message);
    return res.status(502).json({ error: 'Meta API-fout', detail: e.message });
  }
}

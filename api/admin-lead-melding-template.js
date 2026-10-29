// api/admin-lead-melding-template.js
//
// Dient een WhatsApp-template voor de lead-melding (UTILITY, nl) server-side in
// via de 360dialog template-management-API, met de hoofdlijn-credentials (de key
// leeft alleen in Vercel). Zelfde opzet als admin-dagrapport-template.js.
//
// Waarom (2026-10-29): de lead-melding ging met 'nieuwe_lead', dat bij Meta op
// MARKETING stond. Marketing valt onder Meta's frequentiegrens per ontvanger; toen
// die op het meldingsnummer bereikt was, kwamen de lead-meldingen niet meer aan
// (de afspraak-melding, UTILITY, wel). Deze templates zijn strikt transactioneel
// en intern, zodat Meta ze als UTILITY houdt. Een goedgekeurde body NOOIT wijzigen:
// nieuwe tekst = nieuwe naam (api/lead-melding.js valt terug zolang die in review is).
//   interne_nieuwe_lead_v2_nl  (standaard) leesbaar: Naam / Traject / Bron (3 params)
//   interne_nieuwe_lead_nl     (eerste versie, 2 params) — blijft de terugval
//
//   POST /api/admin-lead-melding-template                 → v2 indienen bij 360dialog
//   POST /api/admin-lead-melding-template?template=<naam> → een andere uit TEMPLATES
//   POST /api/admin-lead-melding-template?dry=1           → alleen de payload teruggeven
//
// Auth: ingelogde admin (Bearer user-JWT) OF CRON_SECRET (Bearer).

import { verifyAdmin, checkCronAuth } from './supabase.js';
import { WA_NUMMERS, D360_BASE_URL, apiKeyVan } from './_lib/wa-nummers.js';

const TAAL = 'nl';
const FOOTER_TEKST = 'De Forex Opleiding · interne melding';

export const TEMPLATES = Object.freeze({
  interne_nieuwe_lead_v2_nl: Object.freeze({
    body: 'Er is een nieuwe aanmelding binnengekomen.\nNaam: {{1}}\nTraject: {{2}}\nBron: {{3}}\n\nOpen Leadsonderhoud om de lead op te volgen.',
    voorbeeld: ['Rudy Jansen', 'webinar', 'webinar-v1'],
  }),
  interne_nieuwe_lead_nl: Object.freeze({
    body: 'Nieuwe aanmelding in het CRM: {{1}}, via {{2}}. Open Leadsonderhoud om de lead op te volgen.',
    voorbeeld: ['Sanne de Vries', 'minicursus'],
  }),
});
export const TEMPLATE_NAAM = 'interne_nieuwe_lead_v2_nl';

export function bouwPayload(naam = TEMPLATE_NAAM) {
  const t = TEMPLATES[naam];
  if (!t) return null;
  return {
    name: naam,
    category: 'UTILITY',
    language: TAAL,
    components: [
      { type: 'BODY', text: t.body, example: { body_text: [[...t.voorbeeld]] } },
      { type: 'FOOTER', text: FOOTER_TEKST },
    ],
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const cron = checkCronAuth(req);
  const admin = cron.ok ? true : await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin of CRON_SECRET vereist' });

  const naam = String((req.query && req.query.template) || TEMPLATE_NAAM);
  const payload = bouwPayload(naam);
  if (!payload) return res.status(400).json({ error: `Onbekend template '${naam}'`, bekend: Object.keys(TEMPLATES) });
  if (req.query && (req.query.dry === '1' || req.query.dry === 'true')) {
    return res.status(200).json({ dry_run: true, payload });
  }

  const hoofd = WA_NUMMERS.find((n) => n.sleutel === 'hoofdnummer');
  if (!hoofd) return res.status(500).json({ error: 'hoofdnummer niet in WA_NUMMERS' });
  const key = apiKeyVan(hoofd);
  if (!key) {
    return res.status(503).json({
      error: `360dialog-key ontbreekt (env ${hoofd.api_key_env}). Dien het template handmatig in via de Hub.`,
      fallback: 'hub',
    });
  }

  try {
    const r = await fetch(`${D360_BASE_URL}/v1/configs/templates`, {
      method: 'POST',
      headers: { 'D360-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const tekst = await r.text();
    let json = null;
    try { json = tekst ? JSON.parse(tekst) : null; } catch { /* laat json null */ }

    if (!r.ok) {
      console.error('[admin-lead-melding-template] 360dialog weigerde:', r.status, tekst.slice(0, 400));
      return res.status(502).json({
        ok: false,
        http_status: r.status,
        error: (json && (json.error || json.message)) || tekst.slice(0, 400),
        fallback: 'hub',
        hint: 'Lukt dit niet, dien het template dan handmatig in via de 360dialog-Hub (categorie Utility, tekst hieronder).',
        payload,
      });
    }

    const status = (json && (json.status || json.data?.status)) || 'submitted';
    return res.status(200).json({ ok: true, status, name: naam, language: TAAL, channel: 'hoofdnummer', response: json });
  } catch (e) {
    console.error('[admin-lead-melding-template] exception:', e?.message || e);
    return res.status(502).json({ ok: false, error: e?.message || String(e), fallback: 'hub', payload });
  }
}

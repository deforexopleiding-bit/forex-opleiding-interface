// api/admin-lead-melding-template.js
//
// Dient het WhatsApp-template 'interne_nieuwe_lead_nl' (UTILITY, nl) server-side
// in via de 360dialog template-management-API, met de hoofdlijn-credentials (de
// key leeft alleen in Vercel). Zelfde opzet als admin-dagrapport-template.js.
//
// Waarom (2026-10-29): de lead-melding ging met 'nieuwe_lead', dat bij Meta op
// MARKETING stond. Marketing valt onder Meta's frequentiegrens per ontvanger; toen
// die op het meldingsnummer bereikt was, kwamen de lead-meldingen niet meer aan
// (de afspraak-melding, UTILITY, wel). Dit template is strikt transactioneel en
// intern, zodat Meta het als UTILITY houdt. api/lead-melding.js gebruikt het
// zodra het goedgekeurd is (tot dan valt die terug op 'nieuwe_lead').
//
//   POST /api/admin-lead-melding-template          → indienen bij 360dialog
//   POST /api/admin-lead-melding-template?dry=1     → alleen de payload teruggeven
//
// Auth: ingelogde admin (Bearer user-JWT) OF CRON_SECRET (Bearer).

import { verifyAdmin, checkCronAuth } from './supabase.js';
import { WA_NUMMERS, D360_BASE_URL, apiKeyVan } from './_lib/wa-nummers.js';

export const TEMPLATE_NAAM = 'interne_nieuwe_lead_nl';
const TAAL = 'nl';
export const BODY_TEKST = 'Nieuwe aanmelding in het CRM: {{1}}, via {{2}}. Open Leadsonderhoud om de lead op te volgen.';
const FOOTER_TEKST = 'De Forex Opleiding · interne melding';

export function bouwPayload() {
  return {
    name: TEMPLATE_NAAM,
    category: 'UTILITY',
    language: TAAL,
    components: [
      { type: 'BODY', text: BODY_TEKST, example: { body_text: [['Sanne de Vries', 'minicursus']] } },
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

  const payload = bouwPayload();
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
    return res.status(200).json({ ok: true, status, name: TEMPLATE_NAAM, language: TAAL, channel: 'hoofdnummer', response: json });
  } catch (e) {
    console.error('[admin-lead-melding-template] exception:', e?.message || e);
    return res.status(502).json({ ok: false, error: e?.message || String(e), fallback: 'hub', payload });
  }
}

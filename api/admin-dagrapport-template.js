// api/admin-dagrapport-template.js
//
// Dient het WhatsApp-template 'dfo_dagrapport' (UTILITY, nl) server-side in via
// de 360dialog template-management-API, met de hoofdlijn-credentials (de key
// leeft alleen in Vercel). Tekst-template met een dynamische URL-knop naar de
// redirect-endpoint - geen document-header, dus geen resumable-upload-handle
// nodig (die kan de channel-key niet maken).
//
//   POST /api/admin-dagrapport-template          → indienen bij 360dialog
//   POST /api/admin-dagrapport-template?dry=1     → alleen de payload teruggeven
//
// Auth: ingelogde admin (Bearer user-JWT) OF CRON_SECRET (Bearer). Zo kan het
// zowel vanuit een admin-knop als eenmalig programmatisch.
//
// Lukt het niet (geen key / geen rechten / 360dialog weigert), dan geeft het een
// duidelijke fout terug en val je terug op de handmatige Hub-stappen.

import { verifyAdmin, checkCronAuth } from './supabase.js';
import { WA_NUMMERS, D360_BASE_URL, apiKeyVan } from './_lib/wa-nummers.js';

const TEMPLATE_NAAM = 'dfo_dagrapport';
const TAAL = 'nl';
const BODY_TEKST = 'Je dagrapport van {{1}} staat klaar. Tik op de knop om de cijfers van vandaag te openen: sales en omzet, calls en uitkomsten, belwerk en nieuwe leads.';
const FOOTER_TEKST = 'De Forex Opleiding · intern dagrapport';
const DEFAULT_BASE_URL = 'https://crm.deforexopleiding.nl';

function bouwPayload(baseUrl) {
  const basis = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const voorbeeldToken = '0123456789abcdef0123456789abcdef';
  return {
    name: TEMPLATE_NAAM,
    category: 'UTILITY',
    language: TAAL,
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Dagrapport' },
      { type: 'BODY', text: BODY_TEKST, example: { body_text: [['woensdag 28 oktober 2026']] } },
      { type: 'FOOTER', text: FOOTER_TEKST },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Open rapport', url: `${basis}/r/{{1}}`, example: [`${basis}/r/${voorbeeldToken}`] },
        ],
      },
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

  // Auth: admin-JWT of cron-secret.
  const cron = checkCronAuth(req);
  const admin = cron.ok ? true : await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin of CRON_SECRET vereist' });

  const baseUrl = (req.query && req.query.base_url) || process.env.DAGRAPPORT_BASE_URL || DEFAULT_BASE_URL;
  const payload = bouwPayload(baseUrl);

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
      console.error('[admin-dagrapport-template] 360dialog weigerde:', r.status, tekst.slice(0, 400));
      return res.status(502).json({
        ok: false,
        http_status: r.status,
        error: (json && (json.error || json.message)) || tekst.slice(0, 400),
        fallback: 'hub',
        hint: 'Lukt dit niet, dien het template dan handmatig in via de 360dialog-Hub (tekst + URL-knop).',
      });
    }

    const status = (json && (json.status || json.data?.status)) || 'submitted';
    return res.status(200).json({
      ok: true,
      status,                 // bv. 'submitted' / 'pending' / 'PENDING' (Meta-review loopt)
      name: TEMPLATE_NAAM,
      language: TAAL,
      channel: 'hoofdnummer',
      response: json,
    });
  } catch (e) {
    console.error('[admin-dagrapport-template] exception:', e?.message || e);
    return res.status(502).json({ ok: false, error: e?.message || String(e), fallback: 'hub' });
  }
}

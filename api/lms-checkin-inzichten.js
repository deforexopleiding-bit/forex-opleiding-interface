// api/lms-checkin-inzichten.js
//
// Machine-route voor het LMS (dfo-lms): DE INZICHTEN VAN DE STUDENTENCHECK-IN
// (Maxim, 29 okt 2026) voor /admin/checkin en /hoofdmentor (tab Check-in →
// Inzichten). Server-naar-server, GEEN CORS — het geheim mag nooit in een browser.
//
//   GET ?traject&mentor&fase&trade_stand&test=1&campagne=<slug>   → { ok, code, data: {campagne, inzichten} }
//   GET ...&csv=1                                                → text/csv (één rij per inzending)
//
// Auth: header `x-dfo-secret` (zelfde regel als api/lms-onboarding-sessie.js).
// Het LMS laat dit ALLEEN aan hoofdmentor/admin zien: de open antwoorden staan
// er met naam bij, en een mentor ziet niets van de check-in.
//
// Eén rekenkern met het CRM-scherm: api/_lib/checkin-inzichten.js.

import { machineToegang } from './lms-onboarding-sessie.js';
import { supabaseAdmin } from './supabase.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { laadOverzicht, stuurInzichten } from './checkin-beheer.js';

function antwoord(res, status, ok, code, message, data = null) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json({ ok, code, message, data });
}

export function maakHandler(deps = {}) {
  const d = { lms: () => getDfoLmsClient(), crm: supabaseAdmin, laad: laadOverzicht, ...deps };
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const toegang = machineToegang(req.headers['x-dfo-secret']);
    if (toegang === 'niet_geconfigureerd') return antwoord(res, 503, false, 'niet_geconfigureerd', 'De brug is niet geconfigureerd.');
    if (toegang !== 'ok') return antwoord(res, 403, false, 'machine_toegang_dicht', 'Geen toegang.');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return antwoord(res, 405, false, 'methode_niet_toegestaan', 'Alleen GET is toegestaan.');
    }
    const lms = d.lms();
    if (!lms) return antwoord(res, 503, false, 'lms_niet_geconfigureerd', 'DFO_LMS_SUPABASE_URL/KEY ontbreekt.');
    const q = req.query || {};
    try {
      const ov = await d.laad({ lms, crm: d.crm, slug: typeof q.campagne === 'string' ? q.campagne : null });
      if (String(q.csv || '') === '1') return stuurInzichten(res, ov, q);
      //  Zelfde inhoud als het CRM-scherm, verpakt zoals de andere bruggen.
      const nep = { _body: null, status() { return this; }, json(b) { this._body = b; return this; }, setHeader() {} };
      stuurInzichten(nep, ov, q);
      return antwoord(res, 200, true, 'ok', 'De inzichten.', nep._body);
    } catch (e) {
      console.error('[lms-checkin-inzichten]', e?.message || e);
      return antwoord(res, 500, false, 'interne_fout', 'De inzichten konden niet gelezen worden.');
    }
  };
}

export default maakHandler();

// api/lms-incasso.js
//
// Machine-route voor het LMS (dfo-lms): HET INCASSO-OVERZICHT (Maxim, 3 nov 2026)
// voor Administratie › Incasso en de cijfers op de Weekmeeting. Het CRM is de
// enige bron; het LMS toont en stuurt acties door. Server-naar-server, GEEN
// CORS — het geheim mag nooit in een browser.
//
//   GET                         → { ok, code, data: overzicht }
//   POST { actie, actor, ... }  → { ok, code, message, data }
//
// Auth: header `x-dfo-secret` (zelfde regel als api/lms-onboarding-sessie.js).
// Het LMS zet `actor` = { email, naam, rollen[] } uit hlms_rol van de ingelogde
// gebruiker (zelf nagekeken in de LMS-route); de rechten per actie staan in
// api/_lib/incasso-traject.js (RECHTEN).
//
// Regels + fases: api/_lib/incasso-traject.js. IO: api/_lib/incasso-traject-server.js.
// Teamleader wordt hier NOOIT gewijzigd en er vertrekt geen mail of brief.

import { machineToegang } from './lms-onboarding-sessie.js';
import { supabaseAdmin } from './supabase.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { laadIncassoOverzicht, voerIncassoActieUit } from './_lib/incasso-traject-server.js';
import { zetStatus } from './_lib/klant-incassostatus.js';
import { leesGhlBetaald } from './_lib/ghl-betalingen.js';

function antwoord(res, status, ok, code, message, data = null) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json({ ok, code, message, data });
}

export function maakHandler(deps = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const toegang = machineToegang(req.headers['x-dfo-secret']);
    if (toegang === 'niet_geconfigureerd') return antwoord(res, 503, false, 'niet_geconfigureerd', 'De brug is niet geconfigureerd.');
    if (toegang !== 'ok') return antwoord(res, 403, false, 'machine_toegang_dicht', 'Geen toegang.');
    const crm = deps.crm || supabaseAdmin;
    try {
      if (req.method === 'GET') {
        const lms = deps.lms !== undefined ? deps.lms : getDfoLmsClient();
        const metGhl = String(req.query?.ghl ?? '1') !== '0';
        const data = await laadIncassoOverzicht({ crm, lms, metGhl, ghl: deps.ghl || ((id) => leesGhlBetaald(id)) });
        return antwoord(res, 200, true, 'ok', 'Het incasso-overzicht.', data);
      }
      if (req.method === 'POST') {
        const b = (req.body && typeof req.body === 'object') ? req.body : {};
        const motor = deps.motor !== undefined ? deps.motor
          : async ({ customerId }) => (await import('./_lib/mentor-ledger-engine.js')).releaseProportionalForPaidAmount({ customerId });
        const pijp = deps.pipeline !== undefined ? deps.pipeline : await import('./_lib/dunning-pipeline.js');
        const uit = await voerIncassoActieUit({
          crm,
          zetStatus: deps.zetStatus || zetStatus,
          motor,
          setStage: pijp?.setStage || null,
          ensurePipeline: pijp?.ensurePipelineCustomer || null,
          nu: deps.nu,
        }, b);
        res.setHeader('Content-Type', 'application/json');
        return res.status(uit.status).json(uit.body);
      }
      res.setHeader('Allow', 'GET, POST');
      return antwoord(res, 405, false, 'methode_niet_toegestaan', 'Alleen GET of POST.');
    } catch (e) {
      console.error('[lms-incasso]', e?.message || e);
      return antwoord(res, 500, false, 'interne_fout', 'Het incasso-overzicht kon niet gelezen worden.');
    }
  };
}

export default maakHandler();

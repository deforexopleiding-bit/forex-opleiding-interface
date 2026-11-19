// api/lms-brieven.js
//
// MACHINE-ROUTE VOOR HET BORD IN HET LMS (Administratie) — de brieven
// (Maxim, 16 nov 2026). Gedeeld geheim `x-dfo-secret` (zelfde als lms-incasso).
//
//   POST { actie: 'maak', dossier_id, nr, lms_student_id?, crm_onboarding_id?, email?, actor }
//        Seppe klikte "Brief N mag weg": de brief wordt NU in het CRM gemaakt
//        met DEZELFDE generator als Wanbetalers › Brieven (nog niet verstuurd),
//        gekoppeld aan het dossier, en het bord volgt (hlms_admin_brief_crm).
//        Brief 1 = tussenbrief, brief 2 = pre-incassobrief; het land volgt de
//        klant zoals de generator het al bepaalt.
//   GET  ?pdf=<brief_id>  → een PDF-link van 5 minuten (alleen voor bordbrieven).
//
// Versturen gebeurt NOOIT hier: dat blijft een bewuste stap van Maxim in het CRM
// (selecteren, bundel, labels, als verstuurd markeren). Geen mail, WhatsApp of
// post naar de student. Niets aan Teamleader.
//
// Rechten: actor.rollen moet admin, administratie of hoofdmentor bevatten (het
// LMS stelt die vast uit hlms_rol; deze route vertrouwt alleen het geheim).

import { machineToegang } from './lms-onboarding-sessie.js';
import { supabaseAdmin } from './supabase.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { generatePreBriefForCustomer } from './_lib/incasso-pre-brief-core.js';
import { briefTypeVoorNr, crmBrievenUrl, BUCKET } from './_lib/brieven-lms.js';

export const ROLLEN = ['admin', 'administratie', 'hoofdmentor'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function antwoord(res, status, ok, code, message, data = null) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json({ ok, code, message, data });
}

/** Mag dit dossier nu brief N in het CRM krijgen? Puur. Geeft null of een foutzin. */
export function magBriefMaken(dossier, nr) {
  if (!dossier) return 'Dit dossier bestaat niet.';
  if (dossier.gesloten_op) return 'Dit dossier is al gesloten.';
  if (dossier.spoor !== 'betaling') return 'Brieven horen bij het betalingsspoor.';
  const b = (dossier.brieven || {})[String(nr)] || {};
  if (b.crm && b.crm.brief_id) return null; // al in het CRM: idempotent
  if (nr === 1) {
    return ['contact', 'brief_1'].includes(dossier.fase) ? null : 'Brief 1 kan alleen vanuit Bellen en contact.';
  }
  if (nr === 2) {
    const b1 = (dossier.brieven || {})['1'] || {};
    if (dossier.fase === 'brief_2') return null;
    if (dossier.fase !== 'brief_1') return 'Brief 2 kan alleen na brief 1.';
    return b1.verstuurd_op ? null : 'Verstuur eerst brief 1.';
  }
  return 'Onbekende brief.';
}

async function zoekKlant(crm, invoer) {
  if (invoer.crm_onboarding_id && UUID_RE.test(String(invoer.crm_onboarding_id))) {
    const { data } = await crm.from('onboardings').select('customer_id').eq('id', invoer.crm_onboarding_id).maybeSingle();
    if (data?.customer_id) return data.customer_id;
  }
  if (invoer.lms_student_id && UUID_RE.test(String(invoer.lms_student_id))) {
    const { data } = await crm.from('onboardings').select('customer_id').eq('dfo_lms_student_id', invoer.lms_student_id).not('customer_id', 'is', null).limit(2);
    const ids = [...new Set((data || []).map((r) => r.customer_id))];
    if (ids.length === 1) return ids[0];
  }
  const mail = String(invoer.email || '').trim().toLowerCase();
  if (mail) {
    const { data } = await crm.from('customers').select('id').ilike('email', mail).limit(2);
    if ((data || []).length === 1) return data[0].id;
  }
  return null;
}

export function maakHandler(deps = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const toegang = machineToegang(req.headers['x-dfo-secret']);
    if (toegang === 'niet_geconfigureerd') return antwoord(res, 503, false, 'niet_geconfigureerd', 'De brug is niet geconfigureerd.');
    if (toegang !== 'ok') return antwoord(res, 403, false, 'machine_toegang_dicht', 'Geen toegang.');
    const crm = deps.crm || supabaseAdmin;
    const lms = deps.lms !== undefined ? deps.lms : getDfoLmsClient();
    const genereer = deps.genereer || generatePreBriefForCustomer;
    try {
      if (req.method === 'GET') {
        const id = String(req.query?.pdf || '');
        if (!UUID_RE.test(id)) return antwoord(res, 400, false, 'pdf', 'Geen brief gekozen.');
        const { data: b } = await crm.from('dunning_briefs').select('id, pdf_path, lms_dossier_id').eq('id', id).maybeSingle();
        if (!b || !b.lms_dossier_id) return antwoord(res, 404, false, 'onbekend', 'Deze brief hoort niet bij het bord.');
        const { data: s, error } = await crm.storage.from(BUCKET).createSignedUrl(b.pdf_path, 300);
        if (error || !s?.signedUrl) return antwoord(res, 502, false, 'pdf_link', 'De PDF-link kon niet gemaakt worden.');
        return antwoord(res, 200, true, 'ok', 'PDF-link (5 minuten).', { url: s.signedUrl });
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return antwoord(res, 405, false, 'methode_niet_toegestaan', 'Alleen GET of POST.');
      }
      const b = (req.body && typeof req.body === 'object') ? req.body : {};
      const actor = b.actor || {};
      const rollen = Array.isArray(actor.rollen) ? actor.rollen : [];
      if (!rollen.some((r) => ROLLEN.includes(r))) return antwoord(res, 403, false, 'geen_recht', 'Dit mag je rol niet.');
      if (b.actie !== 'maak') return antwoord(res, 400, false, 'actie', 'Onbekende actie.');
      const nr = Number(b.nr);
      if (![1, 2].includes(nr)) return antwoord(res, 400, false, 'nr', 'Kies brief 1 of brief 2.');
      if (!UUID_RE.test(String(b.dossier_id || ''))) return antwoord(res, 400, false, 'dossier', 'Geen dossier.');
      if (!lms) return antwoord(res, 503, false, 'lms_niet_ingesteld', 'De koppeling met het LMS is niet ingesteld.');

      //  Eerst nakijken, dan pas iets maken (validate-first).
      const { data: dossier, error: dErr } = await lms.from('hlms_admin_dossier')
        .select('id, spoor, fase, gesloten_op, brieven, student_id, crm_onboarding_id').eq('id', b.dossier_id).maybeSingle();
      if (dErr) return antwoord(res, 502, false, 'lms_onleesbaar', 'Het dossier kon niet gelezen worden.');
      const nee = magBriefMaken(dossier, nr);
      if (nee) return antwoord(res, 409, false, 'kan_niet', nee);
      const bestaand = dossier.brieven?.[String(nr)]?.crm?.brief_id || null;
      if (bestaand) {
        return antwoord(res, 200, true, 'al_in_crm', `Brief ${nr} staat al in het CRM.`, { brief_id: bestaand, crm_url: crmBrievenUrl(b.naam) });
      }

      const customerId = await zoekKlant(crm, {
        crm_onboarding_id: b.crm_onboarding_id || dossier.crm_onboarding_id,
        lms_student_id: b.lms_student_id || dossier.student_id,
        email: b.email,
      });
      if (!customerId) return antwoord(res, 404, false, 'klant_onbekend', 'Deze student is niet als klant gevonden in het CRM.');

      let generatedBy = null;
      if (actor.email) {
        const { data: p } = await crm.from('profiles').select('id').ilike('email', String(actor.email)).limit(1);
        generatedBy = p?.[0]?.id || null;
      }
      const uit = await genereer({
        customerId,
        country: null,
        briefType: briefTypeVoorNr(nr),
        generatedByUserId: generatedBy,
        runId: null,
        stepId: null,
        lmsKoppeling: { dossierId: dossier.id, nr, bron: 'lms', aangemaaktDoorEmail: actor.email || null },
      });
      if (!uit.ok) {
        if (uit.code === 'ADDRESS_INCOMPLETE') {
          return antwoord(res, 422, false, 'adres_onvolledig',
            `Het adres in het CRM is onvolledig (ontbreekt: ${(uit.missing || []).join(', ')}). Vul het aan in het klantdossier en probeer opnieuw.`);
        }
        console.error('[lms-brieven] genereren:', uit.code, uit.error);
        return antwoord(res, 500, false, 'brief_mislukt', 'De brief kon niet gemaakt worden in het CRM.');
      }
      const data = { brief_id: uit.brief_id, template_code: uit.template_code, land: uit.country, crm_url: crmBrievenUrl(b.naam), lms: uit.lms };
      if (!uit.lms || !['gekoppeld', 'ongewijzigd'].includes(uit.lms.status)) {
        return antwoord(res, 502, false, 'bord_niet_bijgewerkt',
          'De brief staat in het CRM, maar het bord kon niet bijgewerkt worden. Het bord volgt binnen het uur.', data);
      }
      return antwoord(res, 200, true, 'ok', `Brief ${nr} staat klaar in het CRM.`, data);
    } catch (e) {
      console.error('[lms-brieven]', e?.message || e);
      return antwoord(res, 500, false, 'interne_fout', 'De brief kon niet verwerkt worden.');
    }
  };
}

export default maakHandler();

// api/checkin-portal.js
//
// PUBLIEK — de API achter www.deforexopleiding.nl/checkin ("Jouw DFO-check-in"
// voor BESTAANDE studenten, 27 okt 2026). Eén endpoint, POST, met een action-veld:
//
//   { action:'open',   code }                              → 200 dossier | 404 | 410
//   { action:'save',   sessie, antwoorden, huidige_stap }   → 200 { ok } | 409 verstuurd | 410 dicht
//   { action:'submit', sessie }                             → 200 { ok } | { ok, already:true } | 400 onvolledig
//
// Zelfde patroon als api/onboarding-portal.js: CORS-allowlist (dezelfde
// origins), rate limit (open 10/min + 40/uur per IP, save 30/min, submit
// 10/min), een generieke 404, en de sessie is een server-side token
// (hlms_checkin_toewijzing.sessie) — nooit een student-id uit de browser.
//
// DE DATA STAAT IN HET LMS (dfo-lms, hlms_checkin_*), gelezen en geschreven met
// de service role via api/_lib/dfo-lms-db.js. Bewaren en versturen lopen via
// databankfuncties (supabase/hlms_checkin.sql in dfo-lms-prototype): de merge
// van de antwoorden en het versturen + het begeleidingssignaal zijn daar
// ATOMAIR en idempotent.
//
// WIE KAN ER IN: alleen een toewijzing in een campagne die live staat, of in
// test als het een testtoewijzing is (is_test). Concept, en een gewone
// toewijzing in een testcampagne, geven dezelfde 404 als een onbekende code.
//
// MINIMALE PII: 'open' geeft de voornaam, het traject en de voornaam +
// initialen van de mentor. Geen e-mail, telefoon of achternaam.
//
// NEVENEFFECTEN:
//   · robot_interesse = ja_interesse → één automation-kaart voor Dave
//     (api/_lib/automation-interesse.js, sleutel checkin_toewijzing_id). Niet
//     voor testtoewijzingen.
//   · versturen → een begeleidingssignaal naar de hoofdmentor in het LMS
//     (hlms_signaal, bron 'checkin', bak hoofdmentor) als de antwoorden erom
//     vragen (api/_lib/checkin-portal.js signaalVoor). Los van de automation.
//   · GEEN mail, GEEN WhatsApp, GEEN belacties naar studenten.

import { supabaseAdmin } from './supabase.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { normaliseer } from './_lib/onboarding-startcode.js';
import { resolvePortalOrigin } from './_lib/onboarding-portal.js';
import { syncCheckinAutomationKaart } from './_lib/automation-interesse.js';
import {
  valideerPatch, schoneAntwoorden, ontbrekend, signaalVoor, signaalBewijs, flowVoor, optiesVan,
  maandVan, persoonKort, isZichtbaar, TRAJECT_NAAM, TEKST, AUTOPILOT_SLEUTELS,
} from './_lib/checkin-portal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TOEWIJZING_KOLOMMEN =
  'id, campagne_id, student_id, code, sessie, is_test, status, huidige_stap, antwoorden, opties, verstuurd_op, '
  + 'campagne:hlms_checkin_campagne(id, slug, status, opties, inhoud_versie), '
  + 'student:hlms_student(id, voornaam, product_soort, start_datum, traject_maanden, calls_gedaan, calls_totaal, mentor_id)';

const STANDAARD = {
  lms: () => getDfoLmsClient(),
  rateLimit: checkRateLimit,
  // Faalzacht; een fout hier breekt de save van de student nooit.
  naAutomation: (p) => syncCheckinAutomationKaart(supabaseAdmin, p),
  nu: () => new Date(),
};

/** Ontbreekt de tabel of functie nog (migratie niet gedraaid)? */
function migratieOntbreekt(error) {
  const c = String(error?.code || '');
  return c === '42P01' || c === 'PGRST205' || c === 'PGRST202' || c === '42883'
    || /does not exist|schema cache|could not find the (table|function)/i.test(error?.message || '');
}

function zetCors(req, res) {
  const origin = resolvePortalOrigin(req.headers?.origin);
  res.setHeader('Vary', 'Origin');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

async function beperkt(d, req, bucket, maxHits, withinSeconds) {
  try {
    const r = await d.rateLimit({ req, bucket, maxHits, withinSeconds });
    return !!r?.limited;
  } catch {
    return false; // fail-open
  }
}

const NIET_BESCHIKBAAR = { error: 'De check-in is even niet beschikbaar. Probeer het later opnieuw.', code: 'niet_beschikbaar' };

function lmsOf503(d, res) {
  const lms = d.lms();
  if (!lms) { res.status(503).json(NIET_BESCHIKBAAR); return null; }
  return lms;
}

/** Lees één toewijzing (met campagne + student) op een kolom. */
async function leesToewijzing(lms, kolom, waarde) {
  const { data, error } = await lms.from('hlms_checkin_toewijzing').select(TOEWIJZING_KOLOMMEN).eq(kolom, waarde).maybeSingle();
  return { t: data || null, error };
}

function context(t) {
  const flow = flowVoor(t.student?.product_soort);
  const opties = optiesVan(t, t.campagne);
  return { flow, opties };
}

// ── open ─────────────────────────────────────────────────────────────────
async function open(d, req, res, body) {
  if (await beperkt(d, req, 'checkin-portal-open', 10, 60)
    || await beperkt(d, req, 'checkin-portal-open-uur', 40, 3600)) {
    return res.status(429).json({ error: TEKST.teVeel, code: 'te_veel' });
  }
  const code = normaliseer(typeof body.code === 'string' ? body.code : '');
  if (!code) return res.status(404).json({ error: TEKST.onbekend, code: 'onbekend' });

  const lms = lmsOf503(d, res);
  if (!lms) return;
  const { t, error } = await leesToewijzing(lms, 'code', code);
  if (error) {
    if (migratieOntbreekt(error)) {
      console.warn('[checkin-portal] tabellen ontbreken — draai hlms_checkin.sql in dfo-lms');
      return res.status(503).json(NIET_BESCHIKBAAR);
    }
    console.error('[checkin-portal] open lookup:', error.message);
    return res.status(500).json({ error: 'Er ging iets mis. Probeer het opnieuw.', code: 'fout' });
  }
  if (!t) return res.status(404).json({ error: TEKST.onbekend, code: 'onbekend' });

  const cStatus = t.campagne?.status;
  // Vóór Run bestaat de check-in voor deze student niet — niet eens "gesloten".
  if (cStatus === 'concept' || (cStatus === 'test' && t.is_test !== true) || !cStatus) {
    return res.status(404).json({ error: TEKST.onbekend, code: 'onbekend' });
  }
  const afgerond = t.status === 'verstuurd' || !!t.verstuurd_op;
  if (!afgerond && !isZichtbaar(cStatus, t.is_test)) {
    return res.status(410).json({ error: TEKST.dicht, code: 'dicht' });
  }

  const { flow, opties } = context(t);
  let mentor = null;
  if (flow === '1op1' && t.student?.mentor_id) {
    const { data: m, error: mErr } = await lms.from('hlms_personeel').select('naam').eq('id', t.student.mentor_id).maybeSingle();
    if (mErr) console.warn('[checkin-portal] mentor lookup:', mErr.message);
    mentor = persoonKort(m?.naam);
  }
  const mvy = maandVan(t.student?.start_datum, t.student?.traject_maanden, d.nu());

  return res.status(200).json({
    sessie: t.sessie,
    voornaam: t.student?.voornaam || null,
    flow,
    traject_naam: TRAJECT_NAAM[flow],
    maand: mvy?.maand ?? null,
    maanden: mvy?.maanden ?? null,
    sessies: flow === '1op1' && Number(t.student?.calls_totaal) > 0
      ? { gedaan: Number(t.student.calls_gedaan) || 0, totaal: Number(t.student.calls_totaal) }
      : null,
    mentor,
    opties,
    status: t.status,
    huidige_stap: Number(t.huidige_stap) || 0,
    antwoorden: schoneAntwoorden(t.antwoorden, { flow, opties }),
    afgerond,
  });
}

/** Automation-kaart bijwerken na een save/submit. Laadt de student pas als het nodig is. */
async function automation(d, lms, t, antwoorden) {
  try {
    const { data: st, error } = await lms.from('hlms_student')
      .select('id, voornaam, achternaam, email, telefoon').eq('id', t.student_id).maybeSingle();
    if (error) console.warn('[checkin-portal] student lezen (soft):', error.message);
    const flow = flowVoor(t.student?.product_soort);
    let mentorNaam = null;
    if (t.student?.mentor_id) {
      const { data: m, error: mErr } = await lms.from('hlms_personeel').select('naam').eq('id', t.student.mentor_id).maybeSingle();
      if (mErr) console.warn('[checkin-portal] mentor lezen (soft):', mErr.message);
      mentorNaam = m?.naam || null;
    }
    await d.naAutomation({
      toewijzing: { id: t.id, campagne_id: t.campagne_id, student_id: t.student_id, is_test: t.is_test === true },
      student: st || { id: t.student_id, voornaam: t.student?.voornaam || null },
      trajectLabel: TRAJECT_NAAM[flow],
      mentorNaam,
      answers: antwoorden,
      nu: d.nu(),
    });
  } catch (e) {
    console.error('[checkin-portal] automation-opvolging:', e?.message || e);
  }
}

// ── save ─────────────────────────────────────────────────────────────────
async function save(d, req, res, body) {
  const sessie = typeof body.sessie === 'string' ? body.sessie.trim() : '';
  if (!UUID_RE.test(sessie)) return res.status(404).json({ error: 'Sessie onbekend.', code: 'sessie' });
  const stap = Number(body.huidige_stap);
  if (!Number.isInteger(stap) || stap < 0 || stap > 50) {
    return res.status(400).json({ error: 'huidige_stap moet een geheel getal van 0 tot 50 zijn.', code: 'ongeldig' });
  }
  if (await beperkt(d, req, 'checkin-portal-save', 30, 60)) {
    return res.status(429).json({ error: TEKST.teVeel, code: 'te_veel' });
  }
  const lms = lmsOf503(d, res);
  if (!lms) return;

  const { t, error } = await leesToewijzing(lms, 'sessie', sessie);
  if (error) {
    if (migratieOntbreekt(error)) return res.status(503).json(NIET_BESCHIKBAAR);
    console.error('[checkin-portal] save lookup:', error.message);
    return res.status(500).json({ error: 'Opslaan mislukt.', code: 'fout' });
  }
  if (!t) return res.status(404).json({ error: 'Sessie onbekend.', code: 'sessie' });
  if (t.status === 'verstuurd') return res.status(409).json({ error: 'Je check-in is al verstuurd.', code: 'verstuurd' });

  const { flow, opties } = context(t);
  const { ok, schoon, fouten } = valideerPatch(body.antwoorden, { flow, opties });
  if (!ok) return res.status(400).json({ error: 'Ongeldige antwoorden.', code: 'ongeldig', velden: fouten });

  const { data: r, error: rErr } = await lms.rpc('hlms_checkin_bewaren', { p_sessie: sessie, p_patch: schoon, p_stap: stap });
  if (rErr) {
    if (migratieOntbreekt(rErr)) return res.status(503).json(NIET_BESCHIKBAAR);
    console.error('[checkin-portal] bewaren:', rErr.message);
    return res.status(500).json({ error: 'Opslaan mislukt.', code: 'fout' });
  }
  if (r?.onbekend) return res.status(404).json({ error: 'Sessie onbekend.', code: 'sessie' });
  if (r?.verstuurd) return res.status(409).json({ error: 'Je check-in is al verstuurd.', code: 'verstuurd' });
  if (r?.dicht) return res.status(410).json({ error: TEKST.dicht, code: 'dicht' });

  if (opties.autopilot_stap && AUTOPILOT_SLEUTELS.some((k) => k in schoon)) {
    await automation(d, lms, t, schoneAntwoorden(r?.antwoorden, { flow, opties }));
  }
  return res.status(200).json({ ok: true, huidige_stap: stap });
}

// ── submit ───────────────────────────────────────────────────────────────
async function submit(d, req, res, body) {
  const sessie = typeof body.sessie === 'string' ? body.sessie.trim() : '';
  if (!UUID_RE.test(sessie)) return res.status(404).json({ error: 'Sessie onbekend.', code: 'sessie' });
  if (await beperkt(d, req, 'checkin-portal-submit', 10, 60)) {
    return res.status(429).json({ error: TEKST.teVeel, code: 'te_veel' });
  }
  const lms = lmsOf503(d, res);
  if (!lms) return;

  const { t, error } = await leesToewijzing(lms, 'sessie', sessie);
  if (error) {
    if (migratieOntbreekt(error)) return res.status(503).json(NIET_BESCHIKBAAR);
    console.error('[checkin-portal] submit lookup:', error.message);
    return res.status(500).json({ error: 'Versturen mislukt.', code: 'fout' });
  }
  if (!t) return res.status(404).json({ error: 'Sessie onbekend.', code: 'sessie' });
  if (t.status === 'verstuurd') return res.status(200).json({ ok: true, already: true });
  if (!isZichtbaar(t.campagne?.status, t.is_test)) return res.status(410).json({ error: TEKST.dicht, code: 'dicht' });

  const { flow, opties } = context(t);
  const antwoorden = schoneAntwoorden(t.antwoorden, { flow, opties });
  const missing = ontbrekend(flow, opties, antwoorden);
  if (missing.length) {
    return res.status(400).json({ error: 'Niet alle verplichte vragen zijn ingevuld.', code: 'onvolledig', missing });
  }

  const sig = signaalVoor(antwoorden);
  const p_signaal = sig ? {
    zwaarte: sig.zwaarte,
    bewijs: signaalBewijs({
      antwoorden, redenen: sig.redenen, campagneSlug: t.campagne?.slug, toewijzingId: t.id, isTest: t.is_test === true,
    }),
  } : null;

  const { data: r, error: rErr } = await lms.rpc('hlms_checkin_versturen', {
    p_sessie: sessie, p_antwoorden: antwoorden, p_signaal,
  });
  if (rErr) {
    if (migratieOntbreekt(rErr)) return res.status(503).json(NIET_BESCHIKBAAR);
    console.error('[checkin-portal] versturen:', rErr.message);
    return res.status(500).json({ error: 'Versturen mislukt. Probeer het opnieuw.', code: 'fout' });
  }
  if (r?.onbekend) return res.status(404).json({ error: 'Sessie onbekend.', code: 'sessie' });
  if (r?.dicht) return res.status(410).json({ error: TEKST.dicht, code: 'dicht' });
  if (r?.al) return res.status(200).json({ ok: true, already: true });

  // De kaart staat er normaal al sinds de save; dit maakt hem idempotent "af".
  if (opties.autopilot_stap && antwoorden.robot_interesse) await automation(d, lms, t, antwoorden);
  return res.status(200).json({ ok: true });
}

export function maakHandler(deps = {}) {
  const d = { ...STANDAARD, ...deps };
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    zetCors(req, res);

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(405).json({ error: 'POST only' });
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    try {
      if (body.action === 'open') return await open(d, req, res, body);
      if (body.action === 'save') return await save(d, req, res, body);
      if (body.action === 'submit') return await submit(d, req, res, body);
      return res.status(400).json({ error: 'Onbekende actie.', code: 'actie' });
    } catch (e) {
      console.error('[checkin-portal] fatal:', body.action, e?.message || e);
      return res.status(500).json({ error: 'Er ging iets mis. Probeer het opnieuw.', code: 'fout' });
    }
  };
}

export default maakHandler();

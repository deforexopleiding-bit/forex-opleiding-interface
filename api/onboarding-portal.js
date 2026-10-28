// api/onboarding-portal.js
//
// PUBLIEK — de API achter www.deforexopleiding.nl/onboarding (de nieuwe
// klant-onboarding met startcode). Eén endpoint, POST, met een action-veld:
//
//   { action:'open',     code }                       → 200 dossier | 404 | 410
//   { action:'save',     sessie, answers, current_step } → 200 { ok, current_step }
//   { action:'complete', sessie }                      → 200 { ok } | { ok, already:true }
//
// AUTH. `code` = onboardings.startcode (uit de welkomstmail). `sessie` = het
// bestaande onboardings.token: dat is al de auth van de klassieke wizard
// (modules/onboarding.html?t=…), dus deze portal opent geen nieuwe deur. De
// website houdt de sessie alleen in geheugen/sessionStorage, nooit in de URL.
//
// GEEN ENUMERATIE. Ongeldig formaat en onbekende code geven exact hetzelfde
// 404-antwoord. Brute force wordt afgeremd met een rate limit op 'open':
// 10 per minuut en 40 per uur per IP (fail-open bij een DB-storing, zoals
// overal in api/_lib/rate-limit.js).
//
// MINIMALE PII. 'open' geeft alleen de voornaam terug — geen e-mail, telefoon
// of achternaam — en van de antwoorden alleen de portal-sleutels.
//
// OUDE WIZARD → NIEUWE PORTAL (28 okt 2026). current_step van wie in de
// klassieke wizard begon is een pagina van die wizard (tot 10). 'open' geeft
// daarom het scherm van de NIEUWE flow terug (hervatStap: eerste onbeantwoorde
// vraag, afgeklemd) en zet portal_geopend_op; de eerste save (of afronden)
// zet portal_gestart_op — het kenmerk "begonnen in de nieuwe onboarding".
//
// De klassieke wizard (onboarding-wizard-get / -step-save / -complete) blijft
// ongewijzigd werken: dat is het rollback-pad. 'complete' voert exact dezelfde
// neveneffecten uit via api/_lib/onboarding-afronden.js.

import { supabaseAdmin } from './supabase.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { resolveFlowType } from './_lib/onboarding-wizard-default.js';
import { normaliseer } from './_lib/onboarding-startcode.js';
import { rondWizardAf } from './_lib/onboarding-afronden.js';
import { spiegelNaActie } from './_lib/onboarding-spiegel.js';
import { syncAutomationKaart } from './_lib/automation-interesse.js';
import { hervatStap } from './_lib/onboarding-antwoorden.js';
import { vulPortalKolommenAan } from './_lib/onboarding-portal-kolommen.js';
import {
  valideerPatch, portalAntwoorden, ontbrekend, mentorKort, automationVelden,
  isAfgesloten, resolvePortalOrigin, TRAJECT_NAAM, TEKST,
} from './_lib/onboarding-portal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STANDAARD = {
  db: () => supabaseAdmin,
  rateLimit: checkRateLimit,
  rondWizardAf,
  spiegel: (id, bron) => spiegelNaActie(id, bron),
  // De automation-interesse wordt een belkaart voor Dave (Opvolging). Krijgt de
  // onboarding + samengevoegde antwoorden na elke save die robot_interesse of
  // robot_belmoment raakt. Faalzacht; een fout hier breekt de save niet.
  naAutomation: ({ onboarding, answers, nu }) => syncAutomationKaart(supabaseAdmin, { onboarding, answers, nu }),
  nu: () => new Date(),
};

function kolomOntbreekt(error) {
  return !!error && (String(error.code) === '42703' || /does not exist|schema cache/i.test(error.message || ''));
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

// ── open ─────────────────────────────────────────────────────────────────
async function open(d, req, res, body) {
  if (await beperkt(d, req, 'onboarding-portal-open', 10, 60)
    || await beperkt(d, req, 'onboarding-portal-open-uur', 40, 3600)) {
    return res.status(429).json({ error: TEKST.teVeel, code: 'te_veel' });
  }
  const code = normaliseer(typeof body.code === 'string' ? body.code : '');
  if (!code) return res.status(404).json({ error: TEKST.onbekend, code: 'onbekend' });

  const db = d.db();
  const { data: ob, error } = await db
    .from('onboardings')
    .select('id, token, status, customer_id, traject_id, mentor_user_id, start_date, current_step, answers')
    .eq('startcode', code)
    .maybeSingle();
  if (error) {
    if (kolomOntbreekt(error)) {
      console.warn('[onboarding-portal] kolom startcode ontbreekt — draai 2026-10-27-onboarding-portal.sql');
      return res.status(503).json({ error: 'De onboarding is even niet beschikbaar. Probeer het later opnieuw.', code: 'niet_beschikbaar' });
    }
    console.error('[onboarding-portal] open lookup:', error.message);
    return res.status(500).json({ error: 'Er ging iets mis. Probeer het opnieuw.', code: 'fout' });
  }
  if (!ob) return res.status(404).json({ error: TEKST.onbekend, code: 'onbekend' });
  if (isAfgesloten(ob.status)) return res.status(410).json({ error: TEKST.afgesloten, code: 'afgesloten' });

  // Klant (voornaam), traject en mentor — elk faalzacht: een glitch op één van
  // de drie mag de klant niet buitensluiten.
  const [cust, traj, mentor] = await Promise.all([
    ob.customer_id
      ? db.from('customers').select('first_name').eq('id', ob.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    ob.traject_id
      ? db.from('onboarding_trajecten').select('type, label, duur_maanden').eq('id', ob.traject_id).maybeSingle()
      : Promise.resolve({ data: null }),
    ob.mentor_user_id
      ? db.from('profiles').select('full_name').eq('id', ob.mentor_user_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ].map((p) => Promise.resolve(p).catch((e) => ({ data: null, error: e }))));
  for (const [naam, r] of [['customer', cust], ['traject', traj], ['mentor', mentor]]) {
    if (r?.error) console.warn('[onboarding-portal] ' + naam + ' lookup:', r.error.message || r.error);
  }

  const flow = resolveFlowType(traj?.data?.type);
  // Portalkolommen apart en faalzacht (migratie 2026-10-28-onboarding-portal-gestart.sql).
  await vulPortalKolommenAan(db, ob);
  const afgerond = ob.status === 'afgerond';
  if (!afgerond && ob.portal_geopend_op === null) {
    const { error: gErr } = await db.from('onboardings')
      .update({ portal_geopend_op: d.nu().toISOString() }).eq('id', ob.id).is('portal_geopend_op', null);
    if (gErr) console.error('[onboarding-portal] portal_geopend_op:', gErr.message);
  }
  return res.status(200).json({
    sessie: ob.token,
    voornaam: cust?.data?.first_name || null,
    flow_type: flow,
    traject_naam: TRAJECT_NAAM[flow],
    start_datum: ob.start_date || null,
    duur_maanden: traj?.data?.duur_maanden ?? null,
    mentor: mentorKort(mentor?.data?.full_name),
    status: ob.status,
    // Een scherm van de NIEUWE flow — nooit een pagina van de klassieke wizard.
    current_step: afgerond ? (ob.current_step == null ? 0 : Number(ob.current_step)) : hervatStap(ob, flow),
    answers: portalAntwoorden(ob.answers),
    afgerond,
  });
}

/**
 * "Begonnen in de nieuwe onboarding": alleen de eerste keer (is null).
 * Faalzacht — zonder migratie (kolom ontbreekt) gaat de save gewoon door.
 */
async function zetPortalGestart(db, id, nuIso) {
  const { error } = await db.from('onboardings')
    .update({ portal_gestart_op: nuIso }).eq('id', id).is('portal_gestart_op', null);
  if (error) {
    if (kolomOntbreekt(error)) console.warn('[onboarding-portal] portal_gestart_op ontbreekt nog — draai 2026-10-28-onboarding-portal-gestart.sql');
    else console.error('[onboarding-portal] portal_gestart_op:', error.message);
  }
}

async function zoekSessie(d, sessie, kolommen) {
  return d.db().from('onboardings').select(kolommen).eq('token', sessie).maybeSingle();
}

// ── save ─────────────────────────────────────────────────────────────────
async function save(d, req, res, body) {
  const sessie = typeof body.sessie === 'string' ? body.sessie.trim() : '';
  if (!UUID_RE.test(sessie)) return res.status(404).json({ error: 'Sessie onbekend.', code: 'sessie' });

  const { ok, schoon, fouten } = valideerPatch(body.answers);
  if (!ok) return res.status(400).json({ error: 'Ongeldige antwoorden.', code: 'ongeldig', velden: fouten });
  const stap = Number(body.current_step);
  if (!Number.isInteger(stap) || stap < 0 || stap > 50) {
    return res.status(400).json({ error: 'current_step moet een niet-negatief geheel getal zijn.', code: 'ongeldig' });
  }

  if (await beperkt(d, req, 'onboarding-portal-save', 30, 60)) {
    return res.status(429).json({ error: TEKST.teVeel, code: 'te_veel' });
  }

  const { data: ob, error } = await zoekSessie(d, sessie,
    'id, status, started_at, answers, customer_id, customer_name, traject_id, start_date, is_test');
  if (error) {
    console.error('[onboarding-portal] save lookup:', error.message);
    return res.status(500).json({ error: 'Opslaan mislukt.', code: 'fout' });
  }
  if (!ob) return res.status(404).json({ error: 'Sessie onbekend.', code: 'sessie' });
  if (isAfgesloten(ob.status)) return res.status(410).json({ error: TEKST.afgesloten, code: 'afgesloten' });
  if (ob.status === 'afgerond') return res.status(409).json({ error: 'Onboarding is al afgerond.', code: 'afgerond' });

  // Zelfde gedrag als api/onboarding-step-save.js: shallow merge, current_step
  // overschrijven, aangemeld → bezig (+ started_at), updated_at altijd.
  const vorige = (ob.answers && typeof ob.answers === 'object') ? ob.answers : {};
  const samengevoegd = { ...vorige, ...schoon };
  const nu = d.nu();
  const nowIso = nu.toISOString();
  const updates = { answers: samengevoegd, current_step: stap, updated_at: nowIso };
  if (ob.status === 'aangemeld') {
    updates.status = 'bezig';
    updates.started_at = ob.started_at || nowIso;
  }
  const db = d.db();
  const { error: updErr } = await db.from('onboardings').update(updates).eq('id', ob.id);
  if (updErr) {
    console.error('[onboarding-portal] save update:', updErr.message);
    return res.status(500).json({ error: 'Opslaan mislukt.', code: 'fout' });
  }
  await zetPortalGestart(db, ob.id, nowIso);

  // Automation-kolommen apart en faalzacht: zonder migratie blijft de save
  // gewoon slagen (answers bevat robot_interesse/robot_belmoment toch al).
  const auto = automationVelden(vorige, samengevoegd, schoon, nu);
  if (auto) {
    const { error: aErr } = await db.from('onboardings').update(auto).eq('id', ob.id);
    if (aErr) {
      if (kolomOntbreekt(aErr)) console.warn('[onboarding-portal] automation-kolommen ontbreken nog — draai 2026-10-27-onboarding-portal.sql');
      else console.error('[onboarding-portal] automation-kolommen:', aErr.message);
    }
    try {
      await d.naAutomation({ onboarding: { ...ob, ...updates }, answers: samengevoegd, velden: auto, nu });
    } catch (e) {
      console.error('[onboarding-portal] automation-opvolging:', e?.message || e);
    }
  }

  await d.spiegel(ob.id, 'onboarding-portal-save');
  return res.status(200).json({ ok: true, current_step: stap });
}

// ── complete ─────────────────────────────────────────────────────────────
async function complete(d, req, res, body) {
  const sessie = typeof body.sessie === 'string' ? body.sessie.trim() : '';
  if (!UUID_RE.test(sessie)) return res.status(404).json({ error: 'Sessie onbekend.', code: 'sessie' });

  if (await beperkt(d, req, 'onboarding-portal-complete', 10, 60)) {
    return res.status(429).json({ error: TEKST.teVeel, code: 'te_veel' });
  }

  const { data: ob, error } = await zoekSessie(d, sessie,
    'id, status, traject_id, answers, mentor_user_id, customer_name');
  if (error) {
    console.error('[onboarding-portal] complete lookup:', error.message);
    return res.status(500).json({ error: 'Afronden mislukt.', code: 'fout' });
  }
  if (!ob) return res.status(404).json({ error: 'Sessie onbekend.', code: 'sessie' });
  if (isAfgesloten(ob.status)) return res.status(410).json({ error: TEKST.afgesloten, code: 'afgesloten' });
  if (ob.status === 'afgerond') return res.status(200).json({ ok: true, already: true });

  let flow = '1op1';
  if (ob.traject_id) {
    const { data: traj, error: tErr } = await d.db()
      .from('onboarding_trajecten').select('type').eq('id', ob.traject_id).maybeSingle();
    if (tErr) console.warn('[onboarding-portal] traject lookup:', tErr.message);
    else flow = resolveFlowType(traj?.type);
  }

  const missing = ontbrekend(flow, ob.answers);
  if (missing.length) {
    return res.status(400).json({ error: 'Niet alle verplichte vragen zijn ingevuld.', code: 'onvolledig', missing });
  }

  const af = await d.rondWizardAf(ob, { bron: 'onboarding-portal' });
  if (!af.ok) return res.status(500).json({ error: af.error, code: 'fout' });
  await zetPortalGestart(d.db(), ob.id, d.nu().toISOString());
  return res.status(200).json({ ok: true });
}

export function maakHandler(deps = {}) {
  const d = { ...STANDAARD, ...deps };
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
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
      if (body.action === 'complete') return await complete(d, req, res, body);
      return res.status(400).json({ error: 'Onbekende actie.', code: 'actie' });
    } catch (e) {
      console.error('[onboarding-portal] fatal:', body.action, e?.message || e);
      return res.status(500).json({ error: 'Er ging iets mis. Probeer het opnieuw.', code: 'fout' });
    }
  };
}

export default maakHandler();

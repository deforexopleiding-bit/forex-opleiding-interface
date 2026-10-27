// api/automation-overzicht.js
//
// GET → de sectie "Automation" (views/automation-v2.js): alle automation-
// kaarten uit de onboarding met hun pogingen, het onboardingdossier (traject,
// start, mentor, belmoment, wanneer interesse) en de geboekte call met uitkomst.
// Tabs Te bellen · Ingepland · Afgerond + KPI-strip. Rekenkern:
// api/_lib/automation-overzicht.js.
//
// Alleen LEZEN. Acties (bellen, WhatsApp, inplannen, afsluiten) gaan langs de
// bestaande Opvolging-endpoints op taak_id (opvolging-taak-update, -poging,
// -agenda, softphone-call-log) met hun eigen rechten.
//
// Query: ?test=1 → ook testkaarten (is_test). Standaard niet.
// Recht: automation.view (super_admin altijd).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { alleenAutomationlijst } from './_lib/opvolging-lijst.js';
import { bouwOverzicht } from './_lib/automation-overzicht.js';

export const RECHT = 'automation.view';
const MAX_KAARTEN = 1000;
const STUK = 200;

const KAART_VELDEN = 'id, naam, telefoon, email, reden, reden_code, lijst, status, due, later, notitie, '
  + 'bron_ref, afspraak_ref, archief_reden, gearchiveerd_at, created_at, is_test';

async function inStukken(ids, lees) {
  const uit = [];
  for (let i = 0; i < ids.length; i += STUK) {
    const { data, error } = await lees(ids.slice(i, i + STUK));
    if (error) throw new Error(error.message);
    uit.push(...(data || []));
  }
  return uit;
}

/** Alles lezen en het overzicht bouwen. Kaarten + pogingen zijn hard; de rest faalzacht. */
export async function laadAutomationOverzicht(db, { metTest = false, nuMs = Date.now() } = {}) {
  const meldingen = [];
  let q = alleenAutomationlijst(db.from('opvolging_taken').select(KAART_VELDEN));
  if (!metTest) q = q.eq('is_test', false);
  const { data: kaarten, error } = await q.order('created_at', { ascending: false }).limit(MAX_KAARTEN);
  if (error) throw new Error('kaarten lezen: ' + error.message);
  const rijen = kaarten || [];
  const ids = rijen.map((k) => k.id);

  const pogingen = await inStukken(ids, (stuk) => db.from('opvolging_pogingen')
    .select('taak_id, soort, tijdstip, resultaat, richting, automatisch, duur_sec').in('taak_id', stuk));

  const zacht = async (wat, fn) => {
    try { return await fn(); } catch (e) {
      console.warn('[automation-overzicht] ' + wat + ' (soft):', e?.message || e);
      meldingen.push(wat + ' kon niet gelezen worden');
      return [];
    }
  };

  const obIds = [...new Set(rijen.map((k) => k.bron_ref?.onboarding_id).filter(Boolean).map(String))];
  const obRijen = await zacht('onboardings', () => inStukken(obIds, (stuk) => db.from('onboardings')
    .select('id, customer_id, traject_id, mentor_user_id, start_date, status, automation_interesse_op, automation_belmoment')
    .in('id', stuk)));
  const onboardings = new Map(obRijen.map((o) => [String(o.id), o]));

  const trajIds = [...new Set([...obRijen.map((o) => o.traject_id), ...rijen.map((k) => k.bron_ref?.traject_id)].filter(Boolean).map(String))];
  const trajRijen = await zacht('trajecten', () => inStukken(trajIds, (stuk) => db.from('onboarding_trajecten')
    .select('id, label').in('id', stuk)));
  const trajecten = new Map(trajRijen.map((t) => [String(t.id), t.label]));

  const mentorIds = [...new Set(obRijen.map((o) => o.mentor_user_id).filter(Boolean).map(String))];
  const tmRijen = await zacht('mentoren', () => inStukken(mentorIds, (stuk) => db.from('team_members')
    .select('user_id, name').in('user_id', stuk)));
  const mentoren = new Map(tmRijen.filter((r) => r.user_id && r.name).map((r) => [String(r.user_id), r.name]));

  // De geboekte calls, met de verzet-keten (een verzette call krijgt een kind
  // met parent_appointment_id): tot drie stappen ver.
  const AFSPRAAK_VELDEN = 'id, scheduled_at, status, uitkomst, uitkomst_op, zoom_join_url, parent_appointment_id, created_at';
  const afspraken = new Map();
  const opvolgers = new Map();
  await zacht('calls', async () => {
    let te = [...new Set(rijen.map((k) => k.afspraak_ref?.appointment_id).filter(Boolean).map(String))];
    const rij = await inStukken(te, (stuk) => db.from('follow_up_appointments').select(AFSPRAAK_VELDEN).in('id', stuk));
    for (const a of rij) afspraken.set(String(a.id), a);
    for (let stap = 0; stap < 3 && te.length; stap++) {
      const kinderen = await inStukken(te, (stuk) => db.from('follow_up_appointments').select(AFSPRAAK_VELDEN).in('parent_appointment_id', stuk));
      te = [];
      for (const k of kinderen.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
        afspraken.set(String(k.id), k);
        opvolgers.set(String(k.parent_appointment_id), k);
        te.push(String(k.id));
      }
    }
    return [];
  });

  const overzicht = bouwOverzicht({ kaarten: rijen, pogingen, onboardings, trajecten, mentoren, afspraken, opvolgers, nuMs });
  return { ...overzicht, meldingen, afgekapt: rijen.length >= MAX_KAARTEN };
}

export function maakHandler(deps = {}) {
  const d = {
    db: supabaseAdmin,
    ingelogd: async (req) => {
      const { data: { user } } = await createUserClient(req).auth.getUser();
      return user || null;
    },
    mag: (req) => requirePermission(req, RECHT),
    ...deps,
  };
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
    if (!(await d.ingelogd(req))) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    if (!(await d.mag(req))) return res.status(403).json({ error: `Geen rechten (${RECHT})` });
    try {
      const metTest = String((req.query || {}).test || '') === '1';
      return res.status(200).json(await laadAutomationOverzicht(d.db, { metTest }));
    } catch (e) {
      console.error('[automation-overzicht]', e?.message || e);
      return res.status(500).json({ error: 'Het overzicht kon niet geladen worden.' });
    }
  };
}

export default maakHandler();

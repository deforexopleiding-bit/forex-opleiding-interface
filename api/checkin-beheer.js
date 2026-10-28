// api/checkin-beheer.js
//
// De CRM-sectie "Studentencheck-in" (views/studentencheckin-v2.js): de
// campagnekaart, de KPI-strip, de tabel, payouts om te delen, per mentor — en de
// knoppen Testtoewijzingen / Run / Pauzeren / Hervatten / opties.
//
// De data staat in het LMS (dfo-lms: hlms_checkin_campagne, _toewijzing,
// hlms_student, hlms_personeel, hlms_signaal); de automation-kaarten in het CRM
// (opvolging_taken). Rekenkern: api/_lib/checkin-beheer.js.
//
//   GET                         → overzicht (recht checkin.view)
//   GET ?csv=1                  → export (checkin.view)
//   GET ?campagne=<slug>        → een andere campagne
//   POST { actie:'doelgroep' }  → wie zou Run raken + uitgesloten met reden (checkin.run)
//   POST { actie:'test' }       → testtoewijzingen voor de testaccounts (checkin.run)
//   POST { actie:'run', bevestiging:'ACTIVEER' } → activeer in het LMS (checkin.run)
//   POST { actie:'pauzeer' | 'hervat' }          → pop-up en balk weg / terug (checkin.run)
//   POST { actie:'opties', opties }             → opties van de campagne (checkin.run)
//
// RUN stuurt NIETS naar studenten: geen mail, geen WhatsApp. Het legt de
// doelgroep vast en maakt de toewijzingen aan (idempotent, in één transactie in
// de LMS-functie hlms_checkin_run). De server rekent de doelgroep ZELF opnieuw
// uit; een lijst uit de browser telt niet.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { alleenAutomationlijst } from './_lib/opvolging-lijst.js';
import { LABELS, VRAAG, STANDAARD_OPTIES } from './_lib/checkin-portal.js';
import {
  doelgroep, doelgroepSamenvatting, doelgroepRegel, rijenVan, kpi, perMentor, payouts, csv,
  schoneOpties, runStand, testaccounts, PRODUCTEN, vandaag, UITSLUIT_REDEN,
} from './_lib/checkin-beheer.js';

export const RECHT_VIEW = 'checkin.view';
export const RECHT_RUN = 'checkin.run';
export const BEVESTIGING = 'ACTIVEER';
const SITE = 'https://www.deforexopleiding.nl/checkin';
const LMS = 'https://lms.deforexopleiding.nl';

/**
 * De teksten van de pop-up en de balk in het LMS — KOPIE van
 * dfo-lms-prototype src/lib/checkin/stand.ts (CHECKIN_TEKST). Ze staan hier zodat
 * het bevestigingsvenster van Run exact toont wat de student gaat zien.
 */
export const LMS_TEKST = Object.freeze({
  popup: {
    eyebrow: 'Persoonlijke check-in · ±3 min',
    titel: 'Hoe loopt jouw traject, <voornaam>?',
    tekst: 'We willen weten wat jou vooruithelpt en waar je op vastloopt, zodat we jouw begeleiding scherper maken. Drie minuten, en je antwoorden gaan rechtstreeks naar het team.',
    knoppen: ['Start mijn check-in', 'Later'],
  },
  balk: {
    titel: 'Jouw check-in staat klaar.',
    code: 'Code XXXX-XXXX (met kopieerknop)',
    knop: 'Start check-in · of "Ga verder" als de student al begon',
  },
});

const TOEWIJZING_VELDEN = 'id, campagne_id, student_id, code, is_test, status, huidige_stap, antwoorden, inhoud_versie, '
  + 'signaal_id, popup_gezien_op, gestart_op, laatst_opgeslagen_op, verstuurd_op, aangemaakt_op, '
  + 'student:hlms_student(id, voornaam, achternaam, email, product_soort, mentor_id)';

function migratieOntbreekt(error) {
  const c = String(error?.code || '');
  return c === '42P01' || c === 'PGRST205' || c === 'PGRST202' || c === '42883'
    || /does not exist|schema cache|could not find the (table|function)/i.test(error?.message || '');
}

class Fout extends Error {
  constructor(status, bericht, extra = {}) { super(bericht); this.status = status; this.extra = extra; }
}

async function leesAlles(q, wat) {
  const { data, error } = await q;
  if (error) {
    if (migratieOntbreekt(error)) throw new Fout(503, 'De check-in bestaat nog niet in het LMS: draai eerst hlms_checkin.sql (dfo-lms).', { migratie_nodig: true });
    throw new Fout(500, wat + ' lezen mislukt: ' + error.message);
  }
  return data || [];
}

async function campagnes(lms) {
  return leesAlles(lms.from('hlms_checkin_campagne').select('*').order('aangemaakt_op', { ascending: false }), 'campagnes');
}

function kiesCampagne(lijst, slug) {
  if (slug) return lijst.find((c) => c.slug === slug) || null;
  return lijst.find((c) => c.status !== 'gesloten') || lijst[0] || null;
}

async function mentorNamen(lms) {
  const rijen = await leesAlles(lms.from('hlms_personeel').select('id, naam'), 'personeel');
  return new Map(rijen.map((p) => [String(p.id), p.naam || 'Onbekend']));
}

/** Het volledige overzicht van één campagne. */
export async function laadOverzicht({ lms, crm, slug = null }) {
  const lijst = await campagnes(lms);
  const campagne = kiesCampagne(lijst, slug);
  if (!campagne) return { campagne: null, campagnes: [], rijen: [], kpi: kpi([]), per_mentor: [], payouts: [] };

  const [toewijzingen, namen] = await Promise.all([
    leesAlles(lms.from('hlms_checkin_toewijzing').select(TOEWIJZING_VELDEN).eq('campagne_id', campagne.id).range(0, 9999), 'toewijzingen'),
    mentorNamen(lms),
  ]);

  const meldingen = [];
  const sigIds = [...new Set(toewijzingen.map((t) => t.signaal_id).filter(Boolean).map(String))];
  let signalen = new Map();
  if (sigIds.length) {
    const { data, error } = await lms.from('hlms_signaal').select('id, status, zwaarte').in('id', sigIds);
    if (error) meldingen.push('De begeleidingssignalen konden niet gelezen worden.');
    else signalen = new Map((data || []).map((s) => [String(s.id), s]));
  }
  let kaarten = new Map();
  {
    // Een automation-kaart staat in lijst 'automation' (vóór die migratie nog 'dag').
    const { data, error } = await alleenAutomationlijst(crm.from('opvolging_taken')
      .select('id, status, bron_ref'))
      .not('bron_ref->>checkin_toewijzing_id', 'is', null)
      .limit(5000);
    if (error) meldingen.push('De automation-kaarten konden niet gelezen worden.');
    else kaarten = new Map((data || []).map((k) => [String(k.bron_ref?.checkin_toewijzing_id), { id: k.id, status: k.status }]));
  }

  const rijen = rijenVan({ toewijzingen, mentorNamen: namen, signalen, kaarten })
    .sort((a, b) => String(b.verstuurd_op || '').localeCompare(String(a.verstuurd_op || '')) || a.naam.localeCompare(b.naam, 'nl'));
  const test = rijen.filter((r) => r.is_test);

  return {
    campagne: {
      id: campagne.id, slug: campagne.slug, naam: campagne.naam, status: campagne.status,
      inhoud_versie: campagne.inhoud_versie, opties: { ...STANDAARD_OPTIES, ...(campagne.opties || {}) },
      doelgroep_regel: campagne.doelgroep_regel || null, live_op: campagne.live_op, live_door: campagne.live_door,
      aangemaakt_op: campagne.aangemaakt_op,
    },
    campagnes: lijst.map((c) => ({ slug: c.slug, naam: c.naam, status: c.status })),
    run: runStand(campagne, toewijzingen),
    test: test.map((r) => ({ id: r.id, naam: r.naam, email: r.email, code: r.code, status: r.status, verstuurd_op: r.verstuurd_op, link: `${SITE}?code=${r.code.slice(0, 4)}-${r.code.slice(4)}` })),
    rijen,
    kpi: kpi(rijen),
    per_mentor: perMentor(rijen),
    payouts: payouts(rijen),
    labels: LABELS,
    vragen: VRAAG,
    lms_tekst: LMS_TEKST,
    links: { site: SITE, lms: LMS },
    meldingen,
  };
}

/** Doelgroep van NU (altijd server-side uitgerekend). */
export async function berekenDoelgroep({ lms, crm, nu = new Date() }) {
  const [studenten, namen] = await Promise.all([
    leesAlles(lms.from('hlms_student')
      .select('id, auth_id, email, voornaam, achternaam, product_soort, eind_datum, mentor_id, crm_onboarding_id')
      .not('auth_id', 'is', null)
      .gte('eind_datum', vandaag(nu))
      .in('product_soort', PRODUCTEN)
      .range(0, 9999), 'studenten'),
    mentorNamen(lms),
  ]);
  const { data: obs, error } = await crm.from('onboardings')
    .select('id, status, started_at, created_at, is_test, handmatig_afgerond_op, auto_afgerond_op, customer:customers(email)')
    .range(0, 9999);
  // Zonder de onboardings kunnen we niet uitsluiten wie net de nieuwe onboarding
  // deed — dan liever geen Run dan een te brede.
  if (error) throw new Fout(500, 'De onboardings konden niet gelezen worden: ' + error.message);
  const onboardings = (obs || []).map((o) => ({ ...o, email: o.customer?.email || null }));
  const dg = doelgroep({ studenten, onboardings, testEmails: testaccounts(), nu });
  return { dg, samenvatting: doelgroepSamenvatting(dg, namen) };
}

async function testStudenten(lms) {
  const mails = testaccounts();
  const rijen = await leesAlles(lms.from('hlms_student').select('id, email, voornaam, achternaam, auth_id, product_soort').range(0, 9999), 'studenten');
  const gevonden = rijen.filter((s) => mails.includes(String(s.email || '').trim().toLowerCase()));
  return { gevonden, zonderStudentrij: mails.filter((m) => !gevonden.some((s) => String(s.email).toLowerCase() === m)) };
}

async function rpc(lms, naam, args) {
  const { data, error } = await lms.rpc(naam, args);
  if (error) {
    if (migratieOntbreekt(error)) throw new Fout(503, 'De LMS-functie ' + naam + ' bestaat nog niet: draai hlms_checkin.sql (dfo-lms).', { migratie_nodig: true });
    const hint = String(error.hint || '');
    const status = /checkin_/.test(hint) ? 409 : 500;
    throw new Fout(status, error.message, { code: hint || error.code || null });
  }
  return data;
}

async function zetStatus(lms, campagneId, van, naar) {
  const { data, error } = await lms.from('hlms_checkin_campagne')
    .update({ status: naar, gewijzigd_op: new Date().toISOString() })
    .eq('id', campagneId).eq('status', van).select('id, status');
  if (error) throw new Fout(500, 'Status wijzigen mislukt: ' + error.message);
  if (!data || !data.length) throw new Fout(409, `De campagne staat niet op "${van}".`);
  return data[0];
}

export function maakHandler(deps = {}) {
  const d = {
    crm: supabaseAdmin,
    lms: () => getDfoLmsClient(),
    ingelogd: async (req) => {
      const { data: { user } } = await createUserClient(req).auth.getUser();
      return user || null;
    },
    mag: (req, recht) => requirePermission(req, recht),
    nu: () => new Date(),
    ...deps,
  };
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const user = await d.ingelogd(req);
    if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    if (!(await d.mag(req, RECHT_VIEW))) return res.status(403).json({ error: `Geen rechten (${RECHT_VIEW})` });
    const lms = d.lms();
    if (!lms) return res.status(503).json({ error: 'De koppeling met het LMS is niet geconfigureerd (DFO_LMS_SUPABASE_*).' });
    const q = req.query || {};
    try {
      if (req.method === 'GET') {
        const ov = await laadOverzicht({ lms, crm: d.crm, slug: typeof q.campagne === 'string' ? q.campagne : null });
        if (String(q.csv || '') === '1') {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="checkin-${ov.campagne?.slug || 'export'}.csv"`);
          return res.status(200).send(csv(ov.rijen));
        }
        res.setHeader('Content-Type', 'application/json');
        const magRun = await d.mag(req, RECHT_RUN);
        return res.status(200).json({ ...ov, rechten: { run: !!magRun } });
      }
      if (req.method !== 'POST') return res.status(405).json({ error: 'GET of POST' });

      res.setHeader('Content-Type', 'application/json');
      if (!(await d.mag(req, RECHT_RUN))) return res.status(403).json({ error: `Geen rechten (${RECHT_RUN})` });
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body && typeof body === 'object' ? body : {};
      const lijst = await campagnes(lms);
      const campagne = lijst.find((c) => c.id === body.campagne_id) || null;
      if (!campagne) return res.status(404).json({ error: 'Campagne niet gevonden.' });

      if (body.actie === 'doelgroep') {
        const { samenvatting } = await berekenDoelgroep({ lms, crm: d.crm, nu: d.nu() });
        return res.status(200).json({ ok: true, samenvatting, lms_tekst: LMS_TEKST, uitsluit_redenen: UITSLUIT_REDEN, bevestiging: BEVESTIGING });
      }

      if (body.actie === 'test') {
        const { gevonden, zonderStudentrij } = await testStudenten(lms);
        if (!gevonden.length) return res.status(409).json({ error: 'Geen enkel testaccount heeft een studentrij in het LMS.', zonder_studentrij: zonderStudentrij });
        const r = await rpc(lms, 'hlms_checkin_test_toewijzen', { p_campagne: campagne.id, p_studenten: gevonden.map((s) => s.id) });
        console.log('[checkin-beheer] testtoewijzingen', { door: user.email, campagne: campagne.slug, ...r });
        return res.status(200).json({ ok: true, ...r, testaccounts: gevonden.map((s) => s.email), zonder_studentrij: zonderStudentrij });
      }

      if (body.actie === 'run') {
        if (body.bevestiging !== BEVESTIGING) return res.status(400).json({ error: `Typ ${BEVESTIGING} om te bevestigen.` });
        if (campagne.status === 'live' || campagne.status === 'gepauzeerd') {
          return res.status(200).json({ ok: true, al_live: true, status: campagne.status });
        }
        const { dg, samenvatting } = await berekenDoelgroep({ lms, crm: d.crm, nu: d.nu() });
        const r = await rpc(lms, 'hlms_checkin_run', {
          p_campagne: campagne.id,
          p_studenten: dg.ontvangers.map((s) => s.id),
          p_regel: doelgroepRegel(samenvatting, d.nu()),
          p_door: user.email || user.id,
        });
        console.log('[checkin-beheer] RUN', { door: user.email, campagne: campagne.slug, ...r });
        return res.status(200).json({ ok: true, ...r });
      }

      if (body.actie === 'pauzeer') {
        await zetStatus(lms, campagne.id, 'live', 'gepauzeerd');
        console.log('[checkin-beheer] gepauzeerd', { door: user.email, campagne: campagne.slug });
        return res.status(200).json({ ok: true, status: 'gepauzeerd' });
      }
      if (body.actie === 'hervat') {
        await zetStatus(lms, campagne.id, 'gepauzeerd', 'live');
        console.log('[checkin-beheer] hervat', { door: user.email, campagne: campagne.slug });
        return res.status(200).json({ ok: true, status: 'live' });
      }

      if (body.actie === 'opties') {
        if (campagne.status === 'gesloten') return res.status(409).json({ error: 'De campagne is gesloten.' });
        const nieuw = { ...STANDAARD_OPTIES, ...(campagne.opties || {}), ...schoneOpties(body.opties) };
        // Wie al begon, houdt zijn opties (vastgelegd op de toewijzing bij het
        // starten). Een wijziging na Run krijgt een nieuwe inhoudsversie.
        const versie = (campagne.status === 'live' || campagne.status === 'gepauzeerd')
          ? (Number(campagne.inhoud_versie) || 1) + 1 : campagne.inhoud_versie;
        const { error } = await lms.from('hlms_checkin_campagne')
          .update({ opties: nieuw, inhoud_versie: versie, gewijzigd_op: new Date().toISOString() })
          .eq('id', campagne.id).neq('status', 'gesloten');
        if (error) throw new Fout(500, 'Opties opslaan mislukt: ' + error.message);
        return res.status(200).json({ ok: true, opties: nieuw, inhoud_versie: versie });
      }

      return res.status(400).json({ error: 'Onbekende actie.' });
    } catch (e) {
      if (e instanceof Fout) return res.status(e.status).json({ error: e.message, ...e.extra });
      console.error('[checkin-beheer]', e?.message || e);
      return res.status(500).json({ error: 'Er ging iets mis.' });
    }
  };
}

export default maakHandler();

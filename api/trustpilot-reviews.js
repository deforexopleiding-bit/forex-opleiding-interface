// api/trustpilot-reviews.js
//
// CRM-module "Trustpilot-reviews" (Maxim, 16 nov 2026) — wie in het LMS
// bevestigde dat zijn Trustpilot-review online staat, onder welke naam, en de
// export voor de loting met kerst (die doet Maxim zelf, buiten het platform).
//
// De data staat in het LMS (dfo-lms `hlms_trustpilot_*`, migratie
// dfo-lms-prototype supabase/hlms_trustpilot.sql) en wordt hier met de
// service role gelezen — zoals Studentencheck-in (api/checkin-beheer.js).
// Rekenkern: api/_lib/trustpilot-overzicht.js.
//
// RECHTEN (dezelfde als Studentencheck-in)
//   checkin.view — kijken, CSV, namen voor de loting
//   checkin.run  — een TESTrij wissen (enkel is_test; echte studenten nooit)
//
// GET            → { campagne, tegels, rijen, loting }
// GET ?csv=1     → text/csv (alles, ook testaccounts met kolom Testaccount)
// POST { actie: 'reset_test', student_id } → wist de testrij van die student

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import {
  CAMPAGNE_SLUG, bouwRijen, tegels, lotingNamen, csv, personeelAuthIds, vandaagBrussel, PRODUCTEN, STATUS_LABEL,
} from './_lib/trustpilot-overzicht.js';

export const RECHT_VIEW = 'checkin.view';
export const RECHT_RESET = 'checkin.run';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Fout extends Error {
  constructor(status, bericht, extra = {}) { super(bericht); this.status = status; this.extra = extra; }
}

function ontbreekt(error) {
  const c = String(error?.code || '');
  return c === '42P01' || c === 'PGRST205' || /does not exist|schema cache|could not find the table/i.test(error?.message || '');
}

async function lees(q, wat) {
  const { data, error } = await q;
  if (error) {
    if (ontbreekt(error)) throw new Fout(503, 'De Trustpilot-campagne bestaat nog niet in het LMS: draai eerst hlms_trustpilot.sql (dfo-lms).', { migratie_nodig: true });
    throw new Fout(500, wat + ' lezen mislukt: ' + error.message);
  }
  return data || [];
}

/** Alles lezen in blokken van 1000 (PostgREST-limiet). */
async function leesAlles(maak, wat) {
  const uit = [];
  for (let van = 0; ; van += 1000) {
    const blok = await lees(maak().range(van, van + 999), wat);
    uit.push(...blok);
    if (blok.length < 1000) break;
  }
  return uit;
}

export async function laadOverzicht({ lms, nu = new Date() }) {
  const [campagne] = await lees(lms.from('hlms_trustpilot_campagne').select('*').eq('slug', CAMPAGNE_SLUG).limit(1), 'campagne');
  if (!campagne) throw new Fout(404, 'De campagne ' + CAMPAGNE_SLUG + ' bestaat niet in het LMS.');
  const vandaag = vandaagBrussel(nu);

  const [statussen, actief, rollen, personeel] = await Promise.all([
    leesAlles(() => lms.from('hlms_trustpilot_status').select('*').eq('campagne_id', campagne.id).order('id'), 'statussen'),
    leesAlles(() => lms.from('hlms_student')
      .select('id, auth_id, email, voornaam, achternaam, product_soort, eind_datum, mentor_id')
      .not('auth_id', 'is', null).gte('eind_datum', vandaag).in('product_soort', PRODUCTEN).order('id'), 'studenten'),
    leesAlles(() => lms.from('hlms_rol').select('auth_id, rol, geldig_tot').in('rol', ['admin', 'hoofdmentor', 'mentor']).order('auth_id'), 'rollen'),
    leesAlles(() => lms.from('hlms_personeel').select('id, naam').order('id'), 'personeel'),
  ]);
  //  Wie een statusrij heeft maar niet (meer) in de actieve lijst zit, toch lezen.
  const bekend = new Set(actief.map((s) => String(s.id)));
  const extraIds = [...new Set(statussen.map((t) => String(t.student_id)).filter((id) => !bekend.has(id)))];
  const extra = [];
  for (let i = 0; i < extraIds.length; i += 200) {
    extra.push(...await lees(lms.from('hlms_student')
      .select('id, auth_id, email, voornaam, achternaam, product_soort, eind_datum, mentor_id')
      .in('id', extraIds.slice(i, i + 200)), 'studenten'));
  }

  const rijen = bouwRijen({
    studenten: [...actief, ...extra],
    statussen,
    mentorNamen: new Map(personeel.map((p) => [String(p.id), p.naam || 'Onbekend'])),
    testEmails: campagne.test_emails || [],
    personeel: personeelAuthIds(rollen, nu),
    vandaag,
  });
  const opties = campagne.opties || {};
  const per = Number.isInteger(opties.per_aantal) && opties.per_aantal > 0 ? opties.per_aantal : 10;
  return {
    campagne: {
      slug: campagne.slug, naam: campagne.naam, status: campagne.status,
      start_op: campagne.start_op, einde_op: campagne.einde_op,
      prijs: opties.prijs || '25k funded account', per_aantal: per, trustpilot_url: opties.trustpilot_url || null,
      test_emails: campagne.test_emails || [],
    },
    tegels: tegels(rijen, per),
    rijen,
    loting: lotingNamen(rijen),
    status_label: STATUS_LABEL,
  };
}

export function maakHandler(deps = {}) {
  const d = {
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
    try {
      if (req.method === 'GET') {
        const ov = await laadOverzicht({ lms, nu: d.nu() });
        if (String(req.query?.csv || '') === '1') {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="trustpilot-reviews-${ov.campagne.slug}.csv"`);
          return res.status(200).send(csv(ov.rijen));
        }
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json({ ...ov, rechten: { reset: !!(await d.mag(req, RECHT_RESET)) } });
      }
      if (req.method !== 'POST') return res.status(405).json({ error: 'GET of POST' });

      res.setHeader('Content-Type', 'application/json');
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body && typeof body === 'object' ? body : {};
      if (body.actie !== 'reset_test') return res.status(400).json({ error: 'Onbekende actie.' });
      if (!(await d.mag(req, RECHT_RESET))) return res.status(403).json({ error: `Geen rechten (${RECHT_RESET})` });
      if (typeof body.student_id !== 'string' || !UUID_RE.test(body.student_id)) return res.status(400).json({ error: 'student_id ontbreekt.' });

      const [campagne] = await lees(lms.from('hlms_trustpilot_campagne').select('id').eq('slug', CAMPAGNE_SLUG).limit(1), 'campagne');
      if (!campagne) return res.status(404).json({ error: 'Campagne niet gevonden.' });
      //  ENKEL een testrij: is_test = true staat in de WHERE, nooit een echte student.
      const { data, error } = await lms.from('hlms_trustpilot_status')
        .delete().eq('campagne_id', campagne.id).eq('student_id', body.student_id).eq('is_test', true).select('id');
      if (error) throw new Fout(500, 'Wissen mislukt: ' + error.message);
      if (!data || !data.length) return res.status(409).json({ error: 'Geen testrij gevonden voor deze student (echte studenten worden nooit gewist).' });
      console.log('[trustpilot-reviews] testrij gewist', { door: user.email, student_id: body.student_id });
      return res.status(200).json({ ok: true });
    } catch (e) {
      if (e instanceof Fout) return res.status(e.status).json({ error: e.message, ...e.extra });
      console.error('[trustpilot-reviews]', e?.message || e);
      return res.status(500).json({ error: 'Er ging iets mis.' });
    }
  };
}

export default maakHandler();

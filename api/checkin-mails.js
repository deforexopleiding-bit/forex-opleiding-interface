// api/checkin-mails.js
//
// Studentencheck-in › Mails in het CRM (Maxim, 28 okt 2026): de hoofdschakelaar,
// de drie teksten (concept → goedgekeurd), een testmail naar jezelf en wat de
// cron in de live campagne zou doen. Het versturen: api/cron/checkin-mails.js.
//
// RECHTEN
//   checkin.view                — kijken
//   checkin.run                 — teksten bewerken, testmail
//   checkin.mails.goedkeuren    — goedkeuren en de hoofdschakelaar (zonder rij
//                                 in role_permissions: alleen super_admin)
//
// GET  → { instellingen, soorten, rechten, logboek, campagnes, plan:{per_soort, overgeslagen}, genegeerd }
// POST { actie: 'tekst', soort, onderwerp, tekst } | { actie: 'goedkeuren', soort }
//      { actie: 'schakelaar', aan } | { actie: 'test', soort }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { dagBrussel } from './_lib/onboarding-auto-afronden.js';
import { keurGoed, bewerkTekst } from './_lib/onboarding-herinneringen.js';
import { leesRuweInstellingen, bewaarInstellingen } from './_lib/onboarding-herinneringen-server.js';
import { SETTING_KEY, SOORTEN, SOORT_LABEL, normaliseerInstellingen, GENEGEERD_NA_DAGEN } from './_lib/checkin-mails.js';
import { leesInstellingen, planCheckinMails, stuurCheckinMail } from './_lib/checkin-mails-server.js';

export const RECHT_VIEW = 'checkin.view';
export const RECHT_BEWERK = 'checkin.run';
export const RECHT_GOEDKEUREN = 'checkin.mails.goedkeuren';

function body(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}

export function maakHandler(deps = {}) {
  const d = {
    db: supabaseAdmin,
    lms: () => getDfoLmsClient(),
    ingelogd: async (req) => {
      const { data: { user } } = await createUserClient(req).auth.getUser();
      return user || null;
    },
    mag: (req, recht) => requirePermission(req, recht),
    vandaag: () => dagBrussel(),
    ...deps,
  };
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    const user = await d.ingelogd(req);
    if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    if (!(await d.mag(req, RECHT_VIEW))) return res.status(403).json({ error: `Geen rechten (${RECHT_VIEW})` });
    try {
      if (req.method === 'GET') {
        const inst = await leesInstellingen(d.db);
        const { log, campagnes, plan, genegeerd } = await planCheckinMails({ db: d.db, lms: d.lms(), vandaag: d.vandaag() });
        const perSoort = {};
        const overgeslagen = {};
        const verstuurd = {};
        for (const p of plan) {
          if (p.besluit.actie === 'mail') perSoort[p.besluit.soort] = (perSoort[p.besluit.soort] || 0) + 1;
          else overgeslagen[p.besluit.waarom] = (overgeslagen[p.besluit.waarom] || 0) + 1;
        }
        if (log) for (const l of [...log.values()].flat()) if (l.status === 'verstuurd') verstuurd[l.soort] = (verstuurd[l.soort] || 0) + 1;
        return res.status(200).json({
          instellingen: inst,
          soorten: SOORTEN.map((s) => ({ soort: s, label: SOORT_LABEL[s] })),
          rechten: { bewerk: !!(await d.mag(req, RECHT_BEWERK)), goedkeuren: !!(await d.mag(req, RECHT_GOEDKEUREN)) },
          logboek: log !== null,
          campagnes: campagnes.map((c) => ({ slug: c.slug, naam: c.naam, live_op: c.live_op })),
          plan: { per_soort: perSoort, overgeslagen, verstuurd, toewijzingen: plan.length },
          genegeerd, genegeerd_na_dagen: GENEGEERD_NA_DAGEN,
        });
      }
      if (req.method !== 'POST') return res.status(405).json({ error: 'GET of POST' });
      const b = body(req);
      const door = user.email || user.id;
      if (!SOORTEN.includes(b.soort) && b.actie !== 'schakelaar') return res.status(400).json({ error: 'Onbekende soort.' });

      if (b.actie === 'tekst' || b.actie === 'test') {
        if (!(await d.mag(req, RECHT_BEWERK))) return res.status(403).json({ error: `Geen rechten (${RECHT_BEWERK})` });
        if (b.actie === 'test') {
          const inst = await leesInstellingen(d.db);
          const m = await stuurCheckinMail(inst.teksten[b.soort], { naar: user.email, voornaam: 'Maxim', code: 'TESTCODE', onderwerpPrefix: '[TEST] ' });
          return res.status(m.ok ? 200 : 502).json(m.ok ? { ok: true, naar: m.naar } : { error: 'Testmail niet verstuurd: ' + (m.fout || m.overgeslagen) });
        }
        const onderwerp = String(b.onderwerp || '').trim().slice(0, 200);
        const tekst = String(b.tekst || '').replace(/\r\n/g, '\n').trim().slice(0, 5000);
        if (!onderwerp || !tekst) return res.status(400).json({ error: 'Onderwerp en tekst zijn verplicht.' });
        const ruw = bewerkTekst(await leesRuweInstellingen(d.db, SETTING_KEY), b.soort, { onderwerp, tekst }, door);
        await bewaarInstellingen(d.db, ruw, user.id, SETTING_KEY);
        return res.status(200).json({ ok: true, instellingen: normaliseerInstellingen(ruw) });
      }

      if (!(await d.mag(req, RECHT_GOEDKEUREN))) return res.status(403).json({ error: `Geen rechten (${RECHT_GOEDKEUREN})` });
      if (b.actie === 'goedkeuren') {
        const oud = await leesRuweInstellingen(d.db, SETTING_KEY);
        const ruw = keurGoed(oud, b.soort, normaliseerInstellingen(oud).teksten[b.soort], door);
        await bewaarInstellingen(d.db, ruw, user.id, SETTING_KEY);
        return res.status(200).json({ ok: true, instellingen: normaliseerInstellingen(ruw) });
      }
      if (b.actie === 'schakelaar') {
        const oud = await leesRuweInstellingen(d.db, SETTING_KEY);
        const aan = b.aan === true;
        const nieuw = { ...oud, aan, aan_op: aan ? new Date().toISOString() : null, aan_door: aan ? door : null };
        await bewaarInstellingen(d.db, nieuw, user.id, SETTING_KEY);
        console.log('[checkin-mails] hoofdschakelaar', aan ? 'AAN' : 'UIT', 'door', door);
        return res.status(200).json({ ok: true, instellingen: normaliseerInstellingen(nieuw) });
      }
      return res.status(400).json({ error: 'Onbekende actie.' });
    } catch (e) {
      console.error('[checkin-mails]', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  };
}

export default maakHandler();

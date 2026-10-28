// api/onboarding-herinneringen.js
//
// Onboarding › Herinneringen in het CRM (Maxim, 28 okt 2026): de
// hoofdschakelaar, de teksten (concept → goedgekeurd), een testmail naar
// jezelf, de lijst van vandaag, de oude dossiers en de schakelaar "Geen
// herinneringen" per student. De regels: api/_lib/onboarding-herinneringen.js;
// het versturen doet de cron api/cron/onboarding-herinneringen.js.
//
// RECHTEN
//   onboarding.admin                     — kijken, teksten bewerken, testmail,
//                                          "Geen herinneringen" per student
//   onboarding.herinneringen.goedkeuren  — teksten goedkeuren, de
//                                          hoofdschakelaar, de oude dossiers
//                                          (zonder rij in role_permissions:
//                                          alleen super_admin)
//
// GET  → { instellingen, rechten, oude_automation, logboek, vandaag, plan, oude_dossiers }
// POST { actie: 'tekst', soort, onderwerp, tekst }
//      { actie: 'goedkeuren', soort }
//      { actie: 'schakelaar', aan }
//      { actie: 'test', soort }                         → naar jezelf
//      { actie: 'oude_dossiers', bevestiging: 'VERSTUUR' }
//      { actie: 'geen_herinneringen', onboarding_id, aan }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { bouwOverzichtRijen } from './_lib/onboarding-overzicht-rijen.js';
import { dagBrussel } from './_lib/onboarding-auto-afronden.js';
import { SOORTEN, SOORT_LABEL, normaliseerInstellingen, eersteDag, keurGoed, bewerkTekst } from './_lib/onboarding-herinneringen.js';
import {
  leesInstellingen, leesRuweInstellingen, bewaarInstellingen, planHerinneringen, claim, markeer,
  stuurHerinnering, stuurTestHerinnering, zetGeenHerinneringen,
} from './_lib/onboarding-herinneringen-server.js';

export const RECHT_VIEW = 'onboarding.admin';
export const RECHT_GOEDKEUREN = 'onboarding.herinneringen.goedkeuren';
export const BEVESTIGING = 'VERSTUUR';

function body(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}

function kort(r) {
  return { id: r.id, klant: r.customer_name || null, start: r.start_date || null, mentor: r.mentor_name || null, traject: r.traject_label || null };
}

export function maakHandler(deps = {}) {
  const d = {
    db: supabaseAdmin,
    lms: () => getDfoLmsClient(),
    rijen: () => bouwOverzichtRijen({ scope: 'active' }),
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
    const vandaag = d.vandaag();
    try {
      if (req.method === 'GET') {
        const [inst, rijen] = await Promise.all([leesInstellingen(d.db), d.rijen()]);
        const { log, oude, plan, oudeDossiers } = await planHerinneringen({ db: d.db, lms: d.lms(), rijen, vandaag });
        const magGoedkeuren = !!(await d.mag(req, RECHT_GOEDKEUREN));
        return res.status(200).json({
          vandaag,
          instellingen: inst,
          soorten: SOORTEN.map((s) => ({ soort: s, label: SOORT_LABEL[s] })),
          rechten: { goedkeuren: magGoedkeuren },
          oude_automation: { aan: oude.aan, namen: oude.namen },
          logboek: log !== null,
          plan: plan.filter((p) => p.besluit.actie !== 'niets' || p.besluit.waarom !== 'klaar').map((p) => ({
            ...kort(p.rij),
            actie: p.besluit.actie, soort: p.besluit.soort || null, waarom: p.besluit.waarom || null,
            eerste_dag: eersteDag(p.rij), bedenktijd: p.rij.bedenktijd?.status || null,
            geen_herinneringen: p.rij.geen_herinneringen || null,
            log: p.log.map((l) => ({ soort: l.soort, status: l.status, op: l.aangemaakt_op })),
          })),
          oude_dossiers: oudeDossiers.map((o) => ({
            ...kort(o.rij), actie: o.besluit.actie, waarom: o.besluit.waarom || null,
            laatste_op: (o.log.find((l) => l.soort === 'laatste' && l.status !== 'mislukt') || {}).aangemaakt_op || null,
          })),
        });
      }
      if (req.method !== 'POST') return res.status(405).json({ error: 'GET of POST' });

      const b = body(req);
      const door = user.email || user.id;

      if (b.actie === 'geen_herinneringen') {
        const u = await zetGeenHerinneringen(d.db, { onboardingId: String(b.onboarding_id || ''), aan: b.aan === true, door });
        return res.status(u.status).json(u.body);
      }

      if (b.actie === 'test') {
        if (!SOORTEN.includes(b.soort)) return res.status(400).json({ error: 'Onbekende soort.' });
        const inst = await leesInstellingen(d.db);
        const m = await stuurTestHerinnering(inst.teksten[b.soort], { naar: user.email });
        return res.status(m.ok ? 200 : 502).json(m.ok ? { ok: true, naar: m.naar } : { error: 'Testmail niet verstuurd: ' + m.fout });
      }

      if (b.actie === 'tekst') {
        if (!SOORTEN.includes(b.soort)) return res.status(400).json({ error: 'Onbekende soort.' });
        const onderwerp = String(b.onderwerp || '').trim().slice(0, 200);
        const tekst = String(b.tekst || '').replace(/\r\n/g, '\n').trim().slice(0, 5000);
        if (!onderwerp || !tekst) return res.status(400).json({ error: 'Onderwerp en tekst zijn verplicht.' });
        const ruw = bewerkTekst(await leesRuweInstellingen(d.db), b.soort, { onderwerp, tekst }, door);
        await bewaarInstellingen(d.db, ruw, user.id);
        return res.status(200).json({ ok: true, instellingen: normaliseerInstellingen(ruw) });
      }

      //  Vanaf hier: alleen wie mag goedkeuren.
      if (!(await d.mag(req, RECHT_GOEDKEUREN))) return res.status(403).json({ error: `Geen rechten (${RECHT_GOEDKEUREN})` });

      if (b.actie === 'goedkeuren') {
        if (!SOORTEN.includes(b.soort)) return res.status(400).json({ error: 'Onbekende soort.' });
        const oud = await leesRuweInstellingen(d.db);
        const ruw = keurGoed(oud, b.soort, normaliseerInstellingen(oud).teksten[b.soort], door);
        await bewaarInstellingen(d.db, ruw, user.id);
        return res.status(200).json({ ok: true, instellingen: normaliseerInstellingen(ruw) });
      }

      if (b.actie === 'schakelaar') {
        const ruw = await leesRuweInstellingen(d.db);
        const aan = b.aan === true;
        const nieuw = { ...ruw, aan, aan_op: aan ? new Date().toISOString() : null, aan_door: aan ? door : null };
        await bewaarInstellingen(d.db, nieuw, user.id);
        console.log('[onboarding-herinneringen] hoofdschakelaar', aan ? 'AAN' : 'UIT', 'door', door);
        return res.status(200).json({ ok: true, instellingen: normaliseerInstellingen(nieuw) });
      }

      if (b.actie === 'oude_dossiers') {
        if (b.bevestiging !== BEVESTIGING) return res.status(400).json({ error: `Typ ${BEVESTIGING} om te bevestigen.` });
        const inst = await leesInstellingen(d.db);
        if (!inst.aan) return res.status(409).json({ error: 'De hoofdschakelaar staat uit.' });
        if (!inst.teksten.laatste.goedgekeurd) return res.status(409).json({ error: 'De tekst "Laatste herinnering" is nog niet goedgekeurd.' });
        const { log, oudeDossiers } = await planHerinneringen({ db: d.db, lms: d.lms(), rijen: await d.rijen(), vandaag });
        if (log === null) return res.status(503).json({ error: 'Het logboek ontbreekt: draai eerst 2026-10-28-onboarding-opvolgflow.sql.' });
        const verstuurd = [];
        const mislukt = [];
        for (const o of oudeDossiers) {
          if (o.besluit.actie !== 'laatste_mail') continue;
          try {
            if (!(await claim(d.db, o.rij.id, 'laatste'))) continue;
            const m = await stuurHerinnering(d.db, o.rij, inst.teksten.laatste);
            await markeer(d.db, o.rij.id, 'laatste', m.ok
              ? { status: 'verstuurd', naar: m.naar }
              : { status: 'mislukt', naar: m.naar || null, fout: String(m.fout || m.overgeslagen || '').slice(0, 300) });
            (m.ok ? verstuurd : mislukt).push({ ...kort(o.rij), fout: m.ok ? null : (m.fout || m.overgeslagen) });
          } catch (e) {
            mislukt.push({ ...kort(o.rij), fout: e?.message || String(e) });
          }
        }
        console.log('[onboarding-herinneringen] oude dossiers', { door, verstuurd: verstuurd.length, mislukt: mislukt.length });
        return res.status(200).json({ ok: true, verstuurd, mislukt });
      }

      return res.status(400).json({ error: 'Onbekende actie.' });
    } catch (e) {
      console.error('[onboarding-herinneringen]', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  };
}

export default maakHandler();

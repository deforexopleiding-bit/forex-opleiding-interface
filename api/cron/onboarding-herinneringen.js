// api/cron/onboarding-herinneringen.js
//
// Dagelijkse cron (08:05 UTC ≈ 09:05/10:05 in Brussel) — de onboarding-
// herinneringen per mail, het signaal "geen reactie" en het afronden van oude
// dossiers (Maxim, 28 okt 2026). De regels: api/_lib/onboarding-herinneringen.js.
//
// DRIE SLOTEN VÓÓR ER IETS VERTREKT
//   1. De hoofdschakelaar (app_settings onboarding_herinneringen.aan) —
//      standaard UIT. Uit = deze cron doet niets (behalve met ?dry=1).
//   2. De tekst van DIE soort is goedgekeurd (exact die tekst).
//   3. Het logboek (onboarding_herinneringen): één rij per (onboarding,
//      soort), eerst geclaimd, dan pas gemaild. Zonder logboek (migratie niet
//      gedraaid) vertrekt er niets.
//
// ?dry=1 → de lijst van vandaag, ook met de schakelaar uit; nul schrijfacties,
// nul mails. AUTH: Authorization: Bearer ${CRON_SECRET}.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from '../_lib/dfo-lms-db.js';
import { bouwOverzichtRijen } from '../_lib/onboarding-overzicht-rijen.js';
import { dagBrussel, sluitAutomatischAf, heeftRedenKolom, REDEN_OUD_DOSSIER } from '../_lib/onboarding-auto-afronden.js';
import { SIGNAAL } from '../_lib/onboarding-herinneringen.js';
import {
  leesInstellingen, planHerinneringen, claim, markeer, stuurHerinnering, zetSignaalGeenReactie,
} from '../_lib/onboarding-herinneringen-server.js';

function tel(map, k) { map[k] = (map[k] || 0) + 1; }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET || null;
  if (!secret || (req.headers['authorization'] || '') !== 'Bearer ' + secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const dry = req.query?.dry === '1' || req.query?.dry === 'true';
  const vandaag = dagBrussel();
  const uit = { ok: true, dry, vandaag, gemaild: [], signalen: [], afgerond: [], overgeslagen: {}, fouten: [] };

  try {
    const inst = await leesInstellingen(supabaseAdmin);
    uit.aan = inst.aan;
    if (!inst.aan && !dry) return res.status(200).json({ ...uit, reden: 'hoofdschakelaar uit' });

    const rijen = await bouwOverzichtRijen({ scope: 'active' });
    const { log, plan, oudeDossiers, oude } = await planHerinneringen({ db: supabaseAdmin, lms: getDfoLmsClient(), rijen, vandaag });
    uit.oude_automation_aan = oude.aan;
    if (log === null && !dry) {
      return res.status(200).json({ ...uit, ok: false, reden: 'logboek ontbreekt — migratie 2026-10-28-onboarding-opvolgflow.sql nog niet gedraaid; er vertrekt niets' });
    }
    const lms = getDfoLmsClient();

    for (const { rij: r, besluit: b, overgenomen } of plan) {
      try {
        if (b.actie === 'niets') { tel(uit.overgeslagen, b.waarom); continue; }
        //  De mail van de oude automation telt als herinnering_1: leg ze vast.
        if (overgenomen && !dry) {
          if (await claim(supabaseAdmin, r.id, 'herinnering_1')) {
            await markeer(supabaseAdmin, r.id, 'herinnering_1', { status: 'overgenomen', aangemaakt_op: overgenomen.aangemaakt_op });
          }
        }
        if (b.actie === 'signaal') {
          if (dry) { uit.signalen.push({ id: r.id, klant: r.customer_name }); continue; }
          if (!(await claim(supabaseAdmin, r.id, SIGNAAL))) { tel(uit.overgeslagen, 'signaal_al_geclaimd'); continue; }
          const s = await zetSignaalGeenReactie(lms, r);
          await markeer(supabaseAdmin, r.id, SIGNAAL, { status: s.al_open ? 'overgenomen' : 'verstuurd', naar: 'administratie' });
          uit.signalen.push({ id: r.id, klant: r.customer_name, al_open: !!s.al_open });
          continue;
        }
        //  Een mail.
        const tekst = inst.teksten[b.soort];
        if (!tekst?.goedgekeurd) { tel(uit.overgeslagen, 'tekst_niet_goedgekeurd:' + b.soort); continue; }
        if (dry) { uit.gemaild.push({ id: r.id, klant: r.customer_name, soort: b.soort }); continue; }
        if (!(await claim(supabaseAdmin, r.id, b.soort))) { tel(uit.overgeslagen, 'al_geclaimd'); continue; }
        const m = await stuurHerinnering(supabaseAdmin, r, tekst);
        if (m.ok) {
          await markeer(supabaseAdmin, r.id, b.soort, { status: 'verstuurd', naar: m.naar });
          uit.gemaild.push({ id: r.id, klant: r.customer_name, soort: b.soort });
        } else {
          await markeer(supabaseAdmin, r.id, b.soort, { status: 'mislukt', naar: m.naar || null, fout: (m.fout || m.overgeslagen || '').slice(0, 300) });
          if (m.overgeslagen) tel(uit.overgeslagen, m.overgeslagen);
          else uit.fouten.push({ id: r.id, soort: b.soort, fout: m.fout });
        }
      } catch (e) {
        const msg = (e?.message || String(e)).slice(0, 300);
        console.error('[onboarding-herinneringen]', r.id, msg);
        uit.fouten.push({ id: r.id, fout: msg });
      }
    }

    //  Oude dossiers: 7 dagen na de laatste herinnering nog altijd niet
    //  ingevuld → automatisch afronden (reden oud_dossier) → check-in-doelgroep.
    const metReden = dry ? false : await heeftRedenKolom(supabaseAdmin);
    for (const { rij: r, besluit: b } of oudeDossiers) {
      if (b.actie !== 'afronden') continue;
      try {
        if (dry) { uit.afgerond.push({ id: r.id, klant: r.customer_name }); continue; }
        if (await sluitAutomatischAf(supabaseAdmin, r, REDEN_OUD_DOSSIER, { metReden })) {
          uit.afgerond.push({ id: r.id, klant: r.customer_name });
          console.log('[onboarding-herinneringen] oud dossier afgerond:', r.id, r.customer_name || '');
          const { spiegelNaActie } = await import('../_lib/onboarding-spiegel.js');
          await spiegelNaActie(r.id, 'onboarding-herinneringen');
        }
      } catch (e) {
        uit.fouten.push({ id: r.id, fout: (e?.message || String(e)).slice(0, 300) });
      }
    }
    console.log('[onboarding-herinneringen]', JSON.stringify({ dry, gemaild: uit.gemaild.length, signalen: uit.signalen.length, afgerond: uit.afgerond.length, fouten: uit.fouten.length }));
    return res.status(200).json(uit);
  } catch (e) {
    console.error('[onboarding-herinneringen]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

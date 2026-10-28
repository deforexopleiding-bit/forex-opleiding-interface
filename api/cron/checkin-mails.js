// api/cron/checkin-mails.js
//
// Elke 10 minuten — de check-in per mail (Maxim, 28 okt 2026): de uitnodiging
// voor wie in een LIVE campagne zit, en een herinnering na 5 en 10 dagen voor
// wie nog niet verstuurde. Regels: api/_lib/checkin-mails.js.
//
// Vier sloten: campagne live (de Run die Maxim zelf indrukt) · hoofdschakelaar
// app_settings checkin_mails.aan (standaard UIT) · exact deze tekst
// goedgekeurd · logboek checkin_mails (eerst claimen, dan mailen).
// Per loop hoogstens MAX_PER_LOOP mails (de rest de volgende loop): zo blijft
// een Run van ~270 studenten binnen de tijdslimiet en spreiden de mails zich.
//
// ?dry=1 → het plan, ook met de schakelaar uit; niets gemaild, niets geschreven.
// AUTH: Authorization: Bearer ${CRON_SECRET}.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from '../_lib/dfo-lms-db.js';
import { dagBrussel } from '../_lib/onboarding-auto-afronden.js';
import { leesInstellingen, planCheckinMails, claim, markeer, stuurCheckinMail } from '../_lib/checkin-mails-server.js';

export const MAX_PER_LOOP = 40;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET || null;
  if (!secret || (req.headers['authorization'] || '') !== 'Bearer ' + secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const dry = req.query?.dry === '1' || req.query?.dry === 'true';
  const vandaag = dagBrussel();
  const uit = { ok: true, dry, vandaag, gemaild: 0, gepland: {}, overgeslagen: {}, fouten: [] };
  try {
    const inst = await leesInstellingen(supabaseAdmin);
    uit.aan = inst.aan;
    if (!inst.aan && !dry) return res.status(200).json({ ...uit, reden: 'hoofdschakelaar uit' });
    const { log, plan, campagnes, genegeerd } = await planCheckinMails({ db: supabaseAdmin, lms: getDfoLmsClient(), vandaag });
    uit.campagnes = campagnes.map((c) => c.slug);
    uit.genegeerd = genegeerd;
    if (log === null && !dry) return res.status(200).json({ ...uit, ok: false, reden: 'logboek ontbreekt — migratie 2026-10-28-checkin-mails.sql nog niet gedraaid; er vertrekt niets' });

    for (const p of plan) {
      const b = p.besluit;
      if (b.actie !== 'mail') { uit.overgeslagen[b.waarom] = (uit.overgeslagen[b.waarom] || 0) + 1; continue; }
      const tekst = inst.teksten[b.soort];
      if (!tekst?.goedgekeurd) { uit.overgeslagen['tekst_niet_goedgekeurd:' + b.soort] = (uit.overgeslagen['tekst_niet_goedgekeurd:' + b.soort] || 0) + 1; continue; }
      uit.gepland[b.soort] = (uit.gepland[b.soort] || 0) + 1;
      if (dry) continue;
      if (uit.gemaild >= MAX_PER_LOOP) continue;
      try {
        if (!(await claim(supabaseAdmin, p.toewijzing.id, b.soort, p.campagne.id))) continue;
        const m = await stuurCheckinMail(tekst, { naar: p.student?.email, voornaam: p.student?.voornaam, code: p.toewijzing.code });
        await markeer(supabaseAdmin, p.toewijzing.id, b.soort, m.ok
          ? { status: 'verstuurd', naar: m.naar }
          : { status: 'mislukt', naar: m.naar || null, fout: String(m.fout || m.overgeslagen || '').slice(0, 300) });
        if (m.ok) uit.gemaild++;
        else uit.fouten.push({ toewijzing: p.toewijzing.id, soort: b.soort, fout: m.fout || m.overgeslagen });
      } catch (e) {
        uit.fouten.push({ toewijzing: p.toewijzing.id, fout: (e?.message || String(e)).slice(0, 300) });
      }
    }
    console.log('[checkin-mails]', JSON.stringify({ dry, gemaild: uit.gemaild, gepland: uit.gepland, fouten: uit.fouten.length }));
    return res.status(200).json(uit);
  } catch (e) {
    console.error('[checkin-mails]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

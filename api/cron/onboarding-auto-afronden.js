// api/cron/onboarding-auto-afronden.js
//
// Dagelijkse cron (07:10 UTC, na onboarding-eerste-sessie-afronden) — sluit
// een MEMBERSHIP-onboarding automatisch af zodra de startdatum bereikt is
// (kalenderdag in Brussel) en de klant de onboarding zelf invulde (Maxim, 28
// okt 2026). 1-op-1 sluit op de eerste sessie; dat doet de cron hiervoor al.
// De regel staat in api/_lib/onboarding-auto-afronden.js.
//
// IDEMPOTENT: de update raakt alleen een rij zonder auto_afgerond_op en zonder
// handmatig_afgerond_op; een tweede loop vindt niets meer.
// GEEN VLOEDGOLF: dit is een toestandsregel (start voorbij + ingevuld), geen
// gebeurtenis. Eerste loop = wie vandaag al aan de regel voldoet; meet vooraf
// met ?dry=1 (nul schrijfacties, zelfde logica).
//
// Na elke afsluiting de spiegel naar het LMS (faalzacht; de hersync van
// morgen herstelt een misser). Geen mail, geen WhatsApp.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}.
// Response: { ok, dry, vandaag, bekeken, afgerond:[{id, klant, start}], overgeslagen:{waarom:n}, fouten:[] }

import { supabaseAdmin } from '../supabase.js';
import {
  besluitMembershipAfronden, dagBrussel, heeftRedenKolom, sluitAutomatischAf, REDEN_MEMBERSHIP,
} from '../_lib/onboarding-auto-afronden.js';

const KOLOMMEN = 'id, customer_name, status, traject_id, start_date, completed_at, archived_at, is_test, '
  + 'auto_afgerond_op, handmatig_afgerond_op, incasso_op, incasso_terug_op';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET || null;
  if (!secret || (req.headers['authorization'] || '') !== 'Bearer ' + secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const dry = req.query?.dry === '1' || req.query?.dry === 'true';
  const vandaag = dagBrussel();
  const uit = { ok: true, dry, vandaag, bekeken: 0, afgerond: [], overgeslagen: {}, fouten: [] };

  try {
    const { data: trajecten, error: tErr } = await supabaseAdmin
      .from('onboarding_trajecten').select('id, type').eq('type', 'membership');
    if (tErr) throw new Error('trajecten: ' + tErr.message);
    const ids = (trajecten || []).map((t) => t.id);
    if (!ids.length) return res.status(200).json({ ...uit, reden: 'geen membership-trajecten' });

    //  Kandidaten: membership, wizard voltooid, nog niet dicht, start vandaag of eerder.
    const { data: rijen, error } = await supabaseAdmin
      .from('onboardings')
      .select(KOLOMMEN)
      .in('traject_id', ids)
      .eq('status', 'afgerond')
      .is('auto_afgerond_op', null)
      .is('handmatig_afgerond_op', null)
      .is('archived_at', null)
      .lte('start_date', vandaag)
      .limit(1000);
    if (error) throw new Error('onboardings: ' + error.message);

    const metReden = dry ? false : await heeftRedenKolom(supabaseAdmin);
    for (const ob of rijen || []) {
      uit.bekeken++;
      try {
        const b = besluitMembershipAfronden(ob, 'membership', vandaag);
        if (!b.dicht) {
          uit.overgeslagen[b.waarom] = (uit.overgeslagen[b.waarom] || 0) + 1;
          continue;
        }
        if (dry) {
          uit.afgerond.push({ id: ob.id, klant: ob.customer_name, start: ob.start_date });
          continue;
        }
        const gedaan = await sluitAutomatischAf(supabaseAdmin, ob, REDEN_MEMBERSHIP, { metReden });
        if (!gedaan) {
          uit.overgeslagen.al_afgerond = (uit.overgeslagen.al_afgerond || 0) + 1;
          continue;
        }
        uit.afgerond.push({ id: ob.id, klant: ob.customer_name, start: ob.start_date });
        console.log('[onboarding-auto-afronden] afgerond (membership, start ' + ob.start_date + '):', ob.id, ob.customer_name || '');
        const { spiegelNaActie } = await import('../_lib/onboarding-spiegel.js');
        await spiegelNaActie(ob.id, 'onboarding-auto-afronden');
      } catch (e) {
        const msg = (e?.message || String(e)).slice(0, 300);
        console.error('[onboarding-auto-afronden] rij', ob.id, msg);
        uit.fouten.push({ id: ob.id, fout: msg });
      }
    }
    if (!metReden && !dry && uit.afgerond.length) {
      console.warn('[onboarding-auto-afronden] auto_afgerond_reden ontbreekt — migratie 2026-10-28-onboarding-opvolgflow.sql nog niet gedraaid; de reden is niet bewaard.');
    }
    return res.status(200).json(uit);
  } catch (e) {
    console.error('[onboarding-auto-afronden]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

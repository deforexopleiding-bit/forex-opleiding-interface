// api/contentmachine/data.js
//
// Contentmachine 2.0 (bouwopdracht §6) — GET → de cijfers per drop voor het overzicht en het
// statusbord: bezoekers, leads, conversie, calls en per kanaal (src), uit dezelfde bron als de
// module Trainingdrops (api/_lib/trainingdrops-laden.js), plus de top-3 meest gebruikte blokken
// van de Weekeditie (funnel_events blok_bekeken / quiz_antwoord / slider_gebruikt / replay_gestart).
//
// Response: { drops: { [slug]: { bezoekers, leads, conversie_pct, calls, calls_gehouden,
//   cadeau_klik, kanalen:[{kanaal,label,bezoekers,leads,calls}], top_blokken:[{type,bekeken,gebruikt,pct}] } },
//   meta: { tracking_actief, afgekapt, blok_events, leesfout } }
// Enkel lezen. Recht: content.machine (poort).

import { supabaseAdmin } from '../supabase.js';
import { poort } from '../_lib/contentmachine-http.js';
import { laadTrainingdrops } from '../_lib/trainingdrops-laden.js';
import { dataPerDrop, BLOK_EVENTS } from '../_lib/weekeditie-data.js';
import { TRAINING_BRON_PREFIXEN } from '../_lib/training-bron.js';

const MAX_BLOK_EVENTS = 30000;

async function leesBlokEvents(db) {
  const rijen = [];
  for (const prefix of TRAINING_BRON_PREFIXEN) {
    let laatste = null;
    for (;;) {
      let q = db.from('funnel_events').select('id,session_id,variant,event_type,vraag_id').like('variant', prefix + '%').in('event_type', BLOK_EVENTS);
      if (laatste != null) q = q.gt('id', laatste);
      const { data, error } = await q.order('id', { ascending: true }).limit(1000);
      if (error) return { rijen, fout: error.message || String(error) };
      rijen.push(...(data || []));
      if (!data || data.length < 1000 || rijen.length >= MAX_BLOK_EVENTS) break;
      laatste = data[data.length - 1].id;
    }
  }
  return { rijen, fout: null };
}

export default async function handler(req, res) {
  const p = await poort(req, res, { methodes: ['GET'] });
  if (!p) return;
  try {
    const db = supabaseAdmin;
    const [t, b] = await Promise.all([laadTrainingdrops(db, { tijdbudgetMs: 15000 }), leesBlokEvents(db)]);
    if (b.fout) console.error('[contentmachine/data] blok-events:', b.fout);
    return res.status(200).json({
      drops: dataPerDrop(t.drops, b.rijen),
      meta: { tracking_actief: t.meta.tracking_actief, afgekapt: t.meta.afgekapt, blok_events: b.rijen.length, leesfout: t.meta.leesfout || b.fout || null, calls_fout: t.meta.calls_fout },
    });
  } catch (e) {
    console.error('[contentmachine/data] fout:', e?.message || e);
    return res.status(500).json({ error: 'Cijfers laden mislukt', detail: e?.message || null });
  }
}

// api/cron-weekeditie-lancering.js
//
// Contentmachine 2.0, fase 5 — cron (elke minuut): de nieuwsbrief van een gelanceerde Weekeditie
// naar de lijst, via de verzendtag waarop de GHL-workflow "DFO Weekeditie versturen" mailt.
//   1. loopt er een lancering (status 'taggen')? → verder taggen tot het tijdsbudget op is;
//   2. anders de eerstvolgende ingeplande lancering die aan de beurt is: controleren dat de
//      drop niet meer gewijzigd is (zelfde versie, nog goedgekeurd/gepubliceerd), dan de vaste
//      template + het onderwerp bijwerken en beginnen met taggen.
// Altijd maar ÉÉN lancering tegelijk: de template in GHL is één vaste template.
// Elk contact wordt geclaimd vóór het taggen (nooit dubbel); zie api/_lib/weekeditie-lancering.js.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { ghlNieuwsbriefConfig } from './_lib/ghl-nieuwsbrief.js';
import { leesInstellingen, verwerkLancering, LANCERING_KOLOMMEN } from './_lib/weekeditie-lancering.js';
import { bereidGhlVoor } from './contentmachine/lanceer.js';

export const BUDGET_MS = 48000;

export default async function handler(req, res) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const db = supabaseAdmin;
  const deadline = Date.now() + BUDGET_MS;
  const nu = () => new Date().toISOString();
  const markeer = async (id, patch) => {
    const { error } = await db.from('weekeditie_lanceringen').update({ ...patch, gewijzigd_op: nu() }).eq('id', id);
    if (error) console.error('[cron-weekeditie-lancering] status bewaren mislukt:', error.message);
  };
  try {
    const cfg = ghlNieuwsbriefConfig();
    let { data: lopend, error } = await db.from('weekeditie_lanceringen').select(LANCERING_KOLOMMEN).eq('status', 'taggen').order('gestart_op', { ascending: true }).limit(1);
    if (error) throw error;
    let l = lopend && lopend[0];
    if (!l) {
      const r = await db.from('weekeditie_lanceringen').select(LANCERING_KOLOMMEN).eq('status', 'ingepland').lte('ingepland_op', nu()).order('ingepland_op', { ascending: true }).limit(1);
      if (r.error) throw r.error;
      l = r.data && r.data[0];
      if (!l) return res.status(200).json({ ok: true, niets: true });
      const { data: drop, error: dErr } = await db.from('content_drops').select('*').eq('id', l.drop_id).maybeSingle();
      if (dErr) throw dErr;
      if (!drop || drop.versie !== l.drop_versie || !['goedgekeurd', 'gepubliceerd'].includes(drop.status)) {
        await markeer(l.id, { status: 'geannuleerd', fout: 'De drop werd na het inplannen gewijzigd of offline gehaald; lanceer opnieuw.' });
        return res.status(200).json({ ok: true, geannuleerd: l.id });
      }
      if (!cfg.ok) { await markeer(l.id, { status: 'mislukt', fout: `GHL niet gekoppeld (ontbreekt: ${cfg.ontbreekt.join(', ')})` }); return res.status(200).json({ ok: false, mislukt: l.id }); }
      try {
        const inst = await leesInstellingen(db);
        const v = await bereidGhlVoor(db, cfg, drop, l, inst);
        const { data, error: uErr } = await db.from('weekeditie_lanceringen').update({ onderwerp: v.onderwerp, status: 'taggen', gestart_op: nu(), gewijzigd_op: nu() }).eq('id', l.id).eq('status', 'ingepland').select(LANCERING_KOLOMMEN);
        if (uErr) throw uErr;
        if (!data || !data.length) return res.status(200).json({ ok: true, al_geclaimd: l.id });
        l = data[0];
      } catch (e) {
        console.error('[cron-weekeditie-lancering] voorbereiden mislukt:', e?.code || '', e?.message || e);
        await markeer(l.id, { status: 'mislukt', fout: String(e?.message || e).slice(0, 500) });
        return res.status(200).json({ ok: false, mislukt: l.id });
      }
    }
    if (!cfg.ok) return res.status(200).json({ ok: false, fout: 'GHL niet gekoppeld' });
    const na = await verwerkLancering(db, cfg, l, { deadline });
    console.log('[cron-weekeditie-lancering]', na.id, na.status, `getagd ${na.getagd}/${na.totaal ?? '?'}`, `overgeslagen ${na.overgeslagen}`, `mislukt ${na.mislukt}`);
    return res.status(200).json({ ok: true, lancering: { id: na.id, status: na.status, getagd: na.getagd, totaal: na.totaal, overgeslagen: na.overgeslagen, mislukt: na.mislukt } });
  } catch (e) {
    console.error('[cron-weekeditie-lancering] fout:', e?.code || '', e?.message || e);
    return res.status(500).json({ error: e?.message || 'fout' });
  }
}

// api/support-aanwezigheid.js
//
// GET  — wie staat er nu aan, en is er live bemensing?
// POST — zet jezelf aan of uit, of stuur een hartslag.
//
// De hartslag is het hele punt van deze tabel. Een vinkje "ik ben
// beschikbaar" blijft aanstaan als iemand z'n laptop dichtklapt, en dan
// belooft de widget een live chat waar niemand zit. Daarom stuurt de
// CRM-module elke minuut een POST met dezelfde stand, en telt een
// medewerker alleen mee zolang die hartslag vers is
// (HARTSLAG_VENSTER_MS in api/_lib/support-beschikbaarheid.js).

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';
import { haalBeschikbaarheid, HARTSLAG_VENSTER_MS } from './_lib/support-beschikbaarheid.js';

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, ['GET', 'POST'])) return;

  const staff = await staffUit(req, res, 'support.reply');
  if (!staff) return;

  if (req.method === 'POST') {
    const beschikbaar = req.body?.beschikbaar === true;
    const nu = new Date().toISOString();
    try {
      // sinds alleen zetten bij het áánzetten, zodat "al 40 minuten online"
      // klopt en niet elke hartslag op nul springt.
      const { data: bestaand } = await supabaseAdmin
        .from('support_aanwezigheid').select('beschikbaar, sinds')
        .eq('user_id', staff.user.id).maybeSingle();

      const sinds = beschikbaar
        ? (bestaand?.beschikbaar && bestaand?.sinds ? bestaand.sinds : nu)
        : null;

      const { error } = await supabaseAdmin
        .from('support_aanwezigheid')
        .upsert({ user_id: staff.user.id, beschikbaar, sinds, bijgewerkt_op: nu }, { onConflict: 'user_id' });
      if (error) throw new Error(error.message);
    } catch (e) {
      console.error('[support-aanwezigheid] opslaan mislukt:', e?.message || e);
      return res.status(500).json({ error: 'Kon je aanwezigheid niet opslaan.' });
    }
  }

  try {
    const sinds = new Date(Date.now() - HARTSLAG_VENSTER_MS).toISOString();
    const [{ data: eigen }, { data: online }, beschikbaarheid] = await Promise.all([
      supabaseAdmin.from('support_aanwezigheid').select('beschikbaar, sinds')
        .eq('user_id', staff.user.id).maybeSingle(),
      supabaseAdmin.from('support_aanwezigheid').select('user_id, sinds')
        .eq('beschikbaar', true).gte('bijgewerkt_op', sinds),
      haalBeschikbaarheid(),
    ]);

    const ids = (online || []).map((o) => o.user_id);
    let namen = [];
    if (ids.length) {
      const { data: profs } = await supabaseAdmin
        .from('profiles').select('id, full_name').in('id', ids);
      namen = (profs || []).map((p) => p.full_name).filter(Boolean);
    }

    return res.status(200).json({
      ik_sta_aan: !!eigen?.beschikbaar,
      sinds: eigen?.sinds || null,
      online_namen: namen,
      live: !!beschikbaarheid.live,
      binnen_kantooruren: !!beschikbaarheid.binnen_kantooruren,
      bereikbaarheid: beschikbaarheid.label || null,
    });
  } catch (e) {
    console.error('[support-aanwezigheid] lezen mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Kon de aanwezigheid niet ophalen.' });
  }
}

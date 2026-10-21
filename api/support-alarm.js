// api/support-alarm.js
//
// GET → { chats, teller, instellingen } — welke supportchats wachten NU op
// een mens, voor de rinkelende balk bovenaan elke CRM-pagina
// (modules/klanten-v2/support-alarm.js).
//
// Alleen voor wie mag antwoorden (support.reply). De regel wat "onbeantwoord"
// is staat in api/_lib/support-alarm.js (alarmLijst) — één plek, getest.
//
// Licht gehouden: de balk vraagt dit op bij elke realtime-wijziging op
// support_gesprekken en daarnaast elke 20 seconden als vangnet. Twee kleine
// queries, geen tellers of joins.

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';
import { alarmLijst, wachtOpOns, haalAlarmInstellingen, isTestGesprek, MIN } from './_lib/support-alarm.js';

// Een gesprek in de wachtrij dat langer dan dit stil ligt, is geen live chat
// meer maar achterstallig werk; dat staat in de module zelf.
const TERUGBLIK_DAGEN = 30;

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, 'GET')) return;

  const staff = await staffUit(req, res, 'support.reply');
  if (!staff) return;

  const nu = Date.now();
  try {
    const cfg = await haalAlarmInstellingen();
    const grens = new Date(nu - TERUGBLIK_DAGEN * 24 * 60 * MIN).toISOString();
    const { data: rijen, error } = await supabaseAdmin
      .from('support_gesprekken')
      .select('id, kenmerk, soort, onderwerp, status, naam, email, toegewezen_aan, toegewezen_op, '
        + 'laatste_klant_bericht_op, laatste_ons_bericht_op, created_at')
      .neq('status', 'afgehandeld')
      .gte('laatste_klant_bericht_op', grens)
      .order('laatste_klant_bericht_op', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);

    const kandidaten = (rijen || []).filter((g) => wachtOpOns(g, nu));
    let berichten = [];
    if (kandidaten.length) {
      const { data, error: bFout } = await supabaseAdmin
        .from('support_berichten')
        .select('gesprek_id, tekst, created_at')
        .in('gesprek_id', kandidaten.map((g) => g.id))
        .eq('afzender', 'klant')
        .gte('created_at', grens)
        .order('created_at', { ascending: false })
        .limit(400);
      if (bFout) throw new Error(bFout.message);
      berichten = data || [];
    }

    const testIds = new Set(kandidaten.filter(isTestGesprek).map((g) => g.id));
    const chats = alarmLijst(kandidaten, berichten, { nu, userId: staff.user.id, cfg })
      .map((c) => ({ ...c, test: testIds.has(c.id) }));

    return res.status(200).json({
      nu: new Date(nu).toISOString(),
      chats,
      teller: chats.length,
      instellingen: {
        geluid: cfg.geluid,
        interval_s: cfg.interval_s,
        escalatie_min: cfg.escalatie_min,
      },
      ik: staff.user.id,
    });
  } catch (e) {
    console.error('[support-alarm] mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Kon de chatmeldingen niet ophalen.' });
  }
}

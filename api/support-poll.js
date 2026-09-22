// api/support-poll.js
//
// GET — heeft er iemand van ons geantwoord sinds het laatste bericht dat de
// widget al had?
//
// Polling en geen websocket, om dezelfde reden als in de rest van dit
// project: er is al een werkend poll-patroon (inbox-v2 doet 18 s,
// finance.html 6 s) en een tweede realtime-mechanisme erbij bouwen voor een
// chat die per gesprek een paar berichten heeft, is complexiteit zonder
// opbrengst. De widget pollt elke 5 seconden zolang het venster openstaat en
// stopt zodra het dicht of verborgen is.
//
// `sinds` is een ISO-tijdstempel, geen bericht-id: dan hoeft de widget niets
// bij te houden behalve het tijdstip van het laatste bericht dat 'ie kent.

import { supabaseAdmin } from './supabase.js';
import { applySupportCors, handledPreflight } from './_lib/support-cors.js';
import { tokenUitRequest, gesprekUitToken, publiekBericht, publiekGesprek } from './_lib/support-sessie.js';
import { haalBeschikbaarheid } from './_lib/support-beschikbaarheid.js';

export default async function handler(req, res) {
  applySupportCors(req, res, 'GET, OPTIONS');
  if (handledPreflight(req, res, 'GET')) return;

  const gesprek = await gesprekUitToken(tokenUitRequest(req));
  if (!gesprek) return res.status(401).json({ error: 'Onbekende sessie' });

  // volledig=1 haalt de hele thread op inclusief de eigen berichten. Dat is
  // wat de widget na een refresh nodig heeft om het gesprek terug te zetten;
  // bij gewoon pollen is het zonde van de bandbreedte.
  const volledig = req.query?.volledig === '1';
  const sindsRaw = String(req.query?.sinds || '');
  const sinds = Number.isFinite(Date.parse(sindsRaw))
    ? new Date(Date.parse(sindsRaw)).toISOString()
    : new Date(Date.now() - 60 * 60 * 1000).toISOString();

  let berichten = [];
  try {
    const { data, error } = await supabaseAdmin
      .from('support_berichten')
      .select('id, afzender, tekst, meta, created_at')
      .eq('gesprek_id', gesprek.id)
      .gt('created_at', volledig ? new Date(0).toISOString() : sinds)
      .order('created_at', { ascending: true })
      .limit(volledig ? 200 : 50);
    if (error) throw new Error(error.message);
    // Bij gewoon pollen alleen wat de bezoeker nog niet heeft: zijn eigen
    // berichten kreeg 'ie al terug bij het versturen.
    berichten = (data || [])
      .filter((b) => volledig || b.afzender !== 'klant')
      .map(publiekBericht);
  } catch (e) {
    console.warn('[support-poll] lezen mislukt:', e?.message || e);
    return res.status(200).json({ berichten: [], status: gesprek.status });
  }

  const beschikbaarheid = await haalBeschikbaarheid();

  return res.status(200).json({
    berichten,
    status: gesprek.status,
    gesprek: publiekGesprek(gesprek),
    live: !!beschikbaarheid.live,
  });
}

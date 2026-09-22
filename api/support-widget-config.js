// api/support-widget-config.js
//
// GET — wat de widget moet weten vóór iemand iets intypt: staat support aan,
// welke onderwerpen zijn er, en zit er nu iemand aan de chat.
//
// Geen auth: dit is de eerste call vanaf een publieke pagina. Er staat dan
// ook niets in dit antwoord wat niet op de website zelf had mogen staan —
// geen namen van medewerkers, geen aantallen, alleen ja of nee.
//
// Cache: 30 seconden publiek. Kort genoeg dat "er is nu iemand" klopt,
// lang genoeg dat een drukke pagina niet elke bezoeker een databasequery kost.

import { supabaseAdmin } from './supabase.js';
import { applySupportCors, handledPreflight } from './_lib/support-cors.js';
import { haalBeschikbaarheid, beschikbaarheidsTekst } from './_lib/support-beschikbaarheid.js';

const ONDERWERPEN = {
  klant: [
    { id: 'lms',        label: 'Toegang tot het LMS',      hint: 'Inloggen lukt niet, ik zie mijn lessen niet' },
    { id: 'discord',    label: 'Discord',                  hint: 'Uitnodiging kwijt, kom er niet in' },
    { id: 'traject',    label: 'Mijn traject en mentor',   hint: 'Sessies, mentor, planning' },
    { id: 'financieel', label: 'Facturen en betalen',      hint: 'Betalingsafspraak, factuur, abonnement' },
    { id: 'overig',     label: 'Iets anders',              hint: '' },
  ],
  bezoeker: [
    { id: 'informatie',   label: 'Informatie over de opleiding', hint: 'Werkwijze, mentorship, membership' },
    { id: 'call',         label: 'Een gesprek inplannen',        hint: 'Kennismaking met Dave' },
    { id: 'event',        label: 'Events en masterclasses',      hint: 'Wat is er, wanneer, waar' },
    { id: 'inschrijving', label: 'Mijn inschrijving',            hint: 'Wijzigen of annuleren' },
    { id: 'overig',       label: 'Iets anders',                  hint: '' },
  ],
};

export default async function handler(req, res) {
  applySupportCors(req, res, 'GET, OPTIONS');
  if (handledPreflight(req, res, 'GET')) return;

  let widget = {};
  try {
    const { data } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'support_widget')
      .maybeSingle();
    widget = data?.value || {};
  } catch (e) {
    console.warn('[support-widget-config] instellingen lezen mislukt:', e?.message || e);
  }

  // Uit is uit. Zonder rij in app_settings staat de widget standaard uit:
  // liever geen widget dan een widget die niemand heeft aangezet.
  if (widget.aan !== true) {
    return res.status(200).json({ aan: false });
  }

  const beschikbaarheid = await haalBeschikbaarheid();

  res.setHeader('Cache-Control', 'public, max-age=30');
  return res.status(200).json({
    aan: true,
    titel: widget.titel || 'Hulp nodig?',
    welkom: widget.welkom || 'Stel je vraag — vaak heb je binnen een minuut antwoord.',
    onderwerpen: ONDERWERPEN,
    live: !!beschikbaarheid.live,
    bereikbaarheid: beschikbaarheid.label || null,
    wachtrij_tekst: beschikbaarheidsTekst(beschikbaarheid, widget.antwoord_mailbox),
    links: {
      agenda: widget.agenda_url || null,
      events: widget.events_url || null,
    },
  });
}

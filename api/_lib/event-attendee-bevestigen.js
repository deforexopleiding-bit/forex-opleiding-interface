// api/_lib/event-attendee-bevestigen.js
//
// WAT 'BEVESTIGD' BETEKENT VOOR EEN DEELNEMER — ÉÉN DEFINITIE.
//
// Drukt Dave in de opvolgmodule op Bevestigd, dan bleef dat daar hangen: de
// eventmodule, waar per deelnemer 'bevestigd' of 'voicemail' staat, wist er
// niets van en iemand moest het met de hand overzetten. Twee administraties
// voor één handeling, en dat is precies wat deze module elders juist heeft
// afgeschaft.
//
// DE WEG BESTOND AL. api/follow-up-lead-outcome.js doet dit sinds juli bij
// outcome='bevestigd', en het is meer dan één veld:
//
//   1. call_status = 'bevestigd' + call_status_at — de badge in de bellijst.
//   2. called = true — de belronde had écht bereik.
//   3. status-CORRECTIE: stond de deelnemer op 'geannuleerd' of
//      'switched_to_other_event' en bevestigt hij nu alsnog, dan gaat hij terug
//      naar 'aangemeld'. Zonder dit bevestigt iemand die als geannuleerd te
//      boek staat, en blijft hij geannuleerd.
//   4. onConfirmedAttendeeMutation() — het aantal bevestigden verandert, en
//      daar hangt het openen of sluiten van de inschrijving aan.
//
// Punt 3 en 4 zijn precies de dingen die je vergeet als je 'even een tweede
// weg' bouwt. Vandaar: de betekenis staat hier, één keer, en beide callers
// gebruiken hem.

import { onConfirmedAttendeeMutation } from './event-attendee-mutations.js';

/** Statussen waaruit een bevestiging de deelnemer terughaalt naar 'aangemeld'. */
const TERUG_NAAR_AANGEMELD = new Set(['geannuleerd', 'switched_to_other_event']);

/**
 * De velden die een bevestiging op een deelnemer zet. Puur: geen database,
 * geen klok uit het niets — zodat beide callers erop kunnen testen.
 */
export function bevestigingPatch({ huidigeStatus, nowIso }) {
  const patch = {
    call_status   : 'bevestigd',
    call_status_at: nowIso,
    called        : true,
  };
  if (TERUG_NAAR_AANGEMELD.has(String(huidigeStatus || '').toLowerCase())) {
    patch.status = 'aangemeld';
  }
  return patch;
}

/**
 * De bevestiging wegschrijven. Geeft terug wát er gebeurd is, zodat de caller
 * het kan melden in plaats van het te slikken.
 *
 * NIET FAIL-SILENT. Op 7 september bleek dat createFollowupLead() al maanden
 * faalde met de fout in een `extraWarnings`-lijst die niemand leest; 225 mensen
 * verdwenen daardoor uit beeld. Deze functie gooit niet — de opvolgkaart mag er
 * niet op stuklopen — maar geeft `{ ok:false, fout }` terug, en de caller zet
 * dat in het antwoord én in console.error.
 */
export async function bevestigDeelnemer({ supabaseAdmin, attendeeId, nowIso, bron }) {
  if (!attendeeId) return { ok: false, fout: 'geen attendee_id', overgeslagen: true };
  try {
    const { data: voor, error: leesErr } = await supabaseAdmin
      .from('event_attendees').select('id, event_id, status, call_status').eq('id', attendeeId).maybeSingle();
    if (leesErr) return { ok: false, fout: 'lezen: ' + leesErr.message };
    if (!voor)   return { ok: false, fout: 'deelnemer bestaat niet meer', overgeslagen: true };

    const patch = bevestigingPatch({ huidigeStatus: voor.status, nowIso });
    const { error: schrijfErr } = await supabaseAdmin
      .from('event_attendees').update(patch).eq('id', attendeeId);
    if (schrijfErr) return { ok: false, fout: 'schrijven: ' + schrijfErr.message };

    // Het aantal bevestigden is veranderd wanneer de status meebewoog.
    let telling = null;
    if (patch.status !== undefined && voor.event_id) {
      try {
        await onConfirmedAttendeeMutation(voor.event_id, { reason: bron || 'opvolging-bevestigd' });
        telling = 'herberekend';
      } catch (e) {
        telling = 'mislukt: ' + (e?.message || e);
      }
    }
    return {
      ok: true,
      status_hersteld: patch.status !== undefined ? String(voor.status) : null,
      telling,
    };
  } catch (e) {
    return { ok: false, fout: String(e?.message || e) };
  }
}

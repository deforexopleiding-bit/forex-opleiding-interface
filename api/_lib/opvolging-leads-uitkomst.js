// api/_lib/opvolging-leads-uitkomst.js
//
// LEADS BELLEN — WAT DAVE NA EEN CALL AANKLIKT, RECHTZETTEN IN DE POGINGEN.
//
// De softphone weet alleen of de lijn OPGENOMEN werd (SIP 'Established'). Een
// voicemail neemt ook op. Gemeten op 9 oktober: 66 calls op leadkaarten
// stonden als 'gesproken', vaak twee keer binnen tien seconden na elkaar —
// dat zijn voicemails, geen gesprekken. Daardoor stond bij bijna elke lead
// 'wel gesproken' en klopte het oordeel over de moeite niet.
//
// Dave kent het echte antwoord. Klikt hij 'Geen gehoor' of 'Voicemail' aan,
// dan wordt de laatste call van deze kaart (van het laatste kwartier) bijgesteld
// naar 'niet opgenomen…'. De ruwe waarde blijft bewaard in call_log
// (outcome_hint 'answered'); hier wordt alleen de betekenis voor de opvolging
// rechtgezet. Belde hij buiten de softphone (eigen gsm), dan staat er geen call:
// dan komt er één handmatige belpoging bij, zodat de cadans hem ook ziet.

import { classificeerResultaat, GESPROKEN, NIET_OPGENOMEN } from './opvolging-poging-telling.js';

/** Zo ver terug zoeken we de call waar de uitkomst bij hoort. */
export const UITKOMST_VENSTER_MIN = 45;

/**
 * De bijstelling als pure beslissing.
 * @param {object|null} laatste de laatste call-poging binnen het venster
 * @param {string} uitkomst geen_gehoor | voicemail | gesproken | foutief_nummer
 * @returns {{ actie: 'bijstellen'|'toevoegen'|'niets', resultaat?: string }}
 */
export function beslisCorrectie(laatste, uitkomst) {
  const nietOp = uitkomst === 'geen_gehoor' || uitkomst === 'voicemail';
  const tekst = uitkomst === 'voicemail' ? 'niet opgenomen: voicemail' : 'niet opgenomen';
  if (!laatste) {
    if (nietOp) return { actie: 'toevoegen', resultaat: tekst + ' (zelf gemeld)' };
    if (uitkomst === 'gesproken') return { actie: 'toevoegen', resultaat: 'gesproken (zelf gemeld)' };
    return { actie: 'niets' };
  }
  const klasse = classificeerResultaat(laatste.resultaat);
  if (nietOp && klasse === GESPROKEN) return { actie: 'bijstellen', resultaat: tekst };
  if (uitkomst === 'voicemail' && klasse === NIET_OPGENOMEN && !/voicemail/i.test(String(laatste.resultaat))) {
    return { actie: 'bijstellen', resultaat: tekst };
  }
  if (uitkomst === 'gesproken' && klasse === NIET_OPGENOMEN) return { actie: 'bijstellen', resultaat: 'gesproken' };
  return { actie: 'niets' };
}

/**
 * Zet de laatste call van deze kaart recht volgens de aangeklikte uitkomst.
 * Fail-soft: een fout hier mag de uitkomst zelf niet tegenhouden.
 * @returns {Promise<{actie: string}>}
 */
export async function corrigeerLaatsteCall(db, { taakId, uitkomst, nuMs = Date.now() }) {
  try {
    if (uitkomst === 'foutief_nummer') return { actie: 'niets' };
    const van = new Date(nuMs - UITKOMST_VENSTER_MIN * 60000).toISOString();
    const { data, error } = await db.from('opvolging_pogingen')
      .select('id, resultaat, tijdstip, richting')
      .eq('taak_id', taakId).eq('soort', 'call').gte('tijdstip', van)
      .order('tijdstip', { ascending: false }).limit(5);
    if (error) throw new Error(error.message);
    const laatste = (data || []).find((p) => p.richting !== 'in' && !/^afgebroken/i.test(String(p.resultaat || ''))) || null;
    const besluit = beslisCorrectie(laatste, uitkomst);
    if (besluit.actie === 'bijstellen') {
      const { error: uErr } = await db.from('opvolging_pogingen').update({ resultaat: besluit.resultaat }).eq('id', laatste.id);
      if (uErr) throw new Error(uErr.message);
    } else if (besluit.actie === 'toevoegen') {
      const { error: iErr } = await db.from('opvolging_pogingen').insert({
        taak_id: taakId, soort: 'call', automatisch: false, richting: 'uit',
        resultaat: besluit.resultaat, tijdstip: new Date(nuMs).toISOString(),
      });
      if (iErr) throw new Error(iErr.message);
    }
    return { actie: besluit.actie };
  } catch (e) {
    console.warn('[opvolging-leads-uitkomst] call rechtzetten (soft):', e?.message || e);
    return { actie: 'fout' };
  }
}

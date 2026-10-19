// api/_lib/lab-scan.js
//
// DE STRATEGIESCAN BIJ EEN LAB-BOEKING. De sessie met Dave heet voortaan
// "gratis strategiescan (30 min) met Dave". Bij elke boeking uit The Lab staat
// er daarom meteen een scan klaar in Strategie-scans (tabel `scans`, module van
// een collega: api/scan.js + modules/scan/scan-model.js — NIET aangepast):
//
//   status 'concept' · lead_id · afspraak_id · assessor = Dave (de gastheer)
//   deelnemer = naam / e-mail / gsm uit de lab-lead-rij
//   antwoorden: ALLEEN wat één-op-één uit The Lab volgt — het doel
//   doel-kolom: dat doel, als label (zoals scan.js hem zelf zou zetten)
//   dave_notitie: één regel "Uit The Lab: …" met wat er NIET één-op-één past
//                 (tijd per week, bereid te investeren) — Dave past hem aan.
//
// GEEN readiness/categorie/aanpak/traject: die rekent scan.js uit zodra Dave
// opslaat. Een berekende score op een lege scan zou het gemiddelde in het
// overzicht vertekenen (dat middelt over alle rijen met een score).
//
// Idempotent: staat er al een scan bij deze afspraak, dan niets. Fail-soft in
// de aanroeper: een mislukte scan mag een boeking nooit tegenhouden.

import { ONDERDELEN } from '../../modules/scan/scan-model.js';

/** Lab-doel → index van de optie in de scanvraag "Wat is je uiteindelijke doel?". */
const DOEL_NAAR_OPTIE = Object.freeze({
  bijverdienste: 'Een tweede inkomen naast mijn werk',
  vermogen: 'Vermogen opbouwen voor later',
  volledig_inkomen: 'Financiële vrijheid',
  weet_niet: 'Ik heb (nog) geen concreet doel',
});

const TIJD = { minder_3u: 'minder dan 3 uur', '3_6u': '3 tot 6 uur', meer_6u: 'meer dan 6 uur' };
const INVESTEREN = { ja: 'ja', misschien: 'misschien', nee: 'nee' };

/** De doelvraag zelf: { sleutel: 'motivatie_0', opties: [...] }. PURE. */
function doelVraag() {
  const p = ONDERDELEN.find((o) => o.items.some((it) => it.goal));
  const i = p.items.findIndex((it) => it.goal);
  return { sleutel: `${p.k}_${i}`, opties: p.items[i].opts.map((o) => o[0]) };
}

/**
 * De scan-rij uit een lab-lead. PURE.
 * @returns {object} rij voor `scans` (zonder id/aangemaakt — defaults)
 */
export function scanRijUitLab({ lab, leadId = null, afspraakId, assessorId = null, test = false }) {
  const k = lab?.kwalificatie || {};
  const antwoorden = {};
  let doel = null;
  const optieTekst = DOEL_NAAR_OPTIE[k.doel];
  if (optieTekst) {
    const v = doelVraag();
    const idx = v.opties.indexOf(optieTekst);
    if (idx >= 0) { antwoorden[v.sleutel] = idx; doel = optieTekst; }
  }
  const delen = [];
  if (TIJD[k.tijd]) delen.push(`tijd per week: ${TIJD[k.tijd]}`);
  if (INVESTEREN[k.investeren]) delen.push(`bereid te investeren in begeleiding: ${INVESTEREN[k.investeren]}`);
  const naam = [lab?.voornaam, lab?.achternaam].filter(Boolean).join(' ') || lab?.email || 'Lab-lead';
  return {
    status: 'concept',
    lead_id: leadId,
    afspraak_id: afspraakId,
    assessor_id: assessorId,
    deelnemer_naam: (test ? 'TEST · ' : '') + naam,
    deelnemer_email: lab?.email ? String(lab.email).toLowerCase() : null,
    deelnemer_telefoon: lab?.telefoon || null,
    antwoorden,
    doel,
    dave_notitie: delen.length ? `Uit The Lab: ${delen.join(' · ')}.` : null,
  };
}

/**
 * Maak de scan, tenzij er al één bij deze afspraak hoort. Gooit bij een
 * databankfout — de aanroeper vangt dat op (fail-soft).
 * @returns {Promise<{ id: string, nieuw: boolean }>}
 */
export async function maakLabScan(db, p) {
  const { data: bestaand, error: le } = await db.from('scans').select('id').eq('afspraak_id', p.afspraakId).limit(1);
  if (le) throw new Error('scans lezen: ' + le.message);
  if (bestaand && bestaand.length) return { id: bestaand[0].id, nieuw: false };
  const { data, error } = await db.from('scans').insert(scanRijUitLab(p)).select('id').single();
  if (error) throw new Error('scan maken: ' + error.message);
  return { id: data.id, nieuw: true };
}

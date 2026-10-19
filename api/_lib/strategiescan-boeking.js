// api/_lib/strategiescan-boeking.js
//
// DE STRATEGIE-SCAN ALS FUNNEL (2026-10-19). De landingspagina
// deforexopleiding.nl/strategiescan-v1 boekt via de gewone boek-route
// (public-opstartsessie-book) met booking_source 'strategiescan'. Bij zo'n
// boeking doen we drie dingen extra:
//   1. Dave is de eigenaar van de afspraak (follow_up_appointments.owner_id) —
//      dezelfde persoon als de gastheer van The Lab (_lib/lab-gastheer.js),
//      bewust NIET via booking_sources.owner_user_id (= setter-commissie).
//   2. De titel in GHL (Daves agenda + Zoom) begint met 'Strategie-scan · '.
//   3. Er staat meteen een scan-rij in status 'concept' (scans.lead_id +
//      afspraak_id, assessor Dave), zodat hij hem in Strategie-scans terugvindt
//      en vanuit de afspraak verder invult.
//
// NIET TE VERWARREN met de strategiesessie uit The Lab (booking_source
// 'the-lab'): dat is een ander gesprek, zonder scan-rij.

import { supabaseAdmin } from '../supabase.js';
import { leesLabGastheer } from './lab-gastheer.js';

export const SCAN_BRON = 'strategiescan';
export const SCAN_DUUR_MIN = 20;
export const SCAN_TITEL_PREFIX = 'Strategie-scan · ';

/** Is dit een boeking van de Strategie-scan-funnel? PURE. */
export function isScanBron(source) {
  return String(source || '').trim().toLowerCase() === SCAN_BRON;
}

/** De GHL-titel: 'Strategie-scan · Jonas Peeters'. PURE. */
export function scanGhlTitel(naam) {
  const n = String(naam || '').trim();
  return SCAN_TITEL_PREFIX + (n || 'nieuwe deelnemer');
}

/** De scan-rij in concept. PURE. Score-kolommen blijven leeg tot Dave invult. */
export function scanConceptRij({ leadId = null, afspraakId = null, assessorId = null, naam, email = null, telefoon = null }) {
  return {
    lead_id: leadId || null,
    afspraak_id: afspraakId || null,
    assessor_id: assessorId || null,
    status: 'concept',
    deelnemer_naam: String(naam || '').trim().slice(0, 200) || 'Onbekend',
    deelnemer_email: email ? String(email).trim().toLowerCase().slice(0, 200) : null,
    deelnemer_telefoon: telefoon ? String(telefoon).trim().slice(0, 40) : null,
  };
}

/** Wie neemt de scan af? Dave (zelfde bron als de Lab-gastheer). Fail-soft → null. */
export async function leesScanAssessor() {
  try {
    return await leesLabGastheer();
  } catch (e) {
    console.warn('[strategiescan] assessor lezen (soft):', e?.message || e);
    return null;
  }
}

/**
 * Zet de scan-rij in concept. Idempotent per afspraak: bestaat er al een scan
 * voor deze afspraak, dan laten we die staan. Fail-soft: de boeking is dan al
 * gelukt, een fout hier mag die nooit breken.
 * @returns {Promise<{ ok: boolean, scan_id?: string, al?: boolean, fout?: string }>}
 */
export async function maakScanConcept(p) {
  try {
    if (p.afspraakId) {
      const { data: al, error: alErr } = await supabaseAdmin.from('scans')
        .select('id').eq('afspraak_id', p.afspraakId).limit(1);
      if (alErr) console.warn('[strategiescan] bestaande scan zoeken (soft):', alErr.message);
      if (al && al[0]) return { ok: true, scan_id: al[0].id, al: true };
    }
    const { data, error } = await supabaseAdmin.from('scans')
      .insert(scanConceptRij(p)).select('id').single();
    if (error) {
      console.error('[strategiescan] scan-concept insert mislukt:', error.message);
      return { ok: false, fout: error.message };
    }
    return { ok: true, scan_id: data?.id };
  } catch (e) {
    console.error('[strategiescan] scan-concept exception:', e?.message || e);
    return { ok: false, fout: e?.message || String(e) };
  }
}

// api/_lib/lab-gastheer.js
//
// WIE DE STRATEGIESESSIE VAN THE LAB GEEFT — sinds 15 okt 2026: Dave Heylen.
//
// Eén vraag, één antwoord, voor de boeking (eigenaar van de afspraak), de
// boekingskaart in het LMS (naam + foto, anders initialen) en de mails.
//
// WAAR HET VANDAAN KOMT (niets geraden):
//   1. app_settings.lab_gastheer = { profiel_id }  — de knop om het te wijzigen;
//   2. anders het profiel met e-mail LAB_GASTHEER_EMAIL (env), standaard
//      dave@deforexopleiding.nl.
// Vindt geen van beide een actief profiel, dan is er GEEN gastheer (null): de
// kaart toont dan "iemand van ons team" en de afspraak krijgt geen eigenaar —
// precies zoals vóór deze wijziging.
//
// WAAROM NIET booking_sources.owner_user_id: dat veld is in dit CRM de SETTER
// (create-appointment-from-lead → setter_user_id → setter-attributie op de
// deal → setter-commissie). Dave daar zetten zou hem commissie geven als
// setter van zijn eigen gesprekken. De gastheer is de EIGENAAR van de afspraak
// (follow_up_appointments.owner_id), niet de setter.

import { supabaseAdmin } from '../supabase.js';

export const LAB_GASTHEER_SLEUTEL = 'lab_gastheer';
const STANDAARD_EMAIL = 'dave@deforexopleiding.nl';
const CACHE_MS = 5 * 60 * 1000;

let cache = null; // { tot, waarde }

/** "Dave Heylen" → "DH"; leeg → null. PURE. */
export function initialen(naam) {
  const delen = String(naam || '').trim().split(/\s+/).filter(Boolean);
  if (!delen.length) return null;
  const eerste = delen[0][0] || '';
  const laatste = delen.length > 1 ? delen[delen.length - 1][0] : '';
  return (eerste + laatste).toUpperCase() || null;
}

/** Profielrij → wat buiten getoond mag worden. Geen e-mail, geen rol. PURE. */
export function gastheerUitProfiel(p) {
  if (!p || !p.id || p.is_active === false) return null;
  const naam = String(p.full_name || '').trim() || null;
  const voornaam = naam ? naam.split(/\s+/)[0] : null;
  const foto = typeof p.avatar_url === 'string' && /^https:\/\//.test(p.avatar_url.trim()) ? p.avatar_url.trim() : null;
  return { id: p.id, naam, voornaam, foto_url: foto, initialen: initialen(naam) };
}

const KOLOMMEN = 'id, full_name, avatar_url, is_active';

export async function leesLabGastheer({ vers = false } = {}) {
  if (!vers && cache && cache.tot > Date.now()) return cache.waarde;
  let waarde = null;
  try {
    const { data: inst } = await supabaseAdmin.from('app_settings').select('value').eq('key', LAB_GASTHEER_SLEUTEL).maybeSingle();
    const profielId = inst?.value?.profiel_id || null;
    if (profielId) {
      const { data } = await supabaseAdmin.from('profiles').select(KOLOMMEN).eq('id', profielId).maybeSingle();
      waarde = gastheerUitProfiel(data);
    }
    if (!waarde) {
      const email = (process.env.LAB_GASTHEER_EMAIL || STANDAARD_EMAIL).trim().toLowerCase();
      const { data } = await supabaseAdmin.from('profiles').select(KOLOMMEN).ilike('email', email).maybeSingle();
      waarde = gastheerUitProfiel(data);
    }
  } catch (e) {
    console.warn('[lab-gastheer] lezen (soft):', e?.message || e);
    waarde = null;
  }
  cache = { tot: Date.now() + CACHE_MS, waarde };
  return waarde;
}

/** Alleen voor tests. */
export function _resetGastheerCache() { cache = null; }

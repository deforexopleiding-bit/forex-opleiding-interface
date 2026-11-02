// api/_lib/meta-testtool.js
//
// Meta-toestemming-testtool (2026-11-02) — Leadsonderhoud › Meta-koppeling.
// Spiegel van dfo-website lib/meta-testtool.ts: ÉÉN instelling in app_settings
// (sleutel 'meta_toestemming_testtool') die website én CRM lezen en die de
// cookietoestemming voor Meta SITEBREED kan overschrijven. Bedoeld om te testen;
// Jeffrey zet hem zelf aan en uit (bewust zonder automatische terugval).
//
//   modus 'normaal' → zoals altijd: alleen met toestemming voor advertenties;
//   modus 'altijd'  → ook ZONDER toestemming naar Meta;
//   modus 'nooit'   → nooit naar Meta, ook mét toestemming;
//   cookiebanner 'uit' (alleen met altijd/nooit) → de website toont geen banner en
//                    gedraagt zich alsof iedereen 'alles' resp. 'alleen noodzakelijk' koos;
//   testadressen   → ook +test-adressen / testdomeinen / is_test versturen;
//   test_event_code → optioneel; gaat voor de Testmodus van meta_lead_settings en de env.
//
// Waar het CRM hem toepast: beslisMetaLead (Lead), leadHeeftToestemming (latere
// events: Lab-Schedule/-Gestart/-Afgewerkt, CRMCustomer), stuurLabEvent en de
// test-code van elke CAPI-zender. De ECHTE keuze blijft op de lead staan.

import { supabaseAdmin } from '../supabase.js';

export const TESTTOOL_SLEUTEL = 'meta_toestemming_testtool';
export const TESTTOOL_MODI = Object.freeze(['normaal', 'altijd', 'nooit']);

export const NORMAAL = Object.freeze({ modus: 'normaal', cookiebanner: 'aan', testadressen: false, testEventCode: null });

/** app_settings.value → stand. Onbekend/kapot → NORMAAL. Banner uit alleen met altijd/nooit. PURE. */
export function leesTesttool(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return NORMAAL;
  const modus = value.modus === 'altijd' || value.modus === 'nooit' ? value.modus : 'normaal';
  const cookiebanner = value.cookiebanner === 'uit' && modus !== 'normaal' ? 'uit' : 'aan';
  const code = typeof value.test_event_code === 'string' && value.test_event_code.trim()
    ? value.test_event_code.trim().slice(0, 64) : null;
  return { modus, cookiebanner, testadressen: value.testadressen === true, testEventCode: code };
}

/** Wijkt de stand af van normaal? PURE. */
export function isActief(s) {
  return !!s && (s.modus !== 'normaal' || s.testadressen === true || !!s.testEventCode);
}

/** De toestemming waarmee een Meta-zender rekent. PURE. */
export function effectieveToestemming(s, echt) {
  if (s?.modus === 'altijd') return true;
  if (s?.modus === 'nooit') return false;
  return echt === true;
}

/**
 * Body van het CRM-scherm → de te bewaren waarde, of een fout. PURE.
 * Banner uit vraagt een richting: alleen met modus altijd of nooit.
 */
export function valideerTesttool(b) {
  const x = b && typeof b === 'object' ? b : {};
  if (!TESTTOOL_MODI.includes(x.modus)) return { ok: false, fout: 'Kies een modus: normaal, altijd of nooit.' };
  const cookiebanner = x.cookiebanner === 'uit' ? 'uit' : 'aan';
  if (cookiebanner === 'uit' && x.modus === 'normaal') {
    return { ok: false, fout: 'Cookiebanner uit kan alleen met "Altijd naar Meta" of "Nooit naar Meta".' };
  }
  const code = typeof x.test_event_code === 'string' ? x.test_event_code.trim() : '';
  if (code.length > 64 || /[^A-Za-z0-9_-]/.test(code)) return { ok: false, fout: 'Test-code: alleen letters, cijfers, - en _ (max 64).' };
  return { ok: true, waarde: { modus: x.modus, cookiebanner, testadressen: x.testadressen === true, test_event_code: code } };
}

const CACHE_MS = 15_000;
let cache = null;

/** De huidige stand, ~15 s gecachet. Een leesfout → NORMAAL (dan geldt de echte keuze). Gooit nooit. */
export async function haalTesttool(sb = supabaseAdmin, nu = Date.now()) {
  if (cache && cache.tot > nu) return cache.stand;
  let stand = NORMAAL;
  try {
    const { data, error } = await sb.from('app_settings').select('value').eq('key', TESTTOOL_SLEUTEL).maybeSingle();
    if (error) console.warn('[meta-testtool] app_settings niet leesbaar → normaal', { fout: error.message });
    else stand = leesTesttool(data?.value);
  } catch (e) {
    console.warn('[meta-testtool] lezen gooide → normaal', { fout: e?.message || String(e) });
  }
  cache = { stand, tot: nu + CACHE_MS };
  return stand;
}

/** Na bewaren (en in tests): de volgende lezing haalt vers op. */
export function wisTesttoolCache() { cache = null; }

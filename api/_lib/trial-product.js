// api/_lib/trial-product.js
//
// "Eén login voor alle funnels" (26 okt 2026). Verschillende beloftes in de
// advertenties — minicursus, 7 dagen meekijken, webinar, het formulier op de
// site, The Lab — maar ÉÉN bestemming: een trial van 7 dagen in het echte LMS
// (een lab-lead in dfo-lms, zie dfo-lms-lab-account.js).
//
// Hier staat:
//   * welk PRODUCT (belofte) bij een bron hoort — PURE;
//   * de schakelaar per product: app_settings 'trial_bestemming' =
//       { "minicursus": "lab", "7-daagse": "lab", "webinar": "lab",
//         "website": "lab", "the-lab": "lab" }
//     Waarde 'oud' = terug naar het oude trial-LMS (lms_gebruikers via
//     dfo-website /api/interne-welkom). Ontbreekt de rij of het product: 'lab'.
//     Terugdraaien = die ene rij aanpassen, geen deploy.
//   * de herkomst op een lab_aanmeldingen-rij lezen, ook van vóór de
//     migratie 2026-10-26-trial-een-login.sql (dan staat ze als
//     'trial:<product>:<bron>' in landingspagina — zie herkomstVanAanmelding).

import { isLabBron, LAB_SLUG } from './lab-config.js';

export const PRODUCTEN = Object.freeze(['minicursus', '7-daagse', 'webinar', 'website', 'the-lab']);

/** Hoe het product overal heet (Leadsonderhoud, Opvolging, agenda van Dave). */
export const PRODUCT_LABELS = Object.freeze({
  minicursus: 'Minicursus',
  '7-daagse': '7-daagse',
  webinar: 'Webinar',
  website: 'Website',
  'the-lab': 'The Lab',
});

export const STANDAARD_BESTEMMING = 'lab';
export const BESTEMMINGEN = Object.freeze(['lab', 'oud']);
export const BESTEMMING_SLEUTEL = 'trial_bestemming';

/**
 * Producten die NIET in de trialflow horen: ze hebben een eigen flow die
 * ongemoeid moet blijven (26 okt 2026, Maxim: de webinar). Voor deze
 * producten geldt de omgekeerde standaard — enkel een uitdrukkelijke 'lab' in
 * de schakelaar geeft een trial — en de opvolgmotor en de belmelding slaan
 * hun lab-leads over.
 */
export const BUITEN_TRIALFLOW = Object.freeze(['webinar']);

/** Hoort dit product buiten de trialflow? PURE. */
export function isBuitenTrialflow(product) {
  return BUITEN_TRIALFLOW.includes(String(product || '').trim().toLowerCase());
}

/**
 * Valt een lead helemaal buiten de trialflow? Ja als AL zijn aanmeldingen van
 * zo'n product komen (een webinarlead die zich later ook voor de minicursus
 * aanmeldde, hoort er wél bij). PURE.
 * @param {Array<string|null>} producten
 */
export function alleenBuitenTrialflow(producten) {
  const lijst = (producten || []).filter((p) => p != null && p !== '');
  return lijst.length > 0 && lijst.every(isBuitenTrialflow);
}

/** De bestemming als de schakelaar niets (bruikbaars) zegt. PURE. */
export function standaardBestemming(product) {
  return isBuitenTrialflow(product) ? 'oud' : STANDAARD_BESTEMMING;
}

/**
 * Is dit een geldige productwaarde? De gekende staan in PRODUCTEN, maar een
 * nieuwe belofte (bv. 'eerste-trade') moet er zonder migratie bij kunnen:
 * elke korte slug telt. PURE.
 */
export function isProduct(p) {
  return /^[a-z0-9][a-z0-9-]{1,39}$/.test(String(p || ''));
}

/**
 * Welk product hoort bij deze bron (leads.bron / toegang_aanvragen.bron)?
 * `soort` (toegang_aanvragen.soort: '7-daagse' | 'minicursus') is de
 * terugval als de bron niets zegt. PURE.
 */
export function productUitBron(bron, soort = null) {
  const b = String(bron || '').trim().toLowerCase();
  if (/^kennismakingscursus(-|$)/.test(b) || b === 'minicursus') return 'minicursus';
  if (/^7-daagse(-|$)/.test(b)) return '7-daagse';
  if (/^webinar(-|$)/.test(b)) return 'webinar';
  if (isLabBron(b)) return 'the-lab';
  if (b === 'website') return 'website';
  const s = String(soort || '').trim().toLowerCase();
  if (s === 'minicursus') return 'minicursus';
  if (s === '7-daagse') return '7-daagse';
  return 'website';
}

/** Het split-test-luik uit de bron: 'kennismakingscursus-v9' → 'v9', '…-site' → 'site'. PURE. */
export function variantUitBron(bron) {
  const m = /-(v\d+|site)$/.exec(String(bron || '').trim().toLowerCase());
  return m ? m[1] : null;
}

/** De leesbare herkomst: 'Minicursus', 'The Lab', … PURE. */
export function productLabel(product) {
  if (PRODUCT_LABELS[product]) return PRODUCT_LABELS[product];
  if (!isProduct(product)) return PRODUCT_LABELS['the-lab'];
  const t = String(product).replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** De schakelaar uit de waarde van app_settings, per product. PURE. */
export function bestemmingUit(waarde, product) {
  let w = waarde;
  if (typeof w === 'string') { try { w = JSON.parse(w); } catch { w = null; } }
  const v = w && typeof w === 'object' ? String(w[product] ?? '').trim().toLowerCase() : '';
  return BESTEMMINGEN.includes(v) ? v : standaardBestemming(product);
}

/**
 * Leest de schakelaar. Een leesfout = de standaard van het product ('lab': de
 * bestemming die Maxim wil; 'oud' voor een product buiten de trialflow, zodat
 * de webinar nooit per ongeluk een trial krijgt).
 */
export async function leesBestemming(sb, product) {
  try {
    const { data, error } = await sb.from('app_settings').select('value').eq('key', BESTEMMING_SLEUTEL).maybeSingle();
    if (error) {
      console.warn('[trial-product] schakelaar lezen (soft):', error.message);
      return standaardBestemming(product);
    }
    return bestemmingUit(data?.value, product);
  } catch (e) {
    console.warn('[trial-product] schakelaar exception (soft):', e?.message || e);
    return standaardBestemming(product);
  }
}

// ── Herkomst op een lab_aanmeldingen-rij ───────────────────────────────────
// Na de migratie: kolommen product / bron / variant. Daarvoor bewaart
// lab-trial.js de herkomst als 'trial:<product>:<bron>' in landingspagina
// (die kolom is voor deze funnels leeg: de lead kwam niet via een Lab-pagina).

export const HERKOMST_PREFIX = 'trial:';

/** 'trial:minicursus:kennismakingscursus-v9'. PURE. */
export function herkomstMarker(product, bron) {
  return `${HERKOMST_PREFIX}${product}:${String(bron || '')}`;
}

/** { product, bron, variant } van een aanmelding. Onbekend = The Lab. PURE. */
export function herkomstVanAanmelding(a) {
  const r = a || {};
  if (isProduct(r.product)) {
    return { product: r.product, bron: r.bron || null, variant: r.variant || variantUitBron(r.bron) };
  }
  const lp = String(r.landingspagina || '');
  if (lp.startsWith(HERKOMST_PREFIX)) {
    const [, product, ...rest] = lp.split(':');
    const bron = rest.join(':') || null;
    if (isProduct(product)) return { product, bron, variant: variantUitBron(bron) };
  }
  return { product: LAB_SLUG, bron: r.bron || null, variant: r.variant || null };
}

/** Testadres: '+labtest'/'+test', of een plus-adres van Maxim (testafspraak). PURE. */
export function isTestEmail(email) {
  const e = String(email || '').toLowerCase();
  return /\+(lab)?test/.test(e) || /^maxim\.delombaerde96\+[^@]+@gmail\.com$/.test(e);
}

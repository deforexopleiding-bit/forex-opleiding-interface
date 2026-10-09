// api/_lib/onboarding-provision.js
//
// Trial-site-toegang bij een nieuwe onboarding — ALLEEN wanneer de operator
// het per-klant vinkje `onboardings.lms_provision` aanzette (v1-offerte-
// detail). Dit is systeem (2) uit api/_lib/dfo-lms-db.js: de trial-site met
// lms_gebruikers / lms_toegang in het CRM-project. NIET het nieuwe LMS
// (dfo-lms / hlms_student) — dat doet api/_lib/dfo-lms-student.js, voor elke
// onboarding.
//
// GESCHIEDENIS (9 okt 2026, Maxim): hier stond de Bubble-provisioning
// (workflow create_student_basic + PATCH op het user-object). Onboarding naar
// Bubble is gestopt; Bubble gaat dicht. Het trial-site-blok dat ná een
// geslaagde Bubble-aanmaak draaide, staat hier nu op zichzelf, met één
// verschil: er wordt GEEN wachtwoord meer gezet. Dat wachtwoord bestond
// alleen voor de Bubble-inloggegevensmail (al sinds spoor A stap 1 gedoofd),
// kwam dus nooit bij de klant aan, en overschreef bij een bestaand
// trial-account het wachtwoord dat de klant wél kende.
//
// Fail-soft: gooit nooit. Een fout hier mag de aanmelding niet breken.

import { supabaseAdmin } from '../supabase.js';
import { vindOfMaakAccount, zetGrant } from './lms-provisioning.js';
import { addMonths } from './onboarding-window.js';

/**
 * Toegangsvenster: begin = start_date als die in de toekomst ligt, anders nu;
 * einde = begin + duur_maanden. Zelfde rekenregel als voorheen.
 * PURE — geëxporteerd voor tests.
 */
export function trialVenster(startDate, duurMaanden, nu = new Date()) {
  let basis = nu;
  if (startDate) {
    const s = String(startDate);
    const parsed = new Date(s + (s.includes('T') ? '' : 'T00:00:00Z'));
    if (Number.isFinite(parsed.getTime()) && parsed.getTime() > nu.getTime()) basis = parsed;
  }
  const duur = Number(duurMaanden);
  const tot = (Number.isFinite(duur) && duur > 0) ? addMonths(basis, duur) : basis;
  return { van: basis.toISOString(), tot: tot.toISOString() };
}

/**
 * @param {string} onboardingId
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, error?:string}>}
 */
export async function provisionTrialSiteToegang(onboardingId) {
  if (!onboardingId || typeof onboardingId !== 'string') {
    return { ok: false, error: 'onboardingId ontbreekt' };
  }
  try {
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_id, traject_id, start_date, lms_provision')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob) return { ok: false, error: 'Onboarding niet gevonden' };
    if (ob.lms_provision !== true) return { ok: true, skipped: true, reason: 'vinkje-uit' };

    const [{ data: customer, error: cErr }, { data: traject, error: tErr }] = await Promise.all([
      supabaseAdmin.from('customers').select('id, first_name, last_name, email').eq('id', ob.customer_id).maybeSingle(),
      supabaseAdmin.from('onboarding_trajecten').select('id, duur_maanden').eq('id', ob.traject_id).maybeSingle(),
    ]);
    if (cErr) throw new Error('customer lookup: ' + cErr.message);
    if (tErr) throw new Error('traject lookup: ' + tErr.message);
    const email = String(customer?.email || '').trim().toLowerCase();
    if (!email) return { ok: false, error: 'Klant zonder e-mail' };

    const productSlug = (process.env.LMS_PROVISION_PRODUCT_SLUG || '1-op-1-coaching').trim();
    const { data: product, error: prodErr } = await supabaseAdmin
      .from('lms_producten')
      .select('id, slug, actief')
      .eq('slug', productSlug)
      .maybeSingle();
    if (prodErr) throw new Error('lms_producten lookup: ' + prodErr.message);
    if (!product || product.actief !== true) {
      console.warn('[onboarding-provision] trial-product ontbreekt of inactief:', productSlug);
      return { ok: true, skipped: true, reason: 'product-inactief' };
    }

    const { van, tot } = trialVenster(ob.start_date, traject?.duur_maanden);
    const account = await vindOfMaakAccount({
      email,
      voornaam:   String(customer.first_name || '').trim() || null,
      achternaam: String(customer.last_name  || '').trim() || null,
      van, tot,
    });
    if (!account || !account.id) return { ok: false, error: 'trial-account niet aangemaakt' };
    await zetGrant({ gebruikerId: account.id, productId: product.id, van, tot });
    return { ok: true };
  } catch (e) {
    console.error('[onboarding-provision] trial-site-toegang fail (soft):', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

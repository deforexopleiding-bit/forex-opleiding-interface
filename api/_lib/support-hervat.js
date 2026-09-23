// api/_lib/support-hervat.js
//
// Terug in je eigen gesprek, vanaf een ander apparaat.
//
// Het probleem: de widget onthoudt een lopend gesprek in localStorage, dus
// alleen in dezelfde browser. Wie op de trein op zijn telefoon onze mail
// leest, kan het gesprek daar niet openen — en dat is precies het moment
// waarop iemand wil reageren.
//
// ── WAAROM GEEN MAGIC LINK ──────────────────────────────────────────────────
// De voor de hand liggende oplossing is een link met een token erin. Dat doen
// we niet, om twee redenen die allebei op zichzelf al genoeg zijn:
//
//   * Een token in een URL lekt. Naar serverlogs, naar de Referer-header van
//     elke externe afbeelding op de pagina, en naar de browsergeschiedenis van
//     een gedeelde computer. Zie de kop van support-sessie.js — daar staat
//     dezelfde afweging voor het sessietoken.
//   * Een klikbare link in een mail die toegang geeft tot een gesprek is
//     precies de vorm die phishing nadoet. We leren onze studenten liever aan
//     dat wij dat niet doen.
//
// Wat er wél in de link staat is het kenmerk: SUP-7K2M9Q. Dat is geen sleutel
// maar een dossiernummer — het staat ook in de onderwerpregel van elke mail en
// wordt aan de telefoon hardop doorgegeven. De sleutel is de code van zes
// cijfers die daarna naar hetzelfde mailadres gaat als waar de mail heen ging.
// Wie die code uit de mailbox kan halen, is de eigenaar van die mailbox — en
// dat is exact wat we willen vaststellen.
//
// ── HET ORAKEL-PROBLEEM, NU OP HET KENMERK ──────────────────────────────────
// Een kenmerk is zes tekens uit een alfabet van 31, dus ruim 880 miljoen
// mogelijkheden. Toch mag dit endpoint nooit verschil laten zien tussen een
// bestaand en een verzonnen kenmerk: dan is het een vinkenlijst waarmee je
// geldige dossiernummers kunt aflopen. Daarom geeft `start` altijd hetzelfde
// antwoord, zonder mailadres erin, en zegt `check` bij een onbekend kenmerk
// precies wat 'ie bij een foute code zegt.

import crypto from 'node:crypto';
import { supabaseAdmin } from '../supabase.js';

const KENMERK_RE = /^SUP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/** Waar de widget draait. Alleen voor de link onderaan onze mails. */
export function siteUrl() {
  // Eerst de afsluitende slash eraf, dán keuren — anders valt een keurige
  // "https://host/" af en staat er ineens een link naar de productiesite in
  // een mail vanaf staging.
  const raw = String(process.env.SUPPORT_SITE_URL || '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[a-z0-9.-]+$/i.test(raw)) return raw;
  return 'https://www.deforexopleiding.nl';
}

/**
 * De link die onderaan onze supportmails komt.
 * Bevat het kenmerk en verder niets — geen token, geen mailadres.
 */
export function hervatLink(kenmerk) {
  if (!KENMERK_RE.test(String(kenmerk || '').toUpperCase())) return null;
  return `${siteUrl()}/?dfo-support=${String(kenmerk).toUpperCase()}`;
}

/** Kenmerk uit een request: vorm afdwingen vóór er een query mee gedaan wordt. */
export function kenmerkUitBody(body) {
  const k = String(body?.kenmerk || '').trim().toUpperCase();
  return KENMERK_RE.test(k) ? k : null;
}

/**
 * Het gesprek bij een kenmerk.
 *
 * Fail-closed: een DB-fout geeft null, en de aanroeper maakt daar hetzelfde
 * antwoord van als bij een onbekend kenmerk.
 */
export async function gesprekUitKenmerk(kenmerk) {
  if (!kenmerk) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('support_gesprekken')
      .select('*')
      .eq('kenmerk', kenmerk)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/** Zescijferige code. crypto.randomInt, niet Math.random — dit is een sleutel. */
export function maakCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Mogen we voor dit gesprek nog een code versturen?
 *
 * Telt binnen een VENSTER en niet over de hele levensduur. Dat laatste deed de
 * oorspronkelijke versie, en dat is een sluipende val: een student die na drie
 * verificaties over een half jaar nog eens terugkomt, zat permanent op slot
 * zonder dat iemand dat kon zien. Een venster begrenst het mailbombardement
 * net zo goed en loopt vanzelf weer leeg.
 *
 * Fail-CLOSED: bij een leesfout geen code. Dit endpoint verstuurt mail.
 */
export async function magCodeVersturen(gesprekId, { max = 3, vensterMs = 60 * 60 * 1000 } = {}) {
  try {
    const grens = new Date(Date.now() - vensterMs).toISOString();
    const { count, error } = await supabaseAdmin
      .from('support_verificaties')
      .select('id', { count: 'exact', head: true })
      .eq('gesprek_id', gesprekId)
      .gte('created_at', grens);
    if (error) throw new Error(error.message);
    return (count || 0) < max;
  } catch (e) {
    console.error('[support-hervat] codes tellen mislukt (fail-closed):', e?.message || e);
    return false;
  }
}

/** Constant-time vergelijking van twee hashes. */
export function gelijkeHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (_) {
    return false;
  }
}

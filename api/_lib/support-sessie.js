// api/_lib/support-sessie.js
//
// Sessiebeheer voor de support-widget. De bezoeker is niet ingelogd en heeft
// geen Supabase-sessie, dus het gesprek zelf is de identiteit: bij het starten
// krijgt de widget een token van 32 random bytes, en dat token is de sleutel
// tot precies dat ene gesprek.
//
// In de database staat alleen de SHA-256. Wie support_gesprekken leest — een
// medewerker, een gelekte backup — kan daarmee geen gesprek overnemen. Zelfde
// gedachte als display_tokens.token_hash in api/tv.js.
//
// Het token gaat in de header X-Support-Token, nooit in de URL: URL's belanden
// in serverlogs, in Referer-headers naar derden en in de browsergeschiedenis
// op een gedeelde computer.

import crypto from 'node:crypto';
import { supabaseAdmin } from '../supabase.js';

/** 43 tekens base64url uit 32 random bytes. */
export function maakSessieToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  if (typeof token !== 'string' || !token) return null;
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Kort kenmerk voor in mails en aan de telefoon: SUP-7K2M9Q.
 * Zonder 0/O/1/I/L om verkeerd overtypen te voorkomen — dit getal wordt
 * hardop doorgegeven.
 */
export function maakKenmerk() {
  const alfabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 6; i++) s += alfabet[crypto.randomInt(0, alfabet.length)];
  return `SUP-${s}`;
}

/**
 * Haal het gesprek op dat bij dit token hoort.
 *
 * Fail-closed: geen token, onbekend token of een DB-fout geeft null. De
 * aanroeper maakt daar een 401 van zonder te vertellen wélke van de drie het
 * was — dat verschil is voor een aanvaller gratis informatie.
 *
 * @param {string} token — rauw token uit de X-Support-Token header
 * @returns {Promise<object|null>}
 */
export async function gesprekUitToken(token) {
  const hash = hashToken(token);
  if (!hash) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('support_gesprekken')
      .select('*')
      .eq('sessie_token_hash', hash)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/** Het token uit de request halen. Alleen de header; bewust geen query-param. */
export function tokenUitRequest(req) {
  const h = req.headers?.['x-support-token'];
  if (typeof h !== 'string') return null;
  const t = h.trim();
  return t.length >= 20 && t.length <= 128 ? t : null;
}

/**
 * Schrijf een bericht en houd de tellers op het gesprek bij.
 *
 * Beide schrijfacties zijn awaited. Fire-and-forget met .catch() is hier
 * verleidelijk (het scheelt de bezoeker een paar honderd ms) maar dan kan een
 * bericht in de thread staan zonder dat de wachtrij-teller meebeweegt, en dan
 * ziet niemand van ons dat er iemand wacht.
 *
 * @param {object} opts
 * @param {string} opts.gesprekId
 * @param {'klant'|'bot'|'medewerker'|'systeem'} opts.afzender
 * @param {string} opts.tekst
 * @param {string} [opts.afzenderUserId]
 * @param {object} [opts.meta]
 * @returns {Promise<object|null>} het geschreven bericht, of null bij fout
 */
export async function schrijfBericht(opts) {
  const { bericht, error } = await schrijfBerichtOfFout(opts);
  if (error) {
    console.error('[support-sessie] bericht schrijven mislukt:', error.message);
    return null;
  }
  return bericht;
}

/**
 * Als schrijfBericht, maar geeft de databasefout terug in plaats van 'm weg te
 * loggen: `{ bericht, error }`. Voor callers die een fout moeten kunnen
 * duiden — de mailcron herkent een unieke-sleutelfout als "al verwerkt".
 * Bij een fout worden de tellers op het gesprek niet aangeraakt.
 */
export async function schrijfBerichtOfFout({ gesprekId, afzender, tekst, afzenderUserId = null, meta = {} }) {
  const nu = new Date().toISOString();

  const { data: bericht, error } = await supabaseAdmin
    .from('support_berichten')
    .insert({
      gesprek_id: gesprekId,
      afzender,
      afzender_user_id: afzenderUserId,
      tekst,
      meta,
    })
    .select()
    .maybeSingle();

  if (error) return { bericht: null, error };

  // Tellers. Een bericht van de klant verhoogt de ongelezen-teller; een
  // bericht van ons zet 'm terug en legt de eerste-reactietijd vast.
  const patch = { laatste_bericht_op: nu };
  if (afzender === 'klant') {
    patch.laatste_klant_bericht_op = nu;
  } else if (afzender === 'medewerker') {
    patch.laatste_ons_bericht_op = nu;
    patch.ongelezen_voor_ons = 0;
  }

  try {
    if (afzender === 'klant') {
      // Ophogen kan niet declaratief via de client — lees, tel op, schrijf.
      const { data: huidig } = await supabaseAdmin
        .from('support_gesprekken')
        .select('ongelezen_voor_ons, eerste_reactie_op')
        .eq('id', gesprekId)
        .maybeSingle();
      patch.ongelezen_voor_ons = (huidig?.ongelezen_voor_ons || 0) + 1;
    }
    if (afzender === 'medewerker') {
      const { data: huidig } = await supabaseAdmin
        .from('support_gesprekken')
        .select('eerste_reactie_op')
        .eq('id', gesprekId)
        .maybeSingle();
      if (!huidig?.eerste_reactie_op) patch.eerste_reactie_op = nu;
    }
    await supabaseAdmin.from('support_gesprekken').update(patch).eq('id', gesprekId);
  } catch (e) {
    console.warn('[support-sessie] tellers bijwerken mislukt:', e?.message || e);
  }

  return { bericht, error: null };
}

/**
 * Wat de widget van een gesprek mag zien. Bewust een whitelist en geen
 * `delete row.x` — bij een nieuwe kolom lekt een blacklist automatisch, een
 * whitelist niet. Nooit ip_hash, user_agent, sessie_token_hash of
 * customer_id naar buiten.
 */
export function publiekGesprek(g) {
  if (!g) return null;
  return {
    kenmerk: g.kenmerk,
    soort: g.soort,
    onderwerp: g.onderwerp,
    status: g.status,
    geverifieerd: !!g.geverifieerd,
    verificatie_geblokkeerd: !!g.verificatie_geblokkeerd,
    naam: g.naam || null,
    email: g.email || null,
  };
}

/** Wat de widget van een bericht mag zien. */
export function publiekBericht(b) {
  return {
    id: b.id,
    afzender: b.afzender,
    // De naam van de medewerker maakt het gesprek menselijk; alles overige
    // uit meta (intent, vertrouwen, tokenverbruik, bronnen) blijft binnen.
    naam: b.meta?.afzender_naam || null,
    tekst: b.tekst,
    created_at: b.created_at,
  };
}

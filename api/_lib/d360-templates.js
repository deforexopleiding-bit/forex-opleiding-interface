// api/_lib/d360-templates.js
//
// Templates bij 360dialog: opvragen en indienen. Dun, puur transport.
//
// ── WAAROM DIT BESTAAT ───────────────────────────────────────────────────────
// De bestaande endpoints api/admin-meta-templates-submit.js en -sync.js praten
// rechtstreeks met graph.facebook.com en gebruiken META_WHATSAPP_ACCESS_TOKEN.
// Sinds 5 oktober is de oude Meta-WABA geblokkeerd en loopt alles via
// 360dialog (api/_lib/wa-nummers.js). Die twee endpoints kunnen dus niets meer
// indienen — ze geven een Meta-fout, niet een CRM-fout, en dat leest als een
// probleem met de template in plaats van met het pad.
//
// Indienen kon daarna alleen nog met scripts/360-templates-upload.mjs: een
// terminal, een --env-file met de servicesleutel en de D360-sleutel erin. Wie
// geen terminal heeft, kan geen template indienen.
//
// ── WAT HIER NIET IN ZIT ─────────────────────────────────────────────────────
// Geen sleutels. De sleutel komt uit de env via apiKeyVan() en gaat in de
// header; hij staat nooit in een logregel, nooit in een foutmelding en nooit in
// een antwoord. Een fout over een ontbrekende sleutel noemt de NAAM van de
// env-variabele, nooit een waarde.

import { D360_BASE_URL, nummerOpSleutel, apiKeyVan } from './wa-nummers.js';

/** Hoe lang we op 360dialog wachten. Vercel kapt af op 60 s; ruim eronder blijven. */
const WACHT_MS = 12000;

/** Een nummer zonder sleutel kan niets. De naam van de env mag wél in de fout. */
export class D360GeenSleutelError extends Error {
  constructor(envNaam, sleutel) {
    super(`Er staat geen 360dialog-sleutel voor de lijn "${sleutel}". Zet ${envNaam} in Vercel.`);
    this.name = 'D360GeenSleutelError';
    this.code = 'GEEN_SLEUTEL';
    this.env = envNaam;
  }
}

/**
 * Eén aanroep bij 360dialog.
 * @returns {Promise<{ok: boolean, status: number, json: object|null, tekst: string}>}
 */
export async function d360(nummerSleutel, pad, init = {}) {
  const nummer = nummerOpSleutel(nummerSleutel);
  if (!nummer) throw new Error(`Onbekende lijn "${nummerSleutel}".`);
  const key = apiKeyVan(nummer);
  if (!key) throw new D360GeenSleutelError(nummer.api_key_env, nummerSleutel);

  const afbreken = AbortSignal.timeout ? AbortSignal.timeout(WACHT_MS) : undefined;
  const res = await fetch(D360_BASE_URL + pad, {
    ...init,
    signal: afbreken,
    headers: { 'D360-API-KEY': key, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const tekst = await res.text();
  let json = null;
  try { json = tekst ? JSON.parse(tekst) : null; } catch { /* tekst houden */ }
  return { ok: res.ok, status: res.status, json, tekst };
}

/**
 * Alle templates van een lijn, gepagineerd.
 *
 * Geeft een Map van `naam|taal` → { name, language, status, category, id }.
 * Gooit bij een leesfout — de aanroeper MOET dan stoppen: zonder deze lijst is
 * er geen manier om te weten wat er al staat, en dan is indienen niet meer
 * idempotent maar een gok.
 */
export async function lijstBij360(nummerSleutel) {
  const uit = new Map();
  let pad = '/message_templates?limit=100';
  for (let i = 0; i < 50 && pad; i++) {
    const r = await d360(nummerSleutel, pad);
    if (!r.ok) {
      throw new Error(`360dialog gaf HTTP ${r.status} op de templatelijst: ${kortefout(r)}`);
    }
    for (const t of (r.json?.data || r.json?.waba_templates || [])) {
      if (!t?.name) continue;
      uit.set(sleutelVan(t.name, t.language), {
        name: t.name,
        language: t.language || null,
        status: t.status || null,
        category: t.category || null,
        id: t.id || null,
        rejected_reason: t.rejected_reason || t.rejection_reason || null,
      });
    }
    const na = r.json?.paging?.cursors?.after;
    pad = r.json?.paging?.next && na ? `/message_templates?limit=100&after=${encodeURIComponent(na)}` : null;
  }
  return uit;
}

/** `naam|taal`, met de taal in kleine letters zodat nl en NL dezelfde sleutel zijn. */
export function sleutelVan(naam, taal) {
  return `${String(naam || '').trim()}|${String(taal || '').trim().toLowerCase()}`;
}

/** Eén template indienen. Geeft het ruwe antwoord terug; de aanroeper duidt het. */
export async function dienIn(nummerSleutel, payload) {
  return d360(nummerSleutel, '/message_templates', { method: 'POST', body: JSON.stringify(payload) });
}

/**
 * Zegt 360dialog "die bestaat al"?
 *
 * Dit is de tweede laag onder de idempotentie. De eerste is de lijst hierboven,
 * maar tussen het ophalen van die lijst en het indienen zit ruimte — en twee
 * mensen die tegelijk op de knop drukken, horen niet twee keer in te dienen.
 * "Bestaat al" is dan geen fout maar het antwoord dat we wilden.
 */
export function bestaatAlFout(r) {
  const alles = JSON.stringify(r?.json || r?.tekst || '');
  return /already exists|bestaat al|duplicate|2388024/i.test(alles);
}

/** Een korte, veilige foutregel uit een 360dialog-antwoord. Nooit de sleutel. */
export function kortefout(r) {
  const j = r?.json;
  const m = j?.error?.message || j?.meta?.developer_message || j?.message || r?.tekst || '';
  return String(m).slice(0, 300);
}

/**
 * 360dialog/Meta-status → onze status-enum in whatsapp_meta_templates.
 *
 * Gelijk aan mapMetaStatusToInternal in api/admin-meta-templates-submit.js. Een
 * onbekende status wordt SUBMITTED en niet APPROVED: wie niet weet of een
 * template goedgekeurd is, moet hem niet versturen.
 */
export function statusNaarIntern(status360) {
  const s = String(status360 || '').toUpperCase();
  if (s === 'APPROVED') return 'APPROVED';
  if (s === 'REJECTED') return 'REJECTED';
  if (s === 'PAUSED') return 'PAUSED';
  if (s === 'DISABLED') return 'DISABLED';
  return 'SUBMITTED';
}

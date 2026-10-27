// api/_lib/opvolging-leads-lijsten.js
//
// APARTE LIJSTEN in 'Leads bellen'. Puur en getest, op het lezen van de
// lijsten na (leesLijsten).
//
// Maxim wil naast de algemene pot ook een lijst kunnen opladen die VOLLEDIG
// APART staat: een eigen chip in de chiprij, en de leads ervan verschijnen
// niet in Nu bellen of in een andere algemene chip of teller. Binnen de lijst
// werkt alles zoals in de pot (terugbelafspraken, de belcadans, agenda
// doorsturen, afronden) — daarom zijn het gewone leadkaarten in
// opvolging_taken (lijst 'leads', bron 'import') en rekent stelPottenSamen()
// hun potten, alleen per lijst in plaats van samen met de rest.
//
// De koppeling: bron_ref.aparte_lijst_id → opvolging_leads_lijsten.id.
// Geen dosering: alles staat meteen zichtbaar (due = vandaag).
// Een lijst blijft staan tot iemand hem archiveert; de kaarten blijven dan
// bewaard en de lijst is terug te vinden (en terug te zetten).
//
// Migratie: docs/sql-migrations/2026-10-27-opvolging-aparte-lijsten.sql.
// Zonder die tabel werkt de algemene flow ongewijzigd; alleen de aparte
// lijsten zijn dan niet beschikbaar.

import { staart9 } from './opvolging-leads-pot.js';

export const TABEL_LIJSTEN = 'opvolging_leads_lijsten';
export const LIJST_REF = 'aparte_lijst_id';
export const LIJST_NAAM_MAX = 60;
export const LIJST_STATUS_ACTIEF = 'actief';
export const LIJST_STATUS_GEARCHIVEERD = 'gearchiveerd';

const OPEN = new Set(['open', 'wacht_inplanning', 'wacht_verplaatsing']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isLijstId = (v) => UUID_RE.test(String(v || ''));

/** De aparte lijst van een kaart, of null (= algemene pot). */
export function aparteLijstVan(kaart) {
  const ref = kaart && kaart.bron_ref;
  const id = ref && typeof ref === 'object' ? ref[LIJST_REF] : null;
  return id ? String(id) : null;
}

/** De tabel bestaat (nog) niet: migratie niet gedraaid. */
export function tabelOntbreekt(err) {
  const code = String((err && err.code) || '');
  return code === '42P01' || code === 'PGRST205' || /could not find the table|does not exist/i.test(String((err && err.message) || ''));
}

/** Een geldige lijstnaam (getrimd), of null. */
export function lijstNaam(v) {
  const n = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return n && n.length <= LIJST_NAAM_MAX ? n : null;
}

/** Bestaat er al een actieve lijst met deze naam (hoofdletterongevoelig)? */
export function naamBezet(lijsten, naam) {
  const n = String(naam || '').trim().toLowerCase();
  return (lijsten || []).some((l) => l && l.status === LIJST_STATUS_ACTIEF && String(l.naam || '').trim().toLowerCase() === n);
}

/**
 * De kaarten in tweeën: de algemene pot, en per aparte lijst.
 * @returns {{ algemeen: object[], perLijst: Map<string, object[]> }}
 */
export function splitsKaarten(kaarten) {
  const algemeen = [];
  const perLijst = new Map();
  for (const k of kaarten || []) {
    const id = aparteLijstVan(k);
    if (!id) { algemeen.push(k); continue; }
    if (!perLijst.has(id)) perLijst.set(id, []);
    perLijst.get(id).push(k);
  }
  return { algemeen, perLijst };
}

/**
 * De telefoons (laatste 9 cijfers) van de lopende kaarten in een ACTIEVE
 * aparte lijst. Een nieuwe lead met zo'n nummer komt niet in de algemene pot
 * Nieuw: hij wordt al in die lijst gebeld.
 */
export function aparteStaarten(perLijst, actieveIds) {
  const uit = new Set();
  const actief = new Set(actieveIds || []);
  for (const [id, kaarten] of perLijst || new Map()) {
    if (!actief.has(id)) continue;
    for (const k of kaarten) if (k && OPEN.has(String(k.status || ''))) { const s = staart9(k.telefoon); if (s) uit.add(s); }
  }
  return uit;
}

/**
 * De leads (lead_id) achter een kaart in een aparte lijst — elke lijst, elke
 * status. Zo'n lead heeft al een kaart (in die lijst) en hoort dus niet als
 * nieuwe lead in de algemene pot Nieuw, ook niet als zijn kaart verhuisd is.
 */
export function aparteLeadIds(perLijst) {
  const uit = new Set();
  for (const kaarten of (perLijst || new Map()).values()) for (const k of kaarten) if (k && k.lead_id) uit.add(k.lead_id);
  return uit;
}

/** Open / afgewerkt van één lijst, over de hele historiek (geen venster). */
export function lijstTelling(kaarten) {
  const t = { totaal: 0, open: 0, afgewerkt: 0, ingepland: 0, afgerond: 0 };
  for (const k of kaarten || []) {
    if (!k) continue;
    t.totaal += 1;
    const st = String(k.status || '');
    if (OPEN.has(st)) t.open += 1;
    else if (st === 'ingepland') { t.afgewerkt += 1; t.ingepland += 1; }
    else if (st === 'gearchiveerd') { t.afgewerkt += 1; t.afgerond += 1; }
  }
  return t;
}

/** De secties van een lijst onder 'Nu aan de beurt', in deze volgorde. */
export const LIJST_SECTIES = Object.freeze(['terugbellen', 'verlopen', 'bezig', 'wacht', 'later', 'ingepland', 'afgerond']);

/**
 * Wat het scherm van één lijst toont, uit de uitvoer van stelPottenSamen()
 * op alleen de kaarten van die lijst:
 *   items   — wie NU aan de beurt is (de belrij van de lijst, zelfde secties)
 *   secties — de rest per pot, zonder wie al in items staat
 *
 * @param {object} p
 * @param {object} p.lijst  rij uit opvolging_leads_lijsten
 * @param {object} p.uit    stelPottenSamen()-uitvoer
 * @param {object[]} p.kaarten de ruwe kaarten van de lijst (voor de telling)
 */
export function lijstWeergave({ lijst, uit, kaarten }) {
  const potten = (uit && uit.potten) || {};
  const items = potten.belrij || [];
  const inBelrij = new Set(items.map((r) => r && r.kaart && r.kaart.taak_id).filter(Boolean));
  const secties = {};
  for (const s of LIJST_SECTIES) {
    secties[s] = (potten[s] || []).filter((r) => !(r.kaart && inBelrij.has(r.kaart.taak_id)));
  }
  const belrij = (uit && uit.belrij) || {};
  return {
    lijst: lijstKop(lijst, kaarten, belrij),
    items,
    secties,
    belrij,
  };
}

/** De kop van een lijst zoals de chip en het scherm hem nodig hebben. */
export function lijstKop(lijst, kaarten, belrij) {
  const l = lijst || {};
  return {
    id: l.id,
    naam: l.naam,
    status: l.status || LIJST_STATUS_ACTIEF,
    created_at: l.created_at || null,
    gearchiveerd_at: l.gearchiveerd_at || null,
    telling: lijstTelling(kaarten),
    nu: belrij ? (belrij.dringend || 0) : 0,
  };
}

/**
 * Alle lijsten lezen. Fail-soft: ontbreekt de tabel, dan `beschikbaar: false`
 * (de algemene flow werkt dan gewoon); een andere leesfout geeft `fout`.
 */
export async function leesLijsten(db) {
  const { data, error } = await db.from(TABEL_LIJSTEN)
    .select('id, naam, status, created_at, gearchiveerd_at, aangemaakt_door, gearchiveerd_door')
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) {
    if (tabelOntbreekt(error)) return { beschikbaar: false, lijsten: [], fout: null };
    return { beschikbaar: true, lijsten: [], fout: error.message || String(error) };
  }
  return { beschikbaar: true, lijsten: data || [], fout: null };
}

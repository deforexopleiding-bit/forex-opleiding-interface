// api/_lib/iris/belrij-bronnen.js
//
// De belrij krijgt drie bronnen, en één persoon mag maar één keer op de lijst.
//
// ── WAT HIER WEL EN NIET IN ZIT ──────────────────────────────────────────────
// Dit bestand is puur: geen supabase-import, geen tijdzone-bibliotheek, geen
// netwerk. Het zet een rij uit een bronsysteem om in een kandidaat, en voegt
// kandidaten samen per persoon. Het LEZEN uit de drie bronnen en het wegschrijven
// staan in api/_lib/iris/belrij-vullen.js, zodat deze regels zonder databank
// te toetsen zijn.
//
// ── DE DRIE BRONNEN ──────────────────────────────────────────────────────────
//   a. bel-taken van de wanbetalers — pending_actions met
//      action_type='MANUAL_FOLLOWUP' en payload->>kind='call'. Dat dekt óók wat
//      de aanmaanmotor als bellen markeert: die zet kind='call' zelf al bij een
//      taak die met "Bel klant" begint (api/_lib/dunning-step-executors.js).
//      ALLEEN LEZEN — aan de wanbetalersmodule verandert niets.
//   b. mentorsignalen — iris_signalen (de kopie van hlms_signaal) waarvan het
//      voorstel 'belrij_toevoegen' is, en die nog niet verwerkt zijn.
//   c. verlopen opvolgingen — iris_opvolgingen met status 'verlopen'.
//
// ── WAAROM 'geen_reactie' VOOR EEN VERLOPEN OPVOLGING ────────────────────────
// iris_belrij.bron heeft een CHECK met vijf waarden. Een zesde waarde erbij
// zetten betekent de constraint droppen en opnieuw aanmaken op een tabel die in
// productie staat. Dat hoeft niet: een opvolging verloopt juist omdát er geen
// reactie kwam binnen het venster, en 'geen_reactie' leest al als "Reageert niet
// op berichten". De bron_sleutel (`opvolging:<id>`) houdt wél bij waar het
// vandaan komt, dus er gaat geen herkomst verloren.
//
// ── PRIVACY ──────────────────────────────────────────────────────────────────
// Er komt geen telefoonnummer en geen berichttekst in een kandidaat. `detail` is
// een korte omschrijving, afgekapt op DETAIL_MAX, en wordt nooit gelogd.

/** Hoe hard iets dringt. Hoger gaat eerder. Bewust dezelfde schaal als iris_belrij.prioriteit. */
export const BRON_PRIORITEIT = Object.freeze({
  wanbetaler: 70,
  mentorsignaal: 60,
  geen_reactie: 50,
  onboarding: 40,
  hand: 50,
});

/** Een reden_detail langer dan dit zegt niets meer op een kaart, en is wél een lek-risico. */
export const DETAIL_MAX = 200;

/** De prefixen van bron_sleutel. Eén plek, zodat de vuller en de toetsen niet uit elkaar lopen. */
export const SLEUTEL_PREFIX = Object.freeze({
  beltaak: 'pending_action',
  signaal: 'signaal',
  opvolging: 'opvolging',
  hand: 'hand',
});

/**
 * De prefixen die de VULLER beheert.
 *
 * Alleen deze mag hij afvinken als een bron ze niet meer aanlevert. Een reden
 * die een mens met de hand heeft toegevoegd (`hand:…`) levert geen bron aan en
 * zou dus bij elke ronde meteen op verwerkt gezet worden — die verdwijnt dan
 * van de kaart terwijl degene die hem zette denkt dat hij er staat.
 */
export const BEHEERDE_PREFIXEN = Object.freeze([
  SLEUTEL_PREFIX.beltaak,
  SLEUTEL_PREFIX.signaal,
  SLEUTEL_PREFIX.opvolging,
]);

/** Het systeem vóór de dubbele punt. Zonder prefix is het geen beheerde sleutel. */
export function prefixVan(bronSleutel) {
  const i = String(bronSleutel ?? '').indexOf(':');
  return i > 0 ? String(bronSleutel).slice(0, i) : null;
}

const kort = (s, max = DETAIL_MAX) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** `<systeem>:<id>`. Zonder id geen sleutel — en zonder sleutel geen kandidaat. */
export function bronSleutelVan(systeem, id) {
  const s = String(systeem || '').trim();
  const i = String(id ?? '').trim();
  if (!s || !i) return null;
  return `${s}:${i}`;
}

/**
 * Bel-taak van de wanbetalers → kandidaat.
 *
 * `contact_id` komt NIET uit pending_actions (die kent alleen customer_id); de
 * aanroeper legt de brug van customer_id naar iris_contacten en geeft het mee.
 * Zonder contact geen kandidaat: een belrij-rij zonder contact is een rij waar
 * niemand een nummer bij kan vinden.
 */
export function uitBeltaak(rij, { contactId = null } = {}) {
  if (!rij?.id || !contactId) return null;
  const p = (rij.payload && typeof rij.payload === 'object') ? rij.payload : {};
  const sleutel = bronSleutelVan(SLEUTEL_PREFIX.beltaak, rij.id);
  if (!sleutel) return null;
  return {
    contact_id: contactId,
    bron: 'wanbetaler',
    bron_sleutel: sleutel,
    reden: 'wanbetaler',
    detail: kort(p.title || p.reason || p.note),
    bron_link: `/modules/open-acties.html#taak-${rij.id}`,
    prioriteit: BRON_PRIORITEIT.wanbetaler,
    gezet_op: rij.scheduled_for || rij.created_at || null,
  };
}

/**
 * Mentorsignaal → kandidaat.
 *
 * Alleen signalen waarvan het voorstel 'belrij_toevoegen' is. Welke types dat
 * zijn staat in VOORSTEL_PER_TYPE in signalen.js — dus niet hier nog een keer,
 * want twee lijsten lopen uit elkaar.
 */
export function uitSignaal(rij) {
  if (!rij?.id || !rij.contact_id) return null;
  const sleutel = bronSleutelVan(SLEUTEL_PREFIX.signaal, rij.id);
  if (!sleutel) return null;
  const type = String(rij.type || '').trim() || 'onbekend';
  return {
    contact_id: rij.contact_id,
    bron: 'mentorsignaal',
    bron_sleutel: sleutel,
    reden: 'mentorsignaal',
    detail: kort(rij.toelichting || `${type}${rij.mentor_naam ? ` — ${rij.mentor_naam}` : ''}`),
    bron_link: `/modules/klanten-v2/?v2preview=iris#iris/dossier/${rij.contact_id}`,
    prioriteit: BRON_PRIORITEIT.mentorsignaal,
    gezet_op: rij.signaal_op || null,
  };
}

/**
 * Verlopen opvolging → kandidaat.
 *
 * Een opvolging op een gesprek heeft wel een gesprek_id maar niet altijd een
 * contact_id; de aanroeper vult die aan uit het gesprek. Lukt dat niet, dan geen
 * kandidaat — raden naar wie het is, is precies hoe iemand de verkeerde persoon
 * belt.
 */
export function uitOpvolging(rij, { contactId = null } = {}) {
  const cid = rij?.contact_id || contactId;
  if (!rij?.id || !cid) return null;
  const sleutel = bronSleutelVan(SLEUTEL_PREFIX.opvolging, rij.id);
  if (!sleutel) return null;
  return {
    contact_id: cid,
    bron: 'geen_reactie',
    bron_sleutel: sleutel,
    reden: 'geen_reactie',
    detail: kort(rij.omschrijving),
    bron_link: rij.gesprek_id
      ? `/modules/klanten-v2/?v2preview=iris#iris/gesprek/${rij.gesprek_id}`
      : `/modules/klanten-v2/?v2preview=iris#iris/dossier/${cid}`,
    prioriteit: BRON_PRIORITEIT.geen_reactie,
    gezet_op: rij.tot || null,
  };
}

/**
 * Kandidaten → één regel per persoon.
 *
 * De prioriteit van de rij is de HOOGSTE van zijn redenen: wie om een
 * factuurreden én een mentorsignaal gebeld moet worden, hoort niet lager in de
 * lijst te staan dan iemand met alleen dat mentorsignaal. De `bron` van de rij
 * is die van de zwaarst wegende reden, zodat de eigenaarsregel (deel 2) iets
 * heeft om op te beslissen.
 *
 * Redenen met dezelfde bron_sleutel worden ontdubbeld: twee ronden die hetzelfde
 * bron-item aanbieden mogen niet twee regels opleveren.
 *
 * De volgorde binnen `redenen` is die van aanlevering, met de zwaarste vooraan —
 * dus stabiel, en niet afhankelijk van hoe de databank de rijen teruggaf.
 */
export function voegSamen(kandidaten) {
  const perPersoon = new Map();
  for (const k of (kandidaten || [])) {
    if (!k || !k.contact_id || !k.bron_sleutel) continue;
    let rij = perPersoon.get(k.contact_id);
    if (!rij) {
      rij = { contact_id: k.contact_id, prioriteit: 0, bron: 'hand', redenen: [], _sleutels: new Set() };
      perPersoon.set(k.contact_id, rij);
    }
    if (rij._sleutels.has(k.bron_sleutel)) continue;
    rij._sleutels.add(k.bron_sleutel);
    rij.redenen.push({
      bron: k.bron,
      bron_sleutel: k.bron_sleutel,
      reden: k.reden,
      reden_detail: k.detail || null,
      bron_link: k.bron_link || null,
      prioriteit: Number(k.prioriteit) || 0,
    });
  }

  const uit = [];
  for (const rij of perPersoon.values()) {
    rij.redenen.sort((a, b) => (b.prioriteit - a.prioriteit) || a.bron_sleutel.localeCompare(b.bron_sleutel));
    rij.prioriteit = rij.redenen.length ? rij.redenen[0].prioriteit : 0;
    rij.bron = rij.redenen.length ? rij.redenen[0].bron : 'hand';
    delete rij._sleutels;
    uit.push(rij);
  }
  uit.sort((a, b) => (b.prioriteit - a.prioriteit) || String(a.contact_id).localeCompare(String(b.contact_id)));
  return uit;
}

/**
 * Welke redenen van een bestaande rij gelden niet meer?
 *
 * `bestaand` zijn de onverwerkte redenen in de databank, `nu` de sleutels die de
 * bronnen deze ronde nog aanleveren. Wat in de eerste zit en niet in de tweede,
 * is afgehandeld in zijn bronsysteem en hoort `verwerkt_op` te krijgen — maar
 * ALLEEN als het een sleutel is die de vuller beheert. Een reden die een mens
 * met de hand toevoegde heeft geen bronsysteem dat hem kan aanleveren, en zou
 * er dus bij de eerste ronde weer af vliegen.
 *
 * Dit is met opzet geen DELETE: een reden die ooit gold is een stuk geschiedenis
 * van waarom er gebeld is.
 */
export function vervallenRedenen(bestaand, nu, { beheerd = BEHEERDE_PREFIXEN } = {}) {
  const nog = new Set((nu || []).filter(Boolean));
  const mijn = new Set(beheerd || []);
  return (bestaand || [])
    .filter((r) => r && r.bron_sleutel && !nog.has(r.bron_sleutel))
    // Alleen wat de vuller zelf beheert. Een `hand:`-reden levert geen bron
    // aan en zou anders bij de eerste ronde verdwijnen van de kaart.
    .filter((r) => mijn.has(prefixVan(r.bron_sleutel)))
    .map((r) => r.id)
    .filter(Boolean);
}

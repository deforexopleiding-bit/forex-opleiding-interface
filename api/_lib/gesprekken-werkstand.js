// api/_lib/gesprekken-werkstand.js
//
// Waar een gesprek op wacht, en of er vandaag een belofte loopt.
//
// ── HET GAT ──────────────────────────────────────────────────────────────────
// De gesprekslijst kon filteren op status en op zoeken. Wat ontbrak is precies
// waar je op wilt filteren als je 's ochtends begint: wacht dit op ONS of op de
// KLANT, en wie heeft er vandaag iets beloofd. Gat G5 uit de audit.
//
// Die gegevens bestonden al. `iris_gesprekken` houdt per gesprek bij waar het
// op wacht (cron-iris-werk zet 'wacht_op_ons' zodra er iets binnenkomt,
// iris-verstuur zet 'wacht_op_klant' zodra er iets uitgaat), en
// `iris_beloftes` houdt de toezeggingen bij met een datum. Ze werden alleen
// niet gelezen door het scherm dat ze nodig heeft.
//
// ── WAAROM NIET DE STATUS 'belofte_loopt' ────────────────────────────────────
// Die staat wel in de tabel maar wordt door niets gezet. Een filter daarop zou
// altijd leeg zijn, en een filter die altijd leeg is leert je dat het scherm
// niet klopt. Daarom kijken we naar de beloftes zelf: een rij in
// `iris_beloftes` met status 'actief' en een datum van vandaag.
//
// ── WAAROM IN BLOKKEN ────────────────────────────────────────────────────────
// De lijst kan tot 1000 gesprekken teruggeven. Een `.in()` met 1000 sleutels
// van ruim veertig tekens wordt een URL van tientallen kilobytes, en die knapt
// ergens tussen PostgREST en de proxy — niet met een nette fout, maar met een
// lege lijst of een 414. In blokken van 150 gebeurt dat niet, en bij de 115
// gesprekken van vandaag is het gewoon één blok.

/** Grootte van één blok sleutels per opvraging. */
export const BLOK = 150;

/**
 * De sleutel waarmee een WhatsApp-gesprek in iris_gesprekken staat.
 *
 * Zie de migratie: `whatsapp:<whatsapp_conversations.id>`. Dat is de enige
 * brug tussen de twee tabellen; typ je 'm ergens anders nog eens over, dan
 * loopt hij een keer uit de pas.
 */
export function werkSleutel(conversationId) {
  const id = String(conversationId ?? '').trim();
  return id ? `whatsapp:${id}` : null;
}

/**
 * Hak een lijst in blokken.
 *
 * @param {Array} lijst
 * @param {number} [grootte]
 * @returns {Array<Array>}
 */
export function inBlokken(lijst, grootte = BLOK) {
  const arr = Array.isArray(lijst) ? lijst.filter(Boolean) : [];
  const n = Number(grootte);
  const stap = Number.isFinite(n) && n > 0 ? Math.trunc(n) : BLOK;
  const uit = [];
  for (let i = 0; i < arr.length; i += stap) uit.push(arr.slice(i, i + stap));
  return uit;
}

/**
 * Loopt er vandaag een belofte?
 *
 * Vandaag is hier de LOKALE dag, niet de UTC-dag. Met toISOString() zou een
 * belofte voor morgen er om half elf 's avonds al als "vandaag" uitzien, en om
 * één uur 's nachts zou die van vandaag al verlopen lijken. Dat is de
 * off-by-one waar dit project al eerder op stukliep.
 */
export function isVandaag(datum, nu = new Date()) {
  if (!datum) return false;
  const d = String(datum).trim();
  // Een date-kolom komt als 'JJJJ-MM-DD' terug; dat vergelijken we als tekst,
  // want er zit geen tijd en dus ook geen tijdzone in.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return false;
  const klok = nu instanceof Date && !Number.isNaN(nu.getTime()) ? nu : new Date();
  const jaar = klok.getFullYear();
  const maand = String(klok.getMonth() + 1).padStart(2, '0');
  const dag = String(klok.getDate()).padStart(2, '0');
  return m[1] === String(jaar) && m[2] === maand && m[3] === dag;
}

/**
 * Plak de werkstand aan een lijstregel.
 *
 * Zuiver, zodat te testen is wat een regel krijgt zonder database. Een gesprek
 * dat Iris nog niet gezien heeft krijgt `null` als stand — uitdrukkelijk niet
 * 'nieuw', want dat zou betekenen dat we iets beweren wat we niet weten.
 *
 * @param {object} regel            de lijstregel (heeft .id)
 * @param {Map} standen             sleutel -> rij uit iris_gesprekken
 * @param {Map} namen               profiles.id -> naam
 * @param {Set} contactenMetBelofte contact_id's met een actieve belofte vandaag
 */
export function metWerkstand(regel, standen, namen, contactenMetBelofte) {
  const uit = { ...(regel || {}) };
  const sleutel = werkSleutel(uit.id);
  const stand = sleutel && standen ? standen.get(sleutel) : null;

  uit.iris_status = stand?.status || null;
  uit.toegewezen_aan = stand?.toegewezen_aan || null;
  uit.toegewezen_naam = (uit.toegewezen_aan && namen) ? (namen.get(uit.toegewezen_aan) || null) : null;
  uit.belofte_vandaag = !!(stand?.contact_id && contactenMetBelofte && contactenMetBelofte.has(stand.contact_id));
  return uit;
}

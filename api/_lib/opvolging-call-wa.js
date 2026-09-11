// api/_lib/opvolging-call-wa.js
//
// WHATSAPP-BERICHTEN ALS POGINGEN, VOOR EEN LEAD ZONDER OPVOLGTAAK.
//
// ── HET GAT ──────────────────────────────────────────────────────────────
// De twee vensters (spraakbericht vóór 09:00, nabellen tussen 12 en 13) worden
// beoordeeld op `opvolging_pogingen`, en die rijen hangen aan een TAAK. Een
// zoomlead heeft meestal geen taak: hij boekte zelf een call en kwam nooit in
// de werklijst. api/opvolging-whatsapp-webhook.js gooide zo'n bericht dan ook
// weg — `if (!taak) return gekoppeld:false` — en dus was er niets om op te
// rekenen.
//
// Gemeten op 10 september: de brug liet de nummers gewoon door (118 op
// webhook.verstuurd, 36 doorgelaten op message_create), maar
// /api/opvolging-whatsapp-gesprek?nummer= gaf nul regels voor Rani
// (31641440096), Nadia (32494113391), Nive (32484533550) en Claudia
// (31624270002). Het scherm zei daarom '7 ingeplande calls, maar geen ervan
// staat in de takenlijst' — een nul die eruitzag als een meting.
//
// ── DE OPLOSSING, EN WAAROM ZE HIER STAAT ────────────────────────────────
// De webhook bewaart een bericht van een onbekend nummer voortaan wél als
// gespreksregel (`opvolging_wa_berichten`, taak_id NULL). Deze module maakt van
// zo'n regel een poging-vórmig object, zodat de BESTAANDE beoordeelSpraak() en
// beoordeelNabel() er gewoon op kunnen rekenen. Er komt dus geen tweede
// definitie van 'op tijd' bij — dat is precies wat er niet mag gebeuren.
//
// GEEN RIJ IN opvolging_pogingen. Een poging hoort bij een kaart; er een
// schrijven zonder taak zou een taak-loze telling opleveren die nergens
// zichtbaar is en de dekking van iemand anders kan vervuilen. Het bericht
// staat in het gesprek, en hier wordt het pas op het moment van rekenen tot
// poging omgevormd.

/**
 * Wat WhatsApp een ingesproken bericht noemt. Tweeling van dezelfde set in
 * api/opvolging-whatsapp-webhook.js — die beslist wat er als 'spraakbericht' in
 * de pogingen komt, deze doet hetzelfde voor een regel zonder taak. Lopen ze
 * uiteen, dan telt hetzelfde bericht mét en zónder kaart anders.
 */
export const SPRAAK_TYPES = new Set(['ptt', 'audio', 'voice']);

/** Alleen cijfers, en een internationale 00-prefix eraf. Tweeling van telCijfers. */
export function normaliseerNummer(s) {
  const c = String(s == null ? '' : s).replace(/\D/g, '');
  if (!c) return null;
  return c.startsWith('00') ? (c.slice(2) || null) : c;
}

/**
 * Een gespreksregel als poging-vormig object.
 *
 * Draagt precies de vier velden waar beoordeelSpraak/beoordeelNabel op lezen:
 * `soort`, `richting`, `tijdstip` — plus `bron` zodat je in een dump ziet dat
 * deze poging niet uit opvolging_pogingen komt.
 *
 * Geen `taak_id`: er is er geen, en er een verzinnen zou de rij in tellingen
 * laten opduiken die over kaarten gaan.
 */
export function regelAlsPoging(r) {
  const spraak = SPRAAK_TYPES.has(String((r && r.media_type) || '').toLowerCase());
  return {
    soort   : spraak ? 'spraakbericht' : 'whatsapp',
    richting: (r && r.richting) === 'in' ? 'in' : 'uit',
    tijdstip: r ? r.tijdstip : null,
    bron    : 'wa_bericht',
  };
}

/**
 * De gespreksregels die bij dit telefoonnummer horen.
 *
 * Eerst exact op de volle cijferreeks, dan op de laatste negen — het CRM
 * noteert nummers ook lokaal terwijl WhatsApp altijd met landcode aankomt.
 * Zie CLAUDE.md lesson 18.
 *
 * Anders dan bij het zoeken van een TAAK is een dubbele treffer hier geen
 * probleem: we koppelen een bericht aan een nummer, niet aan een persoon, en
 * twee regels van hetzelfde nummer zijn gewoon twee berichten.
 */
export function regelsVoorNummer(regels, tel) {
  const doel = normaliseerNummer(tel);
  if (!doel) return [];
  const staart = doel.length >= 9 ? doel.slice(-9) : null;
  return (Array.isArray(regels) ? regels : []).filter((r) => {
    const c = normaliseerNummer(r && r.nummer);
    if (!c) return false;
    if (c === doel) return true;
    return !!staart && c.length >= 9 && c.slice(-9) === staart;
  });
}

/** De pogingen die bij dit nummer horen, klaar voor beoordeelSpraak/beoordeelNabel. */
export function waPogingenVoorNummer(regels, tel) {
  return regelsVoorNummer(regels, tel).map(regelAlsPoging);
}

/**
 * De gespreksregels van een periode.
 *
 * GEEN TEKST. Het scherm en het rapport hebben alleen nodig WANNEER er iets
 * ging en van welk soort; de inhoud van een gesprek hoort in het gesprekspaneel
 * en niet in een telling. Dat scheelt ook een hoop bytes op een weekrapport.
 *
 * Gooit niet: bij een leesfout komt `{ regels: [], fout }` terug zodat de
 * aanroeper er een BLINDE VLEK van kan maken. Een lege lijst als 'er ging geen
 * spraakbericht' laten lezen zou precies het verwijt opleveren dat we niet
 * mogen maken.
 */
export async function haalWaRegels(db, vanIso, totIso) {
  try {
    const { data, error } = await db
      .from('opvolging_wa_berichten')
      .select('nummer, richting, media_type, tijdstip')
      .gte('tijdstip', vanIso)
      .lt('tijdstip', totIso)
      .order('tijdstip', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    return { regels: data || [], fout: null };
  } catch (e) {
    console.warn('[opvolging-call-wa] regels lezen:', e?.message || e);
    return { regels: [], fout: e?.message || String(e) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DE KAART ZIET OOK WAT ER VÓÓR HEM GEBEURDE
// ═══════════════════════════════════════════════════════════════════════════
//
// ── GEMETEN OP 11 SEPTEMBER, ±12:15 ─────────────────────────────────────
// Rony Van Hecke en Redouane Jerroudi (reden zoom_nabellen, kaart gemaakt om
// 10:00 UTC door de 12u-instroom): de KAARTTEKST zegt 'geen reactie op het
// spraakbericht van 07:16 / 07:13', en dezelfde kaart toont de chips
// '🎤 geen spraakbericht' en '💬 geen WhatsApp'. /api/opvolging-taken gaf voor
// allebei `pogingen: []` en `wa_totaal: 0`. Daniel Vleeshakker (no_show_call,
// kaart 07:56 UTC) droeg alleen zijn twee calls van 09:58/09:59; het
// spraakbericht van 05:04 en de WhatsApp van 05:05 ontbraken.
//
// Dezelfde berichten stonden WEL goed in /api/opvolging-agenda.
//
// ── DE OORZAAK ──────────────────────────────────────────────────────────
// api/opvolging-whatsapp-webhook.js schrijft twee dingen:
//
//   opvolging_pogingen     de TELLING — alleen als er op dat moment een taak is
//   opvolging_wa_berichten de gespreksregel — ALTIJD, met taak_id of NULL
//
// api/opvolging-taken.js las uitsluitend `opvolging_pogingen` op het eigen
// taak_id. Een bericht dat vóór het bestaan van de kaart ging heeft geen
// poging, dus zag de kaart het niet. De agenda toonde het wel omdat die de
// tweede bron al leest — dat is precies het verschil.
//
// ── WAAROM LEZEN EN NIET ADOPTEREN ──────────────────────────────────────
// De andere weg was: bij het aanmaken van een kaart de taak_id-loze regels van
// dat nummer overschrijven. Drie bezwaren, en ze wegen samen zwaarder dan het
// gemak:
//
//   1. Het herschrijft historische rijen, en dan is de oorspronkelijke stand
//      weg als de regel ooit anders moet.
//   2. Het vraagt een inhaalquery voor alles wat er nu al staat.
//   3. Twee kaarten die vlak na elkaar voor hetzelfde nummer ontstaan (de
//      12u-instroom en een no-show-afronding op dezelfde dag) vechten om
//      dezelfde rijen.
//
// Lezen heeft geen van drieën, en het werkt meteen voor alles wat er al staat.
//
// ── EN WAAROM NIETS DUBBEL TELT ─────────────────────────────────────────
// Een bericht dat al een poging heeft, heeft per definitie een `taak_id` op
// zijn gespreksregel — de webhook schrijft ze in één adem. Een kaart telt dus:
//
//   · zijn eigen rijen uit opvolging_pogingen, plus
//   · de gespreksregels van zijn nummer met taak_id NULL.
//
// Die twee verzamelingen kunnen elkaar niet overlappen. Hangt een regel later
// alsnog aan een taak, dan valt hij hier vanzelf weg en telt hij nog steeds
// één keer — via de poging.
//
// Regels die aan een ÁNDERE kaart hangen blijven er bewust buiten. Anders
// bloedt de archiveerregel van een oude kaart door in een nieuwe, en dan telt
// iemand zijn moeite van vorige maand mee voor het werk van vandaag.

/**
 * De gespreksregels die deze kaart mag meetellen.
 *
 * @param {Array}   regels  uit opvolging_wa_berichten (met taak_id!)
 * @param {?string} taakId  de kaart zelf; zijn eigen regels hebben al een poging
 */
export function losseRegelsVoor(regels, taakId) {
  return (Array.isArray(regels) ? regels : []).filter((r) => {
    const t = r && r.taak_id;
    // NULL/undefined = nog van niemand. Alles met een taak_id hoort daar, en
    // daar staat de poging al.
    return t == null;
  });
}

/**
 * De volledige historie van één kaart: eigen pogingen plus de losse
 * gespreksregels van hetzelfde nummer, op tijd gesorteerd.
 *
 * De uitvoer gaat rechtstreeks naar telPogingen() en naar beoordeelSpraak/
 * beoordeelNabel op het scherm. Er komt dus geen tweede definitie bij van 'wat
 * telt mee' — dat is precies wat opvolging-poging-telling.js wil voorkomen.
 *
 * @param {Array}  pogingen  de rijen uit opvolging_pogingen van deze taak
 * @param {Array}  regels    alle gelezen gespreksregels (van iedereen)
 * @param {object} taak      draagt id en telefoon
 */
export function volledigeHistorie(pogingen, regels, taak) {
  const eigen = Array.isArray(pogingen) ? pogingen : [];
  const tel = taak && taak.telefoon;
  if (!tel) return eigen;

  const los = regelsVoorNummer(losseRegelsVoor(regels, taak && taak.id), tel).map(regelAlsPoging);
  if (los.length === 0) return eigen;

  return [...eigen, ...los].sort((a, b) => {
    const x = Date.parse(a && a.tijdstip) || 0;
    const y = Date.parse(b && b.tijdstip) || 0;
    return x - y;
  });
}

/**
 * De gespreksregels voor een lijst kaarten, in één lezing.
 *
 * Op tijdvenster en niet op nummer: de nummers staan genormaliseerd in de ene
 * tabel en met landcode in de andere, en een `.in('nummer', …)` zou juist de
 * gevallen missen waar het om gaat (zie CLAUDE.md lesson 18). Filteren doet
 * regelsVoorNummer, in JS, met dezelfde laatste-negen-regel als de rest.
 *
 * `vanafIso` begrenst de lezing. Zonder grens zou dit met de jaren elke
 * kaartlezing zwaarder maken; kaarten leven kort (de nachtelijke doorrol) dus
 * een venster van enkele weken dekt alles wat een kaart kan zien.
 *
 * NOOIT STIL AFKAPPEN. Loopt de lezing tegen de limiet, dan komt dat als
 * `afgekapt` terug zodat de aanroeper het kan melden in plaats van een te lage
 * telling als meting te laten lezen.
 */
export const WA_REGELS_LIMIET = 5000;

export async function haalWaRegelsVanaf(db, vanafIso) {
  try {
    const { data, error } = await db
      .from('opvolging_wa_berichten')
      .select('nummer, taak_id, richting, media_type, tijdstip')
      .gte('tijdstip', vanafIso)
      .order('tijdstip', { ascending: true })
      .limit(WA_REGELS_LIMIET);
    if (error) throw new Error(error.message);
    const regels = data || [];
    return { regels, fout: null, afgekapt: regels.length >= WA_REGELS_LIMIET };
  } catch (e) {
    console.warn('[opvolging-call-wa] regels vanaf lezen:', e?.message || e);
    return { regels: [], fout: e?.message || String(e), afgekapt: false };
  }
}

// api/_lib/iris/opdracht-tekst.js
//
// Een opdracht in gewone taal.
//
// ── WAAROM DIT OP DE SERVER STAAT EN NIET IN HET SCHERM ──────────────────────
// Er zijn drie dingen die allemaal "wat is er gebeurd" zeggen — `plan`,
// `verloop` en het `resultaat` per stap — en ze staan in drie vormen. Die
// omzetting naar leesbare regels is logica, geen opmaak, en logica die niemand
// kan narekenen is logica die na een half jaar iets anders zegt dan je denkt.
//
// Dit bestand importeert met opzet NIETS. Daardoor kan een test het laden
// zonder SUPABASE_URL, en dat is in deze reeks al drie keer de reden geweest
// dat een test niet geschreven werd.
//
// ── WAT ER MIS WAS (O-1) ─────────────────────────────────────────────────────
// Maxims enige opdracht stond op "Geregeld", en klapte je hem open dan stond
// er het woord "geregeld" en een knop "Terug openen". Meer niet. Niet omdat er
// niets was: `plan`, `verloop` en `resultaat` worden alle drie geschreven en
// geen van drieën getoond. En het woord "geregeld" was `na_uitvoeren` — een
// enum-waarde die cursief werd afgedrukt alsof het een zin was.
//
// Het plan-blok hing bovendien aan `acties.length`. Zijn er geen iris_acties
// aangemaakt — en dat is precies het geval bij een opdracht die nog op een
// antwoord wacht — dan viel het hele blok weg.

/** Wat een staptype in gewone taal doet. */
export const STAP_LABELS = Object.freeze({
  wa_versturen: 'Een WhatsApp sturen',
  mail_versturen: 'Een mail sturen',
  lms_toegang_verlengen: 'Toegang tot het LMS verlengen',
  lms_uitnodiging: 'De uitnodiging opnieuw sturen',
  lms_on_hold: 'Op pauze zetten of die pauze opheffen',
  belofte_vastleggen: 'Een betaaltoezegging vastleggen',
  afbetalingsplan: 'Een afbetalingsplan voorstellen',
  taak_aanmaken: 'Een taak aanmaken voor een mens',
  belrij_toevoegen: 'Op de belrij zetten',
  factuur_nakijken: 'Laten nakijken of een factuur betaald is',
});

/** Waar een aangemaakte taak te vinden is. Er is (nog) geen link per taak. */
export const TAKEN_URL = '/modules/finance.html?tab=wanbetalers&sub=open-acties&status=PENDING';

/**
 * `na_uitvoeren` als zin.
 *
 * In de databank is dit 'wacht' of 'geregeld'; in het scherm stond het woord
 * zelf, cursief, alsof het een toelichting was. Een enum-waarde is geen zin.
 */
export function naUitvoerenZin(waarde) {
  if (waarde === 'wacht') return 'Iris houdt dit in de gaten en komt erop terug.';
  if (waarde === 'geregeld') return 'Hiermee is het klaar; Iris komt er niet op terug.';
  return null;
}

/**
 * Wat er uit een stap kwam, als leesbare regels.
 *
 * Geeft een array van `{tekst, link?}`. Leeg als er niets bruikbaars in staat —
 * een leeg blok is beter dan een blok met `{"taak_id":"3f2a…"}` erin.
 */
export function resultaatRegels(type, resultaat) {
  if (!resultaat || typeof resultaat !== 'object') return [];
  const r = [];

  if (resultaat.taak_id) {
    r.push({
      tekst: 'Taak aangemaakt',
      link: { href: TAKEN_URL, label: 'Open Acties' },
    });
  }
  if (resultaat.belofte_id) {
    const stukken = [];
    if (resultaat.datum) stukken.push(`op ${resultaat.datum}`);
    if (resultaat.bedrag != null) stukken.push(`€ ${resultaat.bedrag}`);
    r.push({ tekst: `Betaaltoezegging vastgelegd${stukken.length ? ' — ' + stukken.join(', ') : ''}` });
  }
  if (resultaat.belrij_id) {
    r.push({ tekst: 'Op de belrij gezet' });
  }
  if (resultaat.wordt) {
    // Verlengen: was → wordt is het enige dat iemand hier wil weten.
    r.push({
      tekst: resultaat.was
        ? `Toegang loopt nu tot ${resultaat.wordt} (was ${resultaat.was})`
        : `Toegang loopt nu tot ${resultaat.wordt}`,
    });
  }
  return r;
}

/**
 * De stappen van een opdracht, elk met wat ervan terechtkwam.
 *
 * ── DE BRON IS HET PLAN, NIET DE ACTIES ─────────────────────────────────────
 * Wat Iris van plan was, staat in `plan.stappen`. Of er een `iris_acties`-rij
 * bestaat, zegt alleen of iemand die stap al heeft klaargezet. Het plan tonen
 * zodra het er is, is het hele punt: dat is het moment waarop iemand moet
 * kunnen zien wat er gáát gebeuren.
 *
 * Een actie zonder plan-stap (later toegevoegd, of een plan dat herschreven
 * is) verdwijnt niet — die komt er onderaan bij.
 */
export function bouwPlanRegels(plan, acties) {
  const stappen = Array.isArray(plan?.stappen) ? plan.stappen : [];
  const rijen = Array.isArray(acties) ? [...acties] : [];
  const gebruikt = new Set();
  const uit = [];

  for (const s of stappen) {
    const type = String(s?.type || '');
    // Eerste nog ongebruikte actie van hetzelfde type. Niet op volgorde
    // matchen: als stap twee eerder werd klaargezet dan stap één, klopt de
    // index niet meer en zou de verkeerde uitkomst bij de verkeerde stap staan.
    const i = rijen.findIndex((a, idx) => !gebruikt.has(idx) && String(a?.type || '') === type);
    const actie = i >= 0 ? rijen[i] : null;
    if (i >= 0) gebruikt.add(i);
    uit.push(maakRegel(type, s?.omschrijving, s?.wie, actie));
  }

  rijen.forEach((a, idx) => {
    if (gebruikt.has(idx)) return;
    uit.push(maakRegel(String(a?.type || ''), null, null, a));
  });

  return uit;
}

function maakRegel(type, omschrijving, wie, actie) {
  const status = actie?.status || null;
  const fout = actie?.fout || null;
  return {
    type,
    label: STAP_LABELS[type] || type || 'Onbekende stap',
    omschrijving: omschrijving ? String(omschrijving) : null,
    wie: wie ? String(wie) : null,
    actie_id: actie?.id || null,
    status,
    // 'gepland' is niet hetzelfde als 'nog niets klaargezet'. Het eerste
    // betekent dat iemand op Uitvoeren moet drukken, het tweede dat er nog
    // niets bestaat om op te drukken.
    stand: fout ? 'mislukt' : (status === 'uitgevoerd' ? 'gedaan' : (actie ? 'klaargezet' : 'voorgenomen')),
    fout,
    resultaat: resultaatRegels(type, actie?.resultaat),
  };
}

/**
 * Het verloop als tijdlijn, oudste eerst.
 *
 * Elke overgang schrijft hier een regel — opdracht gegeven, plan gemaakt,
 * beantwoord, afgesloten. Het spoor dat maakt dat er nooit iets stil verdwijnt,
 * zegt de tabelbeschrijving. Tot nu toe verdween het spoor zelf stil.
 */
export function bouwVerloop(verloop) {
  if (!Array.isArray(verloop)) return [];
  return verloop
    .filter((r) => r && typeof r === 'object' && r.wat)
    .map((r) => ({
      op: r.op || null,
      wat: String(r.wat),
      door_mens: !!r.wie,
      details: r.details && typeof r.details === 'object' ? r.details : null,
    }));
}

/**
 * Wat je Iris kunt vragen, als knoppen.
 *
 * ── WAAROM DIT BESTOND EN NIET ZICHTBAAR WAS (O-3) ──────────────────────────
 * Het invoerveld had één voorbeeld in de placeholder en verder niets. Wat Iris
 * kan stond wél ergens uitgeschreven -- in de systeemtekst van opdracht.js --
 * maar die lijst gaat naar het taalmodel en niet naar de mens die ervoor zit.
 * Het model wéét wat het kan; jij moest het raden. Dat is de verkeerde kant op.
 *
 * Elke knop noemt het staptype waar hij op leunt. Daar staat een test op: een
 * knop mag alleen verwijzen naar iets dat ook echt uitgevoerd kan worden, en
 * elk uitvoerbaar staptype hoort een knop te hebben. Wordt er iets ingebouwd,
 * dan faalt die test tot er een knop bij staat.
 *
 * De teksten zijn HALVE zinnen. Een hele zin nodigt uit om te versturen wat er
 * staat; een halve dwingt je de naam en de reden zelf in te vullen -- en die
 * mag Iris nooit verzinnen.
 */
export const SNELKNOPPEN = Object.freeze([
  { staptype: 'lms_toegang_verlengen', label: 'Toegang verlengen', tekst: 'Verleng de toegang van ' },
  { staptype: 'belofte_vastleggen', label: 'Betaalafspraak vastleggen', tekst: 'Leg een betaalafspraak vast voor ' },
  { staptype: 'factuur_nakijken', label: 'Factuur nakijken', tekst: 'Kijk na of al betaald is: ' },
  { staptype: 'taak_aanmaken', label: 'Taak aanmaken', tekst: 'Maak een taak aan: ' },
  { staptype: 'belrij_toevoegen', label: 'Op de belrij zetten', tekst: 'Zet op de belrij: ' },
]);

/**
 * Wat hier NIET kan, in één regel onder de knoppen.
 *
 * Zonder deze regel is de enige manier om erachter te komen: het vragen, een
 * plan krijgen, en bij Uitvoeren stuklopen.
 */
export const NIET_HIER_TEKST =
  'Een bericht sturen gaat via de Post, niet via een opdracht.';

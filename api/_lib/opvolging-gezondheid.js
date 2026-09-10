// api/_lib/opvolging-gezondheid.js
//
// DE ZES CONTROLES, ALS PURE FUNCTIES.
//
// Deze week stonden zes keer alle tests groen terwijl productie stuk was, en
// elke keer was de TEST het probleem: hij raakte iets aan wat lijkt op het
// onderwerp in plaats van het onderwerp zelf. Nog meer unit-tests lost dat niet
// op.
//
// Wat het wél oplost is een controle die naar de ECHTE UITKOMST kijkt en zich
// afvraagt of die logisch kan zijn. Niet 'roept de code de juiste functie aan'
// maar 'kan dit getal kloppen'. Elke regressie van deze week had hier binnen een
// dag op afgeketst.
//
// ── DRIE UITKOMSTEN, NOOIT TWEE ────────────────────────────────────────────
// Een controle die niets kon meten is NIET in orde. Dat is de val waar dit hele
// bouwwerk anders opnieuw in loopt: 'geen data gevonden' als groen boeken
// betekent dat een kapotte bron zich voordoet als een gezonde. Vandaar:
//
//   ok           — gemeten, en het klopt.
//   fout         — gemeten, en het klopt niet.
//   niet_gemeten — er viel niets te meten.
//
// EN NIET_GEMETEN IS SMAL. Alleen twee gevallen tellen: (a) we weten VOORAF dat
// we niets kunnen meten — een ontbrekende omgevingsvariabele of koppeling — en
// (b) de meting is leeg: nul rijen, er is niets gebeurd. Een ANTWOORD DAT WE
// KREGEN en dat niet deugt — een 401, een 500, een tijdslimiet, een exception,
// een verminkte vorm — is een FOUT.
//
// Op 7 september riep controle 5 de brug aan met een verzonnen variabelenaam en
// de verkeerde header, kreeg een 401, en boekte die als NIET_GEMETEN. Een echte
// storing verdween zo in de emmer voor ontbrekende configuratie; die controle
// had jaren stil kunnen falen. Vier andere plekken deden hetzelfde en zijn
// tegelijk rechtgezet.
//
// 'niet_gemeten' telt in de mail net zo zwaar als 'fout': allebei betekenen ze
// dat je vandaag niet weet of het goed gaat.
//
// ── ELKE CONTROLE DRAAGT ZIJN GETALLEN ─────────────────────────────────────
// `getallen` is verplicht en gaat mee de mail in. Een controle die alleen 'in
// orde' meldt is niet na te rekenen, en daarmee precies zo'n alibi als de tests
// die we deze week hebben opgeruimd.

export const OK = 'ok';
export const FOUT = 'fout';
export const NIET_GEMETEN = 'niet_gemeten';

const uit = (naam, staat, getallen, uitleg) => ({ naam, staat, getallen, uitleg });

// ═══════════════════════════════════════════════════════════════════════════
// 1 · INSTROOM — slaapt er een verse aanmelding?
// ═══════════════════════════════════════════════════════════════════════════
// Zou de verdwenen ronde A binnen 24 uur gemeld hebben in plaats van na vijf
// dagen. De kaarten van 5 september stonden met due 19 en 22 september in de
// databank; deze controle had ze de volgende ochtend opgesomd.
//
// De regel: een OPEN event-taak zonder ook maar één poging, aangemaakt langer
// dan een dag geleden, mag geen due hebben die verder dan twee dagen weg ligt.
// Twee dagen en niet één, zodat een kaart die net is doorgerold geen vals alarm
// geeft.

export const SLAPER_MAX_DAGEN = 2;

export function controleerInstroom({ taken, vandaag, dagPlus }) {
  const rijen = Array.isArray(taken) ? taken : [];
  if (rijen.length === 0) {
    return uit('instroom', NIET_GEMETEN, { bekeken: 0 },
      'Er staan geen open event-aanmeldingen zonder poging. Er valt dus niets te controleren — dat is iets anders dan goed.');
  }
  const grens = dagPlus(vandaag, SLAPER_MAX_DAGEN);
  const gisteren = dagPlus(vandaag, -1);
  const slapers = rijen.filter((t) =>
    String(t.due || '') > grens && String(t.aangemaakt_op || '') <= gisteren);

  return uit('instroom', slapers.length ? FOUT : OK, {
    bekeken: rijen.length,
    slapend: slapers.length,
    grens,
    namen: slapers.slice(0, 12).map((t) => `${t.naam || '?'} (due ${t.due})`),
  }, slapers.length
    ? `${slapers.length} aanmelding(en) zonder enkele poging staan verder dan ${SLAPER_MAX_DAGEN} dagen vooruit. Ronde A — bellen binnen 24 uur — gebeurt daar niet.`
    : `Alle ${rijen.length} onaangeraakte aanmeldingen staan binnen ${SLAPER_MAX_DAGEN} dagen.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · OPTELLING — kloppen de sommen in het rapport?
// ═══════════════════════════════════════════════════════════════════════════
// Zou de te-kort-teller gevangen hebben: {uit: 9, gesproken: 5, te_kort: 1} —
// vijf plus één is zes, en drie calls vielen in geen enkele emmer.
//
// Twee sommen die per definitie moeten kloppen, niet bij toeval.

export function controleerOptelling({ rapport }) {
  if (!rapport || !rapport.volume || !rapport.volume.bel) {
    // Een antwoord dat we KREGEN en dat niet deugt. Een rapport zonder
    // volume-blok is een kapot rapport, geen blinde vlek.
    return uit('optelling', FOUT, { volume: 'ontbreekt' },
      'Het rapport gaf geen volume-blok terug. Dat is een verminkt antwoord, geen ontbrekende meting.');
  }
  const b = rapport.volume.bel;

  // DE SOM IS MEEGEGAAN MET DE MEETREGEL. Hij was
  // gesproken + te_kort + niet_opgenomen + zonder_duur, en dat klopt sinds
  // 8 september niet meer op twee punten:
  //
  //   · `te_kort` bestaat niet meer — die emmer beweerde iets over de kwaliteit
  //     van een gesprek op basis van duur_sec, en dat getal meet de tijd tussen
  //     kiezen en ophangen.
  //   · `zonder_duur` is geen aparte emmer meer maar een DEELVERZAMELING van
  //     gesproken: er is gesproken, alleen de lengte is niet vastgelegd. Dat
  //     gebeurt bij één op de drie gesprekken.
  //
  // Op de echte dag van 7 september gaf de oude som 21 + 0 + 5 + 5 = 31 bij 26
  // uitgaande calls: FOUT gemeld terwijl de cijfers juist klopten, in een mail
  // die om 07:00 binnenvalt vlak voordat er gebeld wordt. Een bewaker die
  // afgaat als er niets aan de hand is, is binnen een week een bewaker waar
  // niemand meer op reageert.
  //
  // De emmers die elkaar wél uitsluiten en samen `uit` zijn:
  const som = (b.gesproken || 0) + (b.niet_opgenomen || 0)
            + (b.via_ander || 0) + (b.onbekend_resultaat || 0);
  const bevindingen = Array.isArray(rapport.aandacht) ? rapport.aandacht.length : null;

  const fouten = [];
  if (som !== (b.uit || 0)) {
    fouten.push(`de emmers tellen op tot ${som}, maar er zijn ${b.uit} uitgaande calls`);
  }
  if (bevindingen === null) fouten.push('de bevindingenlijst ontbreekt');

  // ONBEKEND_RESULTAAT KRIJGT EEN EIGEN REGEL. Dat is juist de emmer die we
  // hebben ingevoerd om te voorkomen dat een onbekende resultaatwaarde stil als
  // contact meetelt — en de bewaking keek er volledig langs. Het is geen FOUT
  // (de som klopt gewoon), maar het betekent wel dat er een waarde binnenkomt
  // die onze classificatie niet kent, en dat hoort iemand te lezen.
  const onbekend = b.onbekend_resultaat || 0;
  const zonderDuur = b.zonder_duur || 0;
  const staarten = [];
  if (onbekend) {
    staarten.push(`${onbekend} call${onbekend === 1 ? '' : 's'} met een ONBEKEND resultaat — ` +
      'een waarde die de classificatie niet kent, en die dus nergens als contact meetelt');
  }
  if (zonderDuur) {
    staarten.push(`${zonderDuur} van de ${b.gesproken} gesprekken zonder geregistreerde lengte`);
  }

  return uit('optelling', fouten.length ? FOUT : OK, {
    uit: b.uit, gesproken: b.gesproken, niet_opgenomen: b.niet_opgenomen,
    onbekend_resultaat: onbekend, via_ander: b.via_ander || 0,
    zonder_duur: zonderDuur, som, bevindingen,
  }, fouten.length
    ? fouten.join('; ')
    : [`${som} van ${b.uit} calls in de emmers, en ${bevindingen} bevinding(en) in de lijst.`,
       ...staarten].join(' · '));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DUBBELS — staat iemand twee keer in de zoomcall-lijst?
// ═══════════════════════════════════════════════════════════════════════════
// Zou de dubbele Yasmine gevangen hebben: twee afspraakrijen voor dezelfde
// persoon op hetzelfde tijdstip, allebei in de lijst.

export function controleerDubbels({ rapport }) {
  const lijst = rapport && Array.isArray(rapport.zoomcalls) ? rapport.zoomcalls : null;
  if (!lijst) {
    // Idem: geen lijst is iets anders dan een lege lijst. Zie hieronder.
    return uit('dubbels', FOUT, { zoomcalls: 'ontbreekt' },
      'Het rapport gaf geen zoomcall-lijst terug. Dat is een verminkt antwoord, geen ontbrekende meting.');
  }
  if (lijst.length === 0) {
    return uit('dubbels', NIET_GEMETEN, { regels: 0 },
      'Er stonden geen zoomcalls in deze periode. Er valt dus niets te controleren.');
  }

  const perId = new Map();
  const perPersoonTijd = new Map();
  for (const c of lijst) {
    const id = String(c.appointment_id || '');
    perId.set(id, (perId.get(id) || 0) + 1);
    const sleutel = String(c.persoon || c.naam || '?') + '|' + String(c.dag || '') + '|' + String(c.tijd || '');
    perPersoonTijd.set(sleutel, (perPersoonTijd.get(sleutel) || 0) + 1);
  }
  const dubbeleIds = [...perId.entries()].filter(([, n]) => n > 1);
  const dubbeleMomenten = [...perPersoonTijd.entries()].filter(([, n]) => n > 1);

  const stuk = dubbeleIds.length + dubbeleMomenten.length;
  return uit('dubbels', stuk ? FOUT : OK, {
    regels: lijst.length,
    dubbel_op_id: dubbeleIds.length,
    dubbel_op_persoon_en_tijd: dubbeleMomenten.length,
    voorbeelden: dubbeleMomenten.slice(0, 6).map(([k]) => k),
  }, stuk
    ? `${dubbeleIds.length} afspraak-id('s) en ${dubbeleMomenten.length} persoon+tijdstip komen meer dan één keer voor.`
    : `${lijst.length} regels, elk met een eigen afspraak-id en een eigen moment.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · PRINTWEERGAVE — tekent hij, of blijft hij op de laadtekst hangen?
// ═══════════════════════════════════════════════════════════════════════════
// Zou de crash van vanmiddag gevangen hebben — én de oudere build die daarna
// nog werd uitgeleverd. Die twee samen kostten een halve dag.
//
// De beoordeling is puur; het ophalen en uitvoeren gebeurt in de cron.

export function beoordeelPrintweergave({ bereikbaar, fout, html, versie, verwachteVersie, configFout }) {
  if (!bereikbaar) {
    // configFout betekent: wij weten niet WAAR we moeten kijken. Al het andere
    // betekent: we wisten het wel en er kwam geen bruikbare pagina terug — dat
    // is een storing en hoort niet in de emmer voor ontbrekende instellingen.
    return configFout
      ? uit('printweergave', NIET_GEMETEN, { fout: fout || 'onbekend' },
          'De printweergave was niet op te halen: ' + (fout || 'onbekend') + '. Onbekend is niet hetzelfde als goed.')
      : uit('printweergave', FOUT, { fout: fout || 'onbekend' },
          'De printweergave gaf geen bruikbare pagina terug: ' + (fout || 'onbekend') + '.');
  }
  const fouten = [];
  if (fout) fouten.push('uitzondering tijdens het tekenen: ' + fout);
  if (/Rapport wordt opgehaald/.test(String(html || ''))) {
    fouten.push('de pagina bleef op de laadtekst staan');
  }
  if (verwachteVersie && versie && versie !== verwachteVersie) {
    fouten.push(`de uitgeleverde pagina draagt ${versie} terwijl ${verwachteVersie} verwacht wordt — dat is een oudere build`);
  }
  return uit('printweergave', fouten.length ? FOUT : OK, {
    tekens: String(html || '').length, versie: versie || null, verwacht: verwachteVersie || null,
  }, fouten.length ? fouten.join('; ')
    : `De pagina tekende ${String(html || '').length} tekens en draagt ${versie || 'geen merkteken'}.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 · DE WHATSAPP-BRUG — ziet hij iets, en laat hij ook iets door?
// ═══════════════════════════════════════════════════════════════════════════
// Zou de LID-storing gevangen hebben: 92 gebeurtenissen gezien, één
// doorgelaten. Verbonden zijn is niet genoeg — een brug die alles ziet en niets
// doorlaat is net zo stuk als een brug die eruit ligt, alleen stiller.

export function controleerBrug({ status, fout, configFout }) {
  if (!status) {
    // Zie de kop van dit blok: alleen ONTBREKENDE CONFIGURATIE is 'niet
    // gemeten'. Een 401, een 500 of een VPS die niet opneemt zijn storingen.
    // Die twee door elkaar halen laat een echte storing verdwijnen in de bak
    // voor 'nog niet ingesteld' — precies wat op 7 september gebeurde.
    return configFout
      ? uit('brug', NIET_GEMETEN, { fout: fout || 'onbekend' },
          'De brug is niet geconfigureerd: ' + (fout || 'onbekend') + '. Dan weet je niet of er WhatsApp binnenkomt.')
      : uit('brug', FOUT, { fout: fout || 'onbekend' },
          'De brug antwoordde niet: ' + (fout || 'onbekend') + '. Er komt mogelijk geen WhatsApp binnen.');
  }
  // ── DE SLEUTEL HEET `gebeurtenissen`, NIET `tellers` ─────────────────────
  //
  // Dit stond op `status.tellers`, en dat veld bestaat niet. /status geeft de
  // cijfers terug onder `gebeurtenissen` (services/whatsapp-brug/server.js:
  // `gebeurtenissen: wa.tellers()` — de METHODE heet tellers, de sleutel niet).
  //
  // Gevolg: `gezien` was ALTIJD 0, dus deze controle kwam altijd uit op
  // 'niet gemeten', en de tak eronder — gezien > 0 maar doorgelaten = 0 — kon
  // nooit afgaan. Dat is precies de storing van 8 september (de brug zag alles
  // en liet niets door), en de enige bewaker ertegen stond blind.
  //
  // Gemeten op 10 september: de gezondheidscheck zei 'niets gezien sinds de
  // laatste herstart' terwijl /status op datzelfde moment 87 + 165 + 149
  // gebeurtenissen meldde.
  //
  // `tellers` blijft als terugval staan voor een oudere brug op de VPS; die
  // loopt altijd achter op een deploy. tests/opvolging-gezondheid-brug-
  // contract.test.js legt de sleutel vast tegen server.js zodat een hernoeming
  // aan één kant rood wordt in plaats van stil.
  const t = status.gebeurtenissen || status.tellers || null;

  // GEEN TELLERS IS IETS ANDERS DAN NUL GEZIEN. Draait er een brug die dit blok
  // helemaal niet meestuurt, dan hebben we niets gemeten — en dat is een eigen
  // reden, geen '0 gebeurtenissen'.
  if (!t || (!t.gezien && !t.doorgelaten)) {
    return uit('brug', NIET_GEMETEN, { verbonden: status.verbonden === true, tellers: 'ontbreken' },
      'De brug gaf geen tellers terug (andere versie?). Zonder die cijfers valt niet te zeggen of er iets binnenkomt.');
  }

  const gezien = Object.values(t.gezien || {}).reduce((n, v) => n + (Number(v) || 0), 0);
  const door   = Object.values(t.doorgelaten || {}).reduce((n, v) => n + (Number(v) || 0), 0);

  if (status.verbonden !== true) {
    return uit('brug', FOUT, { verbonden: false, gezien, doorgelaten: door },
      'De brug is niet verbonden. Er komt geen enkel WhatsApp-bericht binnen.');
  }
  if (gezien === 0) {
    return uit('brug', NIET_GEMETEN, { verbonden: true, gezien: 0, doorgelaten: door },
      'De brug is verbonden maar heeft sinds de laatste herstart niets gezien. Er valt dus niets te concluderen.');
  }
  if (door === 0) {
    return uit('brug', FOUT, { verbonden: true, gezien, doorgelaten: 0 },
      `De brug zag ${gezien} gebeurtenissen en liet er nul door. Alles valt weg in het filter.`);
  }
  return uit('brug', OK, { verbonden: true, gezien, doorgelaten: door },
    `${door} van ${gezien} gebeurtenissen doorgelaten.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6 · DAGRITME — staat er nog werk van gisteren open?
// ═══════════════════════════════════════════════════════════════════════════
// De hele opvolgmodule rust op één afspraak: wat vandaag op de lijst staat,
// wordt vandaag afgewerkt. Wat blijft liggen rolt 's nachts door naar vandaag
// (cron-opvolging-doorrol), dus na die run hoort er GEEN open taak meer te
// bestaan met een due van vóór vandaag.
//
// Staat er wél zo'n taak, dan is er iets stuk waar deze bewaking voor bedoeld
// is: de doorrol draaide niet, of hij faalde halverwege, of iets schrijft een
// due in het verleden. In alle drie de gevallen ziet Dave die kaart niet meer
// in zijn daglijst — en dat is precies het soort werk dat weken later pas
// opvalt.
//
// GEEN NAMEN IN DE MAIL. Het aantal is genoeg om te weten dát het misgaat, en
// een mail met een lijst leadnamen is een lijst leadnamen in een mailbox. Wie
// wil weten wie het zijn kijkt in de module; deze controle is een alarm, geen
// werklijst.
//
// Gemeten op 10 september: 0. De eerste run hoort dus ok te zijn.

export function controleerDagritme({ taken, vandaag, leesfout }) {
  // KAN HIJ NIET LEZEN, DAN IS HET NIET GEMETEN — en dus nooit 'ok'. Zie de
  // kop van dit bestand: een controle die niets kon meten is niet in orde.
  if (leesfout) {
    return uit('dagritme', NIET_GEMETEN, { fout: String(leesfout).slice(0, 200) },
      'De openstaande taken waren niet te lezen: ' + String(leesfout).slice(0, 200)
      + '. Of er werk van gisteren blijft hangen is dus onbekend.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(vandaag || ''))) {
    return uit('dagritme', NIET_GEMETEN, { fout: 'geen geldige datum' },
      'Zonder de datum van vandaag valt er niets te vergelijken.');
  }

  const rijen = Array.isArray(taken) ? taken : [];
  const achter = rijen.filter((t) => {
    const due = String((t && t.due) || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(due) && due < vandaag;
  });

  // NUL IS HIER WÉL 'OK', en dat is geen tegenspraak met de rest van dit
  // bestand. De meting is de lijst openstaande taken, en die is er: dat er
  // niets achterloopt is een uitkomst, geen leegte.
  return uit('dagritme', achter.length ? FOUT : OK, {
    open   : rijen.length,
    achter : achter.length,
    oudste : achter.length ? achter.map((t) => String(t.due)).sort()[0] : null,
  }, achter.length
    ? `${achter.length} open ta${achter.length === 1 ? 'ak staat' : 'ken staan'} met een due van vóór vandaag. `
      + 'Die staan in geen enkele daglijst. Draaide de nachtelijke doorrol?'
    : `Alle ${rijen.length} open taken staan op vandaag of later.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// DE MAIL
// ═══════════════════════════════════════════════════════════════════════════
// Elke dag één, ook als alles goed is. Een bewaker waarvan je nooit iets hoort
// is niet te onderscheiden van een bewaker die stuk is — en dat is precies de
// vorm die we deze week zes keer hebben gehad.
//
// De onderwerpregel draagt het oordeel, zodat een goede dag één blik kost. De
// tekst draagt de GETALLEN, want een mail die alleen 'in orde' zegt is niet na
// te rekenen.

export function bouwMail({ uitkomsten, dag }) {
  const fouten = uitkomsten.filter((u) => u.staat === FOUT);
  const ongemeten = uitkomsten.filter((u) => u.staat === NIET_GEMETEN);
  const goed = uitkomsten.filter((u) => u.staat === OK);

  const kop = fouten.length
    ? `[Opvolging] ${fouten.length} ${fouten.length === 1 ? 'probleem' : 'problemen'} — ${dag}`
    : ongemeten.length
      ? `[Opvolging] ${goed.length}/${uitkomsten.length} in orde, ${ongemeten.length} niet gemeten — ${dag}`
      : `[Opvolging] ${goed.length}/${uitkomsten.length} in orde — ${dag}`;

  const regel = (u) => {
    const merk = u.staat === FOUT ? '[FOUT]' : u.staat === NIET_GEMETEN ? '[NIET GEMETEN]' : '[ok]';
    const g = Object.entries(u.getallen || {})
      .map(([k, v]) => `${k}=${Array.isArray(v) ? (v.length ? v.join(' · ') : '—') : v}`)
      .join('  ');
    return `${merk} ${u.naam}\n    ${u.uitleg}\n    ${g}`;
  };

  const tekst =
    `Gezondheidscontrole opvolging — ${dag}\n` +
    `Gemeten tegen de productiedatabase en de live endpoints.\n\n` +
    uitkomsten.map(regel).join('\n\n') +
    `\n\n---\n` +
    `'niet gemeten' telt hier even zwaar als 'fout': allebei betekenen ze dat je\n` +
    `vandaag niet weet of het goed gaat.\n`;

  return { subject: kop, text: tekst };
}

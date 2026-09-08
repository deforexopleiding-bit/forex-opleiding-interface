// api/_lib/opvolging-gezondheid.js
//
// DE ZEVEN CONTROLES, ALS PURE FUNCTIES.
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
  const t = status.tellers || {};
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
// 6 · HET DAGRITME — staat er een open kaart in het verleden?
// ═══════════════════════════════════════════════════════════════════════════
// Zou de verdwenen doorrol dezelfde ochtend gemeld hebben. De nachtelijke cron
// zette elke openstaande kaart op MORGEN terwijl het in Amsterdam al de nieuwe
// dag was, waardoor iedereen precies een dag oversloeg: de vijf leads van 7
// september stonden op de 9e, en op de 8e dus nergens. Deze controle draait om
// 07:00, meteen na de doorrol, en zag er niets van — er ging geen enkel
// belletje af terwijl er vijf kaarten uit de dag waren verdwenen.
//
// De vier controles hierboven kijken naar een CIJFER. Deze gaat over het
// dagritme zelf, en dat is de reden dat hij bestaat: niet elke storing laat
// zich zien als een som die niet klopt.
//
// De regel is hard en heeft geen drempel nodig: wat OPEN staat hoort vandaag of
// later te staan. Een open kaart met een due in het verleden staat op geen
// enkele lijst en komt niemand meer tegen — die hoort per definitie niet te
// bestaan.

export function controleerDagritme({ taken, vandaag }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(vandaag || ''))) {
    return uit('dagritme', NIET_GEMETEN, { bekeken: 0 },
      'Zonder geldige dag valt er niets af te meten.');
  }
  const rijen = Array.isArray(taken) ? taken : [];
  if (rijen.length === 0) {
    // Een lege lijst is GEEN bewijs dat het dagritme werkt. Zie de kop.
    return uit('dagritme', NIET_GEMETEN, { bekeken: 0 },
      'Er staan geen openstaande kaarten. Er valt dus niets te controleren — dat is iets anders dan goed.');
  }

  // ONBEKEND IS GEEN VERLEDEN. Een rij zonder bruikbare due is een ander
  // probleem, en die hier als 'de doorrol is stuk' melden zou de melding
  // onbetrouwbaar maken op precies het moment dat je hem nodig hebt.
  const zonderDue = rijen.filter((t) => !/^\d{4}-\d{2}-\d{2}$/.test(String(t && t.due || '')));
  const achter = rijen.filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(String(t && t.due || '')) && String(t.due) < vandaag);

  const getallen = {
    bekeken     : rijen.length,
    achterstallig: achter.length,
    zonder_due  : zonderDue.length,
    namen       : achter.slice(0, 12).map((t) => `${t.naam || 'Naamloos'} (${t.due})`),
    oudste      : achter.length ? achter.map((t) => t.due).sort()[0] : null,
  };

  if (achter.length === 0) {
    return uit('dagritme', OK, getallen,
      `Alle ${rijen.length} openstaande kaarten staan op vandaag of later.`);
  }
  return uit('dagritme', FOUT, getallen,
    `${achter.length} openstaande ${achter.length === 1 ? 'kaart staat' : 'kaarten staan'} op een dag `
    + `die al voorbij is (oudste: ${getallen.oudste}). Die staan op geen enkele lijst. `
    + 'Vrijwel altijd betekent dit dat de nachtelijke doorrol niet gedraaid heeft of zijn werk niet deed.');
}

// ═══════════════════════════════════════════════════════════════════════════
// 7 · DE DOORROL — heeft hij op de goede dag gericht?
// ═══════════════════════════════════════════════════════════════════════════
// Controle 6 hierboven zou de fout van 8 september NIET gezien hebben, en dat
// is de les die deze controle bestaansrecht geeft: de kapotte doorrol zette
// kaarten een dag te ver VOORUIT (op de 9e terwijl ze op de 8e hoorden), en een
// due in de toekomst is voor 'staat er iets in het verleden' onzichtbaar.
//
// EEN VUISTREGEL OP DE RIJEN KAN DIT NIET. 'Een open kaart die ver vooruit
// staat is verdacht' geeft vals alarm op precies de kaarten die het goed doen:
// een bevestigde aanmelding slaapt legitiem tot vier dagen voor het event, en
// cron-opvolging-aanmeldingen draait elk kwartier — ook 's nachts — en maakt
// dan kaarten met een due weken vooruit. Een nachtvenster als vingerafdruk is
// dus geen vingerafdruk.
//
// Daarom laat de doorrol een merkteken achter (app_settings, zie
// DOORROL_MERKTEKEN in api/cron-opvolging-doorrol.js) met de dag waarop hij
// richtte, het moment waarop hij draaide, hoeveel kaarten hij verzette en een
// greep uit de ids. Deze controle rekent dat na.
//
// Dat is GEEN zelfbevestiging: de dag wordt hier opnieuw afgeleid uit het ruwe
// tijdstip van de run, en juist dáár zat de fout. Draaide hij op 07-09T23:59Z
// (in Amsterdam de 8e) en zette hij kaarten op de 9e, dan lopen die twee uit
// elkaar en is dat meteen zichtbaar.
//
// EN ER ZIT GEEN MARGE OP. Het verschil was precies EEN dag, dus een controle
// op 'meer dan een dag vooruit' had hem óók gemist. Na een doorrol hoort de due
// exact de dag van de run te zijn.

export function controleerDoorrol({ merkteken, taken, vandaag }) {
  const m = merkteken && typeof merkteken === 'object' ? merkteken : null;
  if (!m || !m.gedraaid_op || !m.dag) {
    // De eerste ochtend na de deploy, of een cron die nooit gelopen heeft. Dat
    // als groen boeken zou de controle waardeloos maken op het moment dat je
    // hem juist wilt vertrouwen.
    return uit('doorrol', NIET_GEMETEN, { merkteken: 'ontbreekt' },
      'De doorrol heeft nog geen merkteken achtergelaten. Er valt dus niets na te rekenen — dat is iets anders dan goed.');
  }
  const gedraaidMs = Date.parse(m.gedraaid_op);
  if (!Number.isFinite(gedraaidMs)) {
    return uit('doorrol', NIET_GEMETEN, { gedraaid_op: String(m.gedraaid_op) },
      'Het merkteken draagt geen bruikbaar tijdstip, dus de dag van de run is niet af te leiden.');
  }

  // De dag van de run, ONAFHANKELIJK opnieuw uitgerekend.
  const dagVanDeRun = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(gedraaidMs));

  const getallen = {
    dag_gezet     : String(m.dag),
    dag_van_de_run: dagVanDeRun,
    gedraaid_op   : new Date(gedraaidMs).toISOString(),
    doorgerold    : Number(m.doorgerold) || 0,
  };

  if (String(m.dag) !== dagVanDeRun) {
    return uit('doorrol', FOUT, getallen,
      `De doorrol draaide op ${dagVanDeRun} maar zette kaarten op ${m.dag}. `
      + 'Elke openstaande kaart slaat daarmee een dag over en staat die dag op geen enkele lijst. '
      + 'Dit is precies de fout van 8 september.');
  }
  if (dagVanDeRun !== vandaag) {
    return uit('doorrol', FOUT, getallen,
      `De laatste doorrol was op ${dagVanDeRun}: vannacht heeft hij dus niet gedraaid. `
      + 'Wat gisteren bleef liggen staat vandaag niet in de lijst.');
  }

  // ── En de rijen die hij zelf zegt te hebben aangeraakt ─────────────────
  // Alleen kaarten die sinds de run niet meer zijn aangeraakt: verzet een mens
  // er tussen 02:00 en 07:00 eentje vooruit, dan is die due terecht anders en
  // mag dat geen alarm geven.
  const ids = new Set((Array.isArray(m.voorbeelden) ? m.voorbeelden : []).map(String));
  const kandidaten = (Array.isArray(taken) ? taken : []).filter((t) => {
    if (!t || !ids.has(String(t.id))) return false;
    const up = t.updated_at ? Date.parse(t.updated_at) : NaN;
    // Een paar minuten speling: de cron werkt de rijen niet op dezelfde
    // milliseconde bij als het moment dat hij in het merkteken zet.
    return !Number.isFinite(up) || up <= gedraaidMs + 10 * 60 * 1000;
  });
  const mis = kandidaten.filter((t) => String(t.due || '') !== dagVanDeRun);
  getallen.rijen_gecontroleerd = kandidaten.length;
  getallen.rijen_mis = mis.length;
  if (mis.length) {
    getallen.namen = mis.slice(0, 12).map((t) => `${t.naam || 'Naamloos'} (${t.due})`);
    return uit('doorrol', FOUT, getallen,
      `${mis.length} van de ${kandidaten.length} nagekeken kaarten staan niet op ${dagVanDeRun}, `
      + 'terwijl de doorrol ze vannacht wel heeft aangeraakt.');
  }

  return uit('doorrol', OK, getallen,
    `De doorrol draaide op ${dagVanDeRun} en zette ${getallen.doorgerold} kaart(en) op diezelfde dag.`);
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

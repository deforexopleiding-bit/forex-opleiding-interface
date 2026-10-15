// modules/scan/scan-model.js — de strategie-scan: vragen + scoremodel (pure).
//
// Eén bron voor de browser (scan-pagina: live voorbeeld) én de server
// (api/scan.js rekent bij elke opslag opnieuw — de client wordt niet vertrouwd).
// Letterlijk overgenomen uit de goedgekeurde mockup (scan-mockup, 2026-10-15):
// 8 onderdelen, de vragen/teksten, het scoremodel, de uitkomst-, aanpak- en
// trajectlogica. Geen DOM, geen netwerk, geen imports.
//
// Antwoorden worden opgeslagen als { '<onderdeel>_<index>': waarde } met
//   likert → 1..5 (de gekozen stand)
//   mc     → index van de gekozen optie (0-based)
// Score/vlag/stijl worden daaruit afgeleid (antwoordInfo), nooit opgeslagen.
//
// Vaste regels (opdracht 2026-10-15):
//   - "Nu nog niet" ALLEEN bij financiële situatie = "Schulden";
//   - aanpak: Daytrading is de voorkeur, Swingtrading alleen als dat duidelijk
//     beter past (meer swing- dan day-antwoorden);
//   - traject: 12 mnd 1-op-1 standaard, 24 mnd voor topprofielen, Zelfstudie
//     bij zelfstandige leerstijl + sterke mindset;
//   - GEEN prijzen, GEEN rendement- of tijdlijncijfers in de teksten.

export const LIKERT = ['Helemaal oneens', 'Oneens', 'Neutraal', 'Eens', 'Helemaal eens'];

export const ONDERDELEN = [
  { k: 'motivatie', title: 'Jouw doel & motivatie', sub: 'Wat je uiteindelijk wilt bereiken en hoe helder dat doel is.', items: [
    { t: 'Wat is je uiteindelijke doel met traden?', type: 'mc', nosc: true, goal: true, opts: [['Financiële vrijheid', 3], ['Een tweede inkomen naast mijn werk', 3], ['Vermogen opbouwen voor later', 3], ['Leuke extra’s kunnen doen', 3], ['Begrijpen hoe het werkt / mezelf ontwikkelen', 3], ['Ik heb (nog) geen concreet doel', 3]] },
    { t: 'Ik weet precies waarom ik wil leren traden.', type: 'likert' },
    { t: 'Ik heb een concreet doel voor ogen met traden.', type: 'likert' },
    { t: 'Ik zie traden als een vaardigheid die ik opbouw — niet als snel geld.', type: 'likert' },
    { t: 'Ik ben bereid hier de komende maanden serieus tijd in te steken.', type: 'likert' },
  ] },
  { k: 'tijd', title: 'Tijd & toewijding', sub: 'Hoeveel ruimte je hebt en of je het volhoudt.', items: [
    { t: 'Hoeveel tijd kun je wekelijks vrijmaken?', type: 'mc', opts: [['Minder dan 2 uur', 1], ['2–5 uur', 3], ['5–10 uur', 4], ['10+ uur', 5]] },
    { t: 'Ik kan wekelijks consistent tijd vrijmaken, ook als het druk is.', type: 'likert' },
    { t: 'Als ik ergens aan begin, maak ik het meestal af.', type: 'likert' },
    { t: 'Ik kan een vaste routine volhouden.', type: 'likert' },
  ] },
  { k: 'stijl', title: 'Handelsstijl & ritme', sub: 'Dit bepaalt of daytrading of swingtrading beter bij je past.', items: [
    { t: 'Wat past het best bij jou?', type: 'mc', styleQ: true, opts: [['Snel schakelen en actie', 0, 'day'], ['Rustig analyseren en geduldig wachten', 0, 'swing']] },
    { t: 'Hoe vaak wil je met de markt bezig zijn?', type: 'mc', styleQ: true, opts: [['Meerdere momenten per dag', 0, 'day'], ['Een paar keer per week', 0, 'swing']] },
  ] },
  { k: 'financieel', title: 'Financiële situatie', sub: 'Of traden op dit moment verantwoord voor je is.', items: [
    { t: 'Hoe staat je financiële situatie ervoor?', type: 'mc', opts: [['Stabiel', 5], ['Redelijk', 4], ['Krap', 2, 'finsoft'], ['Schulden', 1, 'fin']] },
    { t: 'Zou je liever met eigen geld traden of met funded kapitaal?', type: 'mc', nosc: true, opts: [['Met eigen geld'], ['Met funded kapitaal'], ['Weet ik nog niet']] },
    { t: 'Ik heb een financiële buffer naast het geld dat ik eventueel voor traden zou vrijmaken.', type: 'likert' },
  ] },
  { k: 'kennis', title: 'Kennis & ervaring', sub: 'Wat je al weet en hebt gedaan.', items: [
    { t: 'Hoeveel ervaring heb je met traden?', type: 'mc', opts: [['Geen', 2], ['Zelf wat geprobeerd', 3], ['Enige ervaring', 4], ['Ervaren', 5]] },
    { t: 'Ik begrijp wat risico- en moneymanagement inhoudt.', type: 'likert' },
    { t: 'Ik weet wat een stop-loss is en waarom je die gebruikt.', type: 'likert' },
    { t: 'Ik heb al eens met een demo- of echte account getraded.', type: 'likert' },
  ] },
  { k: 'mindset', title: 'Mindset & discipline', sub: 'Hoe je omgaat met regels, verlies en emoties.', items: [
    { t: 'Ik kan me aan vooraf bepaalde regels houden, ook onder druk.', type: 'likert' },
    { t: 'Na een verlies blijf ik rustig en ga ik niet impulsief door.', type: 'likert' },
    { t: 'Ik ben geduldig en kan wachten op de juiste kans.', type: 'likert' },
    { t: 'Ik laat me niet snel meeslepen door emoties als het om geld gaat.', type: 'likert' },
  ] },
  { k: 'verwachtingen', title: 'Verwachtingen & realisme', sub: 'Of je beeld van traden klopt met de werkelijkheid.', items: [
    { t: 'Binnen welke termijn verwacht je consistent te worden?', type: 'mc', opts: [['Binnen een paar weken', 1, 'verw'], ['Enkele maanden', 3], ['6–12 maanden', 4], ['1–2 jaar', 5]] },
    { t: 'Wat verwacht je qua rendement?', type: 'mc', opts: [['Rustige, realistische opbouw', 5], ['Flinke winst, vrij snel', 1, 'verw']] },
    { t: 'Ik begrijp dat verlies er onvermijdelijk bij hoort.', type: 'likert' },
    { t: 'Ik verwacht geen gegarandeerde of snelle winst.', type: 'likert' },
  ] },
  { k: 'leerstijl', title: 'Leerstijl & begeleiding', sub: 'Hoe je het liefst leert — dit bepaalt het passende traject.', items: [
    { t: 'Hoe leer je het liefst?', type: 'mc', bg: true, opts: [['1-op-1 begeleiding — zodat ik direct mijn vragen kan stellen, meteen antwoord krijg en mijn leerproces optimaal versnel', 3], ['In een groep', 2], ['Zelfstandig met materiaal', 1]] },
    { t: 'Ik heb behoefte aan persoonlijke begeleiding en structuur.', type: 'likert', bgq: true },
    { t: 'Ik stel liever vragen aan iemand die het al kan dan zelf uitzoeken.', type: 'likert', bgq: true },
    { t: 'Ik werk beter met een vast plan dan helemaal zelf uitpuzzelen.', type: 'likert', bgq: true },
  ] },
];

/** Vlaggen die de keuze rood markeren in het formulier. */
export const RODE_VLAGGEN = ['fin', 'finsoft', 'verw'];
/** De onderdelen die meetellen in de readiness-score (en de balken). */
export const SCORE_ONDERDELEN = ['motivatie', 'tijd', 'financieel', 'kennis', 'mindset', 'verwachtingen'];
export const ONDERDEEL_NAMEN = {
  motivatie: 'Motivatie & doelen', tijd: 'Tijd & toewijding', financieel: 'Financiële situatie',
  kennis: 'Kennis & ervaring', mindset: 'Mindset & discipline', verwachtingen: 'Verwachtingen & realisme',
};

export const CATEGORIEEN = ['Zeer geschikt', 'Geschikt met de juiste begeleiding', 'Nu nog niet'];
export const AANPAKKEN = ['Daytrading', 'Swingtrading'];
export const TRAJECTEN = ['12 maanden 1-op-1', '24 maanden 1-op-1', 'Zelfstudietraject', 'Eerst de basis op orde'];
export const TOTAAL_VRAGEN = ONDERDELEN.reduce((a, p) => a + p.items.length, 0);

const TOON = { 'Zeer geschikt': 'ok', 'Geschikt met de juiste begeleiding': 'amber', 'Nu nog niet': 'red' };
const VERDICT = {
  'Zeer geschikt': 'Je hebt een sterk profiel: heldere motivatie, realistische verwachtingen en de juiste instelling om dit op te bouwen.',
  'Geschikt met de juiste begeleiding': 'Je hebt een goede basis om te starten. Een paar punten verdienen aandacht, maar met de juiste begeleiding en aanpak is er veel mogelijk.',
  'Nu nog niet': 'Je bent zeker welkom, maar op basis van je financiële situatie is instappen nu niet verantwoord — en daar zijn we eerlijk over, in jouw belang.',
};
const AANPAK_UITLEG = {
  Daytrading: 'Onze daytrade-strategie past goed bij je: actief de markt lezen en profiteren van de beweging binnen de dag — dit is waar we je het sterkst in maken.',
  Swingtrading: 'Je handelt liever rustig en op minder momenten — onze swingtrade-strategie past daar het best bij: minder schermtijd, met posities over langere tijd.',
};
const TRAJECT_UITLEG = {
  'Zelfstudietraject': 'Je leert het liefst zelfstandig en hebt de discipline om zelf door te zetten. Het zelfstudietraject geeft je alle kennis in eigen tempo.',
  '24 maanden 1-op-1': 'Je ambitie is hoog en je wilt intensieve persoonlijke begeleiding. In 24 maanden bouw je het rustig, grondig en blijvend op — met de meeste ruimte om te groeien.',
  '12 maanden 1-op-1': 'Je wilt persoonlijke begeleiding en hebt serieuze doelen. Met 12 maanden 1-op-1 heb je genoeg tijd én directe sturing om het echt onder de knie te krijgen en door te pakken.',
  'Eerst de basis op orde': 'We raden nu bewust nog géén betaald traject aan — eerst rust in je financiën.',
};
const ADVIES_NU_NOG_NIET = 'Breng eerst je financiële basis op orde en bouw een kleine buffer op. Leer in de tussentijd gratis mee via ons webinar en onze content, en kom gerust terug zodra je kunt starten met geld dat je echt kunt missen. Geen "nee", maar een "nu nog niet".';

const isInt = (x) => Number.isInteger(x);

/**
 * Wat een opgeslagen antwoord betekent: { score, flag, style, label, bg } of null.
 * likert → score = de stand (1..5); mc → de optie (score/vlag/stijl uit de tabel).
 */
export function antwoordInfo(onderdeel, idx, waarde) {
  const p = ONDERDELEN.find((o) => o.k === onderdeel);
  const it = p && p.items[idx];
  if (!it || !isInt(waarde)) return null;
  if (it.type === 'likert') {
    if (waarde < 1 || waarde > 5) return null;
    return { score: waarde, flag: null, style: null, label: String(waarde), bg: null };
  }
  const o = it.opts[waarde];
  if (!o) return null;
  return {
    score: o[1],
    flag: RODE_VLAGGEN.includes(o[2]) ? o[2] : null,
    style: it.styleQ ? o[2] : null,
    label: o[0],
    bg: it.bg ? o[1] : null,
  };
}

/** Alleen geldige sleutels/waarden; al het andere valt weg. */
export function normaliseerAntwoorden(raw) {
  const uit = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return uit;
  ONDERDELEN.forEach((p) => p.items.forEach((_, i) => {
    const key = p.k + '_' + i;
    const w = raw[key];
    if (antwoordInfo(p.k, i, w)) uit[key] = w;
  }));
  return uit;
}

/** Aantal beantwoorde vragen. */
export function aantalBeantwoord(antwoorden) {
  return Object.keys(normaliseerAntwoorden(antwoorden)).length;
}

const kleineLetter = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '');

/**
 * De BEREKENDE beslissingen (zonder overrides): scores, readiness, doel, stijl,
 * categorie, traject. Onbeantwoorde vragen tellen als neutraal (3), zoals in de mockup.
 */
export function berekenBasis(antwoorden) {
  const ans = normaliseerAntwoorden(antwoorden);
  const scores = {}; const flags = {};
  let bgBase = 2; let doel = '';
  const sv = { day: 0, swing: 0 };
  ONDERDELEN.forEach((p) => {
    let sum = 0; let n = 0;
    p.items.forEach((it, ii) => {
      const a = antwoordInfo(p.k, ii, ans[p.k + '_' + ii]);
      const sc = a ? a.score : 3;
      if (p.k !== 'leerstijl' && p.k !== 'stijl' && !it.nosc) { sum += sc; n++; }
      if (it.goal && a) doel = a.label;
      if (it.styleQ && a && a.style) sv[a.style]++;
      if (a && a.flag) flags[a.flag] = (flags[a.flag] || 0) + 1;
      if (it.bg && a) bgBase = a.bg;
    });
    if (n) scores[p.k] = Math.round(sum / n / 5 * 100);
  });
  const stijl = sv.swing > sv.day ? 'Swingtrading' : 'Daytrading';
  const readiness = Math.round(SCORE_ONDERDELEN.reduce((a, k) => a + scores[k], 0) / SCORE_ONDERDELEN.length);
  const fin = !!flags.fin; const finsoft = !!flags.finsoft; const verw = !!flags.verw;
  let categorie; let traject;
  if (fin) { categorie = 'Nu nog niet'; traject = 'Eerst de basis op orde'; } else {
    categorie = readiness >= 66 && !verw ? 'Zeer geschikt' : 'Geschikt met de juiste begeleiding';
    if (bgBase <= 1 && scores.mindset >= 70) traject = 'Zelfstudietraject';
    else if (readiness >= 76 && bgBase >= 3 && scores.motivatie >= 72) traject = '24 maanden 1-op-1';
    else traject = '12 maanden 1-op-1';
  }
  return { antwoorden: ans, scores, readiness, doel, stijl, fin, finsoft, verw, categorie, traject, beantwoord: Object.keys(ans).length };
}

/** Alleen toegestane override-velden (lege tekst = geen override). */
export function normaliseerOverride(raw) {
  const o = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return o;
  if (CATEGORIEEN.includes(raw.categorie)) o.categorie = raw.categorie;
  if (AANPAKKEN.includes(raw.aanpak)) o.aanpak = raw.aanpak;
  if (TRAJECTEN.includes(raw.traject)) o.traject = raw.traject;
  for (const k of ['verdict', 'samenvatting', 'advies']) {
    const t = typeof raw[k] === 'string' ? raw[k].trim().slice(0, 2000) : '';
    if (t) o[k] = t;
  }
  return o;
}

/**
 * De volledige uitkomst (wat het rapport toont): berekend, met Dave's overrides
 * erop. Overschrijft Dave de categorie of het traject, dan volgen de teksten
 * (advies, samenvatting, "wat opvalt", volgende stap) die keuze — tenzij hij
 * die tekst zelf ook heeft aangepast.
 */
export function berekenUitkomst(antwoorden, override = {}) {
  const b = berekenBasis(antwoorden);
  const ov = normaliseerOverride(override);

  const categorie = ov.categorie || b.categorie;
  const nuNogNiet = categorie === 'Nu nog niet';
  const aanpak = nuNogNiet ? null : (ov.aanpak || b.stijl);
  let traject = ov.traject || b.traject;
  // Consistentie: "Eerst de basis op orde" hoort alleen bij "Nu nog niet" en omgekeerd.
  if (nuNogNiet) traject = 'Eerst de basis op orde';
  else if (traject === 'Eerst de basis op orde') traject = '12 maanden 1-op-1';

  const doel = b.doel; const doelKlein = kleineLetter(doel);
  const advies = ov.advies || (nuNogNiet
    ? ADVIES_NU_NOG_NIET
    : 'Op basis van je profiel past ' + traject.toLowerCase() + ' het beste'
      + (doel ? ' om toe te werken naar jouw doel: ' + doel.toLowerCase() : '')
      + ', met onze ' + aanpak.toLowerCase() + '-strategie als uitgangspunt. Dave bespreekt zo met je precies wat dat inhoudt, hoe wij werken en wat de vervolgstappen zijn.');

  const sterk = SCORE_ONDERDELEN.filter((k) => b.scores[k] >= 70).map((k) => ONDERDEEL_NAMEN[k].toLowerCase());
  const zwak = SCORE_ONDERDELEN.filter((k) => b.scores[k] < 55).map((k) => ONDERDEEL_NAMEN[k].toLowerCase());
  let samenvatting = (doel ? 'Je gaf aan dat je doel ' + doelKlein + ' is. ' : '') + 'Je totale readiness-score is ' + b.readiness + ' van de 100. ';
  samenvatting += nuNogNiet
    ? 'Door je financiële situatie is traden nu echter niet het juiste moment — zie hieronder.'
    : (sterk.length ? 'Je scoort sterk op ' + sterk.slice(0, 3).join(', ') + '. ' : '')
      + (zwak.length ? 'Aandacht verdient vooral ' + zwak.slice(0, 3).join(', ') + '.' : 'Je profiel is mooi in balans.');
  if (ov.samenvatting) samenvatting = ov.samenvatting;

  const opvallend = [];
  SCORE_ONDERDELEN.forEach((k) => { if (b.scores[k] >= 72) opvallend.push({ soort: 's', label: 'Sterk', tekst: ONDERDEEL_NAMEN[k] + ': hier zit duidelijk je kracht.' }); });
  SCORE_ONDERDELEN.filter((k) => b.scores[k] < 55).slice(0, 2).forEach((k) => opvallend.push({ soort: 'a', label: 'Aandacht', tekst: ONDERDEEL_NAMEN[k] + ': hier valt de meeste winst te halen.' }));
  if (b.verw && !nuNogNiet) opvallend.push({ soort: 'a', label: 'Aandacht', tekst: 'Je verwachtingen over snelheid mogen realistischer — reken op maanden, niet weken.' });
  if (b.finsoft && !nuNogNiet) opvallend.push({ soort: 'a', label: 'Aandacht', tekst: 'Je financiële ruimte is wat krap — start klein en bouw rustig op met geld dat je kunt missen.' });
  if (!nuNogNiet) opvallend.push({ soort: 's', label: 'Aanpak', tekst: 'Op basis van je ritme en voorkeuren past ' + aanpak.toLowerCase() + ' het beste bij je.' });
  if (!opvallend.length) opvallend.push({ soort: 's', label: 'Mooi', tekst: 'Een evenwichtig profiel zonder grote uitschieters.' });

  // Salesgericht blok "Jouw volgende stap" — valt weg bij "Nu nog niet".
  let volgendeStap = null;
  if (!nuNogNiet) {
    const is1op1 = traject.indexOf('1-op-1') >= 0;
    const voordelen = [['📈', 'Onze ' + aanpak.toLowerCase() + '-strategie', 'stap voor stap, precies zoals wij ’m zelf dagelijks traden.']];
    if (is1op1) voordelen.push(['🤝', 'Persoonlijke 1-op-1 begeleiding', 'stel je vragen en krijg meteen antwoord — zo versnel je je leerproces enorm.']);
    else voordelen.push(['🎓', 'Alle kennis in eigen tempo', 'een compleet programma dat je doorloopt wanneer het jou uitkomt.']);
    voordelen.push(['🛡️', 'Structuur & risicobeheer', 'leer traden met een vast plan in plaats van op gevoel.']);
    voordelen.push(['🎯', 'Een concreet stappenplan', 'gericht op waar jij nu staat en waar je naartoe wilt.']);
    volgendeStap = {
      titel: 'Jouw route: ' + traject,
      lead: 'Op basis van je profiel zetten we in op onze ' + aanpak.toLowerCase() + '-strategie'
        + (doel && doel.indexOf('geen') < 0 ? ', met als stip op de horizon jouw doel: ' + doel.toLowerCase() : '') + '. Zo ziet jouw route eruit:',
      voordelen,
      schaars: is1op1 ? '⚡ We nemen maar een beperkt aantal nieuwe 1-op-1 cursisten per maand aan.' : '',
    };
  }

  return {
    readiness: b.readiness,
    scores: b.scores,
    doel: doel || null,
    categorie,
    toon: TOON[categorie],
    verdict: ov.verdict || VERDICT[categorie],
    aanpak,
    aanpakUitleg: aanpak ? AANPAK_UITLEG[aanpak] : null,
    traject,
    trajectKop: nuNogNiet ? 'Ons eerlijke advies' : 'Aanbevolen traject',
    trajectUitleg: TRAJECT_UITLEG[traject],
    samenvatting,
    opvallend,
    advies,
    volgendeStap,
    beantwoord: b.beantwoord,
    totaal: TOTAAL_VRAGEN,
    berekend: { categorie: b.categorie, aanpak: b.fin ? null : b.stijl, traject: b.traject },
    override: ov,
  };
}

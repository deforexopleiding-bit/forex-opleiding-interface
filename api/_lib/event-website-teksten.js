// api/_lib/event-website-teksten.js
//
// Exacte mailteksten voor het FUNNEL-EIGEN berichtenpad (created_via='website').
// 1-op-1 overgenomen uit het goedgekeurde rapport (A = bevestiging + pre-event
// reminders; C = vervolg-herinnering die naar /vervolg wijst). De WhatsApp-kant
// gebruikt de bestaande goedgekeurde templates; deze module levert alleen de
// mail-tegenhangers.
//
// Raakt de oude GHL-flow niet: puur tekst-builders, geen DB-writes.

import { wrapEmailHtml } from '../mailer.js';

const ZONE = 'Europe/Amsterdam';

export function datumNL(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: ZONE }).format(new Date(iso));
  } catch { return ''; }
}
export function tijdNL(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ZONE }).format(new Date(iso));
  } catch { return ''; }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Zet platte tekst met lege regels om naar <p>-blokken (+ enkele newlines → <br>).
function tekstNaarHtml(text) {
  return String(text || '').trim().split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

// ── 1) Bevestiging (na Definitief) — rapport A.1 ────────────────────────────
export function bevestigingMail({ voornaam, titel, datum, starttijd, locatie, descriptionMd }) {
  const naam = voornaam || 'jij';
  const ev = titel || 'het event';
  const subject = `Je plek voor ${ev} staat nu definitief vast ✅`;
  const extra = descriptionMd && String(descriptionMd).trim()
    ? `\n\nMeer praktische info:\n${String(descriptionMd).trim()}`
    : '';
  const text =
`Hoi ${naam},

Top — je vragenlijst is binnen en daarmee staat je plek voor de ${ev} op ${datum} nu definitief vast! 🎉

Je hebt zonet een belangrijke stap gezet. De meeste mensen blijven eindeloos twijfelen; jij komt in actie. Precies die instelling gaat het verschil maken in je trading.

Praktisch:
• Datum: ${datum}
• Inloop vanaf: ${starttijd}
• Locatie: ${locatie}

In de bijlage vind je alle praktische info: de routebeschrijving naar de locatie én de weg door het gebouw, zodat je straks vlot de juiste zaal vindt. Bewaar hem alvast even.

Let op: je kunt vanaf ${starttijd} binnenwandelen. We starten de masterclass stipt 30 minuten later, dus zorg dat je op tijd binnen bent zodat je niets mist.

De komende dagen sturen we je een paar berichten om je optimaal voor te bereiden, zodat je er straks maximaal uithaalt. Hou je WhatsApp dus in de gaten.${extra}

Tot snel!
Team De Forex Opleiding`;
  return { subject, text, html: wrapEmailHtml(subject, tekstNaarHtml(text)) };
}

// ── 2) Warmup (~120u) — rapport A.2 ─────────────────────────────────────────
export function warmupMail({ voornaam, titel }) {
  const naam = voornaam || 'jij';
  const ev = titel || 'het event';
  const subject = `Zo haal je straks het meeste uit je ${ev}`;
  const text =
`Hoi ${naam},

Nog een paar dagen wachten en dan is het eindelijk zover: de ${ev}.

Tijdens deze masterclass krijg je een unieke inkijk in hoe wij naar de markt kijken, welke fouten de meeste traders blijven maken en welke stappen nodig zijn om structureel betere resultaten te behalen.

Om zoveel mogelijk uit deze dag te halen, willen we je vragen om alvast even stil te staan bij één vraag:

Wat is momenteel jouw grootste uitdaging in trading?

Of het nu gaat om winstgevend worden, discipline, psychologie, risicobeheer of het vinden van een consistente strategie — noteer het voor jezelf. Wie met een duidelijke vraag binnenkomt, haalt vaak de meeste waarde uit de sessie.

We kijken ernaar uit je binnenkort persoonlijk te verwelkomen.

Tot snel!

Team De Forex Opleiding`;
  return { subject, text, html: wrapEmailHtml(subject, tekstNaarHtml(text)) };
}

// ── 3) Reminder 24u — rapport A.3 ───────────────────────────────────────────
export function reminder24uMail({ voornaam, titel, datum, starttijd, locatie }) {
  const naam = voornaam || 'jij';
  const ev = titel || 'het event';
  const subject = `Morgen: ${ev}`;
  const text =
`Hoi ${naam},

Morgen is het zover — we kijken er enorm naar uit je te zien bij de ${ev}! Morgen zet je een echte stap vooruit in je trading.

Nog even het praktische:

– Wanneer: ${datum}
– Inloop vanaf: ${starttijd} (je kunt vanaf dat moment binnenwandelen)
– Start masterclass: stipt 30 minuten na de inloop, dus zorg dat je op tijd binnen bent
– Waar: ${locatie}
– Meenemen: iets om mee te schrijven en een uitgeruste, gefocuste mindset

In de bijlage vind je de volledige routebeschrijving naar de locatie én de weg door het gebouw. Bekijk hem vanavond nog even, dan kom je morgen zonder stress en op tijd binnen.

Vragen of loop je morgen ergens tegenaan? Reageer gerust op deze mail.

Tot morgen!

Team De Forex Opleiding`;
  return { subject, text, html: wrapEmailHtml(subject, tekstNaarHtml(text)) };
}

// ── 4) Reminder laatste uren (~1u) — rapport A.4 ────────────────────────────
export function reminder1uMail({ voornaam, titel, starttijd, locatie }) {
  const naam = voornaam || 'jij';
  const ev = titel || 'het event';
  const subject = `Over een uur starten we — tot zo bij ${ev}!`;
  const text =
`Hoi ${naam},

Over een uur zien we je bij de ${ev}! De inloop is vanaf ${starttijd} op ${locatie} — je kunt vanaf dat moment binnenwandelen. We starten de masterclass stipt 30 minuten later.

Kom je er onderweg niet uit, sta je in de file of loop je vast? Bel of app ons gerust op +31 85 580 36 26, dan helpen we je meteen verder.

Neem iets om mee te schrijven mee. Tot zo - het wordt een waardevolle sessie!`;
  return { subject, text, html: wrapEmailHtml(subject, tekstNaarHtml(text)) };
}

// ── 5) Vervolg-herinnering (2u/24u, naar /vervolg) — rapport C ──────────────
export function vervolgHerinneringMail({ voornaam, titel, vervolgLink }) {
  const naam = voornaam || 'jij';
  const ev = titel || 'het event';
  const subject = `Nog 1 stap: maak je plek voor ${ev} definitief`;
  const text =
`Hoi ${naam},

Je plek voor de ${ev} is nog NIET definitief. Er is nog één korte stap: de vragenlijst (nog geen 2 minuten).

👉 Vul 'm hier in: ${vervolgLink}

Zodra je gegevens binnen zijn, staat je plek definitief vast en sturen we je de praktische voorbereiding. Wacht niet te lang — de plekken zijn beperkt.

Tot snel!
Team De Forex Opleiding`;
  return { subject, text, html: wrapEmailHtml(subject, tekstNaarHtml(text)) };
}

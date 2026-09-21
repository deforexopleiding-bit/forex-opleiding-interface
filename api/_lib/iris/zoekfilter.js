// api/_lib/iris/zoekfilter.js
//
// Zoekwoorden veilig in een PostgREST-filter zetten.
//
// ── HET PROBLEEM ─────────────────────────────────────────────────────────────
// PostgREST bouwt `.or()` op als één tekenreeks waarin de komma de scheiding
// tussen voorwaarden is, en haakjes de groepering. Iets als:
//
//     .or(`weergavenaam.ilike.%${zoek}%,emails.cs.{"${zoek}"}`)
//
// gaat stuk zodra iemand een komma of een haakje intypt. Zoeken op
// "Janssen, Jan" wordt dan twee voorwaarden waarvan de tweede nergens op
// slaat, en de databank geeft een 400 terug. Voor de gebruiker ziet dat eruit
// als "zoeken is kapot".
//
// Erger dan de foutmelding is wat eronder zit: een gebruiker die zijn eigen
// zoekterm in een querytaal kan schrijven, kan die querytaal sturen. Bij een
// `.or()` gaat dat niet verder dan andere kolommen uit dezelfde tabel
// meenemen — de RLS-policy staat er nog achter — maar "niet erg" is geen
// reden om het te laten staan.
//
// ── DE OPLOSSING ─────────────────────────────────────────────────────────────
// Gooi eruit wat betekenis heeft in de filtertaal. Niet ontsnappen maar
// weghalen: PostgREST kent geen ontsnappingsteken dat in alle posities werkt,
// en een zoekterm zonder komma is voor een mens nog steeds een bruikbare
// zoekterm.
//
// De tekens die eruit gaan: komma (scheiding), haakjes (groepering), punt
// (scheiding tussen kolom, operator en waarde), aanhalingstekens, accolades
// (arrayliteral), en de backslash.

/** Tekens die in een PostgREST-filter iets betekenen. */
const GEVAARLIJK = /[,().:"'{}\\*%]/g;

/**
 * Maak een zoekterm veilig voor gebruik in een filter.
 *
 * @param {string} ruw
 * @param {number} max  hoogste lengte; een zoekterm van 500 tekens is geen zoekterm
 * @returns {string}    kan leeg zijn — de aanroeper hoort dat af te vangen
 */
export function veiligZoekwoord(ruw, max = 80) {
  return String(ruw ?? '')
    .replace(GEVAARLIJK, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Bouw het or-filter voor het zoeken naar een contact.
 *
 * Geeft null terug als er na het opschonen niets bruikbaars overblijft. De
 * aanroeper hoort dan géén filter te zetten in plaats van een leeg filter —
 * een leeg filter matcht namelijk alles, en dat is het tegenovergestelde van
 * wat iemand bedoelde die iets intypte.
 *
 * @returns {string|null}
 */
export function contactZoekFilter(ruw) {
  const woord = veiligZoekwoord(ruw);
  if (!woord) return null;

  const delen = [`weergavenaam.ilike.%${woord}%`];
  // Op e-mail alleen zoeken als het er ook als een adres uitziet. `cs` is
  // "bevat" op een array en werkt op hele waarden: zoeken op "jan" vindt
  // jan@example.com níét. Het filter erbij zetten kost dan alleen tijd.
  if (woord.includes('@')) delen.push(`emails.cs.{"${woord.toLowerCase()}"}`);
  return delen.join(',');
}

// api/_lib/ics.js
//
// Eén afspraak als agenda-uitnodiging (.ics, RFC 5545) — voor de bevestiging
// van de strategiesessie na The Lab. Geen afhankelijkheid: een handvol regels.
//
// Tijden in UTC (Z), zodat elke agenda ze in de eigen tijdzone toont. UID is
// stabiel per afspraak: wie de bijlage twee keer opent, krijgt één item.

const pad = (n) => String(n).padStart(2, '0');

/** Date → 20261021T120000Z. PURE. */
export function icsTijd(d) {
  const x = new Date(d);
  return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}${pad(x.getUTCSeconds())}Z`;
}

/** Tekst veilig voor een ICS-veld (\\, ; , en regeleinden). PURE. */
export function icsTekst(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Regels langer dan 75 octetten vouwen (RFC 5545 §3.1). PURE. */
export function vouw(regel) {
  const uit = [];
  let rest = regel;
  while (Buffer.byteLength(rest, 'utf8') > 75) {
    let n = 75;
    while (Buffer.byteLength(rest.slice(0, n), 'utf8') > 75) n--;
    uit.push(rest.slice(0, n));
    rest = ' ' + rest.slice(n);
  }
  uit.push(rest);
  return uit.join('\r\n');
}

/**
 * @param {object} p
 * @param {string} p.uid         stabiel, bv. de afspraak-id
 * @param {string|Date} p.start
 * @param {number} p.duurMin
 * @param {string} p.titel
 * @param {string} [p.beschrijving]
 * @param {string} [p.locatie]    bv. de Zoom-link
 * @param {string} [p.url]
 * @returns {string} de .ics-inhoud (CRLF)
 */
export function maakIcs({ uid, start, duurMin = 30, titel, beschrijving = '', locatie = '', url = '', nu = new Date() }) {
  const begin = new Date(start);
  const einde = new Date(begin.getTime() + duurMin * 60000);
  const regels = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//De Forex Opleiding//The Lab//NL',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsTekst(uid)}@deforexopleiding.nl`,
    `DTSTAMP:${icsTijd(nu)}`,
    `DTSTART:${icsTijd(begin)}`,
    `DTEND:${icsTijd(einde)}`,
    `SUMMARY:${icsTekst(titel)}`,
    beschrijving ? `DESCRIPTION:${icsTekst(beschrijving)}` : null,
    locatie ? `LOCATION:${icsTekst(locatie)}` : null,
    url ? `URL:${icsTekst(url)}` : null,
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsTekst(titel)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return regels.map(vouw).join('\r\n') + '\r\n';
}

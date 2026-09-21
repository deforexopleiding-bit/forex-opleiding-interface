// api/_lib/iris/opname.js
//
// Welke berichten heeft Iris nog niet gezien, en hoe maakt ze er haar eigen
// rij van?
//
// ── HET PROBLEEM MET "NOG NIET GEZIEN" ───────────────────────────────────────
// De voor de hand liggende aanpak is een tijdstempel: onthoud tot wanneer je
// gekeken hebt, en pak alles wat daarna kwam. Die aanpak breekt op twee
// manieren, en allebei stil.
//
// Ten eerste komen berichten niet per se op volgorde binnen. Een mailsync die
// vastliep en een uur later inhaalt, schrijft rijen weg met een ontvangst-
// tijdstip dat vóór de cursor ligt. Die berichten ziet Iris dan nooit.
//
// Ten tweede is een cursor één waarde, en één waarde die misgaat kost je alles
// erachter. Lesson learned 4 in CLAUDE.md gaat hier precies over: gebruik een
// toestandsvlag als impliciete cursor in plaats van een laatste-id.
//
// Dus: de vraag is niet "wat kwam er na tijdstip X" maar "welke bron-sleutels
// staan nog niet in iris_berichten". Dat is een verzamelverschil, geen cursor.
// Het is duurder en het is goed: duizend sleutels vergelijken kost niets, een
// gemist bericht kost een klant.
//
// ── DE BRON-SLEUTEL ──────────────────────────────────────────────────────────
// 'wa:<uuid>' of 'mail:<uuid>'. UNIQUE op iris_berichten. De cron mag zo vaak
// draaien als hij wil; een tweede poging botst op de constraint en wordt stil
// overgeslagen. Geen tellers, geen vergrendeling, geen race.

/** Hoeveel berichten er per ronde hoogstens opgenomen worden. */
export const OPNAME_PER_RONDE = 200;

/** Hoe ver terug we kijken bij een eerste ronde. Dagen. */
export const TERUGBLIK_DAGEN = 14;

/** Bouw de bron-sleutel. Eén plek, zodat de twee kanten nooit uit elkaar lopen. */
export function bronSleutel(bron, id) {
  const voorvoegsel = bron === 'email' ? 'mail' : 'wa';
  return `${voorvoegsel}:${String(id)}`;
}

/** Lees de bron terug uit een sleutel. */
export function leesBron(sleutel) {
  const s = String(sleutel || '');
  if (s.startsWith('mail:')) return 'email';
  if (s.startsWith('wa:')) return 'whatsapp';
  return null;
}

/**
 * De richting van een WhatsApp-bericht.
 *
 * whatsapp_messages.direction is 'in' of 'out' — NIET 'inbound'/'outbound'.
 * Dat is een val waar inbox-thread-unified.js al een expliciete normalisatie
 * voor heeft moeten inbouwen (zie de bug-fix-notitie daar). We lopen er hier
 * niet opnieuw in.
 */
export function waRichting(ruw) {
  const s = String(ruw || '').toLowerCase();
  return (s === 'out' || s === 'outbound') ? 'uit' : 'in';
}

/**
 * Onze eigen mailboxen. Een mail die hiervandaan komt, hebben wij verstuurd.
 *
 * Deze lijst staat ook in api/inbox-thread-unified.js en api/send-email.js.
 * Drie plekken is twee te veel en dat is een bekend driftrisico — het staat
 * in de audit als gat. Hem hier nú samenvoegen zou betekenen dat we twee
 * bestaande, werkende bestanden aanraken voor iets wat Iris ook los kan; dat
 * doen we later als opruiming, niet nu als bijvangst.
 */
export const ONZE_MAILBOXEN = Object.freeze([
  'leads@deforexopleiding.nl',
  'info@deforexopleiding.nl',
  'partners@deforexopleiding.nl',
  'administratie@deforexopleiding.nl',
  'onboarding@deforexopleiding.nl',
  'events@deforexopleiding.nl',
  'welkom@deforexopleiding.nl',
]);

/** Is deze mail door ons verstuurd of aan ons gericht? */
export function mailRichting(vanAdres) {
  const a = String(vanAdres || '').toLowerCase().trim();
  return (a && ONZE_MAILBOXEN.includes(a)) ? 'uit' : 'in';
}

/**
 * Welke van deze bron-rijen zijn nog niet opgenomen?
 *
 * @param {Array<{id: string}>} rijen      rijen uit whatsapp_messages of email_messages
 * @param {Set<string>} bekendeSleutels    wat al in iris_berichten staat
 * @param {'whatsapp'|'email'} bron
 */
export function filterNieuw(rijen, bekendeSleutels, bron) {
  const bekend = bekendeSleutels instanceof Set ? bekendeSleutels : new Set(bekendeSleutels || []);
  const uit = [];
  for (const r of (rijen || [])) {
    if (!r || !r.id) continue;
    const sleutel = bronSleutel(bron, r.id);
    if (bekend.has(sleutel)) continue;
    uit.push({ ...r, _bron_uniek: sleutel });
  }
  return uit;
}

/**
 * Maak van een WhatsApp-rij het vorm die iris_berichten verwacht.
 */
export function vormWa(rij) {
  const tekst = rij.body
    || (rij.template_name ? `[template] ${rij.template_name}` : '')
    || (rij.media_type ? `[${rij.media_type}]` : '');
  return {
    bron: 'whatsapp',
    bron_id: String(rij.id),
    bron_uniek: bronSleutel('whatsapp', rij.id),
    richting: waRichting(rij.direction),
    ontvangen_op: rij.created_at || rij.sent_at || new Date().toISOString(),
    tekst_kort: String(tekst || '').slice(0, 500),
  };
}

/**
 * Maak van een mail-rij de vorm die iris_berichten verwacht.
 *
 * Let op de volgorde van de terugval voor de tekst: snippet, dan body_text,
 * dan het onderwerp. Moderne mail is vaak alleen HTML — dan staan snippet én
 * body_text op NULL en is het onderwerp het enige wat we hebben. Zonder die
 * laatste stap krijgt Iris een leeg bericht te lezen en deelt ze het in als
 * 'overig', wat er in het scherm uitziet als een fout van haar.
 */
export function vormMail(rij) {
  const tekst = rij.snippet || rij.body_text || rij.subject || '';
  return {
    bron: 'email',
    bron_id: String(rij.id),
    bron_uniek: bronSleutel('email', rij.id),
    richting: mailRichting(rij.from_address),
    ontvangen_op: rij.date_received || new Date().toISOString(),
    tekst_kort: String(tekst).slice(0, 500),
  };
}

/** De datum vanaf wanneer we kijken bij een eerste ronde. */
export function terugblikVanaf(nu = new Date(), dagen = TERUGBLIK_DAGEN) {
  const d = new Date(nu.getTime() - dagen * 24 * 3600 * 1000);
  return d.toISOString();
}

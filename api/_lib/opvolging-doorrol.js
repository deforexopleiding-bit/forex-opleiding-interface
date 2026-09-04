// api/_lib/opvolging-doorrol.js
//
// Fase 3a — de twee besluiten die 's nachts en ieder uur automatisch genomen
// worden, als pure functies. Geen database, geen klok uit het niets: alles komt
// binnen als argument zodat het te testen is.
//
//   1. bepaalDoorrol()       — wat blijft liggen rolt door naar morgen.
//   2. beslisWachtInplanning() — heeft de lead zelf iets ingepland, of niet?
//
// Waarom apart: dit zijn precies de plekken waar werk stil kan verdwijnen. Een
// taak die niet doorrolt staat morgen op geen enkele lijst; een taak die na 48
// uur niet terugkomt is een lead waar niemand meer achteraan gaat. Allebei merk
// je pas weken later, als je het al kwijt bent.

/** Zoveel uur mag een lead zelf een moment kiezen voor we hem terughalen. */
export const WACHT_UREN = 48;

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Wat er 's nachts met de openstaande taken gebeurt.
 *
 * Elke taak die open staat en een `due` van vóór morgen heeft, krijgt morgen
 * als nieuwe dag. De lijst van vandaag is dan morgen weer compleet, met de
 * melding "bleef liggen" die de kaart zelf al toont zodra due in het verleden
 * ligt — daarom zetten we due op morgen en niet op de dag van doorrollen.
 *
 * `later` gaat expliciet terug naar false. Dat is het punt van deze cron:
 * zonder die reset blijft een taak die vandaag naar de tweede ronde is gezet
 * daar voor altijd staan, en zakt hij elke ochtend meteen onderaan in plaats
 * van bovenaan de eerste ronde te beginnen. Dan lijkt hij afgehandeld terwijl
 * er nooit meer iemand naar kijkt.
 *
 *   taken  — [{ id, status, due, later }]
 *   morgen — 'YYYY-MM-DD'
 *
 * Geeft alleen de taken terug die echt veranderen, met de patch erbij. Wat al
 * goed staat blijft ongemoeid — geen zinloze updates, en geen updated_at die
 * verschuift zonder reden.
 */
export function bepaalDoorrol({ taken, morgen }) {
  if (!DATUM_RE.test(String(morgen || ''))) return [];
  const uit = [];
  for (const t of (Array.isArray(taken) ? taken : [])) {
    if (!t || !t.id) continue;
    if (String(t.status || '') !== 'open') continue;
    const due = String(t.due || '');
    if (!DATUM_RE.test(due)) continue;
    // Alleen wat achterloopt. Een taak die de gebruiker zelf vooruit heeft
    // gezet (due in de toekomst) mag deze cron nooit naar morgen trekken.
    if (due >= morgen) continue;
    uit.push({ id: t.id, patch: { due: morgen, later: false } });
  }
  return uit;
}

/**
 * Hoort deze naam bij de afspraak die intussen geboekt is?
 *
 * Drie ingangen, want we weten nooit welke de lead invulde: telefoon, e-mail of
 * naam. Telefoon en e-mail zijn hard; naam is de zwakste en daarom exact (op
 * hoofdletters en spaties na) — 'Jan' laten matchen op 'Jan Peeters' zou een
 * afspraak van de verkeerde persoon als bewijs gebruiken en de lead ten
 * onrechte uit de lijst halen.
 */
export function hoortBijLead(taak, afspraak) {
  if (!taak || !afspraak) return false;

  const tel = cijfers(taak.telefoon);
  const aTel = cijfers(afspraak.lead_phone);
  if (tel && aTel && (tel === aTel || staart(tel) === staart(aTel))) return true;

  const mail = String(taak.email || '').trim().toLowerCase();
  const aMail = String(afspraak.lead_email || '').trim().toLowerCase();
  if (mail && aMail && mail === aMail) return true;

  const naam = normaliseerNaam(taak.naam);
  const aNaam = normaliseerNaam(afspraak.lead_name);
  if (naam && aNaam && naam === aNaam) return true;

  return false;
}

function cijfers(s) {
  const c = String(s == null ? '' : s).replace(/\D/g, '');
  if (!c) return null;
  return c.startsWith('00') ? (c.slice(2) || null) : c;
}
function staart(c) { return c && c.length >= 9 ? c.slice(-9) : null; }
function normaliseerNaam(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ') || null;
}

/**
 * De 48-uurbeslissing voor één taak die op 'wacht_inplanning' staat.
 *
 *   taak      — { id, naam, email, telefoon, agenda_doorgestuurd_at }
 *   afspraken — kandidaten uit de agenda ({ id, lead_name, lead_email,
 *               lead_phone, scheduled_at, created_at, zoom_join_url, ... })
 *   nu        — referentiemoment in ms; injecteerbaar voor de test.
 *
 * Drie uitkomsten:
 *   { actie: 'ingepland', afspraak }  — hij heeft zelf geboekt.
 *   { actie: 'terug' }                — 48 uur voorbij, niets geboekt.
 *   { actie: 'wacht' }                — de termijn loopt nog.
 *
 * Alleen afspraken die ná het doorsturen zijn aangemaakt tellen mee. Een oude
 * afspraak van dezelfde persoon is geen bewijs dat hij nú iets heeft gekozen —
 * dan zou de taak meteen als ingepland wegvallen zonder dat er iets gebeurd is.
 */
export function beslisWachtInplanning({ taak, afspraken, nu = Date.now() }) {
  const gestuurd = taak?.agenda_doorgestuurd_at ? new Date(taak.agenda_doorgestuurd_at).getTime() : NaN;

  const kandidaten = (Array.isArray(afspraken) ? afspraken : [])
    .filter((a) => a && hoortBijLead(taak, a))
    .filter((a) => {
      // Zonder bruikbaar doorstuurmoment kunnen we 'na het doorsturen' niet
      // beoordelen. Dan is elke afspraak van deze persoon verdacht en laten we
      // 'm liever staan dan de taak op grond van oude data af te sluiten.
      if (!Number.isFinite(gestuurd)) return false;
      const gemaakt = a.created_at ? new Date(a.created_at).getTime() : NaN;
      return Number.isFinite(gemaakt) && gemaakt >= gestuurd;
    })
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  if (kandidaten.length > 0) return { actie: 'ingepland', afspraak: kandidaten[0] };

  if (!Number.isFinite(gestuurd)) {
    // Geen doorstuurmoment bekend: dan is er geen klok om af te lopen. Terug in
    // de lijst zetten zou hier willekeurig zijn; laat staan en laat het opvallen.
    return { actie: 'wacht' };
  }
  if (nu - gestuurd >= WACHT_UREN * 3600 * 1000) return { actie: 'terug' };
  return { actie: 'wacht' };
}

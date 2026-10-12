// api/_lib/inbox-uitgesteld.js
//
// Een bericht dat dertig seconden in de wacht staat.
//
// ── HET GAT ──────────────────────────────────────────────────────────────────
// Het ongedaan-venster wachtte tot nu toe IN HET SCHERM. Sluit je het tabblad
// binnen die dertig seconden, dan vertrok het bericht nooit — en niets zei dat.
// Je denkt dat je geantwoord hebt.
//
// Nu parkeert de server het meteen. Blijft het tabblad open, dan geeft datzelfde
// scherm na dertig seconden het startsein, en is het dus exact dertig seconden.
// Is het tabblad dicht, dan pikt een cron het op.
//
// ── WAAROM EEN HYBRIDE EN GEEN ZUIVERE CRON ──────────────────────────────────
// Een Vercel-cron draait hooguit één keer per minuut. Alles aan de cron
// overlaten zou betekenen dat je ongedaan-venster in de praktijk tussen de
// dertig en negentig seconden ligt. Dat is niet "ongeveer dertig seconden", dat
// is een venster waarvan je niet weet wanneer het dicht is — en dan blijf je
// ernaar kijken in plaats van door te werken.
//
// ── DE CLAIM: WAAROM DIT HET HART IS ─────────────────────────────────────────
// Het scherm en de cron kunnen tegelijk besluiten dat dit bericht nú weg mag.
// Zonder claim vertrekt het dan TWEE KEER. Bij een klant met een
// betalingsachterstand is dat niet "een dubbel berichtje" maar een reden om te
// twijfelen aan alles wat je stuurt.
//
// De claim is één UPDATE die alleen slaagt als de rij nog op 'gepland' staat én
// nog niet geclaimd is. Twee tegelijk: één krijgt een rij terug, de ander nul.
// Zelfde patroon als cron-lisa-delayed, dat zich daar al bewezen heeft.
//
// ── LIEVER NIET DAN DUBBEL ───────────────────────────────────────────────────
// Een claim wordt NOOIT vrijgegeven. Dat is de belangrijkste regel in dit
// bestand en de reden dat sluitHangendeClaimsAf() zo heet. De uitleg staat daar.

import { supabaseAdmin } from '../supabase.js';
import {
  OPEN_STATUS, CLAIM_VERVAL_MINUTEN,
  MISLUKT, ONBEKEND, AANDACHT_STATUSSEN, AANDACHT_VENSTER_MS,
} from './inbox-wachtrij.js';

// De zuivere kant staat in _lib/inbox-wachtrij.js: die mag niets importeren,
// zodat een test die alleen de vertaling nakijkt niet de hele databaselaag
// meetrekt. Hier opnieuw uitgedeeld zodat een aanroeper aan één import genoeg
// heeft.
export {
  UITSTEL_MS, CLAIM_VERVAL_MINUTEN, OPEN_STATUS,
  MISLUKT, ONBEKEND, AANDACHT_STATUSSEN, AANDACHT_VENSTER_MS,
  verstuurMoment, naarWachtrij, uitWachtrij,
} from './inbox-wachtrij.js';

/**
 * Claim één rij voor deze verzender.
 *
 * Race-vrij: de UPDATE slaagt alleen als de rij nog op 'gepland' staat én nog
 * niet geclaimd is. Twee die tegelijk claimen — het scherm en de cron, of twee
 * cron-runs — leveren één rij en één niets op.
 *
 * @returns {Promise<object|null>} de geclaimde rij, of null als een ander 'm had
 */
export async function claim(id, nu = new Date(), db = supabaseAdmin) {
  const { data, error } = await db
    .from('inbox_uitgesteld')
    .update({ claimed_at: nu.toISOString() })
    .eq('id', id)
    .eq('status', OPEN_STATUS)
    .is('claimed_at', null)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[inbox-uitgesteld] claim mislukt:', id, error.message);
    return null;
  }
  return data || null;
}

/**
 * Leg vast dat we de transportlaag NU gaan aanroepen.
 *
 * Dit is de hele reden dat 'onbekend' een zeldzame stand is en niet de
 * standaard. Zonder deze stempel weet een opruimer alleen "er is geclaimd en
 * daarna niets meer" — en dan moet hij het ergste aannemen voor élke afgebroken
 * rij. Met de stempel is het verschil hard:
 *
 *   leeg   → de verzending is nooit begonnen. Met zekerheid niets vertrokken.
 *   gevuld → we hebben het aangeboden en geen antwoord gezien. Wij weten het
 *            niet.
 *
 * Faalt deze UPDATE, dan roepen we de transportlaag niet aan. Dat is de veilige
 * kant: één bericht dat niet vertrok en dat luid zegt, tegen een bericht
 * waarvan niemand meer kan vaststellen wat ermee gebeurd is.
 *
 * @returns {Promise<boolean>} of de stempel staat
 */
export async function markeerMetaAangeroepen(id, nu = new Date(), db = supabaseAdmin) {
  const { error } = await db
    .from('inbox_uitgesteld')
    .update({ meta_aangeroepen_op: nu.toISOString() })
    .eq('id', id);
  if (error) {
    console.error('[inbox-uitgesteld] meta-stempel mislukt:', id, error.message);
    return false;
  }
  return true;
}

/** Leg vast dat het gelukt is. */
export async function markeerVerstuurd(id, metaWamid = null, db = supabaseAdmin) {
  const { error } = await db
    .from('inbox_uitgesteld')
    .update({ status: 'verstuurd', meta_wamid: metaWamid, afgehandeld_op: new Date().toISOString() })
    .eq('id', id);
  if (error) console.error('[inbox-uitgesteld] verstuurd-markering mislukt:', id, error.message);
}

/**
 * Leg vast dat het niet gelukt is, en waaróm.
 *
 * De reden komt in het gesprek te staan. Een bericht dat niet vertrok mag nooit
 * stil blijven: dat is precies het gat dat deze hele bouw dicht.
 */
export async function markeerMislukt(id, reden, db = supabaseAdmin) {
  const { error } = await db
    .from('inbox_uitgesteld')
    .update({
      status: MISLUKT,
      reden: String(reden || 'onbekende fout').slice(0, 500),
      afgehandeld_op: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) console.error('[inbox-uitgesteld] mislukt-markering mislukt:', id, error.message);
}

/**
 * Haal een bericht terug dat nog niet onderweg is.
 *
 * Let op de voorwaarden: alleen als hij nog op 'gepland' staat én nog niet
 * geclaimd is. Is hij al geclaimd, dan is hij ónderweg en is annuleren een
 * leugen — dan geeft dit null terug en hoort de aanroeper te zeggen dat het te
 * laat is. Beter een eerlijke "te laat" dan een knop die zegt dat hij het
 * tegenhield terwijl de klant het bericht al heeft.
 *
 * @returns {Promise<object|null>} de geannuleerde rij, of null als het te laat was
 */
export async function annuleer(id, reden = 'teruggehaald', db = supabaseAdmin) {
  const { data, error } = await db
    .from('inbox_uitgesteld')
    .update({
      status: 'geannuleerd',
      reden: String(reden).slice(0, 500),
      afgehandeld_op: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', OPEN_STATUS)
    .is('claimed_at', null)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[inbox-uitgesteld] annuleren mislukt:', id, error.message);
    return null;
  }
  return data || null;
}

/**
 * Wat er klaarstaat om te vertrekken.
 *
 * Alleen wat nog van niemand is. De index idx_inbox_uitgesteld_klaar is precies
 * voor deze vraag gemaakt.
 */
export async function klaarVoorVertrek(limiet = 20, nu = new Date(), db = supabaseAdmin) {
  const { data, error } = await db
    .from('inbox_uitgesteld')
    .select('id')
    .eq('status', OPEN_STATUS)
    .is('claimed_at', null)
    .lte('verstuur_na', nu.toISOString())
    .order('verstuur_na', { ascending: true })
    .limit(limiet);
  if (error) {
    console.error('[inbox-uitgesteld] ophalen mislukt:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Hangende claims AFSLUITEN — en waarom dat geen herkansing is.
 *
 * ── HET GEVAL ────────────────────────────────────────────────────────────────
 * Een proces claimt een rij, roept de transportlaag aan, en valt om vóór het de
 * status kan wegschrijven. De rij blijft staan op 'gepland' met een claim erop.
 *
 * ── WAT WE NIET DOEN ─────────────────────────────────────────────────────────
 * De voor de hand liggende oplossing is: claim wissen, iemand anders pakt 'm
 * op. Die deur zit hier dicht, en met opzet. Op het moment dat het proces
 * omviel, kán het bericht al geaccepteerd zijn. Vrijgeven betekent dan dat het
 * een tweede keer vertrekt — precies wat deze hele tabel moet voorkomen.
 *
 * Een eerdere versie van dit bestand keek of er ná het claim-moment een
 * uitgaand bericht in het gesprek stond, en gaf de rij vrij als dat er niet
 * was. Dat is twee keer gokken in één beweging: een uitgaand bericht van
 * iemand anders leest als "dit is verstuurd", en géén uitgaand bericht sluit
 * niet uit dat de transportlaag het wél aannam en alleen het wegschrijven
 * misging. Van de twee manieren waarop dit mis kan gaan is er één veel erger
 * dan de andere. Niet verstuurd en luid gemeld is binnen een minuut recht te
 * zetten door een mens. Twee keer verstuurd naar een klant met een achterstand
 * is niet recht te zetten.
 *
 * ── WAT WE WEL DOEN: KIJKEN NAAR WAT WE ZEKER WETEN ──────────────────────────
 * meta_aangeroepen_op wordt gezet vóór de transportlaag wordt aangeroepen. Dus:
 *
 *   leeg   → de verzending is nooit begonnen. Stand 'mislukt', en het scherm
 *            mag zeggen dat er niets vertrok. Opnieuw doen is veilig, en een
 *            MENS doet dat.
 *   gevuld → aangeboden, geen antwoord gezien. Stand 'onbekend'. Het scherm
 *            zegt dat we het niet weten en vraagt om de draad na te kijken.
 *            Geen enkel automatisme raakt deze rij nog aan.
 *
 * In beide gevallen een eindstand, in beide gevallen een reden in het gesprek.
 */
export async function sluitHangendeClaimsAf(nu = new Date(), db = supabaseAdmin) {
  const grens = new Date(nu.getTime() - CLAIM_VERVAL_MINUTEN * 60 * 1000).toISOString();
  const uitkomst = { afgesloten_mislukt: 0, afgesloten_onbekend: 0 };

  const { data: hangend, error } = await db
    .from('inbox_uitgesteld')
    .select('id, claimed_at, meta_aangeroepen_op')
    .eq('status', OPEN_STATUS)
    .not('claimed_at', 'is', null)
    .lt('claimed_at', grens)
    .limit(50);
  if (error) {
    console.error('[inbox-uitgesteld] hangende claims ophalen mislukt:', error.message);
    return uitkomst;
  }

  for (const rij of (hangend || [])) {
    // Per rij een eigen try: één rij die misgaat mag de rest niet blokkeren.
    try {
      const begonnen = !!rij.meta_aangeroepen_op;
      const stand = begonnen ? ONBEKEND : MISLUKT;
      const reden = begonnen
        ? 'Het versturen brak halverwege af. Wij weten NIET of de klant dit bericht heeft gekregen — kijk de draad na voordat je het opnieuw stuurt.'
        : 'Het versturen is nooit begonnen; er is met zekerheid niets vertrokken. Je kunt dit bericht veilig opnieuw sturen.';
      const { error: zetFout } = await db
        .from('inbox_uitgesteld')
        .update({ status: stand, reden, afgehandeld_op: new Date().toISOString() })
        .eq('id', rij.id)
        .eq('status', OPEN_STATUS);
      if (zetFout) {
        console.error('[inbox-uitgesteld] afsluiten mislukt:', rij.id, zetFout.message);
        continue;
      }
      if (begonnen) uitkomst.afgesloten_onbekend++;
      else uitkomst.afgesloten_mislukt++;
      // Altijd met tekst, nooit alleen een teller: anders is dit in de
      // Vercel-logs niet terug te vinden.
      console.warn('[inbox-uitgesteld] hangende claim afgesloten als', stand + ':', rij.id);
    } catch (e) {
      console.warn('[inbox-uitgesteld] hangende claim overslaan:', rij.id, e?.message || e);
    }
  }

  return uitkomst;
}

/**
 * Wat er in dit gesprek misging — voor het scherm.
 *
 * Een bericht dat niet vertrok mag nooit stil blijven. Dit is de kant van die
 * regel die de gebruiker ziet. Alleen van het laatste etmaal: wat je na een dag
 * nog niet hebt opgepakt, is geen melding meer maar een verwijt.
 */
export async function aandachtVoorGesprek(convId, nu = new Date(), db = supabaseAdmin) {
  const sinds = new Date(nu.getTime() - AANDACHT_VENSTER_MS).toISOString();
  const { data, error } = await db
    .from('inbox_uitgesteld')
    .select('id, mode, body, template_name, status, reden, afgehandeld_op')
    .eq('conversation_id', convId)
    .in('status', AANDACHT_STATUSSEN)
    .gte('afgehandeld_op', sinds)
    .order('afgehandeld_op', { ascending: false })
    .limit(10);
  if (error) {
    console.error('[inbox-uitgesteld] aandacht ophalen mislukt:', error.message);
    return [];
  }
  return data || [];
}

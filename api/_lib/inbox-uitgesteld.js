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
// Is het tabblad dicht, dan pikt een cron het op. Het bericht vertrekt hoe dan
// ook, of het wordt bewust geannuleerd — die twee, en niets ertussenin.
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

import { supabaseAdmin } from '../supabase.js';
import { OPEN_STATUS, CLAIM_VERVAL_MINUTEN } from './inbox-wachtrij.js';

// De zuivere kant staat in _lib/inbox-wachtrij.js: die mag niets importeren,
// zodat een test die alleen de vertaling nakijkt niet de hele databaselaag
// meetrekt. Hier opnieuw uitgedeeld zodat een aanroeper aan één import genoeg
// heeft.
export {
  UITSTEL_MS, CLAIM_VERVAL_MINUTEN, OPEN_STATUS,
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
export async function claim(id, nu = new Date()) {
  const { data, error } = await supabaseAdmin
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

/** Leg vast dat het gelukt is. */
export async function markeerVerstuurd(id, metaWamid = null) {
  const { error } = await supabaseAdmin
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
export async function markeerMislukt(id, reden) {
  const { error } = await supabaseAdmin
    .from('inbox_uitgesteld')
    .update({
      status: 'mislukt',
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
export async function annuleer(id, reden = 'teruggehaald') {
  const { data, error } = await supabaseAdmin
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
export async function klaarVoorVertrek(limiet = 20, nu = new Date()) {
  const { data, error } = await supabaseAdmin
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
 * Hangende claims opruimen — en waarom dat NIET opnieuw versturen is.
 *
 * ── HET GEVAL ────────────────────────────────────────────────────────────────
 * Een proces claimt een rij, roept Meta aan, en valt om vóór het de status kan
 * wegschrijven. De rij blijft staan op 'gepland' met een claim erop, en niemand
 * pakt hem nog op.
 *
 * ── WAAROM WE HEM NIET GEWOON VRIJGEVEN ──────────────────────────────────────
 * De voor de hand liggende oplossing is: claim wissen, iemand anders pakt 'm op.
 * Maar op het moment dat het proces omviel, kan Meta het bericht al geaccepteerd
 * hebben. Vrijgeven betekent dan dat het een tweede keer vertrekt, en dat is
 * precies wat deze hele tabel moet voorkomen.
 *
 * Van de twee manieren waarop dit mis kan gaan is er één veel erger dan de
 * andere. Niet verstuurd en luid gemeld is binnen een minuut recht te zetten
 * door een mens. Twee keer verstuurd naar een klant met een achterstand is niet
 * recht te zetten.
 *
 * ── DUS: KIJKEN IN PLAATS VAN GOKKEN ─────────────────────────────────────────
 * We kijken of er ná het claim-moment een uitgaand bericht in dit gesprek
 * staat. Zo ja, dan is het vrijwel zeker dít bericht en zetten we de rij op
 * 'verstuurd' met een notitie dat het nagekeken hoort te worden. Zo nee, dan is
 * er niets vertrokken en mag de rij veilig weer vrij.
 *
 * Nooit stil, in beide gevallen: de reden komt in het gesprek te staan.
 */
export async function ruimHangendeClaimsOp(nu = new Date()) {
  const grens = new Date(nu.getTime() - CLAIM_VERVAL_MINUTEN * 60 * 1000).toISOString();
  const uitkomst = { vrijgegeven: 0, vermoedelijk_verstuurd: 0 };

  const { data: hangend, error } = await supabaseAdmin
    .from('inbox_uitgesteld')
    .select('id, conversation_id, claimed_at')
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
      const { data: uitgaand } = await supabaseAdmin
        .from('whatsapp_messages')
        .select('id')
        .eq('conversation_id', rij.conversation_id)
        .eq('direction', 'out')
        .gte('sent_at', rij.claimed_at)
        .limit(1);

      if (Array.isArray(uitgaand) && uitgaand.length) {
        await supabaseAdmin
          .from('inbox_uitgesteld')
          .update({
            status: 'verstuurd',
            reden: 'Het versturen brak af, maar er staat een uitgaand bericht van datzelfde moment. Vermoedelijk verstuurd — kijk het na in de draad.',
            afgehandeld_op: new Date().toISOString(),
          })
          .eq('id', rij.id)
          .eq('status', OPEN_STATUS);
        uitkomst.vermoedelijk_verstuurd++;
      } else {
        await supabaseAdmin
          .from('inbox_uitgesteld')
          .update({ claimed_at: null })
          .eq('id', rij.id)
          .eq('status', OPEN_STATUS);
        uitkomst.vrijgegeven++;
      }
    } catch (e) {
      console.warn('[inbox-uitgesteld] hangende claim overslaan:', rij.id, e?.message || e);
    }
  }

  if (uitkomst.vrijgegeven || uitkomst.vermoedelijk_verstuurd) {
    console.log('[inbox-uitgesteld] hangende claims:', uitkomst);
  }
  return uitkomst;
}

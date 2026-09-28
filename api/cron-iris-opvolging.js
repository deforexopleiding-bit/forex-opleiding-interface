// api/cron-iris-opvolging.js
//
// "Verwittig me als er geen reactie komt" — het deel dat kijkt.
//
// Draait dagelijks. Twee vragen per opvolging:
//
//   1. Kwam er sinds het ijkpunt iets binnen op dit spoor? → sluiten, klaar.
//   2. Is de termijn om? → bericht geven aan wie erom vroeg.
//
// ── WAAROM DIT NIET IN cron-iris-werk ZIT ────────────────────────────────────
// Die draait elke paar minuten en heeft een tijdbudget van 25 seconden. Een
// opvolging hoeft maar één keer per dag bekeken te worden, en een mail versturen
// duurt lang genoeg om dat budget op te eten. Twee crons die elkaar niet in de
// weg zitten, is hier goedkoper dan één die alles moet halen.
//
// ── DE VOLGORDE: EERST CLAIMEN, DAN STUREN ───────────────────────────────────
// Een opvolging gaat eerst naar `verlopen` met een voorwaardelijke update op
// `status='kijkt'`, en pas daarna gaat de mail weg. Twee ronden die elkaar
// overlappen kunnen zo niet allebei dezelfde melding sturen: de tweede claim
// raakt nul rijen. Lukt de mail niet, dan blijft de rij op `verlopen` staan met
// de fout erbij en probeert de volgende ronde opnieuw -- tot MAX_MELD_POGINGEN.
//
// Dat is de omgekeerde keuze van de verzendwachtrij, waar niet-versturen beter
// is dan dubbel versturen. Hier gaat het om een bericht aan onszelf: een mail
// die twee keer komt is vervelend, een melding die nooit komt maakt de hele
// opvolging waardeloos. Vandaar wél opnieuw proberen -- maar gecapt, want de
// afspraak-reminders stuurden ooit 95 mails op een dag door precies dit soort
// herhaling zonder rem.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import {
  beoordeel,
  meldTekst,
  meldOnderwerp,
  MAX_MELD_POGINGEN,
} from './_lib/iris/opvolging.js';

/** Hoeveel opvolgingen we per ronde aandurven. Vercel kapt af op 60 seconden. */
const PER_RONDE = 50;

/** Waar de melding vandaan komt. Interne post, dus de algemene bus. */
const VAN_MAILBOX = 'info@deforexopleiding.nl';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Alleen GET en POST' });
  }
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const nu = new Date();
  const rapport = { bekeken: 0, gesloten: 0, gemeld: 0, opgegeven: 0, mislukt: 0, fouten: [] };

  try {
    const { data: rijen, error } = await supabaseAdmin
      .from('iris_opvolgingen')
      .select('id, gesprek_id, contact_id, waarop, omschrijving, sinds, tot, status, verwittig_email, meld_pogingen')
      .in('status', ['kijkt', 'verlopen'])
      .lte('tot', nu.toISOString())
      .order('tot', { ascending: true })
      .limit(PER_RONDE);

    if (error) {
      // Bestaat de tabel nog niet (migratie niet gedraaid), dan is dat geen
      // storing maar een stand van zaken. Eén regel in het log, geen 500 die
      // elk uur als mislukte cron in Vercel verschijnt.
      const tekst = String(error.message || '');
      if (/relation .*iris_opvolgingen.* does not exist/i.test(tekst) || error.code === '42P01') {
        console.warn('[cron-iris-opvolging] tabel iris_opvolgingen bestaat nog niet — migratie 2026-09-28 draaien.');
        return res.status(200).json({ ok: true, overgeslagen: 'tabel bestaat nog niet', rapport });
      }
      throw new Error('opvolgingen lezen: ' + tekst);
    }

    for (const o of (rijen || [])) {
      // Per rij een eigen try. Eén opvolging die omvalt mag de rest van de
      // ronde niet meenemen -- dat is hoe een halve ronde erger wordt dan geen.
      try {
        rapport.bekeken++;
        const reactie = await zoekReactie(o);
        const besluit = beoordeel(o, { reactie, nu });

        if (besluit.doe === 'reactie') {
          await sluit(o, reactie, besluit.reden, rapport);
        } else if (besluit.doe === 'melden') {
          await meld(o, rapport);
        } else if (besluit.doe === 'opgeven') {
          rapport.opgegeven++;
          // Niet naar 'gemeld': er is niets gemeld. De rij blijft op 'verlopen'
          // staan met de fout erbij, zichtbaar in de module. Een opgegeven
          // melding die er afgehandeld uitziet, is een verdwenen melding.
          console.warn('[cron-iris-opvolging] opgegeven na', o.meld_pogingen, 'pogingen:', o.id);
        }
      } catch (e) {
        rapport.mislukt++;
        const tekst = e?.message || String(e);
        if (rapport.fouten.length < 3) rapport.fouten.push(tekst);
        console.error('[cron-iris-opvolging] opvolging', o.id, 'mislukt:', tekst);
      }
    }

    return res.status(200).json({ ok: true, rapport });
  } catch (e) {
    console.error('[cron-iris-opvolging]', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Interne fout', rapport });
  }
}

/**
 * Kwam er iets binnen op dit spoor?
 *
 * Alleen INKOMENDE berichten. Wat wij zelf stuurden is geen reactie, en die
 * meetellen zou betekenen dat een herinnering van Iris haar eigen opvolging
 * sluit -- de zekerste manier om nooit meer bericht te krijgen.
 */
async function zoekReactie(o) {
  let vraag = supabaseAdmin
    .from('iris_berichten')
    .select('id, ontvangen_op')
    .eq('richting', 'in')
    .gt('ontvangen_op', o.sinds)
    .order('ontvangen_op', { ascending: true })
    .limit(1);

  if (o.waarop === 'gesprek' && o.gesprek_id) vraag = vraag.eq('gesprek_id', o.gesprek_id);
  else if (o.contact_id) vraag = vraag.eq('contact_id', o.contact_id);
  else return null;

  const { data, error } = await vraag;
  if (error) throw new Error('berichten lezen: ' + error.message);
  return data?.[0] || null;
}

/** Er kwam iets binnen. De opvolging heeft gedaan waarvoor hij er was. */
async function sluit(o, reactie, reden, rapport) {
  const { error } = await supabaseAdmin
    .from('iris_opvolgingen')
    .update({
      status: 'reactie',
      gezien_bericht_id: reactie?.id || null,
      gezien_op: reactie?.ontvangen_op || new Date().toISOString(),
      bijgewerkt_op: new Date().toISOString(),
    })
    .eq('id', o.id)
    .in('status', ['kijkt', 'verlopen']);
  if (error) throw new Error('sluiten: ' + error.message);
  rapport.gesloten++;

  // PRIVACY: id's en een korte omschrijving. Geen berichttekst.
  const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
    wie: null,
    wat: 'opvolging gesloten: ' + reden,
    gesprek_id: o.gesprek_id || null,
    contact_id: o.contact_id || null,
    resultaat: 'ok',
    details: { opvolging_id: o.id, gewacht_tot: o.tot },
  });
  if (logFout) console.warn('[cron-iris-opvolging] logregel mislukt:', logFout.message);
}

/** De termijn is om en er kwam niets. Claimen, dan sturen. */
async function meld(o, rapport) {
  const pogingen = (Number(o.meld_pogingen) || 0) + 1;

  // Claimen. Staat de rij nog op 'kijkt', dan is dit de eerste ronde die hem
  // pakt; staat hij al op 'verlopen', dan is dit een nieuwe poging. Allebei
  // voorwaardelijk, zodat twee overlappende ronden niet allebei mailen.
  const { data: geclaimd, error: claimFout } = await supabaseAdmin
    .from('iris_opvolgingen')
    .update({ status: 'verlopen', meld_pogingen: pogingen, bijgewerkt_op: new Date().toISOString() })
    .eq('id', o.id)
    .eq('meld_pogingen', Number(o.meld_pogingen) || 0)
    .in('status', ['kijkt', 'verlopen'])
    .select('id');
  if (claimFout) throw new Error('claimen: ' + claimFout.message);
  if (!geclaimd?.length) {
    // Een andere ronde was eerder. Niets doen is hier het juiste antwoord.
    console.warn('[cron-iris-opvolging] al geclaimd door een andere ronde:', o.id);
    return;
  }

  const uit = await sendEmailViaSmtp({
    fromMailbox: VAN_MAILBOX,
    to: o.verwittig_email,
    subject: meldOnderwerp(o),
    text: meldTekst(o, { basisUrl: process.env.PUBLIEKE_BASIS_URL || '' }),
  });

  if (!uit?.ok) {
    const reden = uit?.reason || 'mail niet verstuurd';
    const { error } = await supabaseAdmin
      .from('iris_opvolgingen')
      .update({ meld_fout: String(reden).slice(0, 300), bijgewerkt_op: new Date().toISOString() })
      .eq('id', o.id);
    if (error) console.warn('[cron-iris-opvolging] meld_fout niet opgeslagen:', error.message);
    rapport.mislukt++;
    console.error('[cron-iris-opvolging] melding mislukt voor', o.id, '-', reden,
      `(poging ${pogingen} van ${MAX_MELD_POGINGEN})`);
    return;
  }

  const { error } = await supabaseAdmin
    .from('iris_opvolgingen')
    .update({
      status: 'gemeld',
      gemeld_op: new Date().toISOString(),
      meld_fout: null,
      bijgewerkt_op: new Date().toISOString(),
    })
    .eq('id', o.id);
  if (error) throw new Error('gemeld opslaan: ' + error.message);
  rapport.gemeld++;

  const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
    wie: null,
    wat: 'opvolging gemeld: geen reactie binnen de termijn',
    gesprek_id: o.gesprek_id || null,
    contact_id: o.contact_id || null,
    resultaat: 'ok',
    details: { opvolging_id: o.id, tot: o.tot, pogingen },
  });
  if (logFout) console.warn('[cron-iris-opvolging] logregel mislukt:', logFout.message);
}

// api/iris-herkoppel.js
//
// DE KOPPELING OPNIEUW PROBEREN VOOR CONTACTEN DIE NOG GEEN KLANT HEBBEN.
//
//   GET   → hoeveel staan er op elke stand? (telt alleen, verandert niets)
//   POST  → probeer opnieuw; { max?: 500 }
//
// Recht: iris.instellingen. Dit verandert gegevens, en dat is niet hetzelfde
// als meekijken — vandaar niet `iris.view`.
//
// ── WAAROM DIT BESTAAT ───────────────────────────────────────────────────────
// Een contact kreeg zijn koppelstatus één keer, bij het aanmaken. Ging het
// zoeken toen mis, dan bleef dat contact voor altijd "onbekend", ook nadat de
// oorzaak allang verholpen was. Op productie gebeurde precies dat: de
// klantenopvraging noemde een kolom die niet bestaat, dus kwam ÉLK gesprek op
// "niet gekoppeld" te staan.
//
// De oorzaak is weg (zie _lib/iris/koppel.js) en nieuwe berichten koppelen
// zichzelf voortaan alsnog. Maar contacten waar niets meer binnenkomt, blijven
// hangen. Dit endpoint haalt die achterstand in één keer in.
//
// ── IDEMPOTENT, EN WAAROM DAT HIER MEER IS DAN EEN MOOI WOORD ────────────────
// Twee keer draaien geeft hetzelfde resultaat als één keer. Er wordt alleen
// gekeken naar contacten ZONDER customer_id, en er wordt alleen geschreven als
// de uitkomst afwijkt van wat er stond. Een geslaagde koppeling wordt nooit
// teruggedraaid — ook niet als de klantenlijst op dat moment onleesbaar is.
// Dat laatste is het belangrijkste: een ronde die halverwege stukloopt, mag
// niet erger zijn dan geen ronde.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalKlantenlijst, zoekKlantIn } from './_lib/iris/koppel.js';

/** Hoeveel contacten we per aanroep aandurven. Vercel kapt af op 30 seconden. */
export const STANDAARD_MAX = 500;

/**
 * Wat moet er aan dit contact veranderen?
 *
 * Zuivere functie, los van de databank, zodat de regels na te rekenen zijn.
 * `null` betekent: laat staan.
 *
 * @param {{id: string, customer_id: string|null, koppelstatus: string, koppel_reden: string|null, weergavenaam: string|null}} contact
 * @param {{gelezen: boolean, status: string, id: string|null, reden: string, kandidaten?: Array}} uitkomst
 * @returns {null|object}
 */
export function bepaalWijziging(contact, uitkomst) {
  if (!contact || !uitkomst) return null;

  // Niet gekeken kunnen worden is geen antwoord. Wat er stond blijft staan.
  if (uitkomst.gelezen !== true) return null;

  // Een bestaande koppeling is heilig. Deze ronde maakt koppelingen, hij
  // verbreekt ze niet — daar hoort een mens bij.
  if (contact.customer_id) return null;

  const nieuweKlant = uitkomst.status === 'gekoppeld' ? (uitkomst.id || null) : null;
  const zelfdeStatus = String(uitkomst.status) === String(contact.koppelstatus);
  // De REDEN telt mee als verschil. Blijft de stand 'onbekend' maar staat er
  // nog een oude foutmelding bij ("klanten niet gelezen: column
  // customers.name does not exist"), dan hoort die vervangen te worden door
  // wat er nú aan de hand is. Een reden die een verholpen fout blijft noemen,
  // stuurt de volgende lezer een uur de verkeerde kant op.
  const zelfdeReden = String(uitkomst.reden || '') === String(contact.koppel_reden || '');
  if (!nieuweKlant && zelfdeStatus && zelfdeReden) return null;   // er verandert niets

  const wijziging = {
    customer_id: nieuweKlant,
    koppelstatus: uitkomst.status,
    koppel_reden: uitkomst.reden || null,
    bijgewerkt_op: new Date().toISOString(),
  };
  // Een naam die er al staat blijft staan: die kan met de hand gezet zijn.
  if (!contact.weergavenaam && uitkomst.kandidaten?.[0]?.naam) {
    wijziging.weergavenaam = uitkomst.kandidaten[0].naam;
  }
  return wijziging;
}

/** De standen tellen, zonder iets aan te raken. */
async function tel() {
  const uit = { gekoppeld: 0, te_bevestigen: 0, onbekend: 0, totaal: 0 };
  for (const stand of ['gekoppeld', 'te_bevestigen', 'onbekend']) {
    const { count, error } = await supabaseAdmin
      .from('iris_contacten')
      .select('id', { count: 'exact', head: true })
      .eq('koppelstatus', stand);
    if (error) throw new Error('tellen (' + stand + '): ' + error.message);
    uit[stand] = Number(count || 0);
    uit.totaal += uit[stand];
  }
  return uit;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });
  if (!(await requirePermission(req, 'iris.instellingen'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.instellingen)' });
  }

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ standen: await tel() });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Alleen GET en POST' });
    }

    const voor = await tel();

    const gevraagd = Number(req.body?.max);
    const max = Number.isFinite(gevraagd) && gevraagd > 0 ? Math.min(Math.trunc(gevraagd), 2000) : STANDAARD_MAX;

    const { data: contacten, error } = await supabaseAdmin
      .from('iris_contacten')
      .select('id, customer_id, emails, telefoons, koppelstatus, koppel_reden, weergavenaam')
      .is('customer_id', null)
      .order('aangemaakt_op', { ascending: true })
      .limit(max);
    if (error) throw new Error('contacten: ' + error.message);

    // HET KLANTBESTAND ÉÉN KEER. Per contact opnieuw ophalen zou bij 254
    // contacten 254 volledige opvragingen zijn; Vercel kapt af op dertig
    // seconden en dan ziet degene die op de knop drukte helemaal niets — ook
    // niet wat er wél gelukt was.
    const klanten = await haalKlantenlijst(supabaseAdmin);
    if (!klanten.gelezen) {
      // Geen enkele beoordeling is nu iets waard. Niets schrijven en het
      // eerlijk zeggen, in plaats van 254 rijen op "onbekend" bevestigen.
      return res.status(503).json({
        error: 'Klantbestand niet gelezen',
        uitleg: klanten.reden || 'onbekend',
        voor,
        na: voor,
        bekeken: 0, gewijzigd: 0, mislukt: 0,
      });
    }

    const rijen = contacten || [];
    let bekeken = 0;
    let gewijzigd = 0;
    let mislukt = 0;
    let nietGelezen = 0;
    const foutVoorbeelden = [];

    for (const c of rijen) {
      // Per contact een eigen try. Eén rij die omvalt mag de rest van de ronde
      // niet meenemen — dat is precies hoe een halve ronde erger wordt dan
      // geen ronde.
      try {
        bekeken++;
        // Eerste adres en eerste nummer. Een contact met twee adressen waarvan
        // alleen het tweede matcht, blijft hier onbekend — zeldzaam, en beter
        // dan gokken welk van de twee de echte is.
        const uitkomst = zoekKlantIn(klanten.rijen, {
          email: (c.emails || [])[0] || null,
          telefoon: (c.telefoons || [])[0] || null,
        });
        if (uitkomst.gelezen !== true) { nietGelezen++; continue; }

        const wijziging = bepaalWijziging(c, uitkomst);
        if (!wijziging) continue;

        const { error: schrijfFout } = await supabaseAdmin
          .from('iris_contacten')
          .update(wijziging)
          .eq('id', c.id)
          .is('customer_id', null);   // nog steeds ongekoppeld? anders niets doen
        if (schrijfFout) throw new Error(schrijfFout.message);
        gewijzigd++;
      } catch (e) {
        mislukt++;
        const tekst = e?.message || String(e);
        if (foutVoorbeelden.length < 3) foutVoorbeelden.push(tekst);
        console.error('[iris-herkoppel] contact', c.id, 'mislukt:', tekst);
      }
    }

    const na = await tel();

    const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
      wie: user.id,
      wat: 'koppeling opnieuw geprobeerd',
      resultaat: mislukt ? 'deels' : 'ok',
      details: { bekeken, gewijzigd, mislukt, niet_gelezen: nietGelezen, voor, na },
    });
    if (logFout) console.warn('[iris-herkoppel] logregel mislukt:', logFout.message);

    return res.status(200).json({
      bekeken,
      gewijzigd,
      mislukt,
      niet_gelezen: nietGelezen,
      fout_voorbeelden: foutVoorbeelden,
      // Meer contacten zonder klant dan we in één ronde aandurfden: nog eens
      // draaien pakt de volgende groep. Zeggen is beter dan stil afkappen.
      meer_te_doen: rijen.length === max,
      voor,
      na,
    });
  } catch (e) {
    console.error('[iris-herkoppel]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Herkoppelen mislukt' });
  }
}

// api/opvolging-whatsapp-webhook.js
//
// POST → de brug meldt een gebeurtenis: verzonden, afgeleverd, gelezen of een
// binnengekomen antwoord. Wordt een rij in opvolging_pogingen.
//
// Body: { soort, nummer, tijdstip, tekst?, media_type?, bericht_id? }
//   soort ∈ verzonden | afgeleverd | gelezen | antwoord_ontvangen
//
// Auth: het gedeelde geheim in X-Brug-Secret. Geen user-sessie — de brug heeft
// er geen.
//
// EEN NUMMER ZONDER OPVOLGTAAK KRIJGT WEL EEN GESPREKSREGEL, GEEN POGING.
//
// Dat stond andersom, en dat was fout. Wat hier binnenkomt heeft het
// leadlijstfilter van de brug al gepasseerd — de brug stuurt uitsluitend
// nummers door die op onze eigen lijst staan, inclusief de zoomcall-leads uit
// _lib/opvolging-leadlijst-venster.js. Het bericht wegdoen omdat er toevallig
// geen KAART bij hoort, gooide dus meetbare feiten weg over mensen die we zelf
// hebben aangedragen: op 10 september liet de brug 36 berichten door en gaf
// /api/opvolging-whatsapp-gesprek?nummer= er nul terug voor vier zoomleads.
//
// Een POGING blijft wél aan een taak hangen. Die telt mee in de dekking van een
// kaart, en zonder kaart is er niets om in te tellen. De gespreksregel draagt
// `taak_id` NULL (de kolom is nullable) en wordt pas op het moment van rekenen
// tot poging omgevormd — zie api/_lib/opvolging-call-wa.js.
//
// Het antwoord blijft `gekoppeld: false`. De brug hoort niet te weten welke
// nummers een kaart hebben; `bewaard` zegt alleen of de regel is weggeschreven.
//
// Schrijft in opvolging_pogingen (de TELLING) en in opvolging_wa_berichten
// (het GESPREK), plus updated_at op de taak. Die twee zijn bewust gescheiden:
// een verstuurd bericht levert drie pogingen op (verzonden, afgeleverd,
// gelezen) maar hoort één regel in het gesprek te zijn.

import { supabaseAdmin } from './supabase.js';
import { brugGeheimKlopt } from './_lib/whatsapp-brug-client.js';
import { normaliseerNummer } from './_lib/whatsapp-brug-nummers.js';
import { isEchtGesprek } from './_lib/whatsapp-systeemtypes.js';

// 'uitgaand' is erbij gekomen toen bleek dat een spraakbericht dat Dave zelf
// stuurt nergens meetbaar was: het 'message'-event van whatsapp-web.js slaat
// eigen berichten over, en de ack-events droegen geen media_type. De brug
// stuurt nu message_create mee. Puur additief — de vier bestaande soorten
// gedragen zich exact als voorheen.
const SOORTEN = new Set(['verzonden', 'afgeleverd', 'gelezen', 'antwoord_ontvangen', 'uitgaand']);
const LOPEND  = ['open', 'wacht_inplanning', 'ingepland'];

// Wat er in de historiek komt te staan. Kort en in gewone taal — dit leest
// iemand terug om te zien wat er met deze lead gebeurd is.
const RESULTAAT = {
  verzonden        : 'WhatsApp verstuurd',
  afgeleverd       : 'WhatsApp afgeleverd',
  gelezen          : 'WhatsApp gelezen',
  antwoord_ontvangen: 'antwoord ontvangen',
  uitgaand         : 'WhatsApp verstuurd',
};
// Voor een spraakbericht leest het anders — en dat onderscheid is precies wat
// het dagsysteem meet.
const RESULTAAT_SPRAAK = {
  antwoord_ontvangen: 'spraakbericht ontvangen',
  uitgaand          : 'spraakbericht verstuurd',
};

// Een ingesproken bericht is een ander soort moeite dan een tekstje, en telt in
// de opvolging apart. whatsapp-web.js noemt die types 'ptt' (push to talk) en
// 'audio'.
const SPRAAK_TYPES = new Set(['ptt', 'audio', 'voice']);

/**
 * Statussen van een bericht dat al verstuurd is — geen poging van Dave.
 *
 * 'verzonden' hoort hier NIET bij: dat is het moment dat het bericht de deur
 * uitging, en dat ís de poging. Hij deelt zijn sleutel met 'uitgaand' (zie
 * idemSoort) zodat die twee wegen samen één rij opleveren.
 */
const STATUS_SOORTEN = new Set(['afgeleverd', 'gelezen']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  if (!brugGeheimKlopt(req)) {
    console.warn('[opvolging-whatsapp-webhook] geweigerd, geheim klopt niet');
    return res.status(401).json({ error: 'Niet toegestaan' });
  }

  const b = req.body || {};
  const soort = String(b.soort || '').trim();
  if (!SOORTEN.has(soort)) return res.status(400).json({ error: 'onbekende soort' });

  const nummer = normaliseerNummer(b.nummer);
  if (!nummer) return res.status(400).json({ error: 'nummer ontbreekt' });

  // WhatsApp stuurt over dezelfde stroom ook dingen die geen bericht zijn. Een
  // e2e_notification is een ververste sleutel; die stond in productie als
  // 'antwoord ontvangen' in de pogingen en liet de dekking oplopen voor een
  // lead die nooit gereageerd heeft.
  //
  // De brug weigert dit ook al, maar die draait op een VPS en loopt altijd
  // achter op een deploy. De juistheid van de cijfers mag niet afhangen van
  // wanneer daar voor het laatst een pull is gedaan.
  //
  // 200 en niet 400: de brug heeft niets fout gedaan. Hij heeft doorgegeven wat
  // WhatsApp hem gaf, en het antwoord vertelt hem waarom er niets mee gebeurt.
  if (!isEchtGesprek(b.media_type)) {
    return res.status(200).json({
      ok: true, gekoppeld: false, reden: 'systeemtype',
      media_type: String(b.media_type).slice(0, 40),
    });
  }

  const tijdstip = b.tijdstip ? new Date(b.tijdstip) : new Date();
  const tijdstipIso = isNaN(tijdstip.getTime()) ? new Date().toISOString() : tijdstip.toISOString();

  // Boven de taak-lookup, want de gespreksregel van een nummer zonder kaart
  // draagt hem ook — daar is hij de idempotency-sleutel van de partiële index.
  const berichtId = b.bericht_id ? String(b.bericht_id).slice(0, 200) : null;

  try {
    const taak = await zoekTaak(nummer);
    // Geen kaart, maar wel een lead die wij zelf op de brug-lijst hebben gezet.
    // De gespreksregel gaat door — anders is er straks niets om de twee
    // vensters op te beoordelen. Een poging niet: die hoort bij een kaart.
    if (!taak) {
      const bewaard = await bewaarGesprekRegel({
        soort, nummer, taakId: null, tijdstipIso, berichtId,
        tekst: volledigeTekstVan(b), mediaType: b.media_type,
      });
      return res.status(200).json({ ok: true, gekoppeld: false, bewaard });
    }

    // Zowel een ontvangen als een verstuurd spraakbericht telt als spraakbericht.
    // De richting staat nu in een KOLOM, niet in een woord. Hij was af te lezen
    // aan `resultaat`, en dat is een parser op een zin die iemand ooit anders
    // formuleert — dan telt de kaart weer iets anders dan wat er gebeurd is.
    // Zie de migratie 2026-09-06-opvolging-pogingen-richting.sql.
    const richting = soort === 'antwoord_ontvangen' ? 'in' : 'uit';
    const isSpraak = (soort === 'antwoord_ontvangen' || soort === 'uitgaand')
      && SPRAAK_TYPES.has(String(b.media_type || '').toLowerCase());

    // Idempotent: de brug herkanst bij een mislukte levering, en dezelfde
    // melding twee keer tellen zou de dekking laten oplopen zonder dat er iets
    // gebeurd is.
    //
    // 'uitgaand' en 'verzonden' beschrijven HETZELFDE moment — het bericht ging
    // de deur uit — maar komen langs twee wegen binnen: message_create en de
    // ack. Een bericht dat het CRM zelf stuurt levert allebei op. Ze delen
    // daarom één sleutel, zodat er één rij overblijft in plaats van twee.
    //
    // 'uitgaand' wint als hij later komt: die draagt het echte verzendmoment en
    // het media_type, en de ack draagt geen van beide betrouwbaar.
    const sleutel = berichtId ? berichtId + '#' + idemSoort(soort) : null;
    let bestaandeId = null;
    if (sleutel) {
      const { data: bestaand } = await supabaseAdmin
        .from('opvolging_pogingen')
        .select('id, soort')
        .eq('taak_id', taak.id)
        .eq('call_log_id', sleutel)
        .limit(1);
      if (bestaand && bestaand[0]) {
        if (soort !== 'uitgaand') {
          return res.status(200).json({ ok: true, gekoppeld: true, hergebruikt: true });
        }
        bestaandeId = bestaand[0].id;   // de ack was er eerder; bijwerken
      }
    }

    // ── EEN VERSTUURD BERICHT IS EEN POGING. AFGELEVERD EN GELEZEN NIET. ──
    //
    // Dat zijn geen pogingen van Dave maar statussen van een bericht dat hij al
    // gestuurd heeft. Ze maakten hier hun eigen rij, en drie leesbevestigingen
    // op dezelfde seconde werden dus drie pogingen. Ze werken vanaf nu hooguit
    // een bestaande rij bij.
    //
    // Vinden ze die rij niet — omdat er geen bericht-id was, of omdat het
    // versturen langs een andere weg liep — dan doen ze NIETS. Liever geen
    // status dan een verzonnen poging. De gespreksregel gaat wel gewoon door;
    // die vertelt het verhaal en telt niet mee in de dekking.
    if (STATUS_SOORTEN.has(soort)) {
      const bijgewerkt = await werkStatusBij({ taakId: taak.id, sleutel, soort, isSpraak });
      await bewaarGesprekRegel({
        soort, nummer, taakId: taak.id, tijdstipIso, berichtId,
        tekst: volledigeTekstVan(b), mediaType: b.media_type,
      });
      return res.status(200).json({
        ok: true, gekoppeld: true, status_bijgewerkt: bijgewerkt,
        // Geen sleutel betekent: niets te vinden, dus niets bijgewerkt. Dat is
        // geen fout, maar het hoort wel zichtbaar te zijn.
        reden: bijgewerkt ? null : (sleutel ? 'geen_bijbehorende_poging' : 'geen_bericht_id'),
      });
    }

    // De volledige tekst voor het gesprek, en een korte voor de historiek-regel.
    // Die twee zijn niet hetzelfde: `resultaat` is een samenvatting van 500
    // tekens die iemand terugleest, het gesprek is de tekst zelf.
    //
    // Uitgaande tekst komt sinds het gesprekspaneel ook mee. De brug stuurt die
    // pas ná zijn privacyfilter — alles buiten de leadlijst bereikt dit
    // endpoint niet.
    const volledigeTekst = volledigeTekstVan(b);
    const tekst = (soort === 'antwoord_ontvangen' && volledigeTekst)
      ? volledigeTekst.trim().slice(0, 500) : '';

    const rij = {
      taak_id    : taak.id,
      soort      : isSpraak ? 'spraakbericht' : 'whatsapp',
      tijdstip   : tijdstipIso,
      automatisch: true,
      resultaat  : bouwResultaat(soort, isSpraak, tekst),
      richting,
      // call_log_id is de enige vrije tekstkolom voor een externe verwijzing.
      // De soort staat erachter zodat afleveren en lezen los idempotent zijn;
      // versturen deelt zijn sleutel met 'uitgaand' — zie idemSoort().
      call_log_id: sleutel,
    };
    let poging;
    if (bestaandeId) {
      // De ack stond er al. Bijwerken met het echte verzendmoment en het type,
      // in plaats van er een tweede rij naast te zetten.
      const { data, error } = await supabaseAdmin.from('opvolging_pogingen')
        .update({ soort: rij.soort, tijdstip: rij.tijdstip, resultaat: rij.resultaat })
        .eq('id', bestaandeId).select('id').single();
      if (error) throw new Error(error.message);
      poging = data;
    } else {
      const { data, error } = await supabaseAdmin.from('opvolging_pogingen')
        .insert(rij).select('id').single();
      if (error) throw new Error(error.message);
      poging = data;
    }

    await supabaseAdmin.from('opvolging_taken')
      .update({ updated_at: new Date().toISOString() }).eq('id', taak.id);

    await bewaarGesprekRegel({
      soort, nummer, taakId: taak.id, tijdstipIso, berichtId,
      tekst: volledigeTekst, mediaType: b.media_type,
    });

    return res.status(200).json({ ok: true, gekoppeld: true, poging_id: poging.id });
  } catch (e) {
    console.error('[opvolging-whatsapp-webhook]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

/** De volledige tekst uit de body, begrensd. */
function volledigeTekstVan(b) {
  return typeof b?.tekst === 'string' ? b.tekst.slice(0, 4000) : '';
}

/**
 * Een status op een bestaande poging zetten. Maakt NOOIT een rij.
 *
 * Geeft terug of er iets bijgewerkt is. Nee is geen fout: zonder bericht-id valt
 * er niets te vinden, en dan is 'geen status' het eerlijke antwoord.
 */
async function werkStatusBij({ taakId, sleutel, soort, isSpraak }) {
  if (!sleutel) return false;
  // De poging staat onder de sleutel van het VERSTUREN, niet die van de status.
  const verzendSleutel = sleutel.replace(/#[^#]*$/, '') + '#' + idemSoort('verzonden');
  const { data, error } = await supabaseAdmin
    .from('opvolging_pogingen')
    .select('id')
    .eq('taak_id', taakId)
    .eq('call_log_id', verzendSleutel)
    .limit(1);
  if (error) { console.error('[opvolging-whatsapp-webhook] status zoeken:', error.message); return false; }
  if (!data || !data[0]) return false;
  const { error: updErr } = await supabaseAdmin
    .from('opvolging_pogingen')
    .update({ resultaat: bouwResultaat(soort, isSpraak, '') })
    .eq('id', data[0].id);
  if (updErr) { console.error('[opvolging-whatsapp-webhook] status bijwerken:', updErr.message); return false; }
  return true;
}

/**
 * De gespreksregel naast de poging.
 *
 * Alleen de twee soorten die een echt bericht beschrijven: een antwoord van de
 * lead en iets dat wij verstuurden. 'afgeleverd' en 'gelezen' zijn statussen op
 * een bericht dat er al staat — die als gespreksregel opnemen zou hetzelfde
 * bericht drie keer in de chat zetten.
 *
 * FAIL-SOFT, en dat is een bewuste keuze. De poging is de bestaande functie en
 * bepaalt het oordeel in Afgerond; het gesprek is er sinds vandaag bij. Draait
 * de migratie nog niet, of gaat er iets anders mis met deze tabel, dan mag dat
 * de telling niet meesleuren. De webhook antwoordt dus gewoon ok en er staat
 * een waarschuwing in het log — nooit de tekst zelf, alleen dát het misging.
 *
 * Idempotent op bericht_id via een partiële unique index. Een herkans van de
 * brug levert dus geen tweede regel op; 23505 is hier geen fout maar het bewijs
 * dat de regel er al stond.
 *
 * @returns {Promise<boolean>} of er een regel staat. Voor een nummer zonder
 *   kaart is dat het enige signaal dat de brug terugkrijgt; de statussen
 *   ('afgeleverd', 'gelezen') vallen er sowieso uit en leveren false op.
 */
async function bewaarGesprekRegel({ soort, nummer, taakId, tijdstipIso, berichtId, tekst, mediaType }) {
  const richting = soort === 'antwoord_ontvangen' ? 'in' : soort === 'uitgaand' ? 'uit' : null;
  if (!richting) return false;
  try {
    const { error } = await supabaseAdmin.from('opvolging_wa_berichten').insert({
      nummer,
      taak_id   : taakId,
      richting,
      tekst     : tekst || null,
      media_type: mediaType ? String(mediaType).slice(0, 40) : null,
      bericht_id: berichtId,
      tijdstip  : tijdstipIso,
    });
    if (error && error.code !== '23505') throw new Error(error.message);
    return true;
  } catch (e) {
    console.warn('[opvolging-whatsapp-webhook] gespreksregel (soft):', e?.message || e);
    return false;
  }
}

/**
 * De lopende taak bij dit nummer. Eerst exact op de volle reeks, dan op de
 * laatste negen cijfers — het CRM heeft nummers ook lokaal genoteerd terwijl
 * WhatsApp altijd met landcode aankomt. Bij meerdere treffers wint de meest
 * recent aangeraakte; bij een dubbelzinnige staart-match doen we niets.
 */
async function zoekTaak(nummer) {
  const { data, error } = await supabaseAdmin
    .from('opvolging_taken')
    .select('id, telefoon, status, updated_at')
    .in('status', LOPEND)
    .not('telefoon', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw new Error('taken lezen: ' + error.message);

  const kandidaten = data || [];
  const exact = kandidaten.filter((t) => normaliseerNummer(t.telefoon) === nummer);
  if (exact.length > 0) return exact[0];

  const staart = nummer.length >= 9 ? nummer.slice(-9) : null;
  if (!staart) return null;
  const bijnaam = kandidaten.filter((t) => {
    const c = normaliseerNummer(t.telefoon);
    return c && c.length >= 9 && c.slice(-9) === staart;
  });
  // Precies één, anders is het gokken — en een poging bij de verkeerde persoon
  // maakt het oordeel over twee mensen onwaar.
  return bijnaam.length === 1 ? bijnaam[0] : null;
}

/**
 * De regel die in de historiek komt te staan.
 *
 * De richting staat hierin en nergens anders: opvolging_pogingen heeft geen
 * kolom voor inkomend of uitgaand, en die voegen we hier niet toe. 'verstuurd'
 * tegenover 'ontvangen' is dus het onderscheid waar het dagscherm op leest.
 */
function bouwResultaat(soort, isSpraak, tekst) {
  const basis = (isSpraak && RESULTAAT_SPRAAK[soort]) || RESULTAAT[soort];
  return tekst ? `${basis}: ${tekst}` : basis;
}

/**
 * De soort zoals hij in de idempotency-sleutel terechtkomt.
 *
 * 'uitgaand' en 'verzonden' zijn hetzelfde moment langs twee wegen
 * (message_create en de ack). Ze delen een sleutel, zodat een bericht dat het
 * CRM zelf verstuurt niet twee rijen oplevert en dus niet dubbel meetelt in de
 * WhatsApp-teller op de kaart.
 *
 * Afleveren en lezen zijn wél eigen momenten en houden hun eigen sleutel.
 */
function idemSoort(soort) {
  return (soort === 'uitgaand' || soort === 'verzonden') ? 'uit' : soort;
}

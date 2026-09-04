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
// ONBEKENDE NUMMERS WORDEN STIL GENEGEERD. Niet als fout, niet met een melding
// in het antwoord: de brug hoort niet te weten welke nummers wij kennen, en een
// 404 op een onbekend nummer zou dat alsnog verklappen. Er wordt in dat geval
// ook niets van de tekst gelogd.
//
// Schrijft uitsluitend in opvolging_pogingen (plus updated_at op de taak).

import { supabaseAdmin } from './supabase.js';
import { brugGeheimKlopt } from './_lib/whatsapp-brug-client.js';
import { normaliseerNummer } from './_lib/whatsapp-brug-nummers.js';

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

  const tijdstip = b.tijdstip ? new Date(b.tijdstip) : new Date();
  const tijdstipIso = isNaN(tijdstip.getTime()) ? new Date().toISOString() : tijdstip.toISOString();

  try {
    const taak = await zoekTaak(nummer);
    // Stil. Geen 404, geen melding, geen log met de tekst erin.
    if (!taak) return res.status(200).json({ ok: true, gekoppeld: false });

    // Zowel een ontvangen als een verstuurd spraakbericht telt als spraakbericht.
    // De richting is af te lezen aan `resultaat`; de tabel heeft geen kolom
    // voor richting en die voegen we hier niet toe.
    const isSpraak = (soort === 'antwoord_ontvangen' || soort === 'uitgaand')
      && SPRAAK_TYPES.has(String(b.media_type || '').toLowerCase());

    // Idempotent op bericht_id + soort: de brug herkanst bij een mislukte
    // levering, en dezelfde aflever-melding twee keer tellen zou de dekking in
    // Afgerond laten oplopen zonder dat er iets gebeurd is.
    const berichtId = b.bericht_id ? String(b.bericht_id).slice(0, 200) : null;
    if (berichtId) {
      const { data: bestaand } = await supabaseAdmin
        .from('opvolging_pogingen')
        .select('id')
        .eq('taak_id', taak.id)
        .eq('call_log_id', berichtId + '#' + soort)
        .limit(1);
      if (bestaand && bestaand[0]) return res.status(200).json({ ok: true, gekoppeld: true, hergebruikt: true });
    }

    const tekst = (soort === 'antwoord_ontvangen' && typeof b.tekst === 'string')
      ? b.tekst.trim().slice(0, 500) : '';

    const { data: poging, error } = await supabaseAdmin.from('opvolging_pogingen').insert({
      taak_id    : taak.id,
      soort      : isSpraak ? 'spraakbericht' : 'whatsapp',
      tijdstip   : tijdstipIso,
      automatisch: true,
      resultaat  : bouwResultaat(soort, isSpraak, tekst),
      // call_log_id is de enige vrije tekstkolom voor een externe verwijzing.
      // Met de soort erachter, want één bericht levert meerdere gebeurtenissen
      // op (verzonden, afgeleverd, gelezen) en die moeten los idempotent zijn.
      call_log_id: berichtId ? berichtId + '#' + soort : null,
    }).select('id').single();
    if (error) throw new Error(error.message);

    await supabaseAdmin.from('opvolging_taken')
      .update({ updated_at: new Date().toISOString() }).eq('id', taak.id);

    return res.status(200).json({ ok: true, gekoppeld: true, poging_id: poging.id });
  } catch (e) {
    console.error('[opvolging-whatsapp-webhook]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
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

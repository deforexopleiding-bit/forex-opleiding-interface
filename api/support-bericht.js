// api/support-bericht.js
//
// POST — de bezoeker stuurt een bericht. Antwoordt de bot, of gaat het naar
// een mens?
//
// Drie uitkomsten:
//   1. Het gesprek staat al bij een medewerker (status in_behandeling /
//      wacht_op_ons) → het bericht komt binnen, de bot houdt zijn mond. Een
//      bot die meepraat terwijl een collega aan het typen is, is erger dan
//      geen bot.
//   2. De bezoeker vraagt zelf om een mens → escaleren, klaar.
//   3. Anders → de bot probeert het, en het mandaat in support-bot-core
//      bepaalt of zijn antwoord naar buiten mag.
//
// De botcall gebeurt binnen het verzoek, niet fire-and-forget: de bezoeker
// zit te wachten op een antwoord in de chat, dus er is niets asynchroons aan.

import { supabaseAdmin } from './supabase.js';
import { applySupportCors, handledPreflight } from './_lib/support-cors.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { tokenUitRequest, gesprekUitToken, schrijfBericht, publiekBericht } from './_lib/support-sessie.js';
import { haalBeschikbaarheid, beschikbaarheidsTekst } from './_lib/support-beschikbaarheid.js';
import { botAntwoord } from './_lib/support-bot-core.js';
import { escaleerGesprek } from './_lib/support-escalatie.js';
import { stuurWachtrijBevestiging } from './_lib/support-mail.js';

const MAX_TEKST = 4000;

export default async function handler(req, res) {
  applySupportCors(req, res, 'POST, OPTIONS');
  if (handledPreflight(req, res, 'POST')) return;

  const gesprek = await gesprekUitToken(tokenUitRequest(req));
  if (!gesprek) return res.status(401).json({ error: 'Onbekende sessie' });

  if (gesprek.status === 'afgehandeld') {
    return res.status(409).json({ error: 'Dit gesprek is afgerond. Start een nieuw gesprek.' });
  }

  const { limited } = await checkRateLimit({
    req, bucket: 'support-bericht', maxHits: 30, withinSeconds: 300,
  });
  if (limited) return res.status(429).json({ error: 'Rustig aan — probeer het zo nog eens.' });

  const tekst = String(req.body?.tekst || '').trim().slice(0, MAX_TEKST);
  const vraagtMens = req.body?.vraagt_mens === true;
  if (!tekst) return res.status(400).json({ error: 'Leeg bericht' });

  // `stil` betekent: laat de bot reageren op wat er AL in de thread staat,
  // zonder het bericht nog een keer op te slaan. De widget gebruikt dit twee
  // keer — direct na het startformulier, en opnieuw zodra de mailcode klopt.
  // Zonder deze vlag zou de openingsvraag twee of drie keer in de thread
  // belanden en zou de bot 'm ook nog eens als nieuw bericht lezen.
  //
  // Alleen toegestaan als er echt al een bericht van de klant staat;
  // anders is het een manier om de bot te laten draaien op een lege thread.
  let stil = req.body?.stil === true;
  let nieuw = null;

  if (stil) {
    const { data: bestaat } = await supabaseAdmin
      .from('support_berichten')
      .select('id, afzender, tekst, created_at')
      .eq('gesprek_id', gesprek.id)
      .eq('afzender', 'klant')
      .order('created_at', { ascending: false })
      .limit(1);
    nieuw = (bestaat || [])[0] || null;
    if (!nieuw) stil = false;
  }

  if (!stil) {
    nieuw = await schrijfBericht({ gesprekId: gesprek.id, afzender: 'klant', tekst });
    if (!nieuw) return res.status(500).json({ error: 'Je bericht kon niet opgeslagen worden.' });
  }

  const beschikbaarheid = await haalBeschikbaarheid();
  const antwoorden = [];

  // ── 1. Er zit al een mens op dit gesprek ────────────────────────────────
  if (gesprek.status === 'in_behandeling' || gesprek.status === 'wacht_op_ons') {
    // Terug naar de wachtrij als wij aan zet waren — anders blijft het op
    // 'wacht_op_klant' staan terwijl de klant net geantwoord heeft.
    if (gesprek.status !== 'wacht_op_ons') {
      await supabaseAdmin.from('support_gesprekken').update({ status: 'wacht_op_ons' }).eq('id', gesprek.id);
    }
    return res.status(200).json({
      bericht: publiekBericht(nieuw),
      antwoorden: [],
      status: 'wacht_op_ons',
    });
  }

  // ── 2. De bezoeker wil een mens ─────────────────────────────────────────
  if (vraagtMens) {
    const { melding } = await escaleerGesprek({ gesprek, reden: 'klant_vraagt_mens', beschikbaarheid });
    if (!beschikbaarheid.live) {
      await stuurWachtrijBevestiging({ naar: gesprek.email, naam: gesprek.naam, kenmerk: gesprek.kenmerk, vraag: tekst })
        .catch((e) => console.warn('[support-bericht] wachtrijmail mislukt:', e?.message || e));
    }
    return res.status(200).json({
      bericht: publiekBericht(nieuw),
      antwoorden: melding ? [{ afzender: 'systeem', tekst: melding, created_at: new Date().toISOString() }] : [],
      status: 'wacht_op_ons',
    });
  }

  // ── 3. De bot ───────────────────────────────────────────────────────────
  let berichten = [];
  try {
    const { data } = await supabaseAdmin
      .from('support_berichten')
      .select('afzender, tekst, created_at')
      .eq('gesprek_id', gesprek.id)
      .order('created_at', { ascending: true })
      .limit(60);
    berichten = data || [];
  } catch (e) {
    console.warn('[support-bericht] thread lezen mislukt:', e?.message || e);
  }

  const resultaat = await botAntwoord({ gesprek, berichten, beschikbaarheid });

  if (!resultaat.ok) {
    // De bot kan niet. Dat is geen storing voor de bezoeker — het gesprek
    // gaat gewoon naar een mens, precies zoals wanneer de bot het niet wist.
    console.warn('[support-bericht] bot niet beschikbaar:', resultaat.code);
    const { melding } = await escaleerGesprek({ gesprek, reden: `bot_${resultaat.code}`, beschikbaarheid });
    if (!beschikbaarheid.live) {
      await stuurWachtrijBevestiging({ naar: gesprek.email, naam: gesprek.naam, kenmerk: gesprek.kenmerk, vraag: tekst })
        .catch(() => {});
    }
    return res.status(200).json({
      bericht: publiekBericht(nieuw),
      antwoorden: melding ? [{ afzender: 'systeem', tekst: melding, created_at: new Date().toISOString() }] : [],
      status: 'wacht_op_ons',
    });
  }

  // Het antwoord van de bot in de thread — ook als het gesprek daarna
  // escaleert. De bezoeker heeft er iets aan, en een collega ziet meteen wat
  // er al gezegd is.
  const botBericht = await schrijfBericht({
    gesprekId: gesprek.id,
    afzender: 'bot',
    tekst: resultaat.antwoord,
    meta: { ...resultaat.meta, afzender_naam: 'Sam' },
  });
  if (botBericht) antwoorden.push(publiekBericht(botBericht));

  // Voorgestelde actie vastleggen. Alleen voorstellen — uitvoeren gebeurt
  // pas na goedkeuring, en pas vanaf fase S2.
  if (resultaat.actie) {
    try {
      await supabaseAdmin.from('support_acties').insert({
        gesprek_id: gesprek.id,
        soort: resultaat.actie.soort,
        omschrijving: resultaat.actie.omschrijving,
        payload: resultaat.actie.payload || {},
        voorgesteld_door: 'bot',
      });
    } catch (e) {
      console.warn('[support-bericht] actie vastleggen mislukt:', e?.message || e);
    }
  }

  let status = 'bot';
  if (resultaat.escaleren) {
    const { melding } = await escaleerGesprek({
      gesprek, reden: resultaat.besluit_reden, beschikbaarheid,
    });
    if (melding) antwoorden.push({ afzender: 'systeem', tekst: melding, created_at: new Date().toISOString() });
    if (!beschikbaarheid.live) {
      await stuurWachtrijBevestiging({ naar: gesprek.email, naam: gesprek.naam, kenmerk: gesprek.kenmerk, vraag: tekst })
        .catch(() => {});
    }
    status = 'wacht_op_ons';
  }

  return res.status(200).json({
    bericht: publiekBericht(nieuw),
    antwoorden,
    status,
    // Zodat de widget het codeveld kan tonen zonder te gokken.
    verificatie_nodig: resultaat.besluit_reden === 'verificatie_nodig',
    wachtrij_tekst: beschikbaarheid.live ? null : beschikbaarheidsTekst(beschikbaarheid),
  });
}

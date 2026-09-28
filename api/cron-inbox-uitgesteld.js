// api/cron-inbox-uitgesteld.js
//
// Het vangnet: geparkeerde berichten die niemand meer komt ophalen.
//
// Auth: Bearer $CRON_SECRET (checkCronAuth). Schema: elke minuut.
//
// ── WAAROM DIT ER IS ─────────────────────────────────────────────────────────
// Normaal geeft het scherm zelf het startsein als de dertig seconden om zijn.
// Maar het scherm kan dicht zijn: tabblad gesloten, laptop dicht, browser
// gecrasht. Dan hangt er een bericht dat de gebruiker wél verstuurd dénkt te
// hebben.
//
// Dat is precies het gat dat we dichten. Dus: elke minuut kijken of er iets
// klaarstaat dat niemand heeft opgepakt, en het alsnog versturen.
//
// ── WAAROM ELKE MINUUT EN NIET VAKER ─────────────────────────────────────────
// Vaker kan niet op Vercel. En het hoeft ook niet: in het normale geval is het
// scherm er al bij geweest na dertig seconden. Deze cron bedient alleen het
// geval waarin dat níét gebeurde, en dan maakt een halve minuut extra niets uit
// — het alternatief was namelijk "nooit".
//
// ── WAAROM DIT NOOIT DUBBEL VERSTUURT ────────────────────────────────────────
// Elke rij wordt geclaimd met één UPDATE die alleen slaagt als hij nog op
// 'gepland' staat én nog van niemand is. Draaien er twee cron-runs tegelijk,
// of komt het scherm er tegelijk bij, dan krijgt er precies één de rij.
//
// Het opruimen van hangende claims geeft ze NIET blind vrij — zie de uitleg bij
// ruimHangendeClaimsOp(). Kort: op het moment dat een proces omviel kan Meta het
// bericht al geaccepteerd hebben, en dan is vrijgeven hetzelfde als twee keer
// versturen.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { gesprekkenV2Aan } from './_lib/gesprekken-vlag.js';
import { verstuurInGesprek } from './_lib/inbox-verzenden.js';
import {
  claim, uitWachtrij, klaarVoorVertrek,
  markeerVerstuurd, markeerMislukt, ruimHangendeClaimsOp,
} from './_lib/inbox-uitgesteld.js';

// Ruim binnen de 60 s die een Vercel-functie mag draaien, ook als Meta traag is.
const PER_RONDE = 20;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!checkCronAuth(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (!gesprekkenV2Aan()) {
    // Staat de vlag uit, dan parkeert er ook niemand iets. Niets te doen, en
    // dat zeggen we met zoveel woorden zodat de logs niet suggereren dat de
    // cron stuk is.
    return res.status(200).json({ ok: true, overgeslagen: 'GESPREKKEN_V2 staat uit' });
  }

  const telling = { bekeken: 0, verstuurd: 0, mislukt: 0, overgeslagen: 0 };

  try {
    // Eerst opruimen, dan versturen: een rij die vrijgegeven wordt, mag in
    // dezelfde ronde alsnog mee.
    const opgeruimd = await ruimHangendeClaimsOp();

    const klaar = await klaarVoorVertrek(PER_RONDE);
    for (const { id } of klaar) {
      telling.bekeken++;
      // Per rij een eigen try: één bericht dat misgaat mag de rest van de ronde
      // niet blokkeren. Precies de les uit CLAUDE.md over loops.
      try {
        const rij = await claim(id);
        if (!rij) {
          // Het scherm was net sneller, of een andere cron-run. Geen fout.
          telling.overgeslagen++;
          continue;
        }

        const uitkomst = await verstuurInGesprek(uitWachtrij(rij), {
          userId : rij.aangemaakt_door || null,
          ip     : null,
          // De cron heeft geen sessie. De rechten-controle per module is hier
          // niet de poort — die was het bij het parkeren, door de mens die op
          // Verstuur drukte. Deze rij is al goedgekeurd door een mens; wat hier
          // nog telt is of het bericht technisch weg kan.
          rechten: { finance: true, simone: true, onboarding: true },
        });

        if (uitkomst.http === 200) {
          await markeerVerstuurd(id, uitkomst.payload?.meta_wamid || null);
          telling.verstuurd++;
        } else {
          const reden = uitkomst.payload?.message || uitkomst.payload?.error || 'onbekende fout';
          // ALTIJD de reden erbij loggen. Een teller zonder tekst maakt
          // zoeken in de Vercel-logs onmogelijk — ook een les uit CLAUDE.md.
          console.warn('[cron-inbox-uitgesteld] niet verstuurd:', id, uitkomst.http, reden);
          await markeerMislukt(id, reden);
          telling.mislukt++;
        }
      } catch (e) {
        console.error('[cron-inbox-uitgesteld] rij mislukt:', id, e?.message || e);
        try { await markeerMislukt(id, e?.message || 'onbekende fout'); } catch (_) { /* al gemeld */ }
        telling.mislukt++;
      }
    }

    console.log('[cron-inbox-uitgesteld] klaar:', { ...telling, ...opgeruimd });
    return res.status(200).json({ ok: true, ...telling, ...opgeruimd });
  } catch (e) {
    console.error('[cron-inbox-uitgesteld]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout', ...telling });
  }
}

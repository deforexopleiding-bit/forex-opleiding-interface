// api/support-verificatie-start.js
//
// POST — stuur een zescijferige code naar het opgegeven e-mailadres.
//
// ── HET ORAKEL-PROBLEEM ─────────────────────────────────────────────────────
// Dit endpoint mag nooit verklappen of een mailadres bij een klant hoort.
// Zou het dat wel doen, dan is het een gratis zoekmachine op ons
// klantenbestand: adressen intikken tot er "gevonden" verschijnt. Daarom is
// het antwoord ALTIJD hetzelfde — de code gaat de deur uit ongeacht of er
// een klant bij hoort, en pas ná het invullen van de code kijken we of er
// een dossier is. Wie de code uit de mailbox kan halen, is de eigenaar van
// dat adres; dat is precies wat we wilden vaststellen.
//
// ── TWEE SLOTEN ─────────────────────────────────────────────────────────────
// De IP-rate-limiter is fail-open (bewuste keuze in api/_lib/rate-limit.js:
// een storing mag geen klanten buitensluiten). Voor een endpoint dat mail
// verstuurt is dat te ruim, dus er zit een tweede teller op: maximaal 3
// codes per gesprek. Die telt in de database en is fail-closed.

import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';
import { applySupportCors, handledPreflight } from './_lib/support-cors.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { tokenUitRequest, gesprekUitToken, hashToken, schrijfBericht } from './_lib/support-sessie.js';
import { stuurVerificatieCode } from './_lib/support-mail.js';

const GELDIG_MS = 10 * 60 * 1000;
const MAX_CODES_PER_GESPREK = 3;

export default async function handler(req, res) {
  applySupportCors(req, res, 'POST, OPTIONS');
  if (handledPreflight(req, res, 'POST')) return;

  const gesprek = await gesprekUitToken(tokenUitRequest(req));
  if (!gesprek) return res.status(401).json({ error: 'Onbekende sessie' });

  if (gesprek.geverifieerd) {
    return res.status(200).json({ ok: true, al_geverifieerd: true });
  }
  if (gesprek.verificatie_geblokkeerd) {
    return res.status(423).json({ error: 'Te vaak geprobeerd. Start een nieuw gesprek of mail ons.' });
  }

  const { limited } = await checkRateLimit({
    req, bucket: 'support-verificatie', maxHits: 6, withinSeconds: 600,
  });
  if (limited) return res.status(429).json({ error: 'Te veel codes aangevraagd. Wacht even.' });

  // Tweede slot, fail-CLOSED: bij een leesfout geen code versturen.
  try {
    const { count, error } = await supabaseAdmin
      .from('support_verificaties')
      .select('id', { count: 'exact', head: true })
      .eq('gesprek_id', gesprek.id);
    if (error) throw new Error(error.message);
    if ((count || 0) >= MAX_CODES_PER_GESPREK) {
      return res.status(429).json({ error: 'Er zijn al meerdere codes verstuurd. Kijk ook in je spam.' });
    }
  } catch (e) {
    console.error('[support-verificatie-start] tellen mislukt (fail-closed):', e?.message || e);
    return res.status(503).json({ error: 'Verificatie is even niet beschikbaar.' });
  }

  // crypto.randomInt, niet Math.random: dit is een toegangscode.
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

  try {
    const { error } = await supabaseAdmin.from('support_verificaties').insert({
      gesprek_id: gesprek.id,
      email: gesprek.email,
      code_hash: hashToken(code),
      vervalt_op: new Date(Date.now() + GELDIG_MS).toISOString(),
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error('[support-verificatie-start] code opslaan mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Er ging iets mis bij het versturen.' });
  }

  let mailbox = 'info@deforexopleiding.nl';
  try {
    const { data } = await supabaseAdmin.from('app_settings').select('value').eq('key', 'support_widget').maybeSingle();
    if (data?.value?.antwoord_mailbox) mailbox = data.value.antwoord_mailbox;
  } catch (_) { /* standaard */ }

  const verstuurd = await stuurVerificatieCode({
    naar: gesprek.email,
    code,
    kenmerk: gesprek.kenmerk,
    vanMailbox: mailbox,
  });

  if (!verstuurd?.ok) {
    // De code staat al in de database maar bereikt niemand. Dat moet de
    // bezoeker weten — anders zit 'ie op een mail te wachten die nooit komt.
    console.error('[support-verificatie-start] mail versturen mislukt:', verstuurd?.reason);
    return res.status(502).json({ error: 'De mail kon niet verstuurd worden. Een collega pakt je vraag op.' });
  }

  await schrijfBericht({
    gesprekId: gesprek.id,
    afzender: 'systeem',
    tekst: `Ik heb een code gestuurd naar ${gesprek.email}. Vul die hieronder in, dan kan ik je gegevens erbij pakken.`,
    meta: { soort: 'verificatie_verstuurd' },
  });

  return res.status(200).json({ ok: true, email: gesprek.email });
}

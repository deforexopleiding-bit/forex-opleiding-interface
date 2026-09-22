// api/support-verificatie-check.js
//
// POST — controleer de zescijferige code en koppel het gesprek aan de klant.
//
// Vijf pogingen. Daarna gaat verificatie_geblokkeerd op true en is dit
// gesprek permanent onverifieerbaar; de bezoeker kan wel gewoon doorpraten
// en wordt naar een mens gestuurd. Een teller die je kunt resetten door een
// nieuwe code aan te vragen is geen teller, dus de pogingen tellen per
// gesprek en niet per code.
//
// Timing: de vergelijking gaat over SHA-256-hashes met
// crypto.timingSafeEqual. Bij zes cijfers is een timing-aanval theoretisch,
// maar het kost hier één regel om 'm uit te sluiten.

import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';
import { applySupportCors, handledPreflight } from './_lib/support-cors.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { tokenUitRequest, gesprekUitToken, hashToken, schrijfBericht, publiekGesprek } from './_lib/support-sessie.js';
import { zoekKlant, haalOnboarding } from './_lib/support-lookups.js';

const MAX_POGINGEN = 5;

function gelijk(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (_) {
    return false;
  }
}

export default async function handler(req, res) {
  applySupportCors(req, res, 'POST, OPTIONS');
  if (handledPreflight(req, res, 'POST')) return;

  const gesprek = await gesprekUitToken(tokenUitRequest(req));
  if (!gesprek) return res.status(401).json({ error: 'Onbekende sessie' });
  if (gesprek.geverifieerd) return res.status(200).json({ ok: true, gesprek: publiekGesprek(gesprek) });
  if (gesprek.verificatie_geblokkeerd) {
    return res.status(423).json({ error: 'Te vaak geprobeerd. Een collega pakt je vraag op.' });
  }

  const { limited } = await checkRateLimit({
    req, bucket: 'support-verificatie-check', maxHits: 20, withinSeconds: 600,
  });
  if (limited) return res.status(429).json({ error: 'Te veel pogingen. Wacht even.' });

  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (code.length !== 6) return res.status(400).json({ error: 'Vul de zes cijfers in.' });

  let rij;
  try {
    const { data, error } = await supabaseAdmin
      .from('support_verificaties')
      .select('*')
      .eq('gesprek_id', gesprek.id)
      .is('verbruikt_op', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    rij = (data || [])[0];
  } catch (e) {
    console.error('[support-verificatie-check] lezen mislukt:', e?.message || e);
    return res.status(503).json({ error: 'Verificatie is even niet beschikbaar.' });
  }

  if (!rij) return res.status(400).json({ error: 'Vraag eerst een code aan.' });
  if (Date.parse(rij.vervalt_op) < Date.now()) {
    return res.status(410).json({ error: 'Deze code is verlopen. Vraag een nieuwe aan.' });
  }

  if (!gelijk(hashToken(code), rij.code_hash)) {
    const pogingen = (rij.pogingen || 0) + 1;
    await supabaseAdmin.from('support_verificaties').update({ pogingen }).eq('id', rij.id);
    if (pogingen >= MAX_POGINGEN) {
      await supabaseAdmin.from('support_gesprekken')
        .update({ verificatie_geblokkeerd: true })
        .eq('id', gesprek.id);
      return res.status(423).json({ error: 'Te vaak fout. Een collega pakt je vraag op.' });
    }
    return res.status(400).json({ error: `Die code klopt niet. Je hebt nog ${MAX_POGINGEN - pogingen} pogingen.` });
  }

  // Goed. Code verbruiken, gesprek markeren en pas NU de klant opzoeken.
  await supabaseAdmin.from('support_verificaties')
    .update({ verbruikt_op: new Date().toISOString() })
    .eq('id', rij.id);

  const { customer } = await zoekKlant({ email: gesprek.email, telefoon: gesprek.telefoon });
  const onboarding = customer ? await haalOnboarding(customer.id) : null;

  const { data: bijgewerkt } = await supabaseAdmin
    .from('support_gesprekken')
    .update({
      geverifieerd: true,
      geverifieerd_op: new Date().toISOString(),
      customer_id: customer?.id || null,
      onboarding_id: onboarding?.id || null,
    })
    .eq('id', gesprek.id)
    .select()
    .maybeSingle();

  await schrijfBericht({
    gesprekId: gesprek.id,
    afzender: 'systeem',
    tekst: 'Gelukt. Ik kan nu bij je gegevens.',
    meta: { soort: 'verificatie_gelukt', klant_gevonden: !!customer },
  });

  return res.status(200).json({ ok: true, gesprek: publiekGesprek(bijgewerkt || gesprek) });
}

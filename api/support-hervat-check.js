// api/support-hervat-check.js
//
// POST — de code uit de hervat-mail. Body: { kenmerk, code }.
// Klopt 'ie, dan krijgt de widget een VERS sessietoken en staat het gesprek
// weer open, op welk apparaat dan ook.
//
// ── HET OUDE TOKEN VERVALT ──────────────────────────────────────────────────
// We zetten een nieuw token op het gesprek in plaats van er een tweede naast.
// Eén sleutel per gesprek is een regel die je kunt uitleggen en controleren;
// een groeiend lijstje sleutels waarvan niemand meer weet welke waar ligt, is
// dat niet. Praktisch gevolg: wie het gesprek op zijn telefoon heropent, ziet
// op de laptop het beginscherm terug. Dat is de juiste kant om op te falen —
// een gedeelde laptop houdt zo geen open gesprek over.
//
// ── DIT TELT ALS VERIFICATIE ────────────────────────────────────────────────
// De code ging naar het adres dat al bij het gesprek stond. Wie 'm intikt,
// bewijst hetzelfde als in de gewone flow: toegang tot die mailbox. Dus ja,
// `geverifieerd` gaat hier omhoog — anders zou iemand die terugkomt zijn
// facturen alsnog niet kunnen navragen en is de hele weg terug halve winst.
//
// Let op het verschil met de mailbrug (cron-support-mail.js): een binnenkomende
// mail verhoogt `geverifieerd` juist NOOIT, want een afzenderadres is te
// vervalsen en een code uit die mailbox halen niet.

import { supabaseAdmin } from './supabase.js';
import { applySupportCors, handledPreflight } from './_lib/support-cors.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import {
  maakSessieToken, hashToken, schrijfBericht, publiekGesprek,
} from './_lib/support-sessie.js';
import { zoekKlant, haalOnboarding } from './_lib/support-lookups.js';
import { kenmerkUitBody, gesprekUitKenmerk, gelijkeHash } from './_lib/support-hervat.js';

const MAX_POGINGEN = 5;

// Onbekend kenmerk en foute code geven exact dezelfde tekst: anders is dit
// endpoint alsnog de vinkenlijst die support-hervat-start niet mocht zijn.
const FOUT = 'Die code klopt niet, of is verlopen.';

export default async function handler(req, res) {
  applySupportCors(req, res, 'POST, OPTIONS');
  if (handledPreflight(req, res, 'POST')) return;

  const { limited } = await checkRateLimit({
    req, bucket: 'support-hervat-check', maxHits: 20, withinSeconds: 900,
  });
  if (limited) return res.status(429).json({ error: 'Te veel pogingen. Wacht even.' });

  const kenmerk = kenmerkUitBody(req.body);
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (!kenmerk || code.length !== 6) return res.status(400).json({ error: FOUT });

  const gesprek = await gesprekUitKenmerk(kenmerk);
  if (!gesprek || gesprek.verificatie_geblokkeerd) return res.status(400).json({ error: FOUT });

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
    console.error('[support-hervat-check] lezen mislukt:', e?.message || e);
    return res.status(503).json({ error: 'Even niet beschikbaar. Probeer het zo nog eens.' });
  }

  if (!rij || Date.parse(rij.vervalt_op) < Date.now()) return res.status(400).json({ error: FOUT });

  if (!gelijkeHash(hashToken(code), rij.code_hash)) {
    const pogingen = (rij.pogingen || 0) + 1;
    await supabaseAdmin.from('support_verificaties').update({ pogingen }).eq('id', rij.id);
    if (pogingen >= MAX_POGINGEN) {
      await supabaseAdmin.from('support_gesprekken')
        .update({ verificatie_geblokkeerd: true })
        .eq('id', gesprek.id);
      return res.status(423).json({ error: 'Te vaak fout geprobeerd. Mail ons, dan pakt een collega het op.' });
    }
    return res.status(400).json({ error: FOUT });
  }

  // Goed. Code verbruiken vóór we een token uitgeven, zodat dezelfde code
  // nooit twee sessies kan openen.
  const { data: verbruikt, error: verbruikFout } = await supabaseAdmin
    .from('support_verificaties')
    .update({ verbruikt_op: new Date().toISOString() })
    .eq('id', rij.id)
    .is('verbruikt_op', null)
    .select('id');
  if (verbruikFout || !(verbruikt || []).length) {
    // Iemand anders was net iets eerder met precies deze code. Geen tweede
    // sessie erbij.
    return res.status(400).json({ error: FOUT });
  }

  const token = maakSessieToken();
  const patch = { sessie_token_hash: hashToken(token) };

  if (!gesprek.geverifieerd) {
    const { customer } = await zoekKlant({ email: gesprek.email, telefoon: gesprek.telefoon });
    const onboarding = customer ? await haalOnboarding(customer.id) : null;
    patch.geverifieerd = true;
    patch.geverifieerd_op = new Date().toISOString();
    patch.customer_id = customer?.id || null;
    patch.onboarding_id = onboarding?.id || null;
  }

  const { data: bijgewerkt, error: patchFout } = await supabaseAdmin
    .from('support_gesprekken')
    .update(patch)
    .eq('id', gesprek.id)
    .select()
    .maybeSingle();

  if (patchFout) {
    console.error('[support-hervat-check] gesprek bijwerken mislukt:', patchFout.message);
    return res.status(500).json({ error: 'Er ging iets mis. Probeer het zo nog eens.' });
  }

  // Zichtbaar in de thread, ook voor de collega: dit gesprek is elders
  // heropend. Zonder die regel lijkt het alsof een bericht uit het niets komt.
  await schrijfBericht({
    gesprekId: gesprek.id,
    afzender: 'systeem',
    tekst: 'Je gesprek is weer geopend.',
    meta: { soort: 'hervat' },
  });

  return res.status(200).json({ ok: true, token, gesprek: publiekGesprek(bijgewerkt || gesprek) });
}

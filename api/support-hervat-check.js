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
//
// ── GEEN LOCKOUT HIER, EN DAT IS MET OPZET ──────────────────────────────────
// support-verificatie-check zet na vijf foute codes `verificatie_geblokkeerd`
// op het gesprek. Hier NIET, en er komt ook nooit een 423 uit dit endpoint.
// Het verschil zit in wie er aan de deur staat:
//
//   * Voor verificatie-check heb je het sessietoken nodig. Wie daar vijf keer
//     mis tikt, is de bezoeker zelf, en een slot op zijn eigen gesprek
//     betekent iets.
//   * Hier heb je alleen het kenmerk nodig, en dat is geen geheim: het staat
//     in elke onderwerpregel en wordt aan de telefoon voorgelezen. Een teller
//     die hier het gesprek op slot zet, geeft iedereen die het kenmerk kent
//     een knop om de eigenaar buiten te sluiten, zowel bij de verificatie als
//     bij deze weg terug. De 423 zou bovendien verklappen dat het kenmerk
//     bestaat.
//
// Wat hier wél tegen raden beschermt: elke poging verbruikt de code. We
// claimen de code eerst (voorwaardelijke update op verbruikt_op IS NULL) en
// vergelijken pas daarna. Eén gok per code dus, ook bij gelijktijdige
// verzoeken, met maximaal drie codes per uur (magCodeVersturen) en een
// IP-limiet erbovenop. Zet hier dus GEEN pogingenteller met blokkade terug
// "voor de zekerheid"; daarmee bouw je de lockout opnieuw.

import { supabaseAdmin } from './supabase.js';
import { applySupportCors, handledPreflight } from './_lib/support-cors.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import {
  maakSessieToken, hashToken, schrijfBericht, publiekGesprek,
} from './_lib/support-sessie.js';
import { zoekKlant, haalOnboarding } from './_lib/support-lookups.js';
import { kenmerkUitBody, gesprekUitKenmerk, gelijkeHash } from './_lib/support-hervat.js';

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

  // Eerst claimen, dán vergelijken. Wie de claim wint, mag één keer
  // vergelijken; goed of fout, de code is daarna op. Zo kan dezelfde code
  // nooit twee sessies openen, en levert een stapel gelijktijdige gokken er
  // maar één op.
  const { data: geclaimd, error: claimFout } = await supabaseAdmin
    .from('support_verificaties')
    .update({ verbruikt_op: new Date().toISOString() })
    .eq('id', rij.id)
    .is('verbruikt_op', null)
    .select('id');
  if (claimFout || !(geclaimd || []).length) {
    if (claimFout) console.error('[support-hervat-check] code claimen mislukt:', claimFout.message);
    return res.status(400).json({ error: FOUT });
  }

  // Fout: de code is al verbruikt, verder niets. Geen teller, geen blokkade,
  // geen ander antwoord. Zie de kop van dit bestand.
  if (!gelijkeHash(hashToken(code), rij.code_hash)) return res.status(400).json({ error: FOUT });

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

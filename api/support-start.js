// api/support-start.js
//
// POST — start een support-gesprek en geef de widget een sessietoken.
//
// Geen auth (de bezoeker is niet ingelogd), dus dezelfde drie sloten als op
// api/assessment-submit.js: honeypot, IP-rate-limit en strikte validatie.
//
// Wat hier NIET gebeurt: opzoeken of dit e-mailadres een klant is. Dat
// antwoord zou dit endpoint in een klantenbestand-orakel veranderen — je
// typt adressen in tot je "klant gevonden" leest. De koppeling gebeurt pas
// na een geslaagde mailcode, in support-verificatie-check.

import { supabaseAdmin } from './supabase.js';
import { applySupportCors, handledPreflight } from './_lib/support-cors.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { extractClientIp, hashIp } from './_lib/assessment-validation.js';
import { maakSessieToken, hashToken, maakKenmerk, schrijfBericht, publiekGesprek } from './_lib/support-sessie.js';
import { haalBeschikbaarheid, beschikbaarheidsTekst } from './_lib/support-beschikbaarheid.js';

const SOORTEN = ['klant', 'bezoeker'];
const ONDERWERPEN = ['lms', 'discord', 'traject', 'financieel', 'informatie', 'event', 'inschrijving', 'call', 'overig'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function schoon(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

export default async function handler(req, res) {
  applySupportCors(req, res, 'POST, OPTIONS');
  if (handledPreflight(req, res, 'POST')) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // Honeypot. Een veld dat onzichtbaar in het formulier staat en dus alleen
  // door een bot wordt ingevuld. 422 en verder niets doen — geen rij, geen
  // mail, geen log-regel die de moeite waard is.
  if (schoon(body.bedrijf, 200)) {
    return res.status(422).json({ error: 'Ongeldig verzoek' });
  }

  const { limited } = await checkRateLimit({
    req, bucket: 'support-start', maxHits: 5, withinSeconds: 300,
  });
  if (limited) {
    return res.status(429).json({ error: 'Te veel verzoeken. Probeer het over een paar minuten opnieuw.' });
  }

  const soort = SOORTEN.includes(body.soort) ? body.soort : null;
  if (!soort) return res.status(400).json({ error: 'soort moet klant of bezoeker zijn' });

  const onderwerp = ONDERWERPEN.includes(body.onderwerp) ? body.onderwerp : 'overig';
  const naam = schoon(body.naam, 120);
  const email = schoon(body.email, 200).toLowerCase();
  const telefoon = schoon(body.telefoon, 40);
  const vraag = schoon(body.vraag, 4000);

  // Een klant geeft naam, mail én telefoon; een bezoeker alleen naam en mail.
  // Het telefoonnummer is voor een klant geen formaliteit: het is de
  // tiebreaker als er meerdere klanten op hetzelfde mailadres staan.
  if (!naam) return res.status(400).json({ error: 'Vul je naam in' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Vul een geldig e-mailadres in' });
  if (soort === 'klant' && telefoon.replace(/\D/g, '').length < 8) {
    return res.status(400).json({ error: 'Vul je telefoonnummer in' });
  }
  if (!vraag) return res.status(400).json({ error: 'Stel je vraag' });

  const token = maakSessieToken();
  const beschikbaarheid = await haalBeschikbaarheid();

  let gesprek;
  try {
    const { data, error } = await supabaseAdmin
      .from('support_gesprekken')
      .insert({
        kenmerk: maakKenmerk(),
        soort,
        onderwerp,
        status: 'bot',
        naam,
        email,
        telefoon: telefoon || null,
        sessie_token_hash: hashToken(token),
        bron_url: schoon(body.bron_url, 500) || null,
        user_agent: schoon(req.headers?.['user-agent'], 300) || null,
        ip_hash: hashIp(extractClientIp(req)),
        laatste_bericht_op: new Date().toISOString(),
      })
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    gesprek = data;
  } catch (e) {
    console.error('[support-start] gesprek aanmaken mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Er ging iets mis. Probeer het zo nog eens.' });
  }

  await schrijfBericht({ gesprekId: gesprek.id, afzender: 'klant', tekst: vraag });

  return res.status(201).json({
    token,
    gesprek: publiekGesprek(gesprek),
    live: !!beschikbaarheid.live,
    wachtrij_tekst: beschikbaarheidsTekst(beschikbaarheid),
    // De widget weet hierdoor meteen of 'ie na dit antwoord om een mailcode
    // moet vragen, zonder een tweede rondje naar de server.
    verificatie_nodig: ['lms', 'traject', 'financieel'].includes(onderwerp),
  });
}

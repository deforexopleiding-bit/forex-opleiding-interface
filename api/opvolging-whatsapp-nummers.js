// api/opvolging-whatsapp-nummers.js
//
// GET → de genormaliseerde telefoonnummers van de lopende opvolgtaken.
//
// Dit is de bron van het privacyfilter op de brug. Wat hier niet in staat,
// bestaat voor de brug niet: die negeert elk gesprek met een nummer buiten deze
// lijst. Daves privécontacten lopen over dezelfde telefoon.
//
// ALLEEN VOOR DE BRUG. Geen user-sessie, geen RBAC — de brug heeft er geen. In
// plaats daarvan het gedeelde geheim in de header X-Brug-Secret, dezelfde waarde
// als WHATSAPP_BRUG_SECRET. Zonder dat geheim komt hier niets uit: een lijst met
// telefoonnummers van klanten is precies wat je niet wilt lekken.
//
// Antwoord: { nummers: ['32470111222', ...], aantal: n }
// Alleen cijferreeksen — geen namen, geen taak-ids, geen notities. De brug heeft
// aan meer niets, en wat je niet stuurt kan ook niet weglekken.

import { supabaseAdmin } from './supabase.js';
import { brugGeheimKlopt } from './_lib/whatsapp-brug-client.js';
import { normaliseerNummer } from './_lib/whatsapp-brug-nummers.js';

// De twee toestanden waarin we contact verwachten.
//
// WAAROM OOK 'wacht_inplanning' EN NIET ALLEEN 'open'
// Een taak op wacht_inplanning is iemand die net de agenda doorgestuurd kreeg.
// Dat is precies degene van wie een WhatsApp-antwoord te verwachten valt — en
// dat antwoord is het hele signaal waarop de 48-uurcontrole en de opvolging
// draaien. Zou de lijst alleen 'open' bevatten, dan filtert de brug juist die
// antwoorden weg, en dan is de belangrijkste inkomende gebeurtenis onzichtbaar
// terwijl alles verder lijkt te werken.
//
// 'ingepland' en 'gearchiveerd' horen er niet bij: daar is het gesprek klaar,
// en dan hoeft WhatsApp-verkeer met dat nummer het CRM niet meer in. Het filter
// is een privacygrens, dus die houden we zo klein als het werk toelaat.
const LOPEND = ['open', 'wacht_inplanning'];
const MAX = 5000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  if (!brugGeheimKlopt(req)) {
    // Geen detail in het antwoord: of het geheim ontbreekt of verkeerd is, is
    // zelf ook informatie.
    console.warn('[opvolging-whatsapp-nummers] geweigerd, geheim klopt niet');
    return res.status(401).json({ error: 'Niet toegestaan' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('opvolging_taken')
      .select('telefoon')
      .in('status', LOPEND)
      .not('telefoon', 'is', null)
      .limit(MAX);
    if (error) throw new Error(error.message);

    const uniek = new Set();
    for (const rij of (data || [])) {
      const n = normaliseerNummer(rij.telefoon);
      if (n) uniek.add(n);
    }
    // Alleen het aantal loggen, nooit de nummers.
    console.log('[opvolging-whatsapp-nummers] ' + uniek.size + ' nummers');
    return res.status(200).json({ nummers: [...uniek], aantal: uniek.size });
  } catch (e) {
    console.error('[opvolging-whatsapp-nummers]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

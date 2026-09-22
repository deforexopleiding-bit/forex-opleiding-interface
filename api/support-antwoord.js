// api/support-antwoord.js
//
// POST — een medewerker antwoordt in een gesprek.
//
// Twee dingen gebeuren er altijd samen: het bericht komt in de chat én, als
// de bezoeker niet meer meekijkt, per mail. Dat tweede is geen luxe — een
// bezoeker die de tab gesloten heeft ziet anders nooit dat er geantwoord is,
// en belt de volgende dag alsnog.
//
// "Kijkt niet meer mee" leiden we af uit de tijd sinds het laatste bericht
// van de klant. Binnen twee minuten gaan we ervan uit dat de chat openstaat;
// daarna sturen we de mail. Liever één mail te veel dan een antwoord dat
// niemand leest.

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';
import { schrijfBericht } from './_lib/support-sessie.js';
import { stuurAntwoordMail } from './_lib/support-mail.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE_VENSTER_MS = 2 * 60 * 1000;

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, 'POST')) return;

  const staff = await staffUit(req, res, 'support.reply');
  if (!staff) return;

  const id = String(req.body?.gesprek_id || '');
  const tekst = String(req.body?.tekst || '').trim().slice(0, 8000);
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Ongeldig gesprek_id' });
  if (!tekst) return res.status(400).json({ error: 'Leeg antwoord' });

  const { data: gesprek } = await supabaseAdmin
    .from('support_gesprekken').select('*').eq('id', id).maybeSingle();
  if (!gesprek) return res.status(404).json({ error: 'Gesprek niet gevonden' });

  const bericht = await schrijfBericht({
    gesprekId: id,
    afzender: 'medewerker',
    afzenderUserId: staff.user.id,
    tekst,
    meta: { afzender_naam: staff.naam },
  });
  if (!bericht) return res.status(500).json({ error: 'Antwoord kon niet opgeslagen worden.' });

  // Wie antwoordt, pakt het gesprek op — tenzij iemand anders het al heeft.
  const patch = { status: 'wacht_op_klant' };
  if (!gesprek.toegewezen_aan) {
    patch.toegewezen_aan = staff.user.id;
    patch.toegewezen_op = new Date().toISOString();
  }
  await supabaseAdmin.from('support_gesprekken').update(patch).eq('id', id);

  let gemaild = false;
  const laatsteKlant = Date.parse(gesprek.laatste_klant_bericht_op || '') || 0;
  if (gesprek.email && Date.now() - laatsteKlant > LIVE_VENSTER_MS) {
    const uit = await stuurAntwoordMail({
      naar: gesprek.email,
      naam: gesprek.naam,
      kenmerk: gesprek.kenmerk,
      antwoord: tekst,
      medewerker: staff.naam,
    }).catch((e) => { console.warn('[support-antwoord] mail mislukt:', e?.message || e); return null; });
    gemaild = !!uit?.ok;
  }

  return res.status(200).json({ bericht, gemaild });
}

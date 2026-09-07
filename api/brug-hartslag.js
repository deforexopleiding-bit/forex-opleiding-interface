// api/brug-hartslag.js
//
// De ontvangkant van de hartslag en van directe meldingen van de brug.
//
// AUTH: het gedeelde geheim dat de brug ook voor de berichten-webhook gebruikt
// (header X-Brug-Secret). Geen user-JWT: er zit geen mens aan deze kant.
//
// PRIVACY: hier komt ALLEEN het feit dat de brug leeft plus tellingen binnen.
// Wat er verder in de body zou staan wordt niet opgeslagen — de opslag pakt
// expliciet de velden die we kennen, en niets anders. Zo kan een toekomstige
// wijziging aan de brugkant hier nooit ongemerkt een nummer of berichttekst
// binnenschuiven.
//
// OPSLAG: app_settings, key 'whatsapp_brug_hartslag'. Bewust geen nieuwe tabel:
// het is één rij die steeds overschreven wordt, en dat scheelt een migratie die
// eerst gedraaid moet worden voordat dit werkt.

import { supabaseAdmin } from './supabase.js';
import { brugGeheimKlopt } from './_lib/whatsapp-brug-client.js';

export const SLEUTEL = 'whatsapp_brug_hartslag';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Alleen POST' });
  if (!brugGeheimKlopt(req)) return res.status(401).json({ error: 'Onbekend geheim' });

  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const soort = String(b.soort || 'hartslag');
  const nu = new Date().toISOString();

  // Alleen bekende velden. Zie de kop: een onbekend veld gaat de database niet in.
  const waarde = {
    laatste_hartslag_iso: nu,
    soort,
    verbonden   : b.verbonden === true,
    gezien      : Number.isFinite(Number(b.gezien)) ? Number(b.gezien) : null,
    doorgelaten : Number.isFinite(Number(b.doorgelaten)) ? Number(b.doorgelaten) : null,
    herverbinden: b.herverbinden && typeof b.herverbinden === 'object'
      ? { poging: Number(b.herverbinden.poging) || 0 } : null,
    // Een gebeurtenis onthouden we apart, zodat de waakhond hem kan melden en
    // een volgende hartslag hem niet stilletjes wist.
    ...(soort === 'hartslag' ? {} : { laatste_gebeurtenis: { soort, tijdstip: nu,
      reden: typeof b.reden === 'string' ? b.reden.slice(0, 200) : null } }),
  };

  // De stil-teller hoort bij de waakhond, niet bij de brug: een binnengekomen
  // hartslag zet hem terug op nul.
  const { data: bestaand } = await supabaseAdmin
    .from('app_settings').select('value').eq('key', SLEUTEL).maybeSingle();
  const samen = { ...(bestaand?.value || {}), ...waarde, stil_waarnemingen: 0, gemeld_op: null };

  const rij = { key: SLEUTEL, value: samen, updated_at: nu };
  const { error } = bestaand
    ? await supabaseAdmin.from('app_settings').update(rij).eq('key', SLEUTEL)
    : await supabaseAdmin.from('app_settings').insert(rij);
  if (error) {
    console.error('[brug-hartslag] opslaan faalde:', error.message);
    return res.status(500).json({ error: 'Opslaan faalde' });
  }

  if (soort !== 'hartslag') console.warn('[brug-hartslag] gebeurtenis:', soort, waarde.laatste_gebeurtenis?.reden || '');
  return res.status(200).json({ ok: true, soort, ontvangen: nu });
}

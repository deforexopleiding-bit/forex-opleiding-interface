// api/opvolging-whatsapp-herkoppel.js
//
// POST → de brug opnieuw laten koppelen, zodat er gegarandeerd een QR komt.
//   { wis_sessie: true }  gooit de bewaarde sessie weg — dan is een nieuwe QR
//                         onvermijdelijk. Zonder dat wordt eerst geprobeerd de
//                         bestaande sessie te hervatten (sneller, geen telefoon).
//
// WAAROM DIT BESTAAT. Op 23 september klikte Maxim op de koppelknop en kreeg
// hij een leeg venster: de brugserver leefde, maar de WhatsApp-client lag eruit
// zonder fout en bood geen QR aan. Er viel niets te scannen en er was ook niets
// dat er een maakte. Dit is de uitgang die dat wél doet.
//
// Proxy, met opzet — net als de status-route hiernaast. De browser praat NOOIT
// rechtstreeks met de VPS: dan zou het gedeelde geheim in de front-end moeten
// staan en het adres van de brug publiek zijn.
//
// DIT VERANDERT WEL IETS, en daarom is het een POST met een eigen recht. Een
// herkoppeling verbreekt een lopende verbinding; met wis_sessie moet er daarna
// iemand met een telefoon langs. Dat hoort niet achter een GET te zitten die
// een browser of een crawler kan aantikken.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { brugFetch, brugFoutNaarHttp } from './_lib/whatsapp-brug-client.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  const wisSessie = req.body?.wis_sessie === true;

  try {
    const data = await brugFetch('/herkoppel', { method: 'POST', body: { wis_sessie: wisSessie } });
    return res.status(200).json(data);
  } catch (e) {
    // Een brug die uit staat is geen serverfout van het CRM: de melding moet
    // vertellen wát er aan de hand is, zodat het scherm dat kan tonen in plaats
    // van leeg te blijven. Dat is precies de fout die we hier repareren.
    const { status, body } = brugFoutNaarHttp(e);
    if (e?.oorzaak) console.warn('[opvolging-whatsapp-herkoppel]', e.code, e.oorzaak);
    return res.status(status).json(body);
  }
}

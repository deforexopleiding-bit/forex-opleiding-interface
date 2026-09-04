// api/opvolging-whatsapp-status.js
//
// GET → status van de brug, of de QR om te koppelen.
//   ?wat=status (standaard) — verbonden ja of nee, nummer, laatst gezien
//   ?wat=qr                 — de actuele QR als dataURL, zolang niet gekoppeld
//
// Proxy, met opzet. De browser praat NOOIT rechtstreeks met de VPS: dan zou het
// gedeelde geheim in de front-end moeten staan en het adres van de brug publiek
// zijn. Alles loopt hierlangs, met een gewone user-sessie en RBAC ervoor.
//
// Leest alleen; verandert niets.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { brugFetch, brugFoutNaarHttp } from './_lib/whatsapp-brug-client.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  const wat = String(req.query?.wat || 'status').toLowerCase();
  if (wat !== 'status' && wat !== 'qr') return res.status(400).json({ error: "wat moet 'status' of 'qr' zijn" });

  try {
    const data = await brugFetch(wat === 'qr' ? '/qr' : '/status');
    return res.status(200).json(data);
  } catch (e) {
    // Een brug die uit staat is geen serverfout van het CRM: de melding moet
    // vertellen wát er aan de hand is, zodat het scherm dat kan tonen in plaats
    // van leeg te blijven.
    const { status, body } = brugFoutNaarHttp(e);
    if (e?.oorzaak) console.warn('[opvolging-whatsapp-status]', e.code, e.oorzaak);
    return res.status(status).json(body);
  }
}

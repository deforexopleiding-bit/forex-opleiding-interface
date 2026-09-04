// api/opvolging-whatsapp-send.js
//
// POST { nummer, tekst, taak_id? } → laat de brug een WhatsApp versturen.
//
// Proxy naar de VPS, om dezelfde reden als opvolging-whatsapp-status: het
// gedeelde geheim en het adres van de brug blijven server-side.
//
// De poging in opvolging_pogingen wordt hier NIET geschreven. Dat doet de
// webhook, zodra de brug meldt dat het bericht echt verzonden is. Hier al een
// rij wegschrijven zou een verstuurd bericht tellen dat misschien nooit
// aankwam — en juist die telling bepaalt in Afgerond het oordeel over hoeveel
// moeite er gedaan is.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { brugFetch, brugFoutNaarHttp } from './_lib/whatsapp-brug-client.js';
import { normaliseerNummer } from './_lib/whatsapp-brug-nummers.js';

const MAX_TEKST = 4000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  const b = req.body || {};
  const nummer = normaliseerNummer(b.nummer);
  if (!nummer) return res.status(400).json({ error: 'nummer ontbreekt of is onleesbaar' });
  const tekst = typeof b.tekst === 'string' ? b.tekst.trim() : '';
  if (!tekst) return res.status(400).json({ error: 'tekst ontbreekt' });
  if (tekst.length > MAX_TEKST) return res.status(400).json({ error: `tekst is langer dan ${MAX_TEKST} tekens` });

  try {
    const data = await brugFetch('/send', { method: 'POST', body: { nummer, tekst } });
    return res.status(200).json({ ok: true, ...data });
  } catch (e) {
    // De brug weigert nummers die niet op de leadlijst staan. Dat is geen
    // storing maar een grens: dit nummer hoort niet bij een lopende opvolgtaak.
    if (e?.code === 'BRUG_FOUT' && e.status === 403) {
      return res.status(403).json({
        error: 'Dit nummer hoort niet bij een lopende opvolgtaak, dus de brug verstuurt er niets naartoe.',
        code : 'NIET_TOEGESTAAN',
      });
    }
    const { status, body } = brugFoutNaarHttp(e);
    if (e?.oorzaak) console.warn('[opvolging-whatsapp-send]', e.code, e.oorzaak);
    return res.status(status).json(body);
  }
}

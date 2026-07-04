// api/voys-sip-config.js
//
// GET → SIP/WebRTC-config voor de softphone in de cockpit-belkaart.
// Retourneert ALLEEN aan een ingelogde sales/manager/admin (cockpit-
// permissiecheck). Het SIP-wachtwoord is nodig om de UserAgent te
// registreren op wss://websocket.voipgrid.nl — het wordt over HTTPS
// naar de authenticated frontend gestuurd en verder NERGENS gelogd.
//
// Env-vars (alle 4 verplicht voor 'configured=true'):
//   VOYS_SIP_WSS      — wss://websocket.voipgrid.nl (default)
//   VOYS_SIP_USER     — SIP-username (VoIPGRID SIP-account)
//   VOYS_SIP_DOMAIN   — SIP-domain (bv. voipgrid.nl of het account-domein)
//   VOYS_SIP_PASSWORD — SIP-password (Sensitive)
// Optioneel:
//   VOYS_CALLER_IDS   — komma-gescheiden lijst met publieke nummers voor
//                        de beller-ID-dropdown. Geen secrets — publieke
//                        nummers die aan het account zijn toegekend.
//
// Response:
//   { wss, user, domain, password, caller_ids, configured } bij ok.
//   { configured: false, caller_ids: [] } als ook maar één van de vier
//   verplichte env-vars ontbreekt (geen half werk — anders faalt de
//   UserAgent bij register).

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const wss      = process.env.VOYS_SIP_WSS      || 'wss://websocket.voipgrid.nl';
  const user_    = process.env.VOYS_SIP_USER     || '';
  const domain   = process.env.VOYS_SIP_DOMAIN   || '';
  const password = process.env.VOYS_SIP_PASSWORD || '';
  const configured = !!(wss && user_ && domain && password);

  const idsRaw = String(process.env.VOYS_CALLER_IDS || '').trim();
  const callerIds = idsRaw
    ? idsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  if (!configured) {
    return res.status(200).json({ configured: false, caller_ids: callerIds });
  }
  return res.status(200).json({
    configured : true,
    wss,
    user       : user_,
    domain,
    password,
    caller_ids : callerIds,
  });
}

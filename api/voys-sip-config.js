// api/voys-sip-config.js
//
// GET → SIP/WebRTC-config voor de softphone in de cockpit-belkaart.
// Retourneert ALLEEN aan een ingelogde sales/manager/admin (cockpit-
// permissiecheck). Het SIP-wachtwoord is nodig om de UserAgent te
// registreren op wss://websocket.voipgrid.nl — het wordt over HTTPS
// naar de authenticated frontend gestuurd en verder NERGENS gelogd.
//
// Twee SIP-accounts (dual-lijn NL/BE):
//   NL-account (bestaand, verplicht voor configured=true op top-level):
//     VOYS_SIP_WSS      — wss://websocket.voipgrid.nl (default)
//     VOYS_SIP_USER     — SIP-username (VoIPGRID SIP-account)
//     VOYS_SIP_DOMAIN   — SIP-domain (bv. voipgrid.nl of het account-domein)
//     VOYS_SIP_PASSWORD — SIP-password (Sensitive)
//     VOYS_CALLER_IDS   — komma-gescheiden lijst met publieke NL-nummers
//
//   BE-account (nieuw, optioneel — voor +32-leads):
//     VOYS_BE_SIP_WSS      — wss://websocket.voipgrid.nl (default)
//     VOYS_BE_SIP_USER     — SIP-username BE-account
//     VOYS_BE_SIP_DOMAIN   — SIP-domain BE-account
//     VOYS_BE_SIP_PASSWORD — SIP-password BE-account (Sensitive)
//     VOYS_BE_CALLER_IDS   — komma-gescheiden lijst met publieke BE-nummers
//
// Response:
//   {
//     configured, wss, user, domain, password, caller_ids,   // NL top-level (backward-compat)
//     accounts: {
//       nl: { configured, wss, user, domain, password, caller_ids },
//       be: { configured, wss, user, domain, password, caller_ids },
//     }
//   }
// Als BE niet (volledig) geconfigureerd is → accounts.be.configured=false
// en de frontend valt terug op alleen NL. Als NL niet geconfigureerd is
// → configured=false top-level (zelfde gedrag als voorheen).

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export const config = { maxDuration: 10 };

function parseCallerIds(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function buildAccount(prefix) {
  const wss      = process.env[`${prefix}SIP_WSS`]      || 'wss://websocket.voipgrid.nl';
  const user_    = process.env[`${prefix}SIP_USER`]     || '';
  const domain   = process.env[`${prefix}SIP_DOMAIN`]   || '';
  const password = process.env[`${prefix}SIP_PASSWORD`] || '';
  const configured = !!(wss && user_ && domain && password);
  const caller_ids = parseCallerIds(process.env[`${prefix}CALLER_IDS`]);
  if (!configured) return { configured: false, caller_ids };
  return { configured: true, wss, user: user_, domain, password, caller_ids };
}

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

  // NL heeft geen prefix (env: VOYS_SIP_*), BE wel (env: VOYS_BE_SIP_*).
  const nl = buildAccount('VOYS_');       // VOYS_SIP_* + VOYS_CALLER_IDS
  const be = buildAccount('VOYS_BE_');    // VOYS_BE_SIP_* + VOYS_BE_CALLER_IDS

  // NL callerIds fallback op oude env-var-naam.
  if (!nl.caller_ids?.length) nl.caller_ids = parseCallerIds(process.env.VOYS_CALLER_IDS);

  // Top-level velden = NL default (backward-compat: bestaande callers die
  // { wss, user, domain, password, caller_ids, configured } lezen blijven
  // werken zonder aanpassing).
  const topLevel = nl.configured
    ? {
        configured : true,
        wss        : nl.wss,
        user       : nl.user,
        domain     : nl.domain,
        password   : nl.password,
        caller_ids : nl.caller_ids,
      }
    : { configured: false, caller_ids: nl.caller_ids };

  return res.status(200).json({
    ...topLevel,
    accounts: { nl, be },
  });
}

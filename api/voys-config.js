// api/voys-config.js
//
// GET → publieke Voys-config voor:
//   • caller-ID-wisselaar in de cockpit (legacy top-level shape)
//   • telefonie-sectie in Instellingen v2 (nieuwe `accounts`-shape)
//
// Geeft NOOIT tokens/uuid/wachtwoorden terug. Alleen booleans voor
// "geconfigureerd" per capability + de lijst caller-IDs per account.
//
// Env-vars per account:
//   NL — VOYS_CALLER_IDS + VOYS_API_TOKEN + VOYS_CLIENT_UUID +
//        VOYS_A_NUMBER (REST click-to-dial), en VOYS_SIP_WSS/USER/
//        DOMAIN/PASSWORD (softphone).
//   BE — VOYS_BE_CALLER_IDS + VOYS_BE_API_TOKEN + VOYS_BE_CLIENT_UUID +
//        VOYS_BE_A_NUMBER (REST, nog niet aanwezig), en VOYS_BE_SIP_*
//        (softphone).
//
// Response-shape (backward-compat, top-level velden blijven NL):
//   { caller_ids: [...NL], configured: bool (NL REST-configured),
//     accounts: {
//       nl: { caller_ids, rest_configured, sip_configured },
//       be: { caller_ids, rest_configured, sip_configured }
//     } }

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

  // 2026-08-26: `softphone.use` toegevoegd als dedicated bel-key.
  let allowed = await requirePermission(req, 'softphone.use');
  if (!allowed) allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const parseIds = (raw) => {
    const s = String(raw || '').trim();
    return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
  };
  const nlCallerIds = parseIds(process.env.VOYS_CALLER_IDS);
  const beCallerIds = parseIds(process.env.VOYS_BE_CALLER_IDS);

  const nlRest = !!(process.env.VOYS_API_TOKEN
                 && process.env.VOYS_CLIENT_UUID
                 && process.env.VOYS_A_NUMBER);
  const beRest = !!(process.env.VOYS_BE_API_TOKEN
                 && process.env.VOYS_BE_CLIENT_UUID
                 && process.env.VOYS_BE_A_NUMBER);

  const nlSip = !!(process.env.VOYS_SIP_WSS
                && process.env.VOYS_SIP_USER
                && process.env.VOYS_SIP_DOMAIN
                && process.env.VOYS_SIP_PASSWORD);
  const beSip = !!(process.env.VOYS_BE_SIP_WSS
                && process.env.VOYS_BE_SIP_USER
                && process.env.VOYS_BE_SIP_DOMAIN
                && process.env.VOYS_BE_SIP_PASSWORD);

  return res.status(200).json({
    // Backward-compat velden (cockpit-caller-ID-wisselaar leest deze).
    caller_ids: nlCallerIds,
    configured: nlRest,
    // Nieuwe dual-account shape voor Instellingen v2 telefonie-sectie.
    accounts: {
      nl: { caller_ids: nlCallerIds, rest_configured: nlRest, sip_configured: nlSip },
      be: { caller_ids: beCallerIds, rest_configured: beRest, sip_configured: beSip },
    },
  });
}

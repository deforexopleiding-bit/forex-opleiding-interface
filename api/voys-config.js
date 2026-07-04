// api/voys-config.js
//
// GET → publieke Voys-config voor de caller-ID-wisselaar in de cockpit.
// Geeft NOOIT token/uuid terug. Alleen de lijst caller-IDs + een
// 'configured'-vlag zodat de UI kan bepalen of Voys überhaupt gekoppeld
// is.
//
// Env-vars:
//   VOYS_CALLER_IDS — komma-gescheiden lijst met nummers (E.164 of los).
//                     Bijvoorbeeld: '+31201234567,+31612345678,+3223456789'
//   VOYS_API_TOKEN + VOYS_CLIENT_UUID + VOYS_A_NUMBER — samen bepalen ze
//                     of Voys geconfigureerd is.

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

  const idsRaw = String(process.env.VOYS_CALLER_IDS || '').trim();
  const callerIds = idsRaw
    ? idsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const configured = !!(process.env.VOYS_API_TOKEN
                    && process.env.VOYS_CLIENT_UUID
                    && process.env.VOYS_A_NUMBER);

  return res.status(200).json({
    caller_ids: callerIds,
    configured,
  });
}

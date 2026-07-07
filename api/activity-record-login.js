// api/activity-record-login.js
//
// Login-tracking endpoint (PR1 activiteitenlogboek). Wordt door de frontend
// aangeroepen NA een succesvolle login/magic-link-exchange om
// user_last_activity.last_login_at te zetten. De frontend stuurt de Bearer-
// token mee (net als andere apiFetch-calls), dus we valideren de sessie via
// de supabase-auth-client.
//
// Volledig fire-and-forget qua uitkomst: als de logging faalt, is dat geen
// blocker voor de login zelf. Endpoint returnt 200 met { ok:true } zodra de
// user gevalideerd is; de recordLogin-upsert draait asynchroon.
//
// Geen aparte permission: elke ingelogde user mag zijn eigen login melden.

import { supabase, supabaseAdmin } from './supabase.js';
import { recordLogin, logActivity } from './_lib/activity-logger.js';

function _getIp(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req?.headers?.['x-real-ip'] || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }
  const token = authHeader.slice(7);

  const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  const ip = _getIp(req);

  // Profile-email/rol ophalen voor betere leesbaarheid (fail-soft).
  let email = null;
  let role  = null;
  try {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('email, role')
      .eq('id', user.id)
      .maybeSingle();
    email = data?.email || null;
    role  = data?.role  || null;
  } catch { /* fail-soft */ }

  // Login-timestamp + activity-log-entry (beide fire-and-forget).
  recordLogin({ userId: user.id, userEmail: email, ip });
  logActivity({
    req,
    userId    : user.id,
    userEmail : email,
    userRole  : role,
    action    : 'auth.login',
    statusCode: 200,
  });

  return res.status(200).json({ ok: true });
}

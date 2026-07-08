// Wrapper voor Vercel cron — roept agent-approval expire_pending aan
import handler from './agent-approval.js';
import { checkCronAuth } from './supabase.js';

export default function (req, res) {
  // Verplichte CRON_SECRET check vóór delegatie
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  // Security H1 — signaleer aan agent-approval dat we al via CRON_SECRET
  // geauthenticeerd zijn, zodat requirePermission daar geoverslaagd wordt.
  // De cron heeft geen user-JWT; het shared secret IS de auth.
  req.__cronAuthed = true;

  // Injecteer de action zodat de main handler het juist verwerkt
  req.query = { ...req.query, action: 'expire_pending' };
  return handler(req, res);
}

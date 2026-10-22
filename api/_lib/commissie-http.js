// api/_lib/commissie-http.js
//
// Gedeelde HTTP-schil voor de commissie-endpoints (api/commissie-*.js):
// methode-check, sessie (createUserClient), recht (requirePermission) en
// CommissieFout → statuscode. De logica zelf staat in commissie-core.js.

import { createUserClient } from '../supabase.js';
import { requirePermission } from './requirePermission.js';
import { CommissieFout } from './commissie-core.js';

export function commissieHandler({ method, permissie, label, run }) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== method) {
      res.setHeader('Allow', method);
      return res.status(405).json({ error: `${method} only` });
    }
    const supabase = createUserClient(req);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    if (!(await requirePermission(req, permissie))) {
      return res.status(403).json({ error: `Geen rechten (${permissie})` });
    }
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    try {
      const out = await run({ req, user, body, query: req.query || {} });
      return res.status(200).json(out);
    } catch (e) {
      if (e instanceof CommissieFout) {
        return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
      }
      console.error(`[${label}]`, e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  };
}

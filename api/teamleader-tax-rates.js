// api/teamleader-tax-rates.js
// GET → { taxRates, departments } voor diagnose
import { tlFetch, refreshIfNeeded } from './_lib/teamleader-token.js';
import { createUserClient } from './supabase.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const supabase = createUserClient(req);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  await refreshIfNeeded();
    const [rTax, rDept] = await Promise.all([
          tlFetch('/taxRates.list', { method: 'POST', body: JSON.stringify({}) }),
          tlFetch('/departments.list', { method: 'POST', body: JSON.stringify({}) }),
        ]);
    const taxData = rTax.ok ? await rTax.json() : { error: `HTTP ${rTax.status}`, body: await rTax.text() };
    const deptData = rDept.ok ? await rDept.json() : { error: `HTTP ${rDept.status}` };
    return res.status(200).json({ taxRates: taxData, departments: deptData });
}

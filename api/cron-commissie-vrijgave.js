// api/cron-commissie-vrijgave.js
//
// Dagelijks vangnet voor de factuurmotor (rekenregel 9 nov 2026): draait de
// motor voor ELKE klant met open commissie. De uurlijkse Teamleader-sync doet
// het al voor klanten waarvan een betaling veranderde; dit vangt wat daar niet
// in het tijdsbudget paste of via een andere weg betaald werd. Idempotent.
// Schrijft enkel grootboekregels voor betalingen in OPEN maanden; afgesloten
// maanden blijven exact zoals ze zijn.
//
// Auth: Authorization: Bearer $CRON_SECRET. ?dry_run=1 rekent zonder te schrijven.

import { checkCronAuth } from './supabase.js';
import { klantenMetOpenCommissie, vrijgaveVoorKlanten } from './_lib/commissie-vrijgave-run.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const dryRun = String(req.query?.dry_run || '') === '1';
  const start = Date.now();
  try {
    const klanten = await klantenMetOpenCommissie();
    const r = await vrijgaveVoorKlanten(klanten, { deadline: start + 270_000, dryRun });
    console.log('[cron-commissie-vrijgave] klaar', JSON.stringify({ ...r, voorbeelden: r.voorbeelden.length, dry_run: dryRun, ms: Date.now() - start }));
    return res.status(200).json({ ok: true, dry_run: dryRun, ...r, ms: Date.now() - start });
  } catch (e) {
    console.error('[cron-commissie-vrijgave]', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Onbekende fout' });
  }
}

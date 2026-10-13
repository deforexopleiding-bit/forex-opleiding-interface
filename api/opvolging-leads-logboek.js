// api/opvolging-leads-logboek.js
//
// GET ?dag=YYYY-MM-DD → het logboek van Leads bellen voor die dag (standaard
// vandaag, Amsterdam). Alle calls, berichten, doorgestuurde agenda's,
// inplanningen, terugbelafspraken en afrondingen op de leadkaarten.
// Schrijft niets. De opbouw staat puur in api/_lib/opvolging-leads-logboek.js.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { leesLeadkaarten, leesTellingen } from './_lib/opvolging-leads-data.js';
import { bouwLogboek } from './_lib/opvolging-leads-logboek.js';
import { dagInZone, dagenTussen } from './_lib/opvolging-leads-pot.js';

const DAG_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'opvolging.leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.leads.view)' });
  }

  const nuMs = Date.now();
  const vandaag = dagInZone(nuMs);
  const dag = DAG_RE.test(String((req.query || {}).dag || '')) ? String(req.query.dag) : vandaag;
  const terug = dagenTussen(dag, vandaag);
  if (terug == null || terug < 0 || terug > 55) {
    return res.status(400).json({ error: 'Kies een dag in de laatste 55 dagen.' });
  }

  try {
    const meldingen = [];
    const kaarten = await leesLeadkaarten(supabaseAdmin);
    const tel = await leesTellingen(supabaseAdmin, kaarten, nuMs, meldingen);
    const hist = new Map([...tel.entries()].map(([id, t]) => [id, (t && t.pogingen) || []]));
    const uit = bouwLogboek({ kaarten, histPerKaart: hist, dag });
    return res.status(200).json({ ...uit, vandaag, meldingen });
  } catch (e) {
    console.error('[opvolging-leads-logboek]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

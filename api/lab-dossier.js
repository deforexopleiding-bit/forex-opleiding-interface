// api/lab-dossier.js
//
// GET /api/lab-dossier?lead_id=<uuid>  (of ?email=)
// Het Lab-dossier van één lead voor op de leadkaart en bij de
// kennismakingsgesprekken: status, tijd in The Lab, scores per oefening, ALLE
// antwoorden (simulatie + vragenlaag), de drie kwalificatievragen, leadscore,
// hook en campagne, en de opvolging. RBAC: leads.view.
//
// "Geen dossier" (de lead deed nooit mee) is een gewoon antwoord: 200 met
// `dossier: null`. Een LMS-storing staat apart in `dossier.lms_fout`, zodat het
// scherm "niet gevonden" en "niet kunnen ophalen" uit elkaar houdt.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { leesDossier } from './_lib/lab-dossier.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) return res.status(403).json({ error: 'Geen rechten (leads.view)' });

  const q = req.query || {};
  const leadId = UUID_RE.test(String(q.lead_id || '')) ? String(q.lead_id) : null;
  const email = EMAIL_RE.test(String(q.email || '').trim()) ? String(q.email).trim().toLowerCase() : null;
  if (!leadId && !email) return res.status(400).json({ error: 'lead_id of email vereist' });

  try {
    const d = await leesDossier({ leadId, email });
    const leeg = !d || (!d.aanmeldingen.length && !d.account && !d.afspraken.length);
    return res.status(200).json({ ok: true, dossier: leeg && !d?.lms_fout ? null : d });
  } catch (e) {
    console.error('[lab-dossier] mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Lab-dossier ophalen mislukt' });
  }
}

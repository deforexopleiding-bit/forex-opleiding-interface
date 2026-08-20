// api/lead-welkom-resend.js
//
// POST — Herstuur de welkomstmail (met inloggegevens) naar een bestaande
// lead. Hergebruikt de BESTAANDE stuurWelkom-flow uit _lib/welkom.js
// (identieke pad als lead-handmatig-toevoegen); geen nieuwe auth-flow.
//
// Doel: soms komt de eerste welkomstmail niet aan. Deze endpoint stuurt
// hem opnieuw, optioneel naar een ALTERNATIEF e-mailadres (fallback op
// het lead-e-mail). Er wordt niets structureels gemuteerd — alleen een
// mail-send.
//
// Body: { lead_id: uuid, email?: string, voornaam?: string }
//   - lead_id (required): welke lead
//   - email (optioneel): alternatief adres; als leeg → gebruik lead.email
//   - voornaam (optioneel): override voor personalisatie
//
// Response: 200 { ok: bool, sent: bool, doel_email, resultaat }
//
// RBAC: leads.view (dezelfde als de rest van de leads-module).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { stuurWelkom } from './_lib/welkom.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const body = req.body || {};
  const leadId = String(body.lead_id || '').trim();
  if (!UUID_RE.test(leadId)) {
    return res.status(400).json({ error: 'lead_id (uuid) is verplicht.' });
  }

  // Lookup lead (voor voornaam + fallback-email).
  const { data: lead, error: leadErr } = await supabaseAdmin
    .from('leads')
    .select('id, voornaam, achternaam, email, naam')
    .eq('id', leadId)
    .maybeSingle();
  if (leadErr) {
    console.error('[lead-welkom-resend] lead fetch:', leadErr.message);
    return res.status(500).json({ error: leadErr.message });
  }
  if (!lead) return res.status(404).json({ error: 'Lead niet gevonden.' });

  // Bepaal doel-email: expliciet body.email > lead.email.
  const overrideRaw = typeof body.email === 'string' ? body.email.trim() : '';
  const doelEmail   = overrideRaw || String(lead.email || '').trim();
  if (!doelEmail) {
    return res.status(400).json({ error: 'Geen e-mailadres beschikbaar. Vul een alternatief adres in.' });
  }
  if (!EMAIL_RE.test(doelEmail)) {
    return res.status(400).json({ error: `Ongeldig e-mailadres: ${doelEmail}` });
  }

  const voornaamRaw = typeof body.voornaam === 'string' ? body.voornaam.trim() : '';
  const voornaam    = voornaamRaw || String(lead.voornaam || '').trim() || null;

  try {
    const resultaten = await stuurWelkom({
      email: doelEmail,
      voornaam,
      kanalen: ['email'],
    });
    const emailRes = resultaten.find((r) => r.kanaal === 'email');
    const sent = !!emailRes?.ok;
    if (!sent) {
      console.warn('[lead-welkom-resend] send failed:', leadId, doelEmail, emailRes);
    }
    return res.status(200).json({
      ok:          true,
      sent,
      doel_email:  doelEmail,
      voornaam,
      resultaat:   emailRes || { ok: false, reden: 'no-response' },
    });
  } catch (e) {
    console.error('[lead-welkom-resend]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Onbekende fout.' });
  }
}

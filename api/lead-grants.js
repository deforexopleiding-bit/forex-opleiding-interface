// api/lead-grants.js
// GET ?lead_id=... → basisvelden van de lead + het gekoppelde LMS-account +
// de huidige product-grants (voor de "bewerken"-modal). Permission: leads.update.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const leadId = String(req.query.lead_id || '').trim();
  if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ongeldig' });

  try {
    const { data: lead, error: lErr } = await supabaseAdmin
      .from('leads').select('id, voornaam, achternaam, email, telefoon')
      .eq('id', leadId).maybeSingle();
    if (lErr) throw new Error('leads fetch: ' + lErr.message);
    if (!lead) return res.status(404).json({ error: 'Lead niet gevonden' });

    // Account: eerst op lead_id, anders op e-mail.
    let account = null;
    const { data: opLead } = await supabaseAdmin
      .from('lms_gebruikers').select('id, email').eq('lead_id', leadId).maybeSingle();
    account = opLead || null;
    if (!account && lead.email) {
      const { data: opMail } = await supabaseAdmin
        .from('lms_gebruikers').select('id, email').eq('email', lead.email.toLowerCase()).maybeSingle();
      account = opMail || null;
    }

    let grants = [];
    if (account) {
      const { data: rows, error: gErr } = await supabaseAdmin
        .from('lms_toegang')
        .select('toegang_van, toegang_tot, lms_producten(slug, naam, actief)')
        .eq('gebruiker_id', account.id);
      if (gErr) throw new Error('lms_toegang fetch: ' + gErr.message);
      const nu = Date.now();
      grants = (rows || []).map(r => ({
        slug: r.lms_producten?.slug,
        naam: r.lms_producten?.naam,
        product_actief: !!r.lms_producten?.actief,
        van: r.toegang_van ? String(r.toegang_van).slice(0, 10) : null,
        tot: r.toegang_tot ? String(r.toegang_tot).slice(0, 10) : null,
        verlopen: r.toegang_tot ? new Date(r.toegang_tot).getTime() <= nu : false,
      })).filter(g => g.slug);
    }

    return res.status(200).json({ lead, account, grants });
  } catch (e) {
    console.error('[lead-grants]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

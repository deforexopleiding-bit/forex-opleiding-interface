// api/lead-toegang-verlenen.js
//
// POST { lead_id: <uuid>, product_slug?: <text>, duur_dagen?: <int> }
//
// Simpele "Geef toegang"-knop voor Romy (+ manager/admin). Verleent
// standaard trial-toegang tot 1 LMS-product en verstuurt de inlogmail.
// Zonder product-selector — server-side default = eerste actieve product
// waar we een trial voor doen (of caller-override via product_slug).
//
// Gate: leads.update.
//
// Fail-modes:
//   - lead niet gevonden → 404
//   - geen actieve LMS-producten → 500 (config-fout)
//   - grant-fout → 500 (behoud audit-log)
//
// INCASSO-VEILIG: gebruikt bestaande LMS-provisioning cascade
// (_lib/lms-provisioning + _lib/welkom). Geen finance/dunning-writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { vindOfMaakAccount, zetGrant, telefoonE164, vanIso, totIso } from './_lib/lms-provisioning.js';
import { stuurWelkom } from './_lib/welkom.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TRIAL_DAYS = 7;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const body = req.body || {};
  const leadId    = String(body.lead_id || '').trim();
  const slugRaw   = body.product_slug ? String(body.product_slug).trim().toLowerCase() : null;
  const duurDagen = Number.isFinite(Number(body.duur_dagen))
    ? Math.max(1, Math.min(365, Math.round(Number(body.duur_dagen))))
    : DEFAULT_TRIAL_DAYS;

  if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id (uuid) vereist' });

  try {
    // 1) Lead ophalen.
    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('id, voornaam, achternaam, email, telefoon')
      .eq('id', leadId)
      .maybeSingle();
    if (!lead) return res.status(404).json({ error: 'Lead niet gevonden' });
    if (!lead.email) return res.status(400).json({ error: 'Lead heeft geen e-mailadres' });

    // 2) Product resolven — expliciet via slug of default (eerste actieve).
    let product = null;
    if (slugRaw) {
      const { data: p } = await supabaseAdmin
        .from('lms_producten')
        .select('id, slug, naam, actief')
        .eq('slug', slugRaw).eq('actief', true).maybeSingle();
      if (!p) return res.status(400).json({ error: `Onbekend/inactief product: ${slugRaw}` });
      product = p;
    } else {
      const { data: firstActive } = await supabaseAdmin
        .from('lms_producten')
        .select('id, slug, naam')
        .eq('actief', true)
        .order('slug', { ascending: true })
        .limit(1).maybeSingle();
      if (!firstActive) return res.status(500).json({ error: 'Geen actieve LMS-producten geconfigureerd' });
      product = firstActive;
    }

    // 3) Bepaal trial-window: vanaf vandaag N dagen.
    const startIso = vanIso(new Date().toISOString().slice(0, 10));
    const endDate = new Date();
    endDate.setUTCDate(endDate.getUTCDate() + duurDagen);
    const endIso   = totIso(endDate.toISOString().slice(0, 10));

    // 4) Account + grant + welkom (spiegelt lead-handmatig-toevoegen).
    const { id: gebruikerId } = await vindOfMaakAccount({
      email: lead.email,
      voornaam: lead.voornaam || null,
      achternaam: lead.achternaam || null,
      leadId,
      van: startIso, tot: endIso,
    });
    await zetGrant({
      gebruikerId, productId: product.id,
      van: startIso, tot: endIso,
    });

    // 5) Welkomstmail sturen. Fail-soft — grant staat al.
    let mailStatus = null;
    try {
      const wa = await stuurWelkom({
        email: lead.email,
        voornaam: lead.voornaam || null,
        telefoon: telefoonE164(lead.telefoon || ''),
        kanalen: ['email'],
      });
      mailStatus = { ok: !!wa?.ok, detail: wa || null };
    } catch (mailErr) {
      mailStatus = { ok: false, error: mailErr?.message || String(mailErr) };
      console.warn('[lead-toegang-verlenen] welkom-mail (soft):', mailErr?.message || mailErr);
    }

    return res.status(200).json({
      ok: true,
      lead_id: leadId,
      product_slug: product.slug,
      product_naam: product.naam || null,
      duur_dagen:   duurDagen,
      geldig_tot:   endIso.slice(0, 10),
      mail: mailStatus,
    });
  } catch (e) {
    console.error('[lead-toegang-verlenen]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}

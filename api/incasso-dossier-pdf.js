// api/incasso-dossier-pdf.js
// POST { dossier_id } → PDF-download (application/pdf, attachment).
// Werkt dossier.pdf_ref + updated_at bij (laatst gegenereerd-tijdstip).
// Permission: finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { buildDossierPdfBuffer } from './_lib/incasso-pdf.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const dossierId = typeof body.dossier_id === 'string' && UUID_RE.test(body.dossier_id) ? body.dossier_id : null;
  if (!dossierId) return res.status(400).json({ error: 'dossier_id (uuid) verplicht' });

  try {
    const buffer = await buildDossierPdfBuffer(dossierId);
    const nowIso = new Date().toISOString();
    const pdfRef = 'generated:' + nowIso;
    try {
      await supabaseAdmin.from('dunning_incasso_dossiers')
        .update({ pdf_ref: pdfRef, updated_at: nowIso })
        .eq('id', dossierId);
    } catch (e) {
      console.warn('[incasso-dossier-pdf] pdf_ref update soft-fail:', e?.message || e);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="incassodossier_${dossierId.slice(0, 8)}.pdf"`);
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('[incasso-dossier-pdf]', e?.message || e);
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: e?.message || 'PDF genereren mislukt' });
  }
}

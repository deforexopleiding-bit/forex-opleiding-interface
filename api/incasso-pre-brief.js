// api/incasso-pre-brief.js
// POST { customer_id, country? } → download WIK-14-dagenbrief (NL) of
// eerste (kosteloze) herinnering (BE).
//
// Dunne HTTP-schil rond generatePreBriefForCustomer (api/_lib/incasso-pre-brief-core.js):
// de briefslogica (template → adres-gate → PDF → storage → dunning_briefs-rij
// → dunning_log) leeft in de core zodat de dunning-engine exact dezelfde brief
// kan auto-genereren. Deze handler doet auth/RBAC, roept de core aan met de
// ingelogde user als generated_by, en mapt het resultaat naar de bestaande
// HTTP-responses + PDF-stream.
//
// Permission: finance.incasso.manage.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { generatePreBriefForCustomer } from './_lib/incasso-pre-brief-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { res.setHeader('Content-Type', 'application/json'); return res.status(401).json({ error: 'Niet geauthenticeerd' }); }
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' && UUID_RE.test(body.customer_id) ? body.customer_id : null;
  const country    = (body.country === 'BE') ? 'BE' : 'NL';
  if (!customerId) { res.setHeader('Content-Type', 'application/json'); return res.status(400).json({ error: 'customer_id (uuid) verplicht' }); }

  try {
    // Handmatig pad: land expliciet uit de body, ingelogde user als generated_by,
    // geen run-koppeling (runId = null → handmatige brieven blijven onbeperkt).
    const result = await generatePreBriefForCustomer({
      customerId,
      country,
      generatedByUserId: user.id,
      runId: null,
      stepId: null,
    });

    if (!result.ok) {
      res.setHeader('Content-Type', 'application/json');
      switch (result.code) {
        case 'ADDRESS_INCOMPLETE':
          return res.status(422).json({
            code: 'ADDRESS_INCOMPLETE',
            error: `Adres onvolledig — ontbreekt: ${(result.missing || []).join(', ')}. Vul aan in TeamLeader (sync haalt 'm binnen een uur op) of via het klantdossier.`,
            missing_fields: result.missing || [],
          });
        case 'CUSTOMER_NOT_FOUND':
          return res.status(404).json({ error: 'Klant niet gevonden' });
        case 'TEMPLATE_NOT_FOUND':
          return res.status(500).json({ error: result.error });
        case 'STORAGE_UPLOAD_FAILED':
          return res.status(500).json({ error: 'PDF-opslag mislukt (bewijs kon niet bewaard worden): ' + result.error, code: 'STORAGE_UPLOAD_FAILED' });
        case 'BRIEF_ROW_FAILED':
        case 'DUPLICATE_RUN_BRIEF':
          return res.status(500).json({ error: 'Bewijs-rij aanmaken mislukt: ' + (result.error || 'geen rij'), code: 'BRIEF_ROW_FAILED' });
        default:
          return res.status(500).json({ error: result.error || 'Interne fout' });
      }
    }

    // Stream als download. brief_id + path in headers zodat de UI het bewijs
    // kan tonen + latere email-verzending dezelfde brief kan hergebruiken.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="pre-incassobrief_${result.country}_${customerId.slice(0, 8)}.pdf"`);
    res.setHeader('X-Brief-Id', result.brief_id);
    res.setHeader('X-Brief-Path', result.pdf_path);
    return res.status(200).send(result.buffer);
  } catch (e) {
    console.error('[incasso-pre-brief]', e?.message || e);
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// api/incasso-dossier-create.js
// POST { customer_id, bureau_id?, country?, confirm_no_brief? }
//   1) 409 als klant al open dossier heeft (via createDossierCore
//      idempotency-check).
//   2) Particulier-guard (PR-3): is_company !== true + geen
//      'incasso_pre_brief_sent'-marker + confirm_no_brief !== true
//      → 200 { needs_brief:true, country, customer_id, message }.
//   3) Anders: createDossierCore(...) → dossier + pipeline-fase incasso.
// Permission: finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { createDossierCore } from './_lib/incasso-dossier.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' && UUID_RE.test(body.customer_id) ? body.customer_id : null;
  const bureauId   = typeof body.bureau_id   === 'string' && UUID_RE.test(body.bureau_id)   ? body.bureau_id   : null;
  const country    = (body.country === 'BE') ? 'BE' : 'NL';
  const notes      = typeof body.notes === 'string' ? body.notes.trim() : null;
  const confirmNoBrief = body.confirm_no_brief === true;

  if (!customerId) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });

  try {
    // 1) Customer bestaat?
    const { data: customer, error: cErr } = await supabaseAdmin
      .from('customers').select('id, first_name, last_name, company_name, is_company, email, phone')
      .eq('id', customerId).maybeSingle();
    if (cErr) throw new Error('customers lookup: ' + cErr.message);
    if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });

    // 2) Particulier-guard (PR-3): pre-brief verplicht tenzij expliciet
    //    bevestigd. is_company=true (zakelijk) → guard skippen. Marker:
    //    dunning_log event 'incasso_pre_brief_sent'.
    const isPrivate = customer.is_company !== true;
    if (isPrivate && !confirmNoBrief) {
      let hasBriefSent = false;
      try {
        const { data: sentRows } = await supabaseAdmin
          .from('dunning_log').select('id')
          .eq('event_type', 'incasso_pre_brief_sent')
          .filter('payload->>customer_id', 'eq', customerId).limit(1);
        hasBriefSent = Array.isArray(sentRows) && sentRows.length > 0;
      } catch (e) {
        console.warn('[incasso-dossier-create] pre-brief lookup soft-fail', e?.message || e);
      }
      if (!hasBriefSent) {
        return res.status(200).json({
          needs_brief: true,
          country,
          customer_id: customerId,
          message: 'Verplichte pre-incassobrief nog niet verstuurd — verstuur eerst de WIK/BE-brief of bevestig doorgaan zonder brief.',
        });
      }
    }

    // 3) Core-flow via helper. Idempotent: bij bestaand OPEN dossier
    //    krijgen we { created:false, dossier:<bestaand> } → 409.
    const result = await createDossierCore(customerId, {
      country, bureauId, openedBy: user.id, source: 'handmatig', notes,
    });
    if (!result.created) {
      return res.status(409).json({
        error: 'Klant zit al in incasso (open dossier)',
        dossier_id: result.dossier.id,
      });
    }

    return res.status(200).json({ ok: true, dossier: result.dossier });
  } catch (e) {
    console.error('[incasso-dossier-create]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

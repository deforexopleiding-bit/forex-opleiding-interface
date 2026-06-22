// api/onboarding-wizard-config-get.js
//
// ADMIN — haal de huidige wizard-config op (draft + published + default).
// Singleton-rij op onboarding_wizard.id = 1.
//
// Permission: onboarding.wizard.edit.
//
// Response 200:
//   { ok:true,
//     draft     : object,                  // draft_structure ?? published ?? DEFAULT
//     published : object|null,             // published_structure ?? null
//     default   : object,                  // DEFAULT_WIZARD_STRUCTURE
//     meta      : { draft_updated_at, draft_updated_by,
//                   published_at, published_by } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { DEFAULT_WIZARD_STRUCTURE } from './_lib/onboarding-wizard-default.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'onboarding.wizard.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.wizard.edit)' });
  }

  try {
    const { data: row, error: rowErr } = await supabaseAdmin
      .from('onboarding_wizard')
      .select('draft_structure, published_structure, draft_updated_at, draft_updated_by, published_at, published_by')
      .eq('id', 1)
      .maybeSingle();
    if (rowErr) throw new Error('wizard fetch: ' + rowErr.message);

    const published = row?.published_structure || null;
    const draft     = row?.draft_structure || published || DEFAULT_WIZARD_STRUCTURE;

    return res.status(200).json({
      ok        : true,
      draft,
      published,
      default   : DEFAULT_WIZARD_STRUCTURE,
      meta      : {
        draft_updated_at : row?.draft_updated_at || null,
        draft_updated_by : row?.draft_updated_by || null,
        published_at     : row?.published_at     || null,
        published_by     : row?.published_by     || null,
      },
    });
  } catch (e) {
    console.error('[onboarding-wizard-config-get]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// api/dunning-template-diagnose.js
// GET → diagnose van dunning WhatsApp-templates: welke placeholders
// worden door DUNNING_PLACEHOLDER_RE gematcht (= sturen we naar Meta) en
// welke NIET (= bug-bron voor Meta #132000).
//
// Read-only. Muteert niks. Bedoeld om zonder DB-access snel te zien
// welke templates de parameter-mismatch veroorzaken.
//
// Permission: finance.dunning.view.
//
// Query-params:
//   template_id   uuid  optioneel — diagnose 1 specifieke template.
//                       Als weggelaten: alle actieve kind='whatsapp'-templates.
//
// Response:
//   { items: [
//       {
//         id, name, meta_template_name, is_active,
//         diagnose: {
//           matched:     string[],  // gaat naar Meta als positionele params
//           unmatched:   string[],  // placeholders in body die de regex NIET matcht
//           total_count: number,    // aantal params naar Meta
//           raw_count:   number,    // aantal placeholders in body (mens-telling)
//           n_missing:   number,    // raw - total; als > 0: #132000-risico
//         },
//         body_preview: string (eerste 200 chars),
//       }
//     ],
//     summary: { total, at_risk }
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { diagnoseTemplatePlaceholders } from './_lib/dunning-template-placeholders.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  const templateId = req.query?.template_id ? String(req.query.template_id).trim() : null;
  if (templateId && !UUID_RE.test(templateId)) {
    return res.status(400).json({ error: 'template_id moet een UUID zijn' });
  }

  try {
    let qy = supabaseAdmin
      .from('dunning_templates')
      .select('id, name, kind, meta_template_name, language, is_active, body')
      .eq('kind', 'whatsapp');
    if (templateId) qy = qy.eq('id', templateId);
    else            qy = qy.eq('is_active', true);
    const { data, error } = await qy.order('name', { ascending: true });
    if (error) throw new Error('dunning_templates fetch: ' + error.message);

    const items = (data || []).map((t) => {
      const diag = diagnoseTemplatePlaceholders(t.body);
      return {
        id:                 t.id,
        name:               t.name,
        meta_template_name: t.meta_template_name,
        language:           t.language,
        is_active:          t.is_active,
        diagnose:           diag,
        body_preview:       String(t.body || '').slice(0, 200),
      };
    });

    const atRisk = items.filter(x => x.diagnose.n_missing > 0);
    return res.status(200).json({
      items,
      summary: {
        total:   items.length,
        at_risk: atRisk.length,
        at_risk_names: atRisk.map(x => `${x.name} (${x.diagnose.n_missing} unmatched)`),
      },
    });
  } catch (e) {
    console.error('[dunning-template-diagnose]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

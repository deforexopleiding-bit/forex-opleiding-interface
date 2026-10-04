// api/setter-commission-monthly.js
//
// GET ?setter_user_id=<uuid> (optioneel — default: user zelf)
//
// Commissie per maand (maand = BETAALdatum van de factuur, niet de
// boekingsdatum) voor één setter:
//   - geboekt   = Σ setter_ledger_entries.amount (betaal_datum, vóór de
//                 migratie: created_at)
//   - uitbetaald = deel daarvan met status 'uitbetaald'
//   - berekend  = wat de facturen zeggen (pct × echt ontvangen, credit-veilig)
//                 — gelijk aan geboekt zodra de commissie-cron zonder dry-run
//                 draait; tot die tijd laat dit zien wat er zou komen.
// Plus per factuur wat er binnenkwam (voor controle) en de dry-run-stand.
//
// Gate: setter.ledger.view; setter.ledger.admin mag een andere setter kiezen.
// INCASSO-VEILIG: alleen SELECTs.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  laadCommissieData, planCommissie, laadLedgerRegels, maandOverzicht,
  isSetterCommissieDryRun, vandaagAmsterdam,
} from './_lib/setter-commissie-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'setter.ledger.view'))) {
    return res.status(403).json({ error: 'Geen rechten (setter.ledger.view)' });
  }
  const requested = String(req.query?.setter_user_id || '').trim();
  let setterId = user.id;
  if (requested && requested !== user.id) {
    if (!UUID_RE.test(requested)) return res.status(400).json({ error: 'setter_user_id ongeldig' });
    if (!(await requirePermission(req, 'setter.ledger.admin'))) {
      return res.status(403).json({ error: 'Alleen setter.ledger.admin mag andere setters bekijken' });
    }
    setterId = requested;
  }

  try {
    const [data, entries, dryRun] = await Promise.all([
      laadCommissieData(supabaseAdmin, { setterIds: [setterId] }),
      laadLedgerRegels(supabaseAdmin, setterId),
      isSetterCommissieDryRun(supabaseAdmin),
    ]);
    const [plan] = planCommissie(data, { vandaag: vandaagAmsterdam() });
    const pct = Number(plan?.config?.pct) || 0;
    return res.status(200).json({
      setter_user_id: setterId,
      pct,
      config: plan?.config || null,
      dry_run: dryRun,
      maanden: maandOverzicht({ entries, facturen: plan?.facturen || [], pct }),
      nog_te_boeken: plan?.te_boeken || 0,
      facturen: (plan?.facturen || []).filter((f) => f.ontvangen > 0 || f.geboekte_basis !== 0),
    });
  } catch (e) {
    console.error('[setter-commission-monthly]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}

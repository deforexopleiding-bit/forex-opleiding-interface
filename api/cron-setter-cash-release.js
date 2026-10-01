// api/cron-setter-cash-release.js
//
// Dagelijkse cron (schedule: 0 6 * * * — via vercel.json, ongewijzigd).
// Boekt setter-commissie op FACTUREN: pct % van elk bedrag dat echt binnenkwam
// op een factuur van een setter-deal. FORWARD-ONLY (zoals de mentorbonus):
// geboekte commissie blijft staan, een latere creditnota boekt niets terug;
// er wordt nooit een regel van <= 0 geboekt. Volledige regels: zie
// _lib/setter-commissie-core.js.
//
// Vervangt de oude flow (payments-tabel + setter_watermark): die zag alleen
// betalingen die in het CRM geregistreerd waren (±43 van ±1.400 betaalde
// facturen), alleen facturen met deal_id, en sloeg terug-gedateerde
// betalingen over. De reconcile-aanpak heeft geen watermark nodig; de
// setter_watermark-rij wordt niet meer gelezen of geschreven.
//
// VEILIGHEID:
//   - Dry-run-vlag app_settings.setter_commissie_dry_run (default AAN — een
//     ontbrekende rij of leesfout = dry-run). In dry-run: alleen SELECTs, het
//     antwoord toont wat er geboekt ZOU worden.
//   - ?dry_run=1 forceert dry-run, ook als de vlag uit staat.
//   - ?setter_user_id=<uuid> beperkt tot één setter.
//   - Schrijft UITSLUITEND setter_ledger_entries (insert, idempotent).
//   - ⚠ setter_ledger_entries.betaal_datum (migratie
//     2026-10-01-setter-commissie-facturen.sql) moet bestaan vóór de vlag uit
//     gaat — de insert noemt die kolom.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth).

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import {
  laadCommissieData, planCommissie, isSetterCommissieDryRun, boekMutaties, vandaagAmsterdam,
} from './_lib/setter-commissie-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const q = req.query || {};
  const forceDry = q.dry_run === '1' || q.dry_run === 'true';
  const onlySetter = typeof q.setter_user_id === 'string' && UUID_RE.test(q.setter_user_id) ? q.setter_user_id : null;

  try {
    const dryRun = forceDry || await isSetterCommissieDryRun(supabaseAdmin);
    const vandaag = vandaagAmsterdam();
    const data = await laadCommissieData(supabaseAdmin, { setterIds: onlySetter ? [onlySetter] : null });
    const plan = planCommissie(data, { vandaag });

    const summary = {
      ok: true,
      dry_run: dryRun,
      vandaag,
      setters: plan.length,
      facturen_gekoppeld: plan.reduce((s, p) => s + p.facturen.length, 0),
      te_boeken_regels: plan.reduce((s, p) => s + p.mutaties.length, 0),
      te_boeken_bedrag: Math.round(plan.reduce((s, p) => s + p.te_boeken, 0) * 100) / 100,
      overgeslagen: plan.reduce((s, p) => s + p.overgeslagen.length, 0),
      created: 0, skipped: 0, errors: [],
      per_setter: plan.map((p) => ({
        setter_user_id: p.setter_user_id,
        config: p.config,
        deals: p.deals,
        facturen: p.facturen.length,
        te_boeken: p.te_boeken,
        mutaties: p.mutaties.map((m) => ({
          invoice_id: m.invoice_id, basis: m.basis, amount: m.amount, betaal_datum: m.betaal_datum,
          idempotency_key: m.idempotency_key, note: m.note,
        })),
        overgeslagen: p.overgeslagen.map((o) => ({ invoice_id: o.invoice_id, factuurnummer: o.factuurnummer, ontvangen: o.ontvangen, reden: o.reden })),
      })),
    };

    if (dryRun) return res.status(200).json(summary);

    for (const p of plan) {
      if (!p.mutaties.length) continue;
      const r = await boekMutaties(supabaseAdmin, p.mutaties);
      summary.created += r.created;
      summary.skipped += r.skipped;
      summary.errors.push(...r.errors.map((e) => ({ setter_user_id: p.setter_user_id, ...e })));
    }
    if (summary.errors.length) console.error('[cron-setter-cash-release] fouten:', summary.errors.slice(0, 3));
    return res.status(200).json(summary);
  } catch (e) {
    console.error('[cron-setter-cash-release]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}

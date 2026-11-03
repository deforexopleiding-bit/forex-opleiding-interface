// api/klant-incassostatus.js
//
// INCASSOSTATUS PER KLANT (PR 3 mentorcommissie) — zie api/_lib/klant-incassostatus.js.
//
// GET  ?customer_id=<uuid>
//   → { ok, status, historiek: [...], voorstellen: [...], kolommen }
// POST { customer_id, status: 'actief'|'bij_incasso'|'incasso_regeling'|'afgesloten',
//        afgesloten_als?: 'betaald'|'oninbaar', sinds: 'YYYY-MM-DD', reden, bron? }
//   → { ok, status, vrijgave }   ('actief' = opheffen)
//
// Na elke wijziging draait de factuurmotor voor de klant (forward-only): een
// regeling of opheffing laat echte betalingen weer meetellen; bij incasso
// komt er niets bij en blijft al vrijgegeven staan.
// Rechten: lezen finance.dunning.view, wijzigen finance.incasso.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  laadIncassoRijen, huidigeStatus, laadVoorstellen, zetStatus, statusVan, STATUS_LABEL,
} from './_lib/klant-incassostatus.js';
import { releaseProportionalForPaidAmount } from './_lib/mentor-ledger-engine.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET of POST' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  const recht = req.method === 'GET' ? 'finance.dunning.view' : 'finance.incasso.manage';
  if (!(await requirePermission(req, recht))) return res.status(403).json({ error: `Geen rechten (${recht})` });

  try {
    if (req.method === 'GET') {
      const customerId = String(req.query?.customer_id || '');
      if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });
      const r = await laadIncassoRijen(supabaseAdmin, [customerId]);
      const klantRijen = r.rijen.filter((m) => !m.deal_id);
      const huidig = huidigeStatus(klantRijen, customerId);
      const namen = await profielNamen([...new Set(klantRijen.flatMap((m) => [m.gezet_door, m.opgeheven_door]).filter(Boolean))]);
      const historiek = klantRijen
        .sort((a, b) => String(b.gezet_op || '').localeCompare(String(a.gezet_op || '')))
        .map((m) => ({
          id: m.id, status: statusVan(m), label: STATUS_LABEL[statusVan(m)] + (m.afgesloten_als ? ` (${m.afgesloten_als})` : ''),
          sinds: m.sinds, reden: m.reden, bron: m.bron,
          gezet_op: m.gezet_op, gezet_door: namen.get(m.gezet_door) || null,
          tot: m.opgeheven_op || null, beeindigd_door: namen.get(m.opgeheven_door) || null, beeindigd_reden: m.opheffen_reden || null,
        }));
      const vs = (await laadVoorstellen(supabaseAdmin, [customerId])).get(customerId) || [];
      const voorstellen = vs.filter((v) => v.voorstel !== huidig.status);
      const { rij, ...status } = huidig;
      return res.status(200).json({ ok: true, tabel: r.ok, kolommen: r.statusKolommen, status, historiek, voorstellen });
    }

    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const customerId = String(b.customer_id || '');
    if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });
    const out = await zetStatus(supabaseAdmin, {
      customerId, status: String(b.status || ''), afgeslotenAls: b.afgesloten_als || null,
      sinds: b.sinds, reden: b.reden, actorId: user.id, bron: b.bron,
    });
    let vrijgave = null;
    try {
      const r = await releaseProportionalForPaidAmount({ customerId });
      vrijgave = { vrijgegeven: Math.round((Number(r.total_released) || 0) * 100) / 100 };
    } catch (e) {
      console.error('[klant-incassostatus] factuurmotor:', e.message);
      vrijgave = { fout: e.message };
    }
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'customer.incassostatus', entity_type: 'customer', entity_id: customerId,
        after_json: { status: b.status, afgesloten_als: b.afgesloten_als || null, sinds: b.sinds || null },
        reason_text: String(b.reden || '').slice(0, 500),
      });
    } catch (e) { console.error('[klant-incassostatus] audit:', e.message); }
    return res.status(200).json({ ...out, vrijgave });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('[klant-incassostatus]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

async function profielNamen(ids) {
  const m = new Map();
  if (!ids.length) return m;
  const { data } = await supabaseAdmin.from('profiles').select('id, full_name, email').in('id', ids);
  for (const p of data || []) m.set(p.id, p.full_name || p.email || null);
  return m;
}

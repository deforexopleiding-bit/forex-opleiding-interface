// api/commissie-annulering.js
//
// Mentorcommissie per sale (offerte): lezen, annuleren, herstellen.
// Kern: api/_lib/commissie-annulering.js (regels A, B, E van 12 nov 2026).
//
//   GET  ?deal_id=<uuid>          → { commissie, vorige_vervangen }
//        ?deal_ids=<uuid>,<uuid>  → { per_deal: { <id>: commissie } } (max 500)
//        Recht: sales.deal.view of mentor.admin.view (offertepagina + lijsten).
//   POST { actie:'annuleren', deal_id, soort?:'klant_annuleert'|'vervangen'|'handmatig', reden }
//        { actie:'herstellen', deal_id, reden }
//        Recht: mentor.ledger.write. Reden verplicht bij handmatig + herstellen.
//
// Raakt enkel statussen (ouder-rijen + toewijzing). Vrijgegeven en
// uitbetaalde stukken blijven staan. Audit in agent_audit_log. Geen mails.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  AnnuleringFout, commissieVanDeal, laadCommissieVanDeals, annuleerCommissie, herstelCommissie,
  vorigeVervangenCommissie,
} from './_lib/commissie-annulering.js';
import { releaseProportionalForPaidAmount } from './_lib/mentor-ledger-engine.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function magLezen(req) {
  if (await requirePermission(req, 'sales.deal.view')) return true;
  return requirePermission(req, 'mentor.admin.view');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET/POST only' });
  }
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  try {
    if (req.method === 'GET') {
      if (!(await magLezen(req))) return res.status(403).json({ error: 'Geen rechten (sales.deal.view)' });
      const q = req.query || {};
      if (q.deal_ids) {
        const ids = String(q.deal_ids).split(',').map((s) => s.trim()).filter((s) => UUID_RE.test(s)).slice(0, 500);
        const m = await laadCommissieVanDeals(supabaseAdmin, ids);
        return res.status(200).json({ ok: true, per_deal: Object.fromEntries(m) });
      }
      const dealId = String(q.deal_id || '').trim();
      if (!UUID_RE.test(dealId)) return res.status(400).json({ error: 'deal_id (uuid) vereist' });
      const commissie = await commissieVanDeal(supabaseAdmin, dealId);
      let vorige = null;
      const { data: deal } = await supabaseAdmin.from('deals').select('id, customer_id').eq('id', dealId).maybeSingle();
      if (deal?.customer_id && commissie.status !== 'actief') {
        vorige = await vorigeVervangenCommissie(supabaseAdmin, { customerId: deal.customer_id, dealId });
      }
      return res.status(200).json({ ok: true, commissie, vorige_vervangen: vorige });
    }

    if (!(await requirePermission(req, 'mentor.ledger.write'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.ledger.write)' });
    }
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const actie = String(body.actie || '');
    if (actie === 'annuleren') {
      const out = await annuleerCommissie(supabaseAdmin, {
        dealId: body.deal_id, soort: body.soort || 'handmatig', reden: body.reden, bron: 'commissies', actorId: user.id,
      });
      if (!out.geannuleerd_regels && !out.toewijzing_geannuleerd) {
        return res.status(409).json({ error: 'Er staat geen open commissie op deze offerte (al geannuleerd of volledig vrijgegeven).', code: 'NIETS_OPEN', ...out });
      }
      return res.status(200).json(out);
    }
    if (actie === 'herstellen') {
      const out = await herstelCommissie(supabaseAdmin, {
        dealId: body.deal_id, reden: body.reden, actorId: user.id,
        vrijgave: (customerId) => releaseProportionalForPaidAmount({ customerId }),
      });
      return res.status(200).json(out);
    }
    return res.status(400).json({ error: "actie moet 'annuleren' of 'herstellen' zijn" });
  } catch (e) {
    if (e instanceof AnnuleringFout) return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
    console.error('[commissie-annulering]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

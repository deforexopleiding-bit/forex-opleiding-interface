// api/opvolging-dag.js
//
// GET → de cijfers voor het dashboard van de module Opvolging.
//
// Query: ?dag=YYYY-MM-DD (default vandaag)
// Response 200: { dag, dekking:{...}, discipline:{...}, inplanning:{...},
//                 gearchiveerd:[...], week:[...] }
//
// Nieuw endpoint. Leest uitsluitend opvolging_taken en opvolging_pogingen.
// Het doel van twee belpogingen per lead per dag staat als constante hieronder;
// het dashboard toont daartegen af.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const DOEL_BELLEN_PER_DAG = 2;
const isoDag = (d) => new Date(d).toISOString().slice(0, 10);
const minDagen = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  const vandaag = isoDag(Date.now());
  const q = req.query || {};
  const dag = /^\d{4}-\d{2}-\d{2}$/.test(q.dag || '') ? q.dag : vandaag;
  const weekStart = minDagen(dag, 6);

  try {
    const { data: open, error: e1 } = await supabaseAdmin
      .from('opvolging_taken').select('*').eq('status', 'open').lte('due', dag);
    if (e1) throw e1;

    const { data: overig, error: e2 } = await supabaseAdmin
      .from('opvolging_taken').select('*')
      .in('status', ['wacht_inplanning', 'ingepland', 'gearchiveerd']);
    if (e2) throw e2;

    const { data: pog, error: e3 } = await supabaseAdmin
      .from('opvolging_pogingen').select('*')
      .gte('tijdstip', weekStart + 'T00:00:00Z');
    if (e3) throw e3;

    const perTaak = new Map();
    for (const p of pog || []) {
      if (!perTaak.has(p.taak_id)) perTaak.set(p.taak_id, []);
      perTaak.get(p.taak_id).push(p);
    }
    const belOp = (id, d) => (perTaak.get(id) || [])
      .filter((p) => p.soort === 'call' && isoDag(p.tijdstip) === d).length;
    const waTotaal = (id) => (perTaak.get(id) || [])
      .filter((p) => p.soort === 'whatsapp' || p.soort === 'spraakbericht').length;

    const lijst = open || [];
    const dekking = {
      doel: DOEL_BELLEN_PER_DAG,
      totaal: lijst.length,
      volledig: lijst.filter((t) => belOp(t.id, dag) >= DOEL_BELLEN_PER_DAG).length,
      aangeraakt: lijst.filter((t) => belOp(t.id, dag) > 0).length,
      zonder_whatsapp: lijst.filter((t) => waTotaal(t.id) === 0).map((t) => ({ id: t.id, naam: t.naam })),
      per_lead: lijst.map((t) => ({
        id: t.id, naam: t.naam,
        bel_vandaag: belOp(t.id, dag),
        wa_totaal: waTotaal(t.id),
      })).sort((a, b) => (a.bel_vandaag + (a.wa_totaal ? 1 : 0)) - (b.bel_vandaag + (b.wa_totaal ? 1 : 0))),
    };

    const discipline = {
      tweede_ronde: lijst.filter((t) => t.later).length,
      uitgesteld_zonder_poging: lijst.reduce((n, t) => n + (t.uitgesteld_zonder_poging || 0), 0),
      bleef_liggen: lijst.filter((t) => t.due < dag).length,
    };

    const inplanning = {
      wacht: (overig || []).filter((t) => t.status === 'wacht_inplanning').length,
      ingepland: (overig || []).filter((t) => t.status === 'ingepland' && isoDag(t.updated_at) === dag).length,
      niet_ingepland: lijst.filter((t) => t.reden === 'niet_ingepland').length,
    };

    const gearchiveerd = (overig || [])
      .filter((t) => t.status === 'gearchiveerd' && t.gearchiveerd_at && isoDag(t.gearchiveerd_at) === dag)
      .map((t) => {
        const hist = perTaak.get(t.id) || [];
        const bel = hist.filter((p) => p.soort === 'call');
        return {
          id: t.id, naam: t.naam, archief_reden: t.archief_reden,
          bel_totaal: bel.length,
          bel_dagen: new Set(bel.map((p) => isoDag(p.tijdstip))).size,
          wa_totaal: waTotaal(t.id),
        };
      });

    const week = [];
    for (let i = 6; i >= 0; i--) {
      const d = minDagen(dag, i);
      const pogDag = (pog || []).filter((p) => isoDag(p.tijdstip) === d);
      week.push({
        dag: d,
        belpogingen: pogDag.filter((p) => p.soort === 'call').length,
        whatsapps: pogDag.filter((p) => p.soort === 'whatsapp' || p.soort === 'spraakbericht').length,
        ingepland: pogDag.filter((p) => p.soort === 'ingepland').length,
      });
    }

    // BP3 v32 (2026-09-04) — by_status count-map voor Kanban-badges in
    // #automatiseringen/Opvolging. Zelfde count:'exact',head:true patroon als
    // leads-stats.js (regel 39-52).
    // BP3 v36 (2026-09-04) — PARALLEL via Promise.all (was sequentieel → 4×
    // roundtrip = ~2-8s op cold-start). Elk faalt fail-soft (count:null bij
    // fout) zodat de KPI-payload nooit meer op één trage count blijft
    // hangen. Read-only, geen mutaties.
    const statuses = ['open', 'wacht_inplanning', 'ingepland', 'gearchiveerd'];
    const by_status_pairs = await Promise.all(statuses.map(async (st) => {
      try {
        const { count, error } = await supabaseAdmin
          .from('opvolging_taken')
          .select('id', { count: 'exact', head: true })
          .eq('status', st);
        if (error) return [st, null];
        return [st, Number(count) || 0];
      } catch (_) {
        return [st, null];
      }
    }));
    const by_status = Object.fromEntries(by_status_pairs);

    return res.status(200).json({ dag, vandaag, dekking, discipline, inplanning, gearchiveerd, week, by_status });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Onbekende fout' });
  }
}

// api/opvolging-taken.js
//
// GET → de takenlijst van de module Opvolging voor één dag, plus de leads die
// op eigen initiatief zouden inplannen (status wacht_inplanning).
//
// Nieuw endpoint. Raakt geen enkele bestaande tabel of route aan: leest
// uitsluitend uit opvolging_taken en opvolging_pogingen.
//
// Query:
//   ?dag=YYYY-MM-DD   (default: vandaag)
//   ?view=archief     (in plaats van de dag: de gearchiveerde taken)
//
// Response 200: { dag, taken: [...], wacht: [...] }
//   Elke taak draagt afgeleide tellers mee, zodat de client niets hoeft te rekenen:
//   pogingen_totaal, bel_totaal, bel_dagen, wa_totaal, bel_vandaag, wa_vandaag,
//   laatste_poging, en de volledige historiek in `pogingen`.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const isoDag = (d) => new Date(d).toISOString().slice(0, 10);

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

  try {
    if (q.view === 'archief') {
      const { data: arch, error: archErr } = await supabaseAdmin
        .from('opvolging_taken').select('*')
        .eq('status', 'gearchiveerd')
        .order('gearchiveerd_at', { ascending: false })
        .limit(200);
      if (archErr) throw archErr;
      const archIds = (arch || []).map((t) => t.id);
      let archPog = [];
      if (archIds.length) {
        const { data: ap, error: apErr } = await supabaseAdmin
          .from('opvolging_pogingen').select('*')
          .in('taak_id', archIds).order('tijdstip', { ascending: true });
        if (apErr) throw apErr;
        archPog = ap || [];
      }
      const perArch = new Map();
      for (const p of archPog) {
        if (!perArch.has(p.taak_id)) perArch.set(p.taak_id, []);
        perArch.get(p.taak_id).push(p);
      }
      return res.status(200).json({
        vandaag,
        archief: (arch || []).map((t) => {
          const hist = perArch.get(t.id) || [];
          const bel = hist.filter((p) => p.soort === 'call');
          const wa = hist.filter((p) => p.soort === 'whatsapp' || p.soort === 'spraakbericht');
          return {
            ...t, pogingen: hist,
            bel_totaal: bel.length,
            bel_dagen: new Set(bel.map((p) => isoDag(p.tijdstip))).size,
            wa_totaal: wa.length,
          };
        }),
      });
    }

    // Vandaag toont ook wat is blijven liggen; een andere dag toont enkel die dag.
    let sel = supabaseAdmin.from('opvolging_taken').select('*').eq('status', 'open');
    sel = dag === vandaag ? sel.lte('due', vandaag) : sel.eq('due', dag);
    const { data: taken, error: takenErr } = await sel.order('due', { ascending: true });
    if (takenErr) throw takenErr;

    const { data: wacht, error: wachtErr } = await supabaseAdmin
      .from('opvolging_taken').select('*')
      .eq('status', 'wacht_inplanning')
      .order('agenda_doorgestuurd_at', { ascending: true });
    if (wachtErr) throw wachtErr;

    const ids = [...(taken || []), ...(wacht || [])].map((t) => t.id);
    let pogingen = [];
    if (ids.length) {
      const { data: pg, error: pgErr } = await supabaseAdmin
        .from('opvolging_pogingen').select('*')
        .in('taak_id', ids)
        .order('tijdstip', { ascending: true });
      if (pgErr) throw pgErr;
      pogingen = pg || [];
    }

    const perTaak = new Map();
    for (const p of pogingen) {
      if (!perTaak.has(p.taak_id)) perTaak.set(p.taak_id, []);
      perTaak.get(p.taak_id).push(p);
    }

    const verrijk = (t) => {
      const hist = perTaak.get(t.id) || [];
      const bel = hist.filter((p) => p.soort === 'call');
      const wa = hist.filter((p) => p.soort === 'whatsapp' || p.soort === 'spraakbericht');
      const dagen = new Set(bel.map((p) => isoDag(p.tijdstip)));
      return {
        ...t,
        pogingen: hist,
        pogingen_totaal: hist.length,
        bel_totaal: bel.length,
        bel_dagen: dagen.size,
        wa_totaal: wa.length,
        bel_vandaag: bel.filter((p) => isoDag(p.tijdstip) === vandaag).length,
        wa_vandaag: wa.filter((p) => isoDag(p.tijdstip) === vandaag).length,
        laatste_poging: hist.length ? hist[hist.length - 1].tijdstip : null,
      };
    };

    // BP3 v32 (2026-09-04) — optionele ingepland-lijst voor Kanban 4e kolom.
    // Read-only, geen mutaties. Alleen 50 meest recent bijgewerkt.
    const includeIngepland = String(q.include_ingepland || '') === '1';
    let ingepland = [];
    if (includeIngepland) {
      const { data: ing, error: ingErr } = await supabaseAdmin
        .from('opvolging_taken').select('*')
        .eq('status', 'ingepland')
        .order('updated_at', { ascending: false })
        .limit(50);
      if (ingErr) throw ingErr;
      const ingIds = (ing || []).map((t) => t.id);
      if (ingIds.length) {
        const { data: ipg, error: ipgErr } = await supabaseAdmin
          .from('opvolging_pogingen').select('*')
          .in('taak_id', ingIds).order('tijdstip', { ascending: true });
        if (ipgErr) throw ipgErr;
        for (const p of ipg || []) {
          if (!perTaak.has(p.taak_id)) perTaak.set(p.taak_id, []);
          perTaak.get(p.taak_id).push(p);
        }
      }
      ingepland = (ing || []).map(verrijk);
    }

    return res.status(200).json({
      dag,
      vandaag,
      taken: (taken || []).map(verrijk),
      wacht: (wacht || []).map(verrijk),
      ingepland,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Onbekende fout' });
  }
}

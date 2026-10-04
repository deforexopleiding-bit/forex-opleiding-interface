// api/opvolging-leads-import.js
//
// POST { csv, label, per_dag?, bevestig? } → een lijst oude leads opladen in
// 'Leads bellen'.
//
//   bevestig false/leeg → alleen de voorvertoning (geldig / dubbel / ongeldig,
//                         met de due per rij). Er wordt NIETS geschreven.
//   bevestig true       → dezelfde voorvertoning opnieuw (de server vertrouwt
//                         de client niet), en daarna één kaart per geldige rij.
//
// De beslissingen staan in api/_lib/opvolging-leads-import.js.
// Recht: opvolging.leads.view (manager + sales).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { alleenDaglijst, alleenLeadlijst } from './_lib/opvolging-lijst.js';
import { leesKandidaten } from './_lib/opvolging-leads-data.js';
import { dagInZone, telefoonVan } from './_lib/opvolging-leads-pot.js';
import { leesCsv, maakVoorvertoning, importKaart, STANDAARD_PER_DAG } from './_lib/opvolging-leads-import.js';
import { brugLeadlijstVerversen } from './_lib/opvolging-brug-ververs.js';

const MAX_CSV = 600_000;

async function bekendeTelefoons(nuMs) {
  const [kaarten, dag, kandidaten] = await Promise.all([
    alleenLeadlijst(supabaseAdmin.from('opvolging_taken').select('telefoon')).not('telefoon', 'is', null).limit(10000),
    alleenDaglijst(supabaseAdmin.from('opvolging_taken').select('telefoon'))
      .in('status', ['open', 'wacht_inplanning']).not('telefoon', 'is', null).limit(5000),
    leesKandidaten(supabaseAdmin, nuMs),
  ]);
  if (kaarten.error) throw new Error('leadkaarten: ' + kaarten.error.message);
  if (dag.error) throw new Error('daglijst: ' + dag.error.message);
  return [
    ...(kaarten.data || []).map((t) => t.telefoon),
    ...(dag.data || []).map((t) => t.telefoon),
    ...kandidaten.map(telefoonVan).filter(Boolean),
  ];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'opvolging.leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.leads.view)' });
  }

  const b = req.body || {};
  const label = String(b.label || '').trim().slice(0, 60);
  if (!label) return res.status(400).json({ error: 'Geef de lijst een label (bv. "Geannuleerd voorjaar").' });
  if (typeof b.csv !== 'string' || !b.csv.trim()) return res.status(400).json({ error: 'De CSV is leeg.' });
  if (b.csv.length > MAX_CSV) return res.status(400).json({ error: 'De CSV is te groot.' });

  const { rijen, fout } = leesCsv(b.csv);
  if (fout) return res.status(400).json({ error: fout });

  try {
    const nuMs = Date.now();
    const vandaag = dagInZone(nuMs);
    const { count: alVandaag, error: cErr } = await alleenLeadlijst(supabaseAdmin
      .from('opvolging_taken').select('id', { count: 'exact', head: true }))
      .eq('bron', 'import').eq('status', 'open').eq('due', vandaag);
    if (cErr) throw new Error('telling vandaag: ' + cErr.message);

    const vv = maakVoorvertoning({
      rijen, bekendeTelefoons: await bekendeTelefoons(nuMs), vandaag,
      perDag: b.per_dag || STANDAARD_PER_DAG, alVandaag: alVandaag || 0,
    });
    if (b.bevestig !== true) return res.status(200).json({ voorvertoning: true, ...vv });

    const nuIso = new Date(nuMs).toISOString();
    let gemaakt = 0;
    const fouten = [];
    for (const rij of vv.rijen.filter((r) => r.status === 'geldig')) {
      try {
        const { error } = await supabaseAdmin.from('opvolging_taken').insert(importKaart({ rij, label, nuIso }));
        if (error) throw new Error(error.message);
        gemaakt += 1;
      } catch (e) {
        if (fouten.length < 3) console.error('[opvolging-leads-import] rij', rij.regel, e?.message || e);
        fouten.push({ regel: rij.regel, fout: String(e?.message || e).slice(0, 160) });
      }
    }
    if (gemaakt) await brugLeadlijstVerversen();
    return res.status(200).json({ ok: fouten.length === 0, gemaakt, fouten, ...vv });
  } catch (e) {
    console.error('[opvolging-leads-import]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

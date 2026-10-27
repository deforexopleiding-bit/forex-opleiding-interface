// api/opvolging-leads-lijst.js
//
// POST { lijst_id, actie: 'archiveer' | 'terugzetten' } → een APARTE LIJST van
// 'Leads bellen' archiveren of terugzetten.
//
//   archiveer    → status 'gearchiveerd': de chip verdwijnt. De kaarten blijven
//                  ongewijzigd bewaard (historiek) en de lijst staat onder
//                  'Gearchiveerde lijsten', vanwaar hij terug te zetten is.
//   terugzetten  → weer 'actief' (eigen chip), zolang er geen andere actieve
//                  lijst met dezelfde naam is.
//
// Er wordt niets verwijderd en geen kaart aangeraakt.
// Recht: opvolging.leads.view (zoals Lijst opladen).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  TABEL_LIJSTEN, LIJST_STATUS_ACTIEF, LIJST_STATUS_GEARCHIVEERD, isLijstId, naamBezet, leesLijsten, tabelOntbreekt,
} from './_lib/opvolging-leads-lijsten.js';

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
  const id = String(b.lijst_id || '');
  if (!isLijstId(id)) return res.status(400).json({ error: 'Onbekende lijst.' });
  if (b.actie !== 'archiveer' && b.actie !== 'terugzetten') return res.status(400).json({ error: 'Onbekende actie.' });

  try {
    const l = await leesLijsten(supabaseAdmin);
    if (!l.beschikbaar) return res.status(503).json({ error: 'Aparte lijsten zijn nog niet geactiveerd.', code: 'APARTE_LIJSTEN_NIET_ACTIEF' });
    if (l.fout) throw new Error('lijsten lezen: ' + l.fout);
    const lijst = l.lijsten.find((x) => x.id === id);
    if (!lijst) return res.status(404).json({ error: 'Deze lijst bestaat niet (meer).' });

    const nu = new Date().toISOString();
    let patch;
    if (b.actie === 'archiveer') {
      if (lijst.status === LIJST_STATUS_GEARCHIVEERD) return res.status(200).json({ ok: true, lijst });
      patch = { status: LIJST_STATUS_GEARCHIVEERD, gearchiveerd_at: nu, gearchiveerd_door: user.id, updated_at: nu };
    } else {
      if (lijst.status === LIJST_STATUS_ACTIEF) return res.status(200).json({ ok: true, lijst });
      if (naamBezet(l.lijsten, lijst.naam)) {
        return res.status(409).json({ error: 'Er is al een actieve lijst "' + lijst.naam + '". Archiveer die eerst.', code: 'LIJST_NAAM_BEZET' });
      }
      patch = { status: LIJST_STATUS_ACTIEF, gearchiveerd_at: null, gearchiveerd_door: null, updated_at: nu };
    }

    // Voorwaardelijk op de status die we lazen: twee klikken tegelijk doen één ding.
    const { data, error } = await supabaseAdmin.from(TABEL_LIJSTEN)
      .update(patch).eq('id', id).eq('status', lijst.status)
      .select('id, naam, status, created_at, gearchiveerd_at').maybeSingle();
    if (error) {
      if (String(error.code) === '23505') {
        return res.status(409).json({ error: 'Er is al een actieve lijst "' + lijst.naam + '". Archiveer die eerst.', code: 'LIJST_NAAM_BEZET' });
      }
      if (tabelOntbreekt(error)) return res.status(503).json({ error: 'Aparte lijsten zijn nog niet geactiveerd.', code: 'APARTE_LIJSTEN_NIET_ACTIEF' });
      throw new Error(error.message);
    }
    return res.status(200).json({ ok: true, lijst: data || { ...lijst, ...patch } });
  } catch (e) {
    console.error('[opvolging-leads-lijst]', b.actie, e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

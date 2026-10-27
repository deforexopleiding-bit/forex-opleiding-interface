// api/opvolging-leads-import.js
//
// POST { csv, label, per_dag?, bevestig?, modus?, lijst_naam? } → een lijst
// oude leads opladen in 'Leads bellen'.
//
//   modus 'pot' (standaard) → zoals altijd: in de algemene pot, gedoseerd
//                         (per_dag), met `label` als label.
//   modus 'aparte_lijst'    → een NIEUWE aparte lijst met naam `lijst_naam`:
//                         eigen chip, geen dosering (alles meteen zichtbaar),
//                         leads tellen nergens anders mee. Vereist de migratie
//                         2026-10-27-opvolging-aparte-lijsten.sql (anders 503
//                         APARTE_LIJSTEN_NIET_ACTIEF, er wordt niets geschreven).
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
import {
  leesLijsten, lijstNaam, naamBezet, TABEL_LIJSTEN, LIJST_NAAM_MAX, LIJST_STATUS_ACTIEF,
} from './_lib/opvolging-leads-lijsten.js';

const NIET_ACTIEF = {
  error: 'Aparte lijsten zijn nog niet geactiveerd (migratie 2026-10-27-opvolging-aparte-lijsten.sql). Kies "Toevoegen aan algemene pot".',
  code: 'APARTE_LIJSTEN_NIET_ACTIEF',
};

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
  const apart = b.modus === 'aparte_lijst';
  if (b.modus != null && b.modus !== 'pot' && !apart) return res.status(400).json({ error: 'Onbekende keuze.' });
  const naam = apart ? lijstNaam(b.lijst_naam) : null;
  if (apart && !naam) {
    return res.status(400).json({ error: 'Geef de aparte lijst een naam (max ' + LIJST_NAAM_MAX + ' tekens).' });
  }
  const label = apart ? naam : String(b.label || '').trim().slice(0, 60);
  if (!label) return res.status(400).json({ error: 'Geef de lijst een label (bv. "Geannuleerd voorjaar").' });
  if (typeof b.csv !== 'string' || !b.csv.trim()) return res.status(400).json({ error: 'De CSV is leeg.' });
  if (b.csv.length > MAX_CSV) return res.status(400).json({ error: 'De CSV is te groot.' });

  const { rijen, fout } = leesCsv(b.csv);
  if (fout) return res.status(400).json({ error: fout });

  try {
    const nuMs = Date.now();
    const vandaag = dagInZone(nuMs);

    // Aparte lijst: eerst kijken of het kan (tabel + vrije naam), vóór er iets gebeurt.
    if (apart) {
      const l = await leesLijsten(supabaseAdmin);
      if (!l.beschikbaar) return res.status(503).json(NIET_ACTIEF);
      if (l.fout) throw new Error('lijsten lezen: ' + l.fout);
      if (naamBezet(l.lijsten, naam)) {
        return res.status(409).json({ error: 'Er is al een actieve lijst "' + naam + '". Kies een andere naam.', code: 'LIJST_NAAM_BEZET' });
      }
    }

    // De dosering telt alleen de algemene pot: kaarten van een aparte lijst
    // staan allemaal op vandaag en mogen de dagquota niet opeten.
    let alVandaag = 0;
    if (!apart) {
      const { count, error: cErr } = await alleenLeadlijst(supabaseAdmin
        .from('opvolging_taken').select('id', { count: 'exact', head: true }))
        .eq('bron', 'import').eq('status', 'open').eq('due', vandaag)
        .is('bron_ref->>aparte_lijst_id', null);
      if (cErr) throw new Error('telling vandaag: ' + cErr.message);
      alVandaag = count || 0;
    }

    const vv = maakVoorvertoning({
      rijen, bekendeTelefoons: await bekendeTelefoons(nuMs), vandaag,
      perDag: b.per_dag || STANDAARD_PER_DAG, alVandaag, dosering: !apart,
    });
    if (b.bevestig !== true) return res.status(200).json({ voorvertoning: true, modus: apart ? 'aparte_lijst' : 'pot', lijst_naam: naam, ...vv });

    const nuIso = new Date(nuMs).toISOString();
    const geldige = vv.rijen.filter((r) => r.status === 'geldig');

    let aparteLijst = null;
    if (apart) {
      if (!geldige.length) return res.status(200).json({ ok: true, gemaakt: 0, fouten: [], ...vv });
      const { data: nieuw, error: lErr } = await supabaseAdmin.from(TABEL_LIJSTEN)
        .insert({ naam, status: LIJST_STATUS_ACTIEF, aangemaakt_door: user.id })
        .select('id, naam').single();
      if (lErr) {
        if (String(lErr.code) === '23505') {
          return res.status(409).json({ error: 'Er is al een actieve lijst "' + naam + '". Kies een andere naam.', code: 'LIJST_NAAM_BEZET' });
        }
        throw new Error('lijst aanmaken: ' + lErr.message);
      }
      aparteLijst = nieuw;
    }

    let gemaakt = 0;
    const fouten = [];
    for (const rij of geldige) {
      try {
        const { error } = await supabaseAdmin.from('opvolging_taken').insert(importKaart({ rij, label, nuIso, aparteLijst }));
        if (error) throw new Error(error.message);
        gemaakt += 1;
      } catch (e) {
        if (fouten.length < 3) console.error('[opvolging-leads-import] rij', rij.regel, e?.message || e);
        fouten.push({ regel: rij.regel, fout: String(e?.message || e).slice(0, 160) });
      }
    }
    // Geen enkele kaart gelukt: de net gemaakte (lege) lijst weer weg, anders
    // staat er een lege chip.
    if (aparteLijst && !gemaakt) {
      const { error: dErr } = await supabaseAdmin.from(TABEL_LIJSTEN).delete().eq('id', aparteLijst.id);
      if (dErr) console.error('[opvolging-leads-import] lege lijst opruimen', dErr.message);
      aparteLijst = null;
    }
    if (gemaakt) await brugLeadlijstVerversen();
    return res.status(200).json({ ok: fouten.length === 0, gemaakt, fouten, lijst: aparteLijst, ...vv });
  } catch (e) {
    console.error('[opvolging-leads-import]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

// api/opvolging-leads-import.js
//
// POST { csv, label, per_dag?, bevestig?, modus?, lijst_naam? } → een lijst
// oude leads opladen in 'Leads bellen'.
//
//   modus 'pot' (standaard) → zoals altijd: in de algemene pot, gedoseerd
//                         (per_dag), met `label` als label.
//   modus 'aparte_lijst'    → een NIEUWE aparte lijst met naam `lijst_naam`:
//                         eigen chip, geen dosering (alles meteen zichtbaar),
//                         leads tellen nergens anders mee. Wie al als OPEN
//                         kaart in de algemene pot staat, VERHUIST (zelfde
//                         kaart, alleen bron_ref.aparte_lijst_id erbij); de rest
//                         is nieuw of overgeslagen met reden. Vereist de migratie
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
import {
  leesCsv, maakVoorvertoning, importKaart, STANDAARD_PER_DAG, maakAparteVoorvertoning, verhuisdeBronRef,
} from './_lib/opvolging-leads-import.js';
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

/** Voor een aparte lijst: de kaarten zelf (om te kunnen verhuizen), niet enkel de nummers. */
async function bestaandeKaarten(nuMs) {
  const [kaarten, dag, kandidaten] = await Promise.all([
    alleenLeadlijst(supabaseAdmin.from('opvolging_taken')
      .select('id, telefoon, status, lead_id, bron_ref, naam, badge_label')).limit(10000),
    alleenDaglijst(supabaseAdmin.from('opvolging_taken').select('telefoon'))
      .in('status', ['open', 'wacht_inplanning']).not('telefoon', 'is', null).limit(5000),
    leesKandidaten(supabaseAdmin, nuMs),
  ]);
  if (kaarten.error) throw new Error('leadkaarten: ' + kaarten.error.message);
  if (dag.error) throw new Error('daglijst: ' + dag.error.message);
  return { kaarten: kaarten.data || [], daglijstTelefoons: (dag.data || []).map((t) => t.telefoon), kandidaten };
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
      const actieveLijstIds = l.lijsten.filter((x) => x.status === LIJST_STATUS_ACTIEF).map((x) => x.id);
      return await aparteLijstOpladen({ res, b, rijen, naam, user, nuMs, vandaag, actieveLijstIds });
    }

    // Vanaf hier de ALGEMENE POT, zoals altijd.
    // De dosering telt alleen de algemene pot: kaarten van een aparte lijst
    // staan allemaal op vandaag en mogen de dagquota niet opeten.
    const { count: alVandaag, error: cErr } = await alleenLeadlijst(supabaseAdmin
      .from('opvolging_taken').select('id', { count: 'exact', head: true }))
      .eq('bron', 'import').eq('status', 'open').eq('due', vandaag)
      .is('bron_ref->>aparte_lijst_id', null);
    if (cErr) throw new Error('telling vandaag: ' + cErr.message);

    const vv = maakVoorvertoning({
      rijen, bekendeTelefoons: await bekendeTelefoons(nuMs), vandaag,
      perDag: b.per_dag || STANDAARD_PER_DAG, alVandaag: alVandaag || 0,
    });
    if (b.bevestig !== true) return res.status(200).json({ voorvertoning: true, modus: 'pot', ...vv });

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

/**
 * Een NIEUWE APARTE LIJST: voorvertoning (nieuw / verhuisd / overgeslagen) en
 * bij bevestigen de lijst, de nieuwe kaarten en het verhuizen.
 *
 * Verhuizen = dezelfde kaart houden: enkel bron_ref krijgt de lijst erbij
 * (de bestaande sleutels blijven). Voorwaardelijk op 'nog open, lijst leads,
 * nog in geen aparte lijst', zodat een kaart die intussen veranderde niet
 * stil meeverhuist.
 */
async function aparteLijstOpladen({ res, b, rijen, naam, user, nuMs, vandaag, actieveLijstIds }) {
  const bestaand = await bestaandeKaarten(nuMs);
  const vv = maakAparteVoorvertoning({ rijen, ...bestaand, actieveLijstIds, vandaag });
  if (b.bevestig !== true) return res.status(200).json({ voorvertoning: true, modus: 'aparte_lijst', lijst_naam: naam, ...vv });

  const nieuwe = vv.rijen.filter((r) => r.status === 'geldig');
  const verhuizen = vv.rijen.filter((r) => r.status === 'verhuis');
  if (!nieuwe.length && !verhuizen.length) return res.status(200).json({ ok: true, gemaakt: 0, verhuisd: 0, fouten: [], lijst: null, ...vv });

  const { data: lijst, error: lErr } = await supabaseAdmin.from(TABEL_LIJSTEN)
    .insert({ naam, status: LIJST_STATUS_ACTIEF, aangemaakt_door: user.id })
    .select('id, naam').single();
  if (lErr) {
    if (String(lErr.code) === '23505') {
      return res.status(409).json({ error: 'Er is al een actieve lijst "' + naam + '". Kies een andere naam.', code: 'LIJST_NAAM_BEZET' });
    }
    throw new Error('lijst aanmaken: ' + lErr.message);
  }

  const nuIso = new Date(nuMs).toISOString();
  const refPerKaart = new Map(bestaand.kaarten.map((k) => [k.id, k.bron_ref]));
  let gemaakt = 0, verhuisd = 0;
  const fouten = [];
  const fout = (regel, e) => {
    if (fouten.length < 3) console.error('[opvolging-leads-import] aparte lijst rij', regel, e?.message || e);
    fouten.push({ regel, fout: String(e?.message || e).slice(0, 160) });
  };

  for (const rij of nieuwe) {
    try {
      const { error } = await supabaseAdmin.from('opvolging_taken').insert(importKaart({ rij, label: naam, nuIso, aparteLijst: lijst }));
      if (error) throw new Error(error.message);
      gemaakt += 1;
    } catch (e) { fout(rij.regel, e); }
  }
  for (const rij of verhuizen) {
    for (const id of rij.verhuis_ids || []) {
      try {
        const { data, error } = await alleenLeadlijst(supabaseAdmin.from('opvolging_taken')
          .update({ bron_ref: verhuisdeBronRef(refPerKaart.get(id), lijst, nuIso) }))
          .eq('id', id).eq('status', 'open').is('bron_ref->>aparte_lijst_id', null)
          .select('id');
        if (error) throw new Error(error.message);
        if (!data || !data.length) throw new Error('de kaart veranderde intussen (niet meer open of al in een lijst)');
        verhuisd += 1;
      } catch (e) { fout(rij.regel, e); }
    }
  }

  // Niets gelukt: de net gemaakte (lege) lijst weer weg, anders staat er een lege chip.
  let uitLijst = lijst;
  if (!gemaakt && !verhuisd) {
    const { error: dErr } = await supabaseAdmin.from(TABEL_LIJSTEN).delete().eq('id', lijst.id);
    if (dErr) console.error('[opvolging-leads-import] lege lijst opruimen', dErr.message);
    uitLijst = null;
  }
  if (gemaakt) await brugLeadlijstVerversen();
  return res.status(200).json({ ok: fouten.length === 0, gemaakt, verhuisd, fouten, lijst: uitLijst, ...vv });
}

// api/opvolging-weekbalk.js
//
// GET → de getallen onder de weekbalk van de module Opvolging, en wat achter
// die getallen zit.
//
// Nieuw endpoint. Puur additief: het raakt geen bestaande route aan en leest
// uitsluitend uit opvolging_taken en opvolging_pogingen.
//
// Drie weergaves, allemaal read-only:
//
//   ?van=YYYY-MM-DD&tot=YYYY-MM-DD   de balk zelf
//   ?view=later&na=YYYY-MM-DD        de taken die verder liggen dan de balk toont
//   ?view=tijdlijn&dag=YYYY-MM-DD    wat er op één dag daadwerkelijk gebeurd is
//
// WAAROM DE BALK TWEE VERSCHILLENDE GETALLEN TOONT
// Een taak die blijft liggen houdt zijn oude `due`. /api/opvolging-taken haalt
// voor vandaag daarom alles op met due <= vandaag: wat over tijd is rolt door
// naar vandaag. Gevolg: 'open op dinsdag' is voor een dinsdag in het verleden
// geen zinnig getal — die taak staat inmiddels onder vandaag.
//
// Vandaar per dag maar één getal, en wel het getal dat klopt met wat je ziet
// als je die dag opent:
//
//   verleden → het aantal geregistreerde acties van die dag (pogingen)
//   vandaag  → open taken met due <= vandaag  (exact de lijst eronder)
//   toekomst → open taken met due = die dag   (exact de lijst eronder)
//
// Het andere getal komt bewust NIET mee als nul. Een nul leest als een meting,
// en dit is er geen: het is een vraag die voor die dag niet te stellen is.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const DAG = /^\d{4}-\d{2}-\d{2}$/;

/** De dag in Amsterdam, niet in UTC. Rond middernacht schelen die een dag. */
function vandaagNL() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Een timestamptz terug naar de kalenderdag in Amsterdam. */
function dagVan(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

const dagPlus = (d, n) => {
  const dt = new Date(d + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

/** Wat er van een taak mee naar buiten gaat. Geen select('*') naar de client. */
const kaal = (t) => ({
  id: t.id, naam: t.naam, telefoon: t.telefoon, reden: t.reden,
  badge_label: t.badge_label, due: t.due, bron: t.bron, notitie: t.notitie,
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  const q = req.query || {};
  const vandaag = vandaagNL();
  const view = String(q.view || 'balk');

  try {
    // ── Wat er verder ligt dan de balk toont ────────────────────────────────
    // Dit is waarvoor de knop bestaat: er stonden dertig aanmeldtaken en er
    // waren er tien te zien. De rest was niet weg, alleen onbereikbaar.
    if (view === 'later') {
      const na = DAG.test(q.na || '') ? q.na : dagPlus(vandaag, 6);
      const { data, error } = await supabaseAdmin
        .from('opvolging_taken')
        .select('id,naam,telefoon,reden,badge_label,due,bron,notitie')
        .eq('status', 'open')
        .gt('due', na)
        .order('due', { ascending: true })
        .limit(500);
      if (error) throw error;
      const taken = data || [];
      // Gegroepeerd per dag, want dat is hoe je ernaar kijkt: 'wanneer komt er
      // weer iets aan'. De client hoeft dan niets te sorteren.
      const perDag = new Map();
      for (const t of taken) {
        if (!perDag.has(t.due)) perDag.set(t.due, []);
        perDag.get(t.due).push(kaal(t));
      }
      return res.status(200).json({
        vandaag, na, aantal: taken.length,
        // Bij 500 zou de lijst afgekapt zijn zonder dat je het ziet. Dat is
        // precies de stilte waar deze knop een antwoord op is.
        afgekapt: taken.length >= 500,
        dagen: [...perDag.entries()].map(([dag, lijst]) => ({ dag, taken: lijst })),
      });
    }

    // ── Wat er op één dag gebeurd is ────────────────────────────────────────
    if (view === 'tijdlijn') {
      if (!DAG.test(q.dag || '')) return res.status(400).json({ error: 'dag moet YYYY-MM-DD zijn' });
      const dag = q.dag;
      // Een halve dag speling aan weerskanten, want de kolom is timestamptz en
      // wij knippen op de Amsterdamse kalenderdag. Het echte filter staat
      // hieronder op dagVan(); dit begrenst alleen wat we ophalen.
      const { data: pog, error: pogErr } = await supabaseAdmin
        .from('opvolging_pogingen')
        .select('id,taak_id,soort,tijdstip,resultaat,automatisch,duur_sec')
        .gte('tijdstip', dagPlus(dag, -1) + 'T00:00:00Z')
        .lt('tijdstip', dagPlus(dag, 2) + 'T00:00:00Z')
        .order('tijdstip', { ascending: true });
      if (pogErr) throw pogErr;
      const opDag = (pog || []).filter((p) => dagVan(p.tijdstip) === dag);

      const ids = [...new Set(opDag.map((p) => p.taak_id))];
      let taken = [];
      if (ids.length) {
        const { data: tk, error: tkErr } = await supabaseAdmin
          .from('opvolging_taken')
          .select('id,naam,telefoon,reden,badge_label,due,bron,notitie,status')
          .in('id', ids);
        if (tkErr) throw tkErr;
        taken = tk || [];
      }
      const perId = new Map(taken.map((t) => [t.id, t]));

      return res.status(200).json({
        dag, vandaag,
        items: opDag.map((p) => {
          const t = perId.get(p.taak_id) || null;
          return {
            id: p.id, soort: p.soort, tijdstip: p.tijdstip, resultaat: p.resultaat,
            automatisch: !!p.automatisch, duur_sec: p.duur_sec,
            taak: t ? { ...kaal(t), status: t.status } : null,
          };
        }),
      });
    }

    // ── De balk ─────────────────────────────────────────────────────────────
    if (!DAG.test(q.van || '') || !DAG.test(q.tot || '')) {
      return res.status(400).json({ error: 'van en tot moeten YYYY-MM-DD zijn' });
    }
    const van = q.van, tot = q.tot;
    if (tot < van) return res.status(400).json({ error: 'tot ligt vóór van' });

    // Alle open taken t/m het einde van de balk. Het verleden zit erbij omdat
    // vandaag alles met due <= vandaag toont — die taken tellen dus mee.
    const { data: open, error: openErr } = await supabaseAdmin
      .from('opvolging_taken').select('id,due')
      .eq('status', 'open').lte('due', tot);
    if (openErr) throw openErr;

    // De acties binnen het venster van de balk, ruim opgehaald en daarna op de
    // Amsterdamse dag gefilterd.
    const { data: pog, error: pogErr } = await supabaseAdmin
      .from('opvolging_pogingen').select('id,tijdstip')
      .gte('tijdstip', dagPlus(van, -1) + 'T00:00:00Z')
      .lt('tijdstip', dagPlus(tot, 2) + 'T00:00:00Z');
    if (pogErr) throw pogErr;

    const actiesPerDag = new Map();
    for (const p of pog || []) {
      const d = dagVan(p.tijdstip);
      if (d) actiesPerDag.set(d, (actiesPerDag.get(d) || 0) + 1);
    }

    const dagen = [];
    for (let d = van; d <= tot; d = dagPlus(d, 1)) {
      if (d < vandaag) {
        // Verleden: alleen wat er gebeurd is. `open` blijft met opzet null —
        // zie de uitleg bovenaan.
        dagen.push({ dag: d, open: null, acties: actiesPerDag.get(d) || 0 });
      } else if (d === vandaag) {
        dagen.push({
          dag: d,
          open: (open || []).filter((t) => t.due <= vandaag).length,
          acties: actiesPerDag.get(d) || 0,
        });
      } else {
        dagen.push({
          dag: d,
          open: (open || []).filter((t) => t.due === d).length,
          acties: actiesPerDag.get(d) || 0,
        });
      }
    }

    // En wat er ná de balk ligt: het getal onder de knop 'Later'.
    const { count: laterCount, error: laterErr } = await supabaseAdmin
      .from('opvolging_taken').select('id', { count: 'exact', head: true })
      .eq('status', 'open').gt('due', tot);
    if (laterErr) throw laterErr;

    return res.status(200).json({
      van, tot, vandaag, dagen,
      later: { aantal: laterCount || 0, na: tot },
    });
  } catch (e) {
    console.error('[opvolging-weekbalk]', view, e?.message || e);
    return res.status(500).json({ error: e.message || 'Onbekende fout' });
  }
}

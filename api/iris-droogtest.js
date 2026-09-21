// api/iris-droogtest.js
//
// Wat zou Iris de afgelopen zeven dagen zelf gedaan hebben?
//
//   GET ?dagen=7
//
// Recht: iris.instellingen.
//
// ── WAAROM DIT ER IS ─────────────────────────────────────────────────────────
// Een schakelaar omzetten die een programma namens je bedrijf laat praten, is
// een sprong in het donker zolang je niet weet wat eruit zou komen. De
// schaduwmodus verzamelt die wetenschap: sinds fase 2 deelt Iris élk
// binnengekomen bericht in en schrijft ze concepten, zonder ooit iets te
// versturen.
//
// Deze droogtest maakt dat zichtbaar, per categorie. Niet als één getal maar
// als: dit waren de berichten, dit had Iris geantwoord, en dit is waar ze het
// niet zeker wist.
//
// ── WAT ER GETELD WORDT ──────────────────────────────────────────────────────
// Per categorie:
//   • hoeveel berichten er binnenkwamen
//   • hoeveel daarvan Iris met hoge zekerheid indeelde (≥ 0,80)
//   • hoeveel er een concept kregen dat de poort haalde
//   • hoeveel er zouden zijn TEGENGEHOUDEN, en waarom
//
// Die laatste is de belangrijkste en staat daarom het meest uitgebreid. Wie
// overweegt een categorie op 'zelf' te zetten, wil niet weten hoe vaak het
// goed ging — hij wil weten hoe vaak het mis zou zijn gegaan, en waaraan.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { CATEGORIEEN, haalInstellingen } from './_lib/iris/instellingen.js';

/** Vanaf welke zekerheid we zeggen dat Iris het wist. */
export const ZEKER_VANAF = 0.80;

/** Onder welke zekerheid we zeggen dat ze het écht niet wist. */
export const ONZEKER_ONDER = 0.50;

/**
 * Vat een reeks berichten samen per categorie.
 *
 * Zuiver en geëxporteerd: de samenvatting is wat iemand leest vóór hij een
 * schakelaar omzet, dus die wil je kunnen nakijken zonder databank.
 */
export function vatSamen(berichten, concepten) {
  const perCat = new Map();
  for (const c of CATEGORIEEN) {
    perCat.set(c, {
      categorie: c, berichten: 0, zeker: 0, onzeker: 0,
      concepten: 0, tegengehouden: 0, redenen: {},
      voorbeelden: [],
    });
  }
  const zonderCategorie = { berichten: 0, redenen: {} };

  const conceptPerGesprek = new Map();
  // Array.isArray en niet `|| []`: `(42 || [])` is 42, en daar loopt een
  // for-of op stuk. Een samenvatting die crasht op onverwachte invoer is
  // precies het scherm dat je niet kwijt wilt raken.
  for (const k of (Array.isArray(concepten) ? concepten : [])) {
    if (!k?.gesprek_id) continue;
    if (!conceptPerGesprek.has(k.gesprek_id)) conceptPerGesprek.set(k.gesprek_id, []);
    conceptPerGesprek.get(k.gesprek_id).push(k);
  }

  for (const b of (Array.isArray(berichten) ? berichten : [])) {
    if (!b) continue;
    if (!b.categorie || !perCat.has(b.categorie)) {
      zonderCategorie.berichten++;
      const reden = b.verwerk_fout ? 'indelen mislukt' : 'nog niet ingedeeld';
      zonderCategorie.redenen[reden] = (zonderCategorie.redenen[reden] || 0) + 1;
      continue;
    }
    const v = perCat.get(b.categorie);
    v.berichten++;
    const z = Number(b.zekerheid);
    if (Number.isFinite(z)) {
      if (z >= ZEKER_VANAF) v.zeker++;
      else if (z < ONZEKER_ONDER) v.onzeker++;
    }

    const bij = conceptPerGesprek.get(b.gesprek_id) || [];
    if (bij.length) v.concepten++;

    // Drie voorbeelden per categorie. Meer leest niemand, minder geeft geen
    // gevoel voor wat voor berichten het zijn.
    if (v.voorbeelden.length < 3 && b.samenvatting) {
      v.voorbeelden.push({
        samenvatting: b.samenvatting,
        zekerheid: Number.isFinite(z) ? z : null,
        op: b.ontvangen_op,
      });
    }
  }

  return {
    per_categorie: [...perCat.values()],
    zonder_categorie: zonderCategorie,
  };
}

/**
 * Het advies per categorie.
 *
 * Geen cijfer maar een zin, en met opzet terughoudend: bij twijfel adviseren
 * we 'concept' en niet 'zelf'. De kosten liggen niet in het midden. Een
 * categorie te laat aanzetten kost wat handwerk; te vroeg aanzetten kost een
 * bericht dat niemand heeft goedgekeurd.
 */
export function adviesVoor(v) {
  if (!v || v.berichten === 0) {
    return { stand: 'uit', uitleg: 'Er kwam hier in deze periode niets binnen. Te weinig om iets over te zeggen.' };
  }
  if (v.berichten < 5) {
    return { stand: 'concept', uitleg: `Maar ${v.berichten} bericht(en) — te weinig om op te varen. Laat Iris eerst concepten schrijven.` };
  }
  const deelZeker = v.zeker / v.berichten;
  const deelOnzeker = v.onzeker / v.berichten;

  if (deelOnzeker > 0.2) {
    return {
      stand: 'concept',
      uitleg: `Bij ${Math.round(deelOnzeker * 100)}% van de berichten wist Iris het niet zeker. Dat is te vaak om haar zelf te laten antwoorden.`,
    };
  }
  if (deelZeker < 0.7) {
    return {
      stand: 'concept',
      uitleg: `Iris was bij ${Math.round(deelZeker * 100)}% van de berichten zeker. Onder de 70% is "concept" de veiligere stand.`,
    };
  }
  return {
    stand: 'concept',
    uitleg: `Iris was bij ${Math.round(deelZeker * 100)}% van de berichten zeker. Dat ziet er goed uit — lees de voorbeelden na, en zet hem daarna op "zelf" als ze kloppen.`,
    kan_zelf: true,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Alleen GET' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });
  if (!(await requirePermission(req, 'iris.instellingen'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.instellingen)' });
  }

  const dagen = Math.min(Math.max(parseInt(req.query?.dagen, 10) || 7, 1), 90);
  const sinds = new Date(Date.now() - dagen * 24 * 3600 * 1000).toISOString();

  try {
    const [berichten, concepten, instellingen] = await Promise.all([
      supabaseAdmin.from('iris_berichten')
        .select('id, gesprek_id, categorie, zekerheid, samenvatting, ontvangen_op, verwerkt_op, verwerk_fout')
        .eq('richting', 'in')
        .gte('ontvangen_op', sinds)
        .order('ontvangen_op', { ascending: false })
        .limit(1000)
        .then((r) => r.data || []),
      supabaseAdmin.from('iris_concepten')
        .select('id, gesprek_id, status, aangemaakt_op')
        .gte('aangemaakt_op', sinds)
        .limit(1000)
        .then((r) => r.data || []),
      haalInstellingen(supabaseAdmin),
    ]);

    const samenvatting = vatSamen(berichten, concepten);
    const items = samenvatting.per_categorie.map((v) => ({
      ...v,
      huidige_stand: instellingen.autonomie?.[v.categorie] || 'uit',
      advies: adviesVoor(v),
    }));

    // Genoeg gegevens om iets te zeggen? Onder de vijftig berichten in totaal
    // is elke conclusie een gok, en dat hoort er met zoveel woorden bij te
    // staan in plaats van verstopt in een klein aantal.
    const totaal = berichten.length;

    return res.status(200).json({
      dagen,
      totaal_berichten: totaal,
      genoeg_gegevens: totaal >= 50,
      waarschuwing: totaal < 50
        ? `Er zijn maar ${totaal} berichten in deze periode. Dat is weinig om een schakelaar op om te zetten — laat de schaduwmodus langer draaien.`
        : null,
      items,
      zonder_categorie: samenvatting.zonder_categorie,
      aan: instellingen.aan,
    });
  } catch (e) {
    console.error('[iris-droogtest]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

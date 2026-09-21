// api/iris-instellingen.js
//
// De schakelaars van Iris lezen en zetten.
//
//   GET   → { instellingen, ruw, aan, gelezen }
//   POST  → { sleutel, waarde }  zet één instelling
//
// Rechten: lezen met iris.view, schrijven met iris.instellingen. Die twee zijn
// met opzet niet dezelfde sleutel: Dave mag zien hoe Iris ingesteld staat, maar
// alleen Maxim zet de autonomie om. Wie namens het bedrijf mag gaan praten is
// een beslissing van één persoon.
//
// De hoofdschakelaar IRIS_AAN is GEEN instelling. Die staat in de omgeving en
// is hier alleen af te lezen, nooit te zetten. Reden: een schakelaar die alles
// stillegt hoort buiten het systeem te staan dat hij stillegt. Staat Iris op
// hol, dan is een omgevingsvariabele omzetten en opnieuw uitrollen een weg die
// niet afhangt van of de databank en de rechten meewerken.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  CATEGORIEEN,
  STANDEN,
  NOOIT_ZELF,
  haalInstellingen,
  normaliseerAutonomie,
  irisAan,
} from './_lib/iris/instellingen.js';

/** Welke sleutels er mogen bestaan. Een onbekende sleutel is een typefout. */
const TOEGESTANE_SLEUTELS = new Set([
  'autonomie',
  'escalatie',
  'stille_uren',
  'dosering',
  'mailboxen',
  'model',
  'ongedaan_seconden',
]);

const UUR_RX = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Kijk een waarde na vóór ze de databank in gaat.
 *
 * Een instelling die niemand nakijkt, is een instelling die ooit 'ZELF ' met
 * een spatie bevat en dan stil als 'uit' gelezen wordt — terwijl degene die
 * hem zette denkt dat het aan staat. Dat is de ergste soort fout: niet luid,
 * maar verkeerd om.
 *
 * @returns {{ok: true, waarde: any} | {ok: false, fout: string}}
 */
export function keurWaardeGoed(sleutel, waarde) {
  switch (sleutel) {
    case 'autonomie': {
      if (!waarde || typeof waarde !== 'object' || Array.isArray(waarde)) {
        return { ok: false, fout: 'autonomie moet een object zijn met een stand per categorie' };
      }
      const schoon = {};
      for (const [cat, stand] of Object.entries(waarde)) {
        if (!CATEGORIEEN.includes(cat)) {
          return { ok: false, fout: `onbekende categorie: ${cat}` };
        }
        const s = String(stand ?? '').trim().toLowerCase();
        if (!STANDEN.includes(s)) {
          return { ok: false, fout: `onbekende stand voor ${cat}: ${stand}. Kies uit ${STANDEN.join(' / ')}.` };
        }
        if (s === 'zelf' && NOOIT_ZELF.includes(cat)) {
          return {
            ok: false,
            fout: `${cat} kan niet op zelf. Klachten, opzeggingen en alles wat juridisch kan worden gaan altijd langs een mens.`,
          };
        }
        schoon[cat] = s;
      }
      return { ok: true, waarde: schoon };
    }

    case 'escalatie': {
      const p = Number(waarde?.pogingen);
      const d = Number(waarde?.dagen);
      if (!Number.isInteger(p) || p < 1 || p > 10) return { ok: false, fout: 'pogingen moet tussen 1 en 10 liggen' };
      if (!Number.isInteger(d) || d < 1 || d > 30) return { ok: false, fout: 'dagen moet tussen 1 en 30 liggen' };
      if (d > p) return { ok: false, fout: 'dagen kan niet groter zijn dan pogingen — je kunt niet op meer dagen proberen dan je pogingen hebt' };
      return { ok: true, waarde: { pogingen: p, dagen: d } };
    }

    case 'stille_uren': {
      const van = String(waarde?.van ?? '');
      const tot = String(waarde?.tot ?? '');
      if (!UUR_RX.test(van)) return { ok: false, fout: 'van moet uu:mm zijn, bijvoorbeeld 21:00' };
      if (!UUR_RX.test(tot)) return { ok: false, fout: 'tot moet uu:mm zijn, bijvoorbeeld 08:00' };
      return {
        ok: true,
        waarde: {
          van,
          tot,
          zondag_stil: waarde?.zondag_stil !== false,
          tijdzone: String(waarde?.tijdzone || 'Europe/Brussels'),
        },
      };
    }

    case 'dosering': {
      const m = Number(waarde?.max_per_minuut);
      const u = Number(waarde?.max_per_uur);
      const pp = Number(waarde?.max_per_dag_per_persoon);
      if (!Number.isInteger(m) || m < 1 || m > 60)  return { ok: false, fout: 'max_per_minuut moet tussen 1 en 60 liggen' };
      if (!Number.isInteger(u) || u < 1 || u > 600) return { ok: false, fout: 'max_per_uur moet tussen 1 en 600 liggen' };
      if (!Number.isInteger(pp) || pp < 1 || pp > 10) return { ok: false, fout: 'max_per_dag_per_persoon moet tussen 1 en 10 liggen' };
      if (u < m) return { ok: false, fout: 'max_per_uur kan niet kleiner zijn dan max_per_minuut' };
      return { ok: true, waarde: { max_per_minuut: m, max_per_uur: u, max_per_dag_per_persoon: pp } };
    }

    case 'mailboxen': {
      if (!Array.isArray(waarde?.lezen) || waarde.lezen.length === 0) {
        return { ok: false, fout: 'lezen moet een niet-lege lijst mailboxnamen zijn' };
      }
      const perCat = waarde.afzender_per_categorie;
      if (perCat && typeof perCat === 'object' && !Array.isArray(perCat)) {
        for (const cat of Object.keys(perCat)) {
          if (!CATEGORIEEN.includes(cat)) return { ok: false, fout: `onbekende categorie in afzender_per_categorie: ${cat}` };
        }
      }
      return {
        ok: true,
        waarde: {
          lezen: waarde.lezen.map((x) => String(x).trim()).filter(Boolean),
          afzender_per_categorie: (perCat && typeof perCat === 'object' && !Array.isArray(perCat)) ? perCat : {},
          standaard: String(waarde.standaard || 'administratie@deforexopleiding.nl'),
        },
      };
    }

    case 'model': {
      const r = String(waarde?.redeneren || '').trim();
      const t = String(waarde?.transcriptie || '').trim();
      if (!r) return { ok: false, fout: 'redeneren mag niet leeg zijn' };
      if (!t) return { ok: false, fout: 'transcriptie mag niet leeg zijn' };
      const temp = Number(waarde?.temperatuur ?? 0.3);
      if (!Number.isFinite(temp) || temp < 0 || temp > 1) return { ok: false, fout: 'temperatuur moet tussen 0 en 1 liggen' };
      return { ok: true, waarde: { redeneren: r, transcriptie: t, temperatuur: temp } };
    }

    case 'ongedaan_seconden': {
      const n = Number(waarde);
      if (!Number.isInteger(n) || n < 5 || n > 300) {
        return { ok: false, fout: 'ongedaan_seconden moet tussen 5 en 300 liggen. Korter dan 5 is een knop die niet waarmaakt wat hij belooft.' };
      }
      return { ok: true, waarde: n };
    }

    default:
      return { ok: false, fout: `onbekende sleutel: ${sleutel}` };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });

  if (req.method === 'GET') {
    if (!(await requirePermission(req, 'iris.view'))) {
      return res.status(403).json({ error: 'Geen rechten (iris.view)' });
    }
    const inst = await haalInstellingen(supabaseAdmin);

    // Ook de ruwe rijen terug, zodat het scherm het verschil kan tonen tussen
    // "staat zo ingesteld" en "valt terug op de standaard".
    let ruw = [];
    try {
      const { data } = await supabaseAdmin
        .from('iris_instellingen')
        .select('sleutel, waarde, omschrijving, bijgewerkt_op, bijgewerkt_door')
        .order('sleutel');
      ruw = data || [];
    } catch (e) {
      console.warn('[iris-instellingen] ruwe rijen niet gelezen:', e?.message || e);
    }

    return res.status(200).json({
      instellingen: inst,
      ruw,
      aan: irisAan(),
      gelezen: inst.gelezen,
      categorieen: CATEGORIEEN,
      standen: STANDEN,
      nooit_zelf: NOOIT_ZELF,
    });
  }

  if (req.method === 'POST') {
    if (!(await requirePermission(req, 'iris.instellingen'))) {
      return res.status(403).json({ error: 'Geen rechten (iris.instellingen)' });
    }

    const sleutel = String(req.body?.sleutel || '').trim();
    if (!TOEGESTANE_SLEUTELS.has(sleutel)) {
      return res.status(400).json({ error: `onbekende sleutel: ${sleutel || '(leeg)'}` });
    }

    const keuring = keurWaardeGoed(sleutel, req.body?.waarde);
    if (!keuring.ok) return res.status(400).json({ error: keuring.fout });

    try {
      const { error } = await supabaseAdmin
        .from('iris_instellingen')
        .upsert(
          {
            sleutel,
            waarde: keuring.waarde,
            bijgewerkt_op: new Date().toISOString(),
            bijgewerkt_door: user.id,
          },
          { onConflict: 'sleutel' }
        );
      if (error) throw new Error(error.message);

      // In het logboek staat WELKE schakelaar omging en door wie, niet de
      // inhoud. Een autonomie-object is klein genoeg om mee te geven; bij de
      // andere sleutels houden we het bij de naam.
      const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
        wie: user.id,
        wat: `instelling gewijzigd: ${sleutel}`,
        resultaat: 'ok',
        details: sleutel === 'autonomie' ? { autonomie: keuring.waarde } : { sleutel },
      });
      if (logFout) console.warn('[iris-instellingen] logregel mislukt:', logFout.message);

      const inst = await haalInstellingen(supabaseAdmin);
      return res.status(200).json({ ok: true, sleutel, waarde: keuring.waarde, instellingen: inst });
    } catch (e) {
      console.error('[iris-instellingen] opslaan mislukt:', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Opslaan mislukt' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Alleen GET en POST' });
}

export { normaliseerAutonomie, TOEGESTANE_SLEUTELS };

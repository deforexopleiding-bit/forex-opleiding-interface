// api/opvolging-taken.js
//
// GET → de takenlijst van de module Opvolging voor één dag, plus de leads die
// op eigen initiatief zouden inplannen (status wacht_inplanning).
//
// Leest uit opvolging_taken, opvolging_pogingen EN opvolging_wa_berichten.
// Die derde kwam er op 11 september bij, en dat is geen uitbreiding maar een
// reparatie: een bericht dat verstuurd werd vóórdat de kaart bestond heeft geen
// rij in opvolging_pogingen — de webhook maakt die alleen als er op dat moment
// al een taak is. Rony Van Hecke en Redouane Jerroudi kregen daardoor een kaart
// die in zijn eigen tekst het spraakbericht van 07:16 noemde en er in dezelfde
// adem '🎤 geen spraakbericht' bij zette. Zie de kop van _lib/opvolging-call-wa.js.
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
import { telPogingen } from './_lib/opvolging-poging-telling.js';
import { haalWaRegelsVanaf, volledigeHistorie } from './_lib/opvolging-call-wa.js';

const isoDag = (d) => new Date(d).toISOString().slice(0, 10);

// ── HOE VER TERUG KIJKEN WE VOOR LOSSE BERICHTEN? ───────────────────────
// Kaarten leven kort: de nachtelijke doorrol schuift ze door en wat afgehandeld
// is verdwijnt naar Afgerond. Zestig dagen dekt dus ruim de hele levensloop van
// elke kaart die nog op een lijst staat, en houdt de lezing begrensd.
const WA_TERUG_DAGEN = 60;
const waVanaf = () => new Date(Date.now() - WA_TERUG_DAGEN * 86400000).toISOString();

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
      // Ook hier, en juist hier: Afgerond is het bewijsscherm. Een kaart die
      // daar met 'te weinig moeite' staat terwijl er 's ochtends een
      // spraakbericht ging is een verwijt op grond van een halve meting.
      const archWa = await leesWaRegels();
      return res.status(200).json({
        vandaag,
        ...(archWa.melding ? { wa_melding: archWa.melding } : {}),
        archief: (arch || []).map((t) => {
          // Eén plek waar 'wat telt als moeite' staat — zie
          // _lib/opvolging-poging-telling.js. Een antwoord van de lead telt
          // niet mee: dat is het resultaat van de moeite, niet de moeite zelf.
          const hist = volledigeHistorie(perArch.get(t.id) || [], archWa.regels, t);
          return { ...t, ...telPogingen(hist, vandaag, isoDag) };
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

    // De tweede bron, één keer voor het hele scherm. volledigeHistorie() voegt
    // per kaart de losse regels van dát nummer toe; wat al een taak_id draagt
    // blijft eruit, want daar staat de poging al. Dubbel tellen kan dus niet.
    const wa = await leesWaRegels();
    const verrijk = (t) => ({
      ...t,
      ...telPogingen(volledigeHistorie(perTaak.get(t.id) || [], wa.regels, t), vandaag, isoDag),
    });

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
      // Waarom een telling mogelijk te laag is. Zwijgen zou een halve meting
      // als hele laten lezen — precies de fout die deze PR repareert.
      ...(wa.melding ? { wa_melding: wa.melding } : {}),
      taken: (taken || []).map(verrijk),
      wacht: (wacht || []).map(verrijk),
      ingepland,
    });
  } catch (e) {
    console.error('[opvolging-taken]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

/**
 * De losse gespreksregels, met een melding als de lezing niet compleet is.
 *
 * Fail-soft: valt deze tabel weg, dan blijft de lijst werken op alleen de
 * pogingen — de stand van vóór deze reparatie. Maar nooit stil: dan staat er
 * bij waarom een telling te laag kan zijn.
 */
async function leesWaRegels() {
  const r = await haalWaRegelsVanaf(supabaseAdmin, waVanaf());
  let melding = null;
  if (r.fout) {
    melding = 'De WhatsApp-berichten waren niet te lezen (' + String(r.fout).slice(0, 120)
      + '). Berichten van vóór het ontstaan van een kaart tellen nu niet mee.';
  } else if (r.afgekapt) {
    melding = 'Er zijn meer WhatsApp-berichten dan in één lezing passen; de oudste tellen mogelijk niet mee.';
  }
  return { regels: r.regels, melding };
}

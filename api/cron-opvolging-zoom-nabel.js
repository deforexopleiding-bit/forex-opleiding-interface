// api/cron-opvolging-zoom-nabel.js
//
// DE INSTROOM VAN 12:00 — wie kreeg een spraakbericht en reageerde niet?
//
// De afspraak: elke lead met een zoomcall krijgt vóór 09:00 een ingesproken
// bericht. Wie daar niet op reageert wordt tussen 12 en 13 uur gebeld. Dat
// nabellen stond nergens als taak; het was een venster in een rapport en verder
// een kwestie van eraan denken. Deze cron maakt er een kaart van.
//
// ── ALLEEN ALS DE METING WERKT ───────────────────────────────────────────
// Dit is de regel die de hele cron bepaalt. GEEN REACTIE IS IETS ANDERS DAN
// NIET GEMETEN. Ziet de brug geen uitgaande berichten, of valt de dag buiten
// het bereik van de leadlijst, dan weten we niet of er een spraakbericht ging
// en al helemaal niet of er geantwoord is. Kaarten maken op zo'n dag zou Dave
// laten bellen naar mensen die vanochtend gewoon geantwoord hebben.
//
// Dus: eerst vaststellen dat de meting werkt. Zo niet, dan GEEN kaarten, een
// logregel en `{ gemeten: false, reden }` in het antwoord.
//
// ── HET TIJDVENSTER, EN WAAROM HET IN AMSTERDAM GEREKEND WORDT ───────────
// Vercel draait crons in UTC. Een schema dat 's zomers om 12:00 Amsterdamse
// tijd valt, valt 's winters om 11:00 — precies een uur vóór het venster. Het
// schema staat daarom op twee UTC-uren (`0 10,11 * * *`) en de cron handelt
// alleen als het in Amsterdam tussen 12:00 en 21:00 is. Zomer én winter raakt
// er zo precies één run binnen het venster, en twee runs zijn idempotent.
//
// ── WAT HET NIET DOET ────────────────────────────────────────────────────
// Geen belpogingen registreren, geen uitkomsten schrijven, niets naar GHL.
// Alleen kaarten aanmaken langs hetzelfde pad als api/opvolging-taak-create.js,
// zodat er maar één plek is waar een opvolgtaak ontstaat.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth), zelfde patroon als
// de andere opvolging-crons. GET (Vercel cron) + POST (debug).
//
// Schrijft uitsluitend in opvolging_taken.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { brugConfig, brugFetch } from './_lib/whatsapp-brug-client.js';
import { leadlijstDektDag } from './_lib/opvolging-leadlijst-venster.js';
import { haalWaRegels, regelsVoorNummer } from './_lib/opvolging-call-wa.js';
import { inZone } from './_lib/opvolging-vensters.js';

const ZONE = 'Europe/Amsterdam';

// Het venster waarin deze cron mag handelen, in Amsterdamse tijd. Van 12:00
// (het nabelvenster gaat dan open) tot 21:00 (daarna is de dag voorbij en zou
// een verse kaart alleen nog morgen om aandacht vragen).
export const VENSTER_VAN_UUR = 12;
export const VENSTER_TOT_UUR = 21;

// De statussen waarbij er al werk op de lijst staat voor deze lead, en er dus
// geen tweede kaart bij hoeft.
//
// SMALLER DAN LOPEND IN DE WEBHOOK, en dat is bewust. Die lijst draagt ook
// 'ingepland', want een bericht van een lead met een geboekte afspraak hoort
// wél bij die kaart. Maar 'ingepland' is precies de toestand van iedere lead
// die deze cron bekijkt — ze hebben allemaal een zoomcall vandaag. Zou die
// status hier meetellen, dan zou de cron nooit één kaart maken.
const LOPEND = ['open', 'wacht_inplanning'];

/** De twee redenen, en het verschil ertussen is de reden dat het er twee zijn. */
export const REDEN_GEEN_REACTIE     = 'zoom_geen_reactie';
export const REDEN_GEEN_SPRAAK      = 'zoom_geen_spraakbericht';

const dagInZone = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

/**
 * Mag deze cron nu handelen?
 *
 * Pure functie met de klok als argument, zodat de zomer/winter-grens in een
 * test staat en niet alleen in productie blijkt.
 */
export function magHandelen(nuMs) {
  const z = inZone(nuMs);
  if (!z) return { mag: false, reden: 'de tijd is niet te bepalen' };
  const uur = Math.floor(z.minuut / 60);
  if (uur < VENSTER_VAN_UUR || uur >= VENSTER_TOT_UUR) {
    return { mag: false, reden: `het is ${z.tijd} in Amsterdam, buiten ${VENSTER_VAN_UUR}:00–${VENSTER_TOT_UUR}:00` };
  }
  return { mag: true, reden: null };
}

/**
 * Welke reden hoort bij deze lead?
 *
 * Twee gevallen, en ze zijn niet hetzelfde werk:
 *   · er ging een spraakbericht en er kwam geen antwoord — gewoon nabellen;
 *   · er ging er geen — dan is er nog helemaal geen contact geweest, en dat is
 *     een groter gat dan een onbeantwoord bericht.
 *
 * Een inkomend bericht van vandaag betekent: niets doen. De lead heeft
 * gereageerd, en dan is een belkaart precies de dubbeling die Dave niet wil.
 *
 * @returns {{kaart:boolean, reden_code:?string, spraak_tijd:?string}}
 */
export function bepaalKaart(waPogingen, dag) {
  const lijst = Array.isArray(waPogingen) ? waPogingen : [];
  const vanDieDag = lijst
    .map((p) => ({ p, z: inZone(p && p.tijdstip) }))
    .filter((x) => x.z && x.z.dag === dag);

  const geantwoord = vanDieDag.some((x) => x.p.richting === 'in');
  if (geantwoord) return { kaart: false, reden_code: null, spraak_tijd: null };

  const spraak = vanDieDag
    .filter((x) => x.p.soort === 'spraakbericht' && x.p.richting !== 'in')
    .sort((a, b) => a.z.minuut - b.z.minuut)[0];

  return spraak
    ? { kaart: true, reden_code: REDEN_GEEN_REACTIE, spraak_tijd: spraak.z.tijd }
    : { kaart: true, reden_code: REDEN_GEEN_SPRAAK, spraak_tijd: null };
}

/** De notitie op de kaart. Vertelt wat er wél en niet gebeurd is. */
export function bouwNotitie({ callTijd, reden_code, spraak_tijd }) {
  const kop = `Zoomcall vandaag om ${callTijd}`;
  return reden_code === REDEN_GEEN_REACTIE
    ? `${kop} — geen reactie op het spraakbericht van ${spraak_tijd}.`
    : `${kop} — er ging geen spraakbericht uit.`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const startedAt = Date.now();
  const vandaag = dagInZone(startedAt);

  // ── Het tijdvenster ────────────────────────────────────────────────────
  const venster = magHandelen(startedAt);
  if (!venster.mag) {
    console.log('[cron-opvolging-zoom-nabel] overgeslagen: ' + venster.reden);
    return res.status(200).json({ ok: true, gehandeld: false, reden: venster.reden, dag: vandaag });
  }

  // ── Werkt de meting? ───────────────────────────────────────────────────
  const meting = await meetbaar(vandaag);
  if (!meting.gemeten) {
    // Luid, want dit is de hele reden dat deze cron bestaat. Stil overslaan
    // zou niet te onderscheiden zijn van 'er was niets te doen'.
    console.warn('[cron-opvolging-zoom-nabel] NIET GEMETEN: ' + meting.reden + ' — geen kaarten aangemaakt');
    return res.status(200).json({ ok: true, gemeten: false, reden: meting.reden, dag: vandaag });
  }

  const summary = {
    dag: vandaag, gemeten: true,
    calls: 0, overgeslagen_antwoord: 0, overgeslagen_bestaat_al: 0,
    aangemaakt: 0, per_reden: {}, errors: [], duration_ms: 0,
  };

  try {
    // ── De calls van vandaag die nog moeten komen ────────────────────────
    // `scheduled_at > nu`: wie zijn call al gehad heeft valt onder de
    // no-show-flow en niet onder deze. Een kaart maken voor een call die net
    // is geweest zou Dave laten bellen over iets wat hij zojuist zelf deed.
    const nuIso = new Date(startedAt).toISOString();
    const eindDagIso = new Date(Date.parse(vandaag + 'T00:00:00Z') + 34 * 3600 * 1000).toISOString();
    const afspraken = await leesAfspraken(nuIso, eindDagIso, vandaag);
    summary.calls = afspraken.length;
    if (afspraken.length === 0) {
      summary.duration_ms = Date.now() - startedAt;
      console.log('[cron-opvolging-zoom-nabel] klaar', JSON.stringify(summary));
      return res.status(200).json({ ok: true, summary });
    }

    // ── De WhatsApp-berichten van vandaag ────────────────────────────────
    const dagVanIso = new Date(Date.parse(vandaag + 'T00:00:00Z') - 3 * 3600 * 1000).toISOString();
    const { regels, fout } = await haalWaRegels(supabaseAdmin, dagVanIso, eindDagIso);
    if (fout) {
      // Zonder de berichten is er niets gemeten, en dan geldt de regel
      // bovenaan dit bestand: geen kaarten.
      console.warn('[cron-opvolging-zoom-nabel] NIET GEMETEN: berichten lezen mislukte — geen kaarten');
      return res.status(200).json({ ok: true, gemeten: false, reden: 'de WhatsApp-berichten waren niet te lezen', dag: vandaag });
    }

    const bestaandeTaken = await leesLopendeTaken();

    for (const a of afspraken) {
      try {
        const z = inZone(a.scheduled_at);
        const waPog = regelsVoorNummer(regels, a.lead_phone)
          .map((r) => ({
            soort   : SPRAAK.has(String(r.media_type || '').toLowerCase()) ? 'spraakbericht' : 'whatsapp',
            richting: r.richting === 'in' ? 'in' : 'uit',
            tijdstip: r.tijdstip,
          }));

        const besluit = bepaalKaart(waPog, vandaag);
        if (!besluit.kaart) { summary.overgeslagen_antwoord += 1; continue; }
        if (heeftAlKaart(bestaandeTaken, a)) { summary.overgeslagen_bestaat_al += 1; continue; }

        await maakKaart({
          afspraak: a, vandaag, callTijd: (z && z.tijd) || '',
          reden_code: besluit.reden_code, spraak_tijd: besluit.spraak_tijd,
        });

        // Meteen bij de lijst, zodat twee calls voor dezelfde lead op één dag
        // niet twee kaarten opleveren binnen dezelfde run.
        bestaandeTaken.push({ telefoon: a.lead_phone, bron_ref: { appointment_id: a.id } });
        summary.aangemaakt += 1;
        summary.per_reden[besluit.reden_code] = (summary.per_reden[besluit.reden_code] || 0) + 1;
      } catch (e) {
        // Per afspraak vangen: één rij die weigert mag de rest niet laten liggen.
        summary.errors.push({ appointment_id: a.id, error: e?.message || String(e) });
        console.error('[cron-opvolging-zoom-nabel] kaart faalde', a.id, e?.message || e);
      }
    }
  } catch (e) {
    console.error('[cron-opvolging-zoom-nabel] fataal:', e?.message || e);
    summary.errors.push({ phase: 'fataal', error: e?.message || String(e) });
    summary.duration_ms = Date.now() - startedAt;
    return res.status(500).json({ ok: false, summary });
  }

  summary.duration_ms = Date.now() - startedAt;
  console.log('[cron-opvolging-zoom-nabel] klaar', JSON.stringify(summary));
  return res.status(200).json({ ok: true, summary });
}

const SPRAAK = new Set(['ptt', 'audio', 'voice']);

/**
 * Kunnen we vandaag überhaupt meten of er een spraakbericht ging?
 *
 * Twee voorwaarden, en allebei moeten ze kloppen:
 *   · de leadlijst dekt deze dag (zie _lib/opvolging-leadlijst-venster.js);
 *   · de brug is verbonden en ziet uitgaande berichten.
 *
 * Dezelfde bron als /api/opvolging-whatsapp-status, zodat het scherm en deze
 * cron niet elk hun eigen antwoord op dezelfde vraag geven.
 */
async function meetbaar(dag) {
  if (!leadlijstDektDag(dag)) {
    return { gemeten: false, reden: `de leadlijst dekt ${dag} niet, dus er is niets gemeten` };
  }
  const cfg = brugConfig();
  if (!cfg.ok) return { gemeten: false, reden: 'de brug is niet geconfigureerd: ' + (cfg.melding || 'onbekend') };
  try {
    const status = await brugFetch('/status');
    if (!status || status.verbonden !== true) {
      return { gemeten: false, reden: 'de WhatsApp-brug is niet verbonden' };
    }
    // ZIET HIJ UITGAANDE BERICHTEN? Een brug die alleen inkomend doorlaat kan
    // 'geen spraakbericht' niet onderscheiden van 'wel gestuurd, niet gezien'.
    //
    // === true, en niet !== false: een oudere brug die dit veld niet meestuurt
    // is geen brug waarvan we WETEN dat hij uitgaand ziet. Zelfde strengheid
    // als brugZietUitgaand() in de view, zodat het scherm en deze cron niet
    // elk hun eigen antwoord geven op dezelfde vraag.
    if (status.ziet_uitgaand !== true) {
      return { gemeten: false, reden: 'de brug ziet nog geen uitgaande berichten' };
    }
    return { gemeten: true, reden: null };
  } catch (e) {
    return { gemeten: false, reden: 'de brug antwoordde niet: ' + (e?.message || String(e)) };
  }
}

/** De zoomcalls van vandaag die nog moeten komen. */
async function leesAfspraken(vanIso, totIso, dag) {
  const { data, error } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, is_test')
    .eq('status', 'scheduled')
    .gt('scheduled_at', vanIso)
    .lt('scheduled_at', totIso)
    .not('lead_phone', 'is', null)
    .order('scheduled_at', { ascending: true })
    .limit(200);
  if (error) throw new Error('afspraken lezen: ' + error.message);
  return (data || []).filter((a) => {
    if (!a || a.is_test === true) return false;
    if (!String(a.lead_phone || '').trim()) return false;
    // Het venster is ruim genomen om de zomertijdgrens heen; de dag moet
    // alsnog kloppen in Amsterdamse tijd.
    const z = inZone(a.scheduled_at);
    return !!z && z.dag === dag;
  });
}

/** De lopende kaarten waar een tweede naast zou komen. */
async function leesLopendeTaken() {
  const { data, error } = await supabaseAdmin
    .from('opvolging_taken')
    .select('id, telefoon, bron_ref')
    .in('status', LOPEND)
    .order('updated_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error('taken lezen: ' + error.message);
  return data || [];
}

/**
 * Staat er al een kaart voor deze lead?
 *
 * Twee ingangen, want er zijn twee manieren waarop er al een kan staan:
 *   · op NUMMER — dezelfde match als zoekTaak in de webhook, zodat een lead
 *     die vanochtend al om een andere reden op de lijst kwam er geen tweede
 *     krijgt;
 *   · op APPOINTMENT_ID — een kaart die uit precies deze afspraak is ontstaan.
 */
function heeftAlKaart(taken, afspraak) {
  const doel = cijfers(afspraak.lead_phone);
  const staart = doel && doel.length >= 9 ? doel.slice(-9) : null;
  for (const t of (taken || [])) {
    const aid = t && t.bron_ref && t.bron_ref.appointment_id;
    if (aid && String(aid) === String(afspraak.id)) return true;
    const c = cijfers(t && t.telefoon);
    if (!c || !doel) continue;
    if (c === doel) return true;
    if (staart && c.length >= 9 && c.slice(-9) === staart) return true;
  }
  return false;
}

function cijfers(s) {
  const c = String(s == null ? '' : s).replace(/\D/g, '');
  if (!c) return null;
  return c.startsWith('00') ? (c.slice(2) || null) : c;
}

/**
 * De kaart zelf.
 *
 * Zelfde velden als api/opvolging-taak-create.js schrijft — dat endpoint is de
 * gewone weg en deze cron mag daar niet van afwijken, anders leest de kaart in
 * de werklijst anders dan een die Dave zelf maakte.
 */
async function maakKaart({ afspraak, vandaag, callTijd, reden_code, spraak_tijd }) {
  const { error } = await supabaseAdmin.from('opvolging_taken').insert({
    naam       : (afspraak.lead_name && String(afspraak.lead_name).trim()) || 'Naamloos',
    email      : afspraak.lead_email || null,
    telefoon   : afspraak.lead_phone || null,
    reden      : 'zoom_nabellen',
    reden_code,
    bron       : 'call',
    bron_ref   : {
      appointment_id: afspraak.id,
      start         : afspraak.scheduled_at,
      soort         : 'zoom_nabel',
      source        : 'cron-opvolging-zoom-nabel',
    },
    badge_label: 'Zoomcall ' + callTijd,
    due        : vandaag,
    later      : false,
    status     : 'open',
    notitie    : bouwNotitie({ callTijd, reden_code, spraak_tijd }),
    // Proefafspraken leveren proefkaarten op, niet echte. Ontbreekt de kolom,
    // dan is dit undefined en verandert er niets.
    ...(afspraak.is_test === true ? { is_test: true } : {}),
    eigenaar_id: null,
  });
  if (error) throw new Error('kaart aanmaken: ' + error.message);
}

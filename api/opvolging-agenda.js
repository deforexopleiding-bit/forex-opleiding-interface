// api/opvolging-agenda.js
//
// Fase 2 DEEL B — de agenda achter "Opnieuw inplannen" in de opvolgmodule.
//
//   GET  /api/opvolging-agenda?van=YYYY-MM-DD&tot=YYYY-MM-DD[&achterstand=1]
//        → { timezone, window, dagen:[{ dag, vrij:[{tijd}], bezet:[{tijd,naam,status}] }],
//            agenda_beschikbaar, melding, achterstand?:[…] }
//
//   POST /api/opvolging-agenda
//        { taak_id, start } → boekt en zet de taak op 'ingepland'.
//
// TWEE BRONNEN
//   · Vrij  — Dave's GHL-kalender (calendars/free-slots), dezelfde kalender en
//             dezelfde normalisatie als api/follow-up-ghl-free-slots.js.
//   · Bezet — onze eigen follow_up_appointments, gelezen met de user-client
//             zodat RLS blijft gelden.
// Samenvoegen gebeurt in api/_lib/opvolging-agenda-merge.js (pure functie,
// getest zonder netwerk).
//
// WAAROM DE GHL-CALL HIER OPNIEUW STAAT EN NIET VIA follow-up-ghl-free-slots
// Een HTTP-self-call vanuit een Vercel-functie naar een andere functie van
// dezelfde deployment is in deze repo een gedocumenteerd anti-pattern: dat
// faalde structureel op productie met `TypeError: fetch failed` (Deployment
// Protection / cold-start DNS-race) — zie de kop van api/_lib/joost-suggest-core.js.
// De helpers uit follow-up-ghl-free-slots.js exporteren zou dat bestand moeten
// wijzigen, en dat mag niet. Dus: dezelfde GET naar dezelfde kalender, met de
// tijdzone uit het GHL-antwoord, en verder niets nieuws richting GHL.
//
// BOEKEN GAAT NOOIT RECHTSTREEKS NAAR GHL
// De POST hergebruikt createAppointmentForLead() — hetzelfde pad als de
// cockpit-uitkomst 'zoom_ingepland'. Dat pad maakt de GHL-afspraak én de
// follow_up_appointments-rij, en laat GHL zelf de uitnodiging en de Zoom-link
// naar de lead sturen. Zelf naar GHL schrijven zou precies die twee berichten
// laten verdwijnen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { verzetAfspraak, verzetBlokkade, mapGhlError as mapVerzetGhlError } from './_lib/verzet-afspraak.js';
import { zelfdeLead } from './_lib/opvolging-annulering.js';
import { createAppointmentForLead, mapGhlError } from './_lib/create-appointment-from-lead.js';
import { voegAgendaSamen, dagenTussen } from './_lib/opvolging-agenda-merge.js';
import { bestemmingPerParent, vulVerzetBestemming } from './_lib/opvolging-dagbeeld.js';
import { dagEnTijd } from './_lib/opvolging-dagbeeld.js';
import { haalWaRegels, waPogingenVoorNummer } from './_lib/opvolging-call-wa.js';
import { leadlijstDektDag } from './_lib/opvolging-leadlijst-venster.js';
import fetch from 'node-fetch';

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15';
const ZONE        = 'Europe/Amsterdam';
const DATUM_RE    = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAGEN   = 45;                 // zes weken vooruit plus wat lucht
const DUUR_MIN    = 30;

// ── Tijdrekenen in Amsterdam ───────────────────────────────────────────────
// Gelijk aan api/follow-up-ghl-free-slots.js: expliciete UTC-constructie plus
// de offset op díe datum, zodat de zomertijdgrens geen uur verschuift.
function zoneMiddernachtMs(datum) {
  const [y, m, d] = datum.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utc))) map[p.type] = p.value;
  const alsUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return utc - Math.round((alsUtc - utc) / 60000) * 60000;
}

function vandaagInZone() {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(new Date());
}

// Zelfde vormen als GHL ze teruggeeft: plat array óf object keyed op datum.
function normaliseerSlots(raw, timeZone) {
  const perDag = new Map();
  const push = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return;
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const map = {};
    for (const p of dtf.formatToParts(new Date(t))) map[p.type] = p.value;
    const dag = `${map.year}-${map.month}-${map.day}`;
    if (!perDag.has(dag)) perDag.set(dag, new Set());
    perDag.get(dag).add(`${map.hour}:${map.minute}`);
  };
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.slots)) {
    for (const s of raw.slots) push(typeof s === 'string' ? s : s?.startTime || s?.start || '');
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!DATUM_RE.test(k)) continue;
    const arr = Array.isArray(v?.slots) ? v.slots : (Array.isArray(v) ? v : []);
    for (const s of arr) push(typeof s === 'string' ? s : s?.startTime || s?.start || '');
  }
  const uit = [];
  for (const [date, set] of perDag) uit.push({ date, times: [...set].sort() });
  uit.sort((a, b) => a.date.localeCompare(b.date));
  return uit;
}

// Haalt de vrije slots op. Gooit niet: bij elke storing komt er
// { slots: [], melding } terug zodat de UI iets leesbaars kan tonen in plaats
// van een leeg scherm.
async function haalVrijeSlots(van, tot) {
  const calendarId = process.env.GHL_CALENDAR_ID;
  const token      = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  if (!calendarId || !token) {
    console.warn('[opvolging-agenda] GHL env ontbreekt', { calendarId: !!calendarId, token: !!token });
    return { slots: [], timezone: ZONE, melding: 'De agenda is niet gekoppeld op de server. Kies hieronder zelf een dag.' };
  }
  const url = new URL(`${GHL_BASE}/calendars/${encodeURIComponent(calendarId)}/free-slots`);
  url.searchParams.set('startDate', String(zoneMiddernachtMs(van)));
  url.searchParams.set('endDate',   String(zoneMiddernachtMs(tot) + 24 * 3600 * 1000 - 1));
  url.searchParams.set('timezone',  ZONE);
  try {
    const res = await fetch(url.toString(), {
      method : 'GET',
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[opvolging-agenda] GHL free-slots', res.status, (body || '').slice(0, 200));
      return { slots: [], timezone: ZONE, melding: 'De agenda is even niet bereikbaar. Kies hieronder zelf een dag.' };
    }
    const raw = await res.json();
    // De tijdzone komt uit het antwoord; alleen als GHL 'm niet meestuurt
    // vallen we terug op de zone die we hebben gevraagd.
    const timezone = (typeof raw?.timezone === 'string' && raw.timezone.trim()) ? raw.timezone.trim() : ZONE;
    return { slots: normaliseerSlots(raw, timezone), timezone, melding: null };
  } catch (e) {
    console.warn('[opvolging-agenda] GHL fetch faalde:', e?.message || e);
    return { slots: [], timezone: ZONE, melding: 'De agenda is even niet bereikbaar. Kies hieronder zelf een dag.' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  if (req.method === 'GET')  return await lees(req, res, supabase);
  if (req.method === 'POST') return await boek(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'GET of POST' });
}

// ── GET: vrij + bezet per dag ──────────────────────────────────────────────
async function lees(req, res, supabase) {
  const q = req.query || {};
  const vandaag = vandaagInZone();
  const van = DATUM_RE.test(String(q.van || '')) ? String(q.van) : vandaag;
  let tot = DATUM_RE.test(String(q.tot || '')) ? String(q.tot) : null;
  if (!tot) tot = isoPlusDagen(van, 6);

  // Venster begrenzen: een spoof-caller mag geen half jaar aan GHL-verkeer
  // afdwingen, en de UI vraagt nooit meer dan een week tegelijk.
  const reeks = dagenTussen(van, tot);
  if (reeks.length === 0) return res.status(400).json({ error: 'van/tot ongeldig (verwacht YYYY-MM-DD, tot >= van)' });
  if (reeks.length > MAX_DAGEN) tot = reeks[MAX_DAGEN - 1];

  const achterstandGevraagd = String(q.achterstand || '') === '1';

  const { slots, timezone, melding } = await haalVrijeSlots(van, tot);

  // Bezet uit onze eigen tabel. Fail-soft: zonder deze lijst tonen we de vrije
  // slots nog steeds — dat is beter dan een leeg scherm, en het risico
  // (een slot dat GHL zelf al kent) is klein.
  let afspraken = [];
  let bezetMelding = null;
  let ontbrekend = [];
  try {
    const vanIso = new Date(zoneMiddernachtMs(van)).toISOString();
    const totIso = new Date(zoneMiddernachtMs(tot) + 24 * 3600 * 1000).toISOString();

    // lead_phone / lead_email / zoom_join_url zijn fase 3a: het blok 'Calls van
    // vandaag' hangt aan dezelfde momenten en heeft de Zoom-link en het nummer
    // nodig.
    const VAST = 'id, lead_name, lead_email, lead_phone, scheduled_at, status, zoom_join_url';

    // ── DRIE KOLOMMEN DIE ER NIET HOEVEN TE ZIJN ─────────────────────────
    // Elk uit een eigen migratie, en elk in een eigen tempo gedraaid. Een
    // select die een ontbrekende kolom noemt faalt met 42703 en neemt de HÉLE
    // query mee — dus niet één kolom weg, maar het complete dagbeeld.
    //
    // 42703 zegt WEL dat een kolom ontbreekt en NIET welke. Daarom matchen we
    // op de kolomnaam in de foutmelding: zonder dat zou het ontbreken van
    // `uitkomst` ook `eerst_gepland_op` uitzetten, en dan verdwijnen de
    // verzette afspraken om een reden die er niets mee te maken heeft.
    const OPTIONEEL = ['uitkomst', 'uitkomst_op', 'eerst_gepland_op', 'is_test'];
    let beschikbaar = [...OPTIONEEL];
    let data = null;
    let error = null;

    // Hooguit zo vaak als er optionele kolommen zijn: elke ronde valt er
    // minstens één af, anders stoppen we.
    for (let poging = 0; poging <= OPTIONEEL.length; poging += 1) {
      const heeftEerst = beschikbaar.includes('eerst_gepland_op');
      let q = supabase
        .from('follow_up_appointments')
        .select([VAST, ...beschikbaar].join(', '));

      // OOK WAT VAN DEZE DAG WEG IS VERPLAATST. Een afspraak die in dezelfde
      // rij naar een andere dag is gezet heeft een scheduled_at buiten dit
      // venster, maar stond wél op deze dag. Zonder de tweede voorwaarde
      // verdwijnt hij stil uit het dagbeeld — precies het gat dat dicht moet.
      q = heeftEerst
        ? q.or(`and(scheduled_at.gte.${vanIso},scheduled_at.lt.${totIso}),`
             + `and(eerst_gepland_op.gte.${vanIso},eerst_gepland_op.lt.${totIso})`)
        : q.gte('scheduled_at', vanIso).lt('scheduled_at', totIso);

      ({ data, error } = await q.order('scheduled_at', { ascending: true }));
      if (!error) break;
      if (error.code !== '42703') break;

      const weg = beschikbaar.filter((k) => new RegExp('\\b' + k + '\\b').test(error.message || ''));
      if (weg.length === 0) break;              // 42703 om een andere kolom: niet blijven proberen.
      beschikbaar = beschikbaar.filter((k) => !weg.includes(k));
    }

    if (error) throw error;
    afspraken = data || [];
    ontbrekend = OPTIONEEL.filter((k) => !beschikbaar.includes(k));
  } catch (e) {
    console.warn('[opvolging-agenda] afspraken lezen faalde:', e?.message || e);
    bezetMelding = 'De geboekte afspraken konden niet geladen worden; vrije momenten kloppen mogelijk niet helemaal.';
  }

  // Zeggen wat er ontbreekt in plaats van doen alsof het dagbeeld klopt. Een
  // onvolledig beeld dat zich voordoet als volledig is precies waar we deze
  // week op zijn vastgelopen.
  const dagbeeldMeldingen = [];
  if (ontbrekend.includes('eerst_gepland_op')) {
    dagbeeldMeldingen.push('De kolom eerst_gepland_op bestaat nog niet, dus afspraken die naar een andere dag '
      + 'zijn verzet ontbreken in dit dagbeeld. Draai docs/sql-migrations/2026-09-08-eerst-gepland-op.sql.');
  }
  if (ontbrekend.includes('is_test')) {
    dagbeeldMeldingen.push('De kolom is_test bestaat nog niet, dus proefafspraken staan hier gewoon tussen. '
      + 'Draai docs/sql-migrations/2026-09-09-follow-up-appointments-is-test.sql.');
  }

  const dagen = voegAgendaSamen({ slots, afspraken, van, tot, timeZone: timezone });
  const vrijTotaal = dagen.reduce((n, d) => n + d.vrij.length, 0);

  // WAARHEEN IS HIJ VERZET? Bij de parent/child-vorm staat het nieuwe moment in
  // een tweede rij, buiten dit venster. Zonder deze stap leest de oude dag
  // alleen 'verzet' — wel dat hij weg is, niet of hij morgen of over drie weken
  // terugkomt.
  await hangVerzetBestemming(dagen, afspraken);

  // De uitkomst die Dave zelf vastlegde, ook als die alleen als werklijstkaart
  // bestaat. Zie hangAfrondUitTaak — dit is de reden dat een no-show nooit
  // 'Afgerond' toonde.
  await hangAfrondUitTaak(dagen);

  // De WhatsApp-pogingen bij elke geplande call. Zie de kop van
  // hangWhatsAppAanCalls: `wa` is een lijst of NULL, en NULL betekent 'niet
  // gemeten' — niet 'geen spraakbericht'.
  const waMelding = await hangWhatsAppAanCalls(dagen, van, tot);

  // Wat er van eerdere dagen nog open staat. Alleen op verzoek van de view.
  const achterstand = achterstandGevraagd ? await leesAchterstand() : [];

  return res.status(200).json({
    timezone,
    window: { van, tot },
    dagen,
    agenda_beschikbaar: !melding,
    // TWEE MELDINGEN, TWEE VELDEN. Ze stonden in één `melding`, en dan
    // verdwijnt een mislukte lezing van de afspraken achter een GHL-storing —
    // precies op het moment dat je wilt weten waarom het dagbeeld leeg is.
    afspraken_melding: bezetMelding,
    dagbeeld_volledig: dagbeeldMeldingen.length === 0,
    dagbeeld_melding : dagbeeldMeldingen.join(' ') || null,
    // Waarom `wa` op sommige calls null staat. Null zonder uitleg zou het
    // scherm laten kiezen tussen zwijgen en gokken.
    wa_melding       : waMelding,
    // Alleen als de view erom vraagt, en die doet dat alleen op vandaag.
    ...(achterstandGevraagd ? { achterstand } : {}),
    melding: melding || bezetMelding || (vrijTotaal === 0 ? 'Geen vrije momenten in deze week.' : null),
  });
}

/**
 * DE WHATSAPP-BERICHTEN BIJ ELKE GEPLANDE CALL.
 *
 * ── WAAROM DIT HIER HANGT EN NIET IN DE VIEW ────────────────────────────
 * De twee vensters (spraakbericht vóór 09:00, nabellen 12-13) worden beoordeeld
 * op `opvolging_pogingen`, en die hangen aan een taak. Een zoomlead heeft er
 * meestal geen: hij boekte zelf een call en kwam nooit in de werklijst. Het
 * scherm zei daarom '7 ingeplande calls, maar geen ervan staat in de
 * takenlijst' terwijl er die ochtend gewoon spraakberichten waren gegaan.
 *
 * De berichten staan wél in `opvolging_wa_berichten` (sinds de webhook ze ook
 * zonder taak bewaart). Die hangen we hier aan de call, zodat het scherm met de
 * BESTAANDE beoordeelSpraak/beoordeelNabel kan rekenen.
 *
 * ── NULL IS NIET LEEG ────────────────────────────────────────────────────
 * `wa` is een array (gemeten) óf null (niet gemeten). Een lege array betekent
 * 'die dag ging er niets naar dit nummer'; null betekent 'we kunnen het niet
 * weten'. Vier redenen voor null, en elk is er één waarbij een lege lijst een
 * verwijt zou worden:
 *   · de dag valt vóór DEKKING_VANAF — de webhook gooide toen nog weg;
 *   · het lezen van de berichten mislukte;
 *   · de call heeft geen telefoonnummer;
 *   · de call gaat niet door (verzet, geannuleerd, doorgehaald).
 *
 * ── supabaseAdmin, EN DAT IS EEN BEWUSTE KEUZE ──────────────────────────
 * Dit endpoint zit al achter opvolging.module.access. Zou hier de user-client
 * staan, dan leest een RLS-nul als 'geen spraakbericht' — een verwijt dat
 * ontstaat uit een rechtenkwestie. Liever alles of een expliciete melding.
 *
 * @returns {Promise<?string>} een melding voor het scherm, of null.
 */
async function hangWhatsAppAanCalls(dagen, van, tot) {
  const geplandeCalls = [];
  for (const d of dagen || []) {
    for (const c of (d.gepland || [])) geplandeCalls.push({ dag: d.dag, call: c });
  }
  if (geplandeCalls.length === 0) return null;

  // Alleen de dagen waarop de leadlijst de zoomcall-leads dekte. Buiten dat
  // bereik hoeven we niet eens te lezen.
  const meetbareDagen = new Set((dagen || []).map((d) => d.dag).filter(leadlijstDektDag));
  for (const { call } of geplandeCalls) call.wa = null;
  if (meetbareDagen.size === 0) return null;

  const vanIso = new Date(zoneMiddernachtMs(van)).toISOString();
  const totIso = new Date(zoneMiddernachtMs(tot) + 24 * 3600 * 1000).toISOString();
  const { regels, fout } = await haalWaRegels(supabaseAdmin, vanIso, totIso);
  if (fout) {
    return 'De WhatsApp-berichten konden niet gelezen worden, dus het spraakbericht per call is niet gemeten.';
  }

  for (const { dag, call } of geplandeCalls) {
    if (!meetbareDagen.has(dag)) continue;
    if (!call.telefoon) continue;
    // Een call die niet doorgaat heeft geen ochtend om over te oordelen.
    if (call.doorgehaald === true) continue;
    if (NIET_GEVOERD.has(String(call.status || '').toLowerCase())) continue;
    call.wa = waPogingenVoorNummer(regels, call.telefoon);
  }
  return null;
}

/**
 * Statussen waarbij de call niet gevoerd is en er dus niets te beoordelen valt.
 * Tweeling van de filter in de view; zie de kop van hangWhatsAppAanCalls.
 */
const NIET_GEVOERD = new Set(['cancelled', 'verwijderd', 'verplaatst', 'wacht_op_reschedule']);

// ── DE UITKOMST DIE ALLEEN ALS WERKLIJSTKAART BESTAAT ────────────────────
//
// NO-SHOW TOONDE NOOIT 'AFGEROND', en dat is geen schoonheidsfoutje.
//
// __opvCallBevestig('no_show') maakt een werklijstkaart (reden `no_show_call`,
// `bron_ref.appointment_id`) en schrijft met opzet NIETS naar de
// uitkomstmotor: dat outcome maakt daar een eigen follow_up_lead aan, en dan
// staat dezelfde persoon in twee modules op Dave te wachten. Zie het
// waarschuwingsblok bij CALL_UITKOMST in de view — productie-incident 20 mei.
//
// Gevolg: `follow_up_appointments.uitkomst` blijft leeg, afrondActie() zegt
// 'knop', en de call staat eeuwig op 'Afronden →'. Dave heeft hem wél
// afgerond; het bewijs staat alleen in een andere tabel. En sinds de
// achterstand hieronder zou zo'n call ook elke dag opnieuw meeschuiven.
//
// Dus lezen we het bewijs waar het staat. De MOTOR BLIJFT ONAANGERAAKT — dat
// is precies de afspraak uit 20 mei.
const AFROND_UIT_TAAK = {
  no_show_call     : 'niet gekomen · in je werklijst',
  wil_nog_beslissen: 'wil nog beslissen',
};
const AFROND_UIT_REDEN_CODE = {
  zoom_geen_interesse: 'geen interesse',
};

/**
 * Kaarten die uit de REDEN van de taak komen in plaats van uit een reden_code.
 *
 * Een geannuleerde call met een 'opnieuw inplannen'-kaart is afgehandeld: er
 * ligt werk klaar. Zonder deze regel blijft hij op 'Afronden →' staan en zou
 * hij bovendien elke dag als achterstand meeschuiven — dezelfde valkuil als
 * bij no_show_call, alleen een andere weg erheen.
 */
const AFROND_UIT_TAAK_REDEN = {
  zoom_geannuleerd: 'geannuleerd · in je werklijst',
};

/**
 * Een PostgREST in-filter over een JSON-pad.
 *
 * Dubbele quotes zijn hier geen overdaad: `.filter()` krijgt de rauwe
 * filterwaarde, en een UUID draagt koppeltekens. Zonder quotes hangt het van
 * de parser af of dat goed gaat.
 */
function inLijst(ids) {
  return '(' + ids.map((i) => '"' + String(i).replace(/"/g, '') + '"').join(',') + ')';
}

/** Het label bij een werklijstkaart, of null als deze kaart niets afrondt. */
export function afrondLabelVanTaak(t) {
  const code = String((t && t.reden_code) || '').trim();
  if (code && AFROND_UIT_REDEN_CODE[code]) {
    return { code, label: AFROND_UIT_REDEN_CODE[code] };
  }
  const reden = String((t && t.reden) || '').trim();
  if (reden && AFROND_UIT_TAAK[reden]) {
    return { code: reden, label: AFROND_UIT_TAAK[reden] };
  }
  // NA de reden_code-lijst: een zoom_geannuleerd-kaart draagt zelf een
  // reden_code (zelf_geannuleerd / geannuleerd_in_agenda), en die staat niet in
  // AFROND_UIT_REDEN_CODE. Zonder deze regel valt hij dus overal doorheen.
  if (reden && AFROND_UIT_TAAK_REDEN[reden]) {
    return { code: reden, label: AFROND_UIT_TAAK_REDEN[reden] };
  }
  return null;
}

/**
 * Hangt de uit-een-taak-afgeleide uitkomst aan de calls die nog op 'knop' staan.
 *
 * Alleen waar `afrond.toon === 'knop'`: staat er al een echte uitkomst in
 * `follow_up_appointments.uitkomst`, dan wint die. Dat is Daves eigen
 * afrondknop en die is directer bewijs dan een afgeleide kaart.
 *
 * Fail-soft: zonder deze lezing gedraagt het dagbeeld zich als voorheen.
 */
async function hangAfrondUitTaak(dagen) {
  const calls = [];
  for (const d of dagen || []) {
    for (const c of (d.gepland || [])) {
      if (c && c.appointment_id && c.afrond && c.afrond.toon === 'knop') calls.push(c);
    }
  }
  if (calls.length === 0) return;

  const ids = [...new Set(calls.map((c) => String(c.appointment_id)))];
  let taken = [];
  try {
    // ALLE STATUSSEN. Een 'geen interesse'-kaart wordt meteen gearchiveerd
    // (direct_archiveren in opvolging-taak-create); die eruit filteren zou
    // precies de afgeronde calls onzichtbaar maken.
    const { data, error } = await supabaseAdmin
      .from('opvolging_taken')
      .select('id, reden, reden_code, bron_ref, created_at')
      .filter('bron_ref->>appointment_id', 'in', inLijst(ids))
      .order('created_at', { ascending: false })
      .limit(1000);
    if (error) throw new Error(error.message);
    taken = data || [];
  } catch (e) {
    console.warn('[opvolging-agenda] afrond-uit-taak (soft):', e?.message || e);
    return;
  }

  // Nieuwste wint: de lijst staat aflopend, dus de eerste treffer per
  // appointment_id is de meest recente kaart.
  const perAfspraak = new Map();
  for (const t of taken) {
    const aid = t && t.bron_ref && t.bron_ref.appointment_id;
    if (!aid || perAfspraak.has(String(aid))) continue;
    const label = afrondLabelVanTaak(t);
    if (label) perAfspraak.set(String(aid), { ...label, op: t.created_at || null });
  }

  for (const c of calls) {
    const vast = perAfspraak.get(String(c.appointment_id));
    if (vast) c.afrond = { toon: 'uitkomst', vastgelegd: vast };
  }
}

// ── ONAFGERONDE ZOOMCALLS VAN EERDERE DAGEN ──────────────────────────────
//
// Maxims regel: Dave rondt elke zoomcall af — klant geworden, wil nog beslissen
// (met datum), no-show, of geen interesse. Rondt hij er een niet af, dan staat
// die de volgende dag bovenaan: 'van gisteren, werk deze af'.
//
// Zonder dat blijft zo'n call op zijn eigen dag staan, en die dag kijkt niemand
// meer terug. Gemeten: /api/opvolging-agenda van 9 september gaf 3 calls zonder
// afronding (10:00 en 12:00 scheduled, 11:00 cancelled) en 8 september 1 (15:00).
//
// TWEE WEKEN TERUG, EN NOOIT VÓÓR ACHTERSTAND_VANAF. Vóór 8 september bestond
// de afrondknop niet; alles daarvoor zou als achterstand op Daves dag landen
// terwijl er nooit een knop was om te drukken. Dat is geen werklijst maar een
// aanklacht over een periode waarin de functie niet bestond.
export const ACHTERSTAND_VANAF = '2026-09-08';
export const ACHTERSTAND_DAGEN = 14;
// Alleen calls die GEVOERD zijn. Geannuleerd en verzet horen er niet in: daar
// viel niets af te ronden.
export const ACHTERSTAND_STATUS = ['scheduled', 'in_progress', 'completed', 'no_show'];

/**
 * De grenzen van het achterstandsvenster: van max(vandaag−14, ACHTERSTAND_VANAF)
 * tot het begin van vandaag, allebei in Amsterdamse tijd.
 *
 * Pure functie, zodat de grens in een test staat en niet alleen in een query.
 * `leeg` is true als er niets over is — vlak na ACHTERSTAND_VANAF is dat het
 * normale geval en niet een randgeval.
 */
export function achterstandVenster(vandaag) {
  const beginVandaagMs = zoneMiddernachtMs(vandaag);
  const vroegsteMs = Math.max(
    beginVandaagMs - ACHTERSTAND_DAGEN * 24 * 3600 * 1000,
    zoneMiddernachtMs(ACHTERSTAND_VANAF),
  );
  return {
    vanIso: new Date(vroegsteMs).toISOString(),
    totIso: new Date(beginVandaagMs).toISOString(),
    leeg  : vroegsteMs >= beginVandaagMs,
  };
}

/** Eén afspraak als achterstandsrij. Zelfde vorm als een gepland-call. */
export function achterstandRij(a) {
  const dt = dagEnTijd(a && a.scheduled_at) || { dag: null, tijd: '' };
  return {
    dag           : dt.dag,
    tijd          : dt.tijd,
    naam          : (a && a.lead_name && String(a.lead_name).trim()) || 'Bezet',
    status        : String((a && a.status) || 'scheduled').toLowerCase(),
    label         : null,
    doorgehaald   : false,
    verzet_naar   : null,
    verzet_van    : null,
    afrond        : { toon: 'knop', vastgelegd: null },
    // De Zoom-link niet: die call is geweest. Bellen en WhatsApp wél — daar
    // gaat het bij een achterstand juist om.
    knoppen       : { afronden: true, bellen: !!(a && a.lead_phone), whatsapp: !!(a && a.lead_phone), zoom: false },
    appointment_id: (a && a.id) || null,
    telefoon      : (a && a.lead_phone) || null,
    email         : (a && a.lead_email) || null,
    zoom_url      : null,
    start         : (a && a.scheduled_at) || null,
    // De spraak/nabel-vensters rekenen NIET met de achterstand: die hoort bij
    // een andere dag. Null zegt hier 'niet gemeten voor vandaag'.
    wa            : null,
  };
}

/**
 * De zoomcalls van eerdere dagen die nog geen uitkomst hebben.
 *
 * Zelfde vorm als een gepland-call, plus `dag`, zodat de view er dezelfde rij
 * en dezelfde knoppen omheen kan tekenen.
 *
 * Fail-soft: bij een leesfout een lege lijst. Een achterstandsblok dat er niet
 * staat is minder erg dan een dagbeeld dat helemaal niet laadt.
 */
async function leesAchterstand() {
  const { vanIso, totIso, leeg } = achterstandVenster(vandaagInZone());
  if (leeg) return [];

  // `is_test` komt uit een eigen migratie en kan nog ontbreken. Eén retry
  // zonder die kolom, net als het dagbeeld hierboven doet — anders verdwijnt
  // het hele achterstandsblok om een reden die er niets mee te maken heeft.
  //
  // `uitkomst` NIET optioneel: zonder die kolom is 'nog geen uitkomst' niet te
  // bepalen, en dan zou elke gevoerde call als achterstand op Daves dag landen.
  let rijen = null;
  for (const metIsTest of [true, false]) {
    const kolommen = 'id, lead_name, lead_email, lead_phone, scheduled_at, status, zoom_join_url, uitkomst'
      + (metIsTest ? ', is_test' : '');
    const { data, error } = await supabaseAdmin
      .from('follow_up_appointments')
      .select(kolommen)
      .gte('scheduled_at', vanIso)
      .lt('scheduled_at', totIso)
      .in('status', ACHTERSTAND_STATUS)
      .is('uitkomst', null)
      .order('scheduled_at', { ascending: true })
      .limit(200);
    if (!error) { rijen = (data || []).filter((a) => a && a.is_test !== true); break; }
    if (metIsTest && error.code === '42703' && /\bis_test\b/.test(error.message || '')) continue;
    console.warn('[opvolging-agenda] achterstand lezen (soft):', error.message);
    return [];
  }
  if (!rijen) return [];
  if (rijen.length === 0) return [];

  // ── ZONDER OPVOLGTAAK ────────────────────────────────────────────────
  // Een call waar Dave een werklijstkaart van maakte (no-show, wil nog
  // beslissen, geen interesse) IS afgerond — alleen niet in de kolom
  // `uitkomst`. Zie hangAfrondUitTaak. Die hier laten staan zou elke no-show
  // eeuwig laten meeschuiven, en dat is precies wat we niet willen.
  const ids = [...new Set(rijen.map((a) => String(a.id)))];
  let metTaak = new Set();
  try {
    const { data, error } = await supabaseAdmin
      .from('opvolging_taken')
      .select('bron_ref')
      .filter('bron_ref->>appointment_id', 'in', inLijst(ids))
      .limit(1000);
    if (error) throw new Error(error.message);
    metTaak = new Set((data || [])
      .map((t) => t && t.bron_ref && t.bron_ref.appointment_id)
      .filter(Boolean)
      .map(String));
  } catch (e) {
    // NIET DOORGAAN MET EEN HALVE FILTER. Zonder deze lezing weten we niet
    // welke calls al afgerond zijn, en dan zou Dave kaarten terugkrijgen die
    // hij gisteren heeft weggewerkt. Liever geen blok dan een fout blok.
    console.warn('[opvolging-agenda] achterstand: taken lezen (soft):', e?.message || e);
    return [];
  }

  return rijen.filter((a) => !metTaak.has(String(a.id))).map(achterstandRij);
}

function isoPlusDagen(datum, n) {
  const ms = Date.parse(`${datum}T12:00:00Z`) + n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── POST: boeken via het bestaande zoom_ingepland-pad ──────────────────────
async function boek(req, res) {
  // Alleen op het boeken, niet op het lezen: de vrije momenten bekijken is
  // onschuldig, er een vastleggen is dat niet. Zonder deze regel deed de
  // schakelaar 'Agenda-afspraak boeken' in het beheerscherm helemaal niets.
  //
  // GEMETEN, want de opdracht vroeg om 'opvolging.taak.afronden' uit vrees dat
  // sales het boekrecht niet heeft: in
  // docs/sql-migrations/2026-09-04-opvolging-role-permissions.sql krijgt sales
  // ZOWEL opvolging.taak.afronden ALS opvolging.agenda.boeken op true. De vrees
  // gold events.attendee.create, niet dit. Daarom blijft het boekrecht staan —
  // ook voor het verzetten hieronder, want dat is een boeking. Zou het op
  // afronden gaan, dan boekt de knop nog steeds terwijl Jeffrey de schakelaar
  // 'Agenda-afspraak boeken' juist heeft uitgezet.
  if (!(await requirePermission(req, 'opvolging.agenda.boeken'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.agenda.boeken)' });
  }
  const b = req.body || {};
  const start = b.start ? new Date(b.start) : null;
  if (!start || isNaN(start.getTime())) return res.status(400).json({ error: 'start (ISO) ontbreekt of is ongeldig' });

  // TWEE INGANGEN, ÉÉN RECHT.
  //
  //   taak_id        — de werklijst: een kaart krijgt een afspraak.
  //   appointment_id — het afrondvenster: een BESTAANDE call wordt verzet.
  //
  // De tweede kwam erbij omdat een lead die op de dag zelf belt om te
  // verzetten anders alleen via 'no-show afronden' te verplaatsen was. Dat
  // levert een valse no-show op in het rapport en een overbodige kaart in de
  // werklijst, en allebei kloppen ze niet: hij kwam niet niet-opdagen, hij
  // belde.
  if (b.appointment_id) return await verzetCall(req, res, b, start);
  if (!b.taak_id) return res.status(400).json({ error: 'taak_id of appointment_id ontbreekt' });

  let taak;
  try {
    const { data, error } = await supabaseAdmin
      .from('opvolging_taken').select('*').eq('id', b.taak_id).maybeSingle();
    if (error) throw error;
    taak = data;
  } catch (e) {
    console.error('[opvolging-agenda] taak lezen:', e?.message || e);
    return res.status(500).json({ error: 'Taak kon niet gelezen worden' });
  }
  if (!taak) return res.status(404).json({ error: 'Taak niet gevonden' });

  const lead = await zoekLeadVoorTaak(taak);

  let afspraak;
  try {
    afspraak = await createAppointmentForLead({
      lead,
      scheduledAt    : start.toISOString(),
      durationMinutes: DUUR_MIN,
    });
  } catch (e) {
    // Dezelfde vertaling als de cockpit-uitkomst gebruikt, zodat de melding
    // in beide schermen hetzelfde leest.
    if (e?.code === 'NO_GHL_CONTACT') {
      return res.status(422).json({
        error: 'Geen e-mail of telefoon bekend — er is niets om het GHL-contact op te vinden. Vul de gegevens aan.',
        code : 'NO_GHL_CONTACT',
      });
    }
    if (e?.code === 'GHL_CONFIG_MISSING') {
      return res.status(500).json({ error: 'GHL is niet gekoppeld op de server (GHL_CALENDAR_ID / GHL_LOCATION_ID).' });
    }
    if (e?.code === 'GHL_API') {
      console.error('[opvolging-agenda] GHL:', e.ghlStatus, e.ghlBody);
      return res.status(422).json({ error: mapGhlError(e.ghlStatus, e.ghlBody), ghl_status: e.ghlStatus });
    }
    if (e?.code === 'DB_INSERT') {
      console.error('[opvolging-agenda] DB insert:', e?.message, 'ghl:', e?.ghl_appointment_id);
      return res.status(500).json({
        error             : 'De afspraak staat wel in GHL maar niet bij ons — controleer de kalender voor je opnieuw boekt.',
        ghl_appointment_id: e?.ghl_appointment_id || null,
      });
    }
    console.error('[opvolging-agenda] onbekend:', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }

  // Pas nu de taak bijwerken. Faalt dit, dan staat de afspraak er wel — dat
  // melden we expliciet in plaats van stil door te gaan, want anders blijft de
  // taak open en boekt iemand 'm een tweede keer.
  const afspraakRef = {
    bron               : 'opvolging-agenda',
    appointment_id     : afspraak.appointment_id,
    ghl_appointment_id : afspraak.ghl_appointment_id,
    zoom_join_url      : afspraak.zoom_join_url,
    scheduled_at       : afspraak.scheduled_at,
  };
  try {
    const { error } = await supabaseAdmin.from('opvolging_taken').update({
      status              : 'ingepland',
      afspraak_ref        : afspraakRef,
      afspraak_gevonden_at: new Date().toISOString(),
      updated_at          : new Date().toISOString(),
    }).eq('id', taak.id);
    if (error) throw error;
  } catch (e) {
    console.error('[opvolging-agenda] taak bijwerken:', e?.message || e);
    return res.status(500).json({
      error   : 'De afspraak is geboekt, maar de taak kon niet bijgewerkt worden. Zet de taak handmatig op ingepland.',
      afspraak: afspraakRef,
    });
  }

  // De poging is de historiek, niet de actie zelf — fail-soft.
  try {
    const { error } = await supabaseAdmin.from('opvolging_pogingen').insert({
      taak_id    : taak.id,
      soort      : 'ingepland',
      automatisch: true,
      resultaat  : 'afspraak geboekt',
      // Het boeken is iets dat aan onze kant gebeurt.
      richting   : 'uit',
    });
    if (error) throw error;
  } catch (e) {
    console.warn('[opvolging-agenda] poging schrijven (soft):', e?.message || e);
  }

  return res.status(200).json({ success: true, afspraak: afspraakRef });
}

/**
 * createAppointmentForLead() verwacht een follow_up_leads-achtig object.
 *
 * Voor een taak die uit een event komt bestaat die rij echt — Punt A in
 * events-complete-core.js maakt 'm, met dezelfde attendee_id in source_ref.
 * Die is te verkiezen: hij draagt customer_id en source_ref.ghl_contact_id,
 * en dat is de nette weg naar het bestaande GHL-contact.
 *
 * Bestaat hij niet (handmatige taak, of een taak uit een call), dan bouwen we
 * een lead-vormig object uit de taak zelf. resolveGhlContactId valt dan terug
 * op contacts/upsert met e-mail of telefoon — hetzelfde gedrag als elke andere
 * caller van dit pad.
 */
async function zoekLeadVoorTaak(taak) {
  const attendeeId = taak?.bron_ref?.attendee_id || null;
  if (attendeeId) {
    try {
      const { data } = await supabaseAdmin
        .from('follow_up_leads')
        .select('id, customer_id, lead_name, lead_email, lead_phone, owner_id, source_ref')
        .eq('source', 'event')
        .filter('source_ref->>attendee_id', 'eq', attendeeId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (data && data[0]) return data[0];
    } catch (e) {
      console.warn('[opvolging-agenda] lead-lookup (soft):', e?.message || e);
    }
  }
  return {
    id        : taak.id,
    customer_id: null,
    lead_name : taak.naam || null,
    lead_email: taak.email || null,
    lead_phone: taak.telefoon || null,
    owner_id  : taak.eigenaar_id || null,
    source_ref: taak.bron_ref || {},
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// POST · EEN BESTAANDE CALL VERZETTEN VANUIT HET AFRONDVENSTER
// ═══════════════════════════════════════════════════════════════════════════
//
// ── HET PROBLEEM DAT DIT OPLOST ─────────────────────────────────────────
// Een lead met een zoomcall vandaag belt Dave om 09:40 dat het niet lukt.
// Tot nu toe kon Dave alleen herplannen via 'Wat nu? → Opnieuw inplannen' op
// een werklijstkaart — en die kaart bestaat pas NADAT hij de call als no-show
// heeft afgerond. Twee dingen die niet waar zijn: een no-show in het rapport,
// en een kaart 'hij kwam niet opdagen' in de werklijst.
//
// ── WAT HET WEL DOET ────────────────────────────────────────────────────
// Precies wat de cockpit doet: verzetAfspraak(). Oude rij op 'verplaatst',
// nieuwe rij met parent_appointment_id, GHL blokkerend-eerst zodat er geen
// spookafspraak op het oude uur blijft staan. GEEN uitkomst, GEEN no-show,
// GEEN nieuwe kaart.
//
// ── EN WAT ER DICHTGAAT ─────────────────────────────────────────────────
// Staat er voor deze lead al een open kaart die zegt 'plan hem opnieuw in'
// (zoom_geannuleerd, no_show_call, zoom_nabellen), dan is die opdracht zojuist
// uitgevoerd. Die kaart laten staan is dezelfde valse taak als in PR 8: Dave
// belt iemand op om iets te regelen wat al geregeld is.
const VERZET_SLUIT_REDENEN = ['zoom_geannuleerd', 'no_show_call', 'zoom_nabellen'];
/** De statussen waarin een kaart nog werk is. Gelijk aan cron-opvolging-annuleringen. */
const KAART_LOPEND = ['open', 'wacht_inplanning'];
const VERZET_ARCHIEF_REDEN = 'opnieuw ingepland vanuit het afrondvenster';

async function verzetCall(req, res, b, start) {
  let afspraak;
  try {
    const { data, error } = await supabaseAdmin
      .from('follow_up_appointments').select('*').eq('id', b.appointment_id).maybeSingle();
    if (error) throw error;
    afspraak = data;
  } catch (e) {
    console.error('[opvolging-agenda] afspraak lezen:', e?.message || e);
    return res.status(500).json({ error: 'De afspraak kon niet gelezen worden' });
  }
  if (!afspraak) return res.status(404).json({ error: 'Afspraak niet gevonden' });

  // Niet elke status is te verzetten, en de reden hoort leesbaar te zijn —
  // 'er ging iets mis' laat Dave gokken wat hij nu moet doen.
  const blokkade = verzetBlokkade(afspraak);
  if (blokkade) return res.status(409).json({ error: blokkade });

  let uit;
  try {
    uit = await verzetAfspraak({
      supabaseAdmin,
      afspraak,
      nieuwStartIso: start.toISOString(),
      duurMinuten  : afspraak.duration_minutes || DUUR_MIN,
      doorUserId   : null,
      bron         : 'opvolging-afronden',
    });
  } catch (e) {
    if (e?.code === 'GHL_UPDATE') {
      console.error('[opvolging-agenda] verzet GHL:', e.ghlStatus, e.ghlBody);
      return res.status(422).json({ error: mapVerzetGhlError(e.ghlStatus, e.ghlBody), ghl_status: e.ghlStatus });
    }
    // De databanktekst blijft in het log. Wat Dave leest is een zin waar hij
    // iets mee kan — 'duplicate key value violates unique constraint' leest
    // als 'het systeem is stuk' en vertelt hem niet wat hij nu moet doen.
    console.error('[opvolging-agenda] verzet:', e?.code || '', e?.message || e);
    return res.status(500).json({
      error: 'Verzetten is niet gelukt. De afspraak staat nog op zijn oude moment; probeer het opnieuw.',
    });
  }

  // De kaarten pas NA een geslaagde verzetting. Andersom zou een mislukte
  // GHL-call een kaart sluiten waarvan de opdracht nog gewoon openstaat.
  const gesloten = await sluitKaartenNaVerzet(afspraak);

  return res.status(200).json({
    success: true,
    verzet : {
      appointment_id       : afspraak.id,
      nieuw_appointment_id : uit.nieuweAfspraak.id,
      van                  : afspraak.scheduled_at,
      naar                 : uit.nieuweAfspraak.scheduled_at,
      ghl_bijgewerkt       : uit.ghlBijgewerkt,
      zoom_bijgewerkt      : uit.zoomBijgewerkt,
    },
    kaarten_gesloten: gesloten,
  });
}

/**
 * Sluit de open kaarten die door deze verzetting hun opdracht verliezen.
 *
 * Twee manieren om bij dezelfde lead te komen, want een kaart kan uit deze
 * afspraak zijn ontstaan (bron_ref.appointment_id) óf gewoon op het nummer
 * staan. zelfdeLead() is dezelfde matching als de annuleringen-cron gebruikt:
 * GHL-contact eerst, dan het genormaliseerde nummer.
 *
 * Fail-soft per kaart: de verzetting is al gelukt en die mag hier niet meer
 * sneuvelen. Maar nooit stil — elke misser komt in het log.
 */
async function sluitKaartenNaVerzet(afspraak) {
  let kaarten = [];
  try {
    const { data, error } = await supabaseAdmin
      .from('opvolging_taken')
      .select('id, telefoon, status, reden, bron_ref')
      .in('status', KAART_LOPEND)
      .in('reden', VERZET_SLUIT_REDENEN)
      .limit(500);
    if (error) throw new Error(error.message);
    kaarten = data || [];
  } catch (e) {
    console.warn('[opvolging-agenda] kaarten lezen na verzet (soft):', e?.message || e);
    return 0;
  }

  const raak = kaarten.filter((k) => {
    const uitDezeAfspraak = k.bron_ref && String(k.bron_ref.appointment_id || '') === String(afspraak.id);
    return uitDezeAfspraak || zelfdeLead(afspraak, k);
  });

  let n = 0;
  for (const k of raak) {
    try {
      const nu = new Date().toISOString();
      const { error } = await supabaseAdmin.from('opvolging_taken').update({
        status         : 'gearchiveerd',
        archief_reden  : VERZET_ARCHIEF_REDEN,
        gearchiveerd_at: nu,
        updated_at     : nu,
      }).eq('id', k.id).in('status', KAART_LOPEND);
      if (error) throw new Error(error.message);
      n += 1;
    } catch (e) {
      console.warn('[opvolging-agenda] kaart sluiten na verzet (soft):', k.id, e?.message || e);
    }
  }
  return n;
}

/**
 * Hangt de bestemming aan de regels die als 'verzet' gemarkeerd staan.
 *
 * De opvolger ligt per definitie BUITEN het gevraagde venster (anders was hij
 * niet verzet), dus die moet apart gelezen worden. Fail-soft: zonder deze
 * lezing blijft het label gewoon 'verzet' — minder, maar niet fout.
 */
async function hangVerzetBestemming(dagen, afspraken) {
  const verzet = (afspraken || [])
    .filter((a) => String((a && a.status) || '').toLowerCase() === 'verplaatst')
    .map((a) => String(a.id));
  if (verzet.length === 0) return;
  try {
    const { data, error } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, parent_appointment_id, scheduled_at')
      .filter('parent_appointment_id', 'in', inLijst(verzet))
      .limit(500);
    if (error) throw new Error(error.message);
    vulVerzetBestemming(dagen, bestemmingPerParent(data || []));
  } catch (e) {
    console.warn('[opvolging-agenda] verzet-bestemming (soft):', e?.message || e);
  }
}

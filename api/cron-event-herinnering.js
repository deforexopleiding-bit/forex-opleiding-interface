// api/cron-event-herinnering.js
//
// EENMALIGE e-mail-herinnering voor AFGEHAAKTE event-opt-ins (fase 1, e-mail-only).
//
// Doelgroep: iemand liet in de event-funnel zijn gegevens achter
// (event_kwalificatie_submissions, resultaat='toegelaten') maar boekte GEEN plek
// (attendee_id IS NULL en geen matchende event_attendees-rij). Die krijgt eenmalig
// een vriendelijke mail om de aanmelding alsnog af te ronden.
//
// Model: api/cron-afspraak-reminders.js
//   - auth via checkCronAuth (CRON_SECRET);
//   - live-flag EVENT_HERINNERING_LIVE: zonder de vlag = DRY-RUN (wel selecteren
//     en loggen wie een mail ZOU krijgen, maar niets versturen, geen claim);
//   - per-rij afhandeling, volledig fail-soft (een fout op 1 rij breekt de run niet);
//   - submission-scoped dedup via een atomic claim op herinnering_sent_at.
//
// Doelgroep-query (§2 uit het onderzoek):
//   resultaat='toegelaten' AND attendee_id IS NULL AND geen event_attendees op
//   (event_id, lower(email)) AND website_events.starts_at > now() AND email aanwezig
//   AND geen test-email AND created_at tussen 2 en 72 uur oud.
//
// Vercel-cron: elke 15 min (de 2-uur-drempel zit in de query).
//
// Env:
//   CRON_SECRET               (verplicht, auth)
//   EVENT_HERINNERING_LIVE    ('1'/'true'/… = echt versturen; anders dry-run)
//   DFO_WEBSITE_BASE_URL      (merk-domein voor de afrond-link; default www.deforexopleiding.nl)

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { sendEventMail, wrapEmailHtml } from './mailer.js';

const UUR = 60 * 60 * 1000;
const ONDERGRENS_UREN = 2;    // gun ze eerst zelf de kans om af te ronden
const BOVENGRENS_UREN  = 72;  // oudere rijen niet meer opdiepen
const MAX_POGINGEN = 5;       // na zoveel mislukte sends: opgeven (gaveup)
const BATCH_LIMIET = 500;

// Event-funnels met een eigen landingspad op de site (zie funnel-stats-compute.js).
const EVENT_FUNNEL_PADEN = new Set(['event-1', 'event-2', 'event-3', 'event-4', 'event-forex-1']);
const DFO_BASE = (process.env.DFO_WEBSITE_BASE_URL || 'https://www.deforexopleiding.nl').replace(/\/+$/, '');

// Test-adressen tellen niet (zelfde markers als funnel-stats-compute.js).
const TEST_EMAIL_MARKERS = ['test', 'deforexopleiding'];
function isTestEmail(e) {
  if (!e || typeof e !== 'string') return false;
  const s = e.toLowerCase();
  return TEST_EMAIL_MARKERS.some((m) => s.includes(m));
}

function aanUit(v) {
  return ['1', 'true', 'aan', 'on', 'ja'].includes(String(v || '').trim().toLowerCase());
}

function voornaamVan(naam) {
  const eerste = String(naam || '').trim().split(/\s+/)[0];
  return eerste || 'jij';
}

// De afrond-/boekingspagina voor dit event/bron. Een bekende event-funnel heeft
// een eigen pad (/event-1 …); anders (sitepagina, bron NULL) de events-overzichtspagina.
function afrondLink(bron) {
  return EVENT_FUNNEL_PADEN.has(String(bron || '')) ? `${DFO_BASE}/${bron}` : `${DFO_BASE}/events`;
}

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function bouwMail({ voornaam, eventTitel, link }) {
  const titel = eventTitel || 'ons event';
  const subject = `Je aanmelding voor ${titel} is nog niet afgerond`;
  const html = wrapEmailHtml(subject, `
    <p>Beste ${escHtml(voornaam)},</p>
    <p>Je was er bijna! Je gegevens voor <strong>${escHtml(titel)}</strong> staan bij ons klaar, maar je aanmelding is nog niet helemaal afgerond, dus je plek staat nog niet vast.</p>
    <p>Wil je erbij zijn? Rond je aanmelding dan even af via de knop hieronder, dan is je plek definitief.</p>
    <p style="text-align:center;margin:28px 0">
      <a href="${escHtml(link)}" style="display:inline-block;background:#093d54;color:#ffffff;padding:12px 28px;border-radius:8px;font-weight:600;text-decoration:none">Aanmelding afronden</a>
    </p>
    <p>Twijfel je ergens over of heb je een vraag? Laat het gerust weten, we helpen je graag.</p>
    <p style="margin-top:28px">Tot snel!<br>Team De Forex Opleiding</p>
  `);
  const text = [
    `Beste ${voornaam},`, '',
    `Je was er bijna! Je gegevens voor ${titel} staan bij ons klaar, maar je aanmelding is nog niet helemaal afgerond, dus je plek staat nog niet vast.`, '',
    `Wil je erbij zijn? Rond je aanmelding dan even af via deze link, dan is je plek definitief:`,
    link, '',
    `Twijfel je ergens over of heb je een vraag? Laat het gerust weten, we helpen je graag.`, '',
    `Tot snel!`, `Team De Forex Opleiding`,
  ].join('\n');
  return { subject, text, html };
}

/**
 * Selecteer de afgehaakte opt-ins (zonder boeking). Retourneert verrijkte rijen
 * met { id, naam, email, bron, event_id, event_titel }. Doet de anti-join op
 * event_attendees en de "event in de toekomst"-check in JS (PostgREST kan de
 * left-anti-join niet netjes).
 */
async function haalKandidaten(nowMs) {
  const ondergrens = new Date(nowMs - BOVENGRENS_UREN * UUR).toISOString(); // oudste toegestane
  const bovengrens = new Date(nowMs - ONDERGRENS_UREN * UUR).toISOString(); // jongste toegestane

  const { data: subs, error } = await supabaseAdmin
    .from('event_kwalificatie_submissions')
    .select('id, naam, email, bron, event_id, created_at')
    .eq('resultaat', 'toegelaten')
    .is('attendee_id', null)
    .is('herinnering_sent_at', null)
    .is('herinnering_gaveup_at', null)
    .gt('created_at', ondergrens)
    .lt('created_at', bovengrens)
    .limit(BATCH_LIMIET);
  if (error) throw new Error('kandidaten-query: ' + error.message);

  const rijen = (subs || []).filter((s) => s && s.email && !isTestEmail(s.email) && s.event_id);
  if (rijen.length === 0) return [];

  const eventIds = [...new Set(rijen.map((r) => r.event_id))];
  const emails = [...new Set(rijen.map((r) => String(r.email).toLowerCase()))];

  // Events: alleen die nog in de toekomst liggen (titel voor de mail).
  const { data: events } = await supabaseAdmin
    .from('website_events')
    .select('id, titel, starts_at')
    .in('id', eventIds);
  const nowIso = new Date(nowMs).toISOString();
  const eventById = new Map();
  for (const e of events || []) {
    if (e && e.starts_at && e.starts_at > nowIso) eventById.set(e.id, e);
  }

  // Anti-join: wie al een attendee heeft op (event_id, lower(email)) valt af.
  const { data: attendees } = await supabaseAdmin
    .from('event_attendees')
    .select('event_id, email')
    .in('event_id', eventIds);
  const geboekt = new Set();
  for (const a of attendees || []) {
    if (a && a.event_id && a.email) geboekt.add(`${a.event_id}|${String(a.email).toLowerCase()}`);
  }

  const uit = [];
  for (const s of rijen) {
    const ev = eventById.get(s.event_id);
    if (!ev) continue; // event niet (meer) toekomstig of onbekend
    if (geboekt.has(`${s.event_id}|${String(s.email).toLowerCase()}`)) continue; // al geboekt
    uit.push({ id: s.id, naam: s.naam, email: s.email, bron: s.bron, event_id: s.event_id, event_titel: ev.titel });
  }
  return uit;
}

/**
 * Atomic claim: zet herinnering_sent_at=now() en bump pogingen, maar alleen als
 * nog niemand claimde. Lege return = al geclaimd door een andere run → skip.
 */
async function claim(id, huidigePogingen) {
  const { data, error } = await supabaseAdmin
    .from('event_kwalificatie_submissions')
    .update({ herinnering_sent_at: new Date().toISOString(), herinnering_pogingen: (huidigePogingen || 0) + 1 })
    .eq('id', id)
    .is('herinnering_sent_at', null)
    .select('id')
    .maybeSingle();
  if (error) { console.warn('[cron-event-herinnering] claim-fout (soft):', id, error.message); return false; }
  return !!data;
}

// Geef de claim vrij zodat een volgende run opnieuw kan proberen (tijdelijke fout).
async function geefVrij(id, kanalen) {
  try {
    await supabaseAdmin.from('event_kwalificatie_submissions')
      .update({ herinnering_sent_at: null, herinnering_kanalen: kanalen })
      .eq('id', id);
  } catch (e) { console.warn('[cron-event-herinnering] vrijgeven (soft):', id, e?.message || e); }
}

// Markeer als afgehandeld (geslaagd, opgegeven, of bewust overgeslagen).
async function markeer(id, velden) {
  try {
    await supabaseAdmin.from('event_kwalificatie_submissions').update(velden).eq('id', id);
  } catch (e) { console.warn('[cron-event-herinnering] markeren (soft):', id, e?.message || e); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const live = aanUit(process.env.EVENT_HERINNERING_LIVE);
  const now = new Date();
  const nowMs = now.getTime();
  const summary = { live, verzendt: live, kandidaten: 0, verstuurd: 0, overgeslagen: 0, opgegeven: 0, resultaten: [], errors: [] };

  try {
    const kandidaten = await haalKandidaten(nowMs);
    summary.kandidaten = kandidaten.length;

    for (const k of kandidaten) {
      if (!live) {
        // Dry-run: alleen tonen wie een mail ZOU krijgen. Geen claim, geen send.
        summary.resultaten.push({ id: k.id, email: k.email, event: k.event_titel, bron: k.bron || null, dry: true });
        continue;
      }

      // Live: atomair claimen vóór de send (race-veilig, eenmalig).
      const huidige = await (async () => {
        const { data } = await supabaseAdmin
          .from('event_kwalificatie_submissions').select('herinnering_pogingen').eq('id', k.id).maybeSingle();
        return data?.herinnering_pogingen || 0;
      })();
      const gotClaim = await claim(k.id, huidige);
      if (!gotClaim) { summary.overgeslagen += 1; continue; }

      // Vlak vóór verzenden opnieuw checken: intussen tóch geboekt? Dan niets sturen.
      try {
        const { data: att } = await supabaseAdmin
          .from('event_attendees').select('id').eq('event_id', k.event_id).eq('email', String(k.email).toLowerCase()).maybeSingle();
        const { data: sub2 } = await supabaseAdmin
          .from('event_kwalificatie_submissions').select('attendee_id').eq('id', k.id).maybeSingle();
        if (att || sub2?.attendee_id) {
          await markeer(k.id, { herinnering_kanalen: { skipped: 'reeds_geboekt', at: new Date().toISOString() } });
          summary.overgeslagen += 1;
          summary.resultaten.push({ id: k.id, skipped: 'reeds_geboekt' });
          continue;
        }
      } catch (e) {
        // Her-check faalde: ga door met versturen is riskant (dubbel), dus geef vrij en sla over.
        await geefVrij(k.id, { email: { ok: false, error: 'hercheck_mislukt: ' + (e?.message || e) } });
        summary.overgeslagen += 1;
        continue;
      }

      // Versturen.
      const link = afrondLink(k.bron);
      const { subject, text, html } = bouwMail({ voornaam: voornaamVan(k.naam), eventTitel: k.event_titel, link });
      let uitkomst;
      try {
        uitkomst = await sendEventMail({ to: k.email, subject, text, html });
      } catch (e) {
        uitkomst = { success: false, error: e?.message || String(e) };
      }

      if (uitkomst && uitkomst.success === true) {
        await markeer(k.id, { herinnering_kanalen: { email: { ok: true, at: new Date().toISOString(), message_id: uitkomst.messageId || null } } });
        summary.verstuurd += 1;
        summary.resultaten.push({ id: k.id, email: k.email, ok: true });
      } else {
        const reden = uitkomst?.error || 'onbekende mailfout';
        const pogingen = (huidige || 0) + 1;
        if (pogingen >= MAX_POGINGEN) {
          // Cap bereikt: opgeven (claim blijft staan, gaveup gezet → niet meer oppakken).
          await markeer(k.id, { herinnering_gaveup_at: new Date().toISOString(), herinnering_kanalen: { email: { ok: false, error: reden, pogingen } } });
          summary.opgegeven += 1;
        } else {
          // Tijdelijke fout: claim vrijgeven zodat een volgende run het opnieuw probeert.
          await geefVrij(k.id, { email: { ok: false, error: reden, pogingen, last_attempt_at: new Date().toISOString() } });
        }
        summary.resultaten.push({ id: k.id, email: k.email, ok: false, error: reden, pogingen });
      }
    }
  } catch (e) {
    console.error('[cron-event-herinnering]', e?.message || e);
    summary.errors.push(e?.message || String(e));
  }

  return res.status(200).json(summary);
}

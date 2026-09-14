// api/cron-events-geen-gehoor-reacties.js
//
// IEMAND ANTWOORDT ALSNOG, EN DE KLOK LOOPT DOOR.
//
// De automatisatie 'Geen gehoor - laatste kans' stuurt een mail met een
// deadline van 48 uur en annuleert daarna de inschrijving als er niets
// binnenkomt. Die controle gebeurt ÉÉN keer, op het moment dat de wachtstap
// afloopt. Antwoordt iemand op dag één, dan weet niemand dat tot de deadline
// verstrijkt — het antwoord ligt in de inbox of in de WhatsApp-lijn, en de
// deelnemer denkt dat het geregeld is.
//
// Deze cron loopt elke 15 minuten langs de LOPENDE runs en meldt elk nieuw
// inkomend bericht aan Maxim, met de tekst erbij en de zin dat de plek nog
// niet vervallen is.
//
// ── ÉÉN METING, TWEE GEBRUIKERS ─────────────────────────────────────────
// De vraag 'heeft deze persoon iets van zich laten horen?' staat in
// _lib/events-geen-gehoor-reactie.js, en de condition-check van de
// automatisatie gebruikt dezelfde functie. Zouden die twee elk hun eigen
// definitie hebben, dan kan deze cron 'hij heeft geantwoord' melden terwijl de
// automatisatie een uur later 'niets binnengekomen' concludeert en de plek
// afneemt.
//
// ── IDEMPOTENT PER BERICHT-ID, ZONDER NIEUWE TABEL ──────────────────────
// De gemelde bericht-ids gaan in `event_automation_runs.context`
// (jsonb, `gemelde_reacties`). Die kolom wordt door de engine gezet op `{}` bij
// inschrijving en daarna nooit meer aangeraakt — advanceRun schrijft alleen
// current_step_index / status / next_run_at / attempts / last_error /
// completed_at. Vandaar hier, en niet in een eigen tabel: een migratie die nog
// niet gedraaid is zou deze cron kapot maken, en dan is het antwoord van een
// klant weer onzichtbaar.
//
// Een id komt er PAS in nadat de mail echt verstuurd is. Andersom zou een
// mislukte verzending het antwoord voorgoed verstoppen.
//
// ── NOOIT STIL SLAGEN ───────────────────────────────────────────────────
// Kan de cron niets meten, dan staat dat als `niet_gemeten` in het antwoord én
// in de logs, met de reden erbij, en is `ok` false. 'Geen treffers' en 'kon
// niet meten' zijn twee verschillende uitkomsten; ze op één hoop gooien is
// precies hoe je een maand later denkt dat er niemand antwoordt.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth).
// Methodes: GET (Vercel cron) + POST (handmatige debug-trigger).
// Schedule: */15 * * * * — zie vercel.json.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { meetInkomendeReacties } from './_lib/events-geen-gehoor-reactie.js';
import { geenGehoorDeadline, formatDeadlineNl } from './_lib/geen-gehoor-deadline.js';
import { sendEventMail } from './mailer.js';

/** Waar de melding naartoe gaat. */
const MELD_AAN = process.env.GEEN_GEHOOR_MELDING_EMAIL || 'maxim@deforexopleiding.nl';

/** Hoeveel lopende runs we per keer nakijken. */
const MAX_RUNS = 200;

/** Stoppen vóór de Vercel-limiet van 60s. */
const ABORT_MS = 45_000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const startedAt = Date.now();
  const uit = {
    ok            : true,
    niet_gemeten  : false,
    reden         : null,
    automatisaties: 0,
    runs_bekeken  : 0,
    reacties      : 0,
    gemeld        : 0,
    al_gemeld     : 0,
    mail_mislukt  : 0,
    onmeetbaar    : [],   // [{ run_id, attendee_id, reden }]
    afgebroken    : false,
    meldingen     : [],   // [{ naam, event, kanaal, tijdstip }]
  };

  try {
    // ── 1 · De automatisaties die op een belstatus starten ───────────────
    const { data: autos, error: autoErr } = await supabaseAdmin
      .from('event_automations')
      .select('id, name, trigger_config')
      .eq('trigger_type', 'on_call_status');
    if (autoErr) throw new Error('automatisaties lezen: ' + autoErr.message);

    uit.automatisaties = (autos || []).length;
    if (uit.automatisaties === 0) {
      // GEEN AUTOMATISATIE IS NIET 'NIET GEMETEN'. Er is dan niets om te meten,
      // en dat is een geldige uitkomst — de automatisatie is nog niet
      // aangemaakt of staat uit zonder ooit iemand ingeschreven te hebben.
      uit.reden = 'geen automatisatie met trigger_type on_call_status';
      uit.duration_ms = Date.now() - startedAt;
      return res.status(200).json(uit);
    }
    const autoById = new Map((autos || []).map((a) => [a.id, a]));

    // ── 2 · De lopende runs ───────────────────────────────────────────────
    // Alleen 'active': een run die al geannuleerd heeft is 'completed' of
    // 'exited', en dan is de zin 'je plek is nog niet vervallen' niet waar.
    const { data: runs, error: runErr } = await supabaseAdmin
      .from('event_automation_runs')
      .select('id, automation_id, attendee_id, event_id, status, context, started_at')
      .eq('status', 'active')
      .in('automation_id', [...autoById.keys()])
      .order('started_at', { ascending: true })
      .limit(MAX_RUNS);
    if (runErr) throw new Error('runs lezen: ' + runErr.message);

    for (const run of (runs || [])) {
      if (Date.now() - startedAt > ABORT_MS) { uit.afgebroken = true; break; }
      uit.runs_bekeken += 1;
      try {
        await verwerkRun({ run, auto: autoById.get(run.automation_id) || null, uit });
      } catch (e) {
        // PER RUN EEN TRY/CATCH. Eén kapotte rij mag de rest van de batch niet
        // blokkeren — en de fout gaat in onmeetbaar, niet in de stilte.
        console.error('[cron-events-geen-gehoor-reacties] run', run.id, e?.message || e);
        uit.onmeetbaar.push({
          run_id: run.id, attendee_id: run.attendee_id,
          reden : 'onverwachte fout: ' + (e?.message || e),
        });
      }
    }

    // Kon er van geen enkele bekeken run gemeten worden, dan heeft deze run
    // niets gemeten — ook al gaf elke losse query netjes antwoord.
    if (uit.runs_bekeken > 0 && uit.onmeetbaar.length === uit.runs_bekeken) {
      uit.ok = false;
      uit.niet_gemeten = true;
      uit.reden = 'geen enkele lopende run was meetbaar (' + uit.runs_bekeken + ' bekeken)';
      console.error('[cron-events-geen-gehoor-reacties] niet_gemeten:', uit.reden,
        JSON.stringify(uit.onmeetbaar.slice(0, 3)));
    }
  } catch (e) {
    // EEN GEFAALDE QUERY IS GEEN 'ALLES RUSTIG'. ok=false + niet_gemeten, zodat
    // een reeks lege runs in de logs niet als 'niemand antwoordt' leest.
    uit.ok = false;
    uit.niet_gemeten = true;
    uit.reden = e?.message || String(e);
    console.error('[cron-events-geen-gehoor-reacties] niet_gemeten:', uit.reden);
  }

  uit.duration_ms = Date.now() - startedAt;
  return res.status(200).json(uit);
}

/**
 * Eén lopende run: is er iets binnengekomen, en is dat al gemeld?
 *
 * Muteert `uit` (de tellers van de cron) en stuurt hoogstens één mail per
 * nieuw bericht.
 */
async function verwerkRun({ run, auto, uit }) {
  const { data: attendee, error: attErr } = await supabaseAdmin
    .from('event_attendees')
    .select('id, event_id, first_name, last_name, email, phone, status, call_status, call_status_at')
    .eq('id', run.attendee_id)
    .maybeSingle();
  if (attErr) {
    uit.onmeetbaar.push({ run_id: run.id, attendee_id: run.attendee_id,
      reden: 'deelnemer lezen: ' + attErr.message });
    return;
  }
  if (!attendee) {
    // De rij is weg. Niets te meten, en dat is een feit en geen fout: de
    // engine zet zo'n run bij de volgende tick zelf op 'cancelled'.
    uit.onmeetbaar.push({ run_id: run.id, attendee_id: run.attendee_id,
      reden: 'deelnemer bestaat niet meer' });
    return;
  }

  const { data: event, error: evErr } = await supabaseAdmin
    .from('events')
    .select('id, title, starts_at, location')
    .eq('id', attendee.event_id)
    .maybeSingle();
  if (evErr) {
    uit.onmeetbaar.push({ run_id: run.id, attendee_id: attendee.id,
      reden: 'event lezen: ' + evErr.message });
    return;
  }

  // ── DE METING, dezelfde als die van de condition-check ────────────────
  // De client gaat EXPLICIET mee. De lib heeft supabaseAdmin als default, maar
  // dan hangt de meting aan de module-instantie van die lib in plaats van aan
  // deze handler — en dan meet een test (of een tweede runtime) met de
  // verkeerde databank zonder dat iemand het ziet.
  const meting = await meetInkomendeReacties({
    phone   : attendee.phone,
    email   : attendee.email,
    sinceIso: attendee.call_status_at,
    db      : supabaseAdmin,
  });
  if (meting.niet_gemeten) {
    uit.onmeetbaar.push({ run_id: run.id, attendee_id: attendee.id, reden: meting.reden });
    return;
  }
  if (meting.treffers.length === 0) return;   // gemeten, en er is niets. Rustig.

  uit.reacties += meting.treffers.length;

  // ── IDEMPOTENT PER BERICHT-ID ─────────────────────────────────────────
  const ctx = (run.context && typeof run.context === 'object') ? run.context : {};
  const alGemeld = new Set(Array.isArray(ctx.gemelde_reacties) ? ctx.gemelde_reacties : []);
  const nieuw = meting.treffers.filter((t) => !alGemeld.has(t.bericht_id));
  uit.al_gemeld += meting.treffers.length - nieuw.length;
  if (nieuw.length === 0) return;

  const deadline = geenGehoorDeadline({
    callStatusAt : attendee.call_status_at,
    eventStartsAt: event ? event.starts_at : null,
  });

  const verstuurd = [];
  for (const treffer of nieuw) {
    try {
      const mail = bouwMelding({ attendee, event, auto, treffer, deadline });
      const r = await sendEventMail({ to: MELD_AAN, subject: mail.subject, text: mail.text, html: mail.html });
      if (r && r.ok === false) throw new Error(r.error || 'mail geweigerd');
      verstuurd.push(treffer.bericht_id);
      uit.gemeld += 1;
      uit.meldingen.push({
        naam    : naamVan(attendee),
        event   : (event && event.title) || attendee.event_id,
        kanaal  : treffer.kanaal,
        tijdstip: treffer.tijdstip,
      });
    } catch (e) {
      // NIET IN context OPNEMEN. Een mislukte verzending mag het antwoord niet
      // voorgoed verstoppen: de volgende ronde probeert 'm opnieuw.
      uit.mail_mislukt += 1;
      console.error('[cron-events-geen-gehoor-reacties] mail voor', treffer.bericht_id,
        ':', e?.message || e);
    }
  }

  if (verstuurd.length === 0) return;

  // ── DE MERGE TERUG ────────────────────────────────────────────────────
  // Alleen de sleutel `gemelde_reacties` en de rest van context ongemoeid: die
  // jsonb is niet van deze cron alleen.
  const { error: ctxErr } = await supabaseAdmin
    .from('event_automation_runs')
    .update({ context: { ...ctx, gemelde_reacties: [...alGemeld, ...verstuurd] } })
    .eq('id', run.id);
  if (ctxErr) {
    // De mail is de deur uit. Lukt het bijhouden niet, dan komt er volgende
    // ronde een tweede — hinderlijk, maar beter dan een antwoord dat stil
    // blijft. Wel hard loggen: bij herhaling is dit een dubbele-mail-bron.
    console.error('[cron-events-geen-gehoor-reacties] context bijwerken run',
      run.id, ':', ctxErr.message);
  }
}

function naamVan(a) {
  const delen = [a && a.first_name, a && a.last_name]
    .map((s) => (s == null ? '' : String(s).trim())).filter(Boolean);
  return delen.join(' ') || (a && (a.email || a.phone || a.id)) || 'onbekend';
}

const ZONE = 'Europe/Amsterdam';
function tijdNl(iso) {
  const ms = iso == null ? NaN : Date.parse(iso);
  if (!Number.isFinite(ms)) return 'onbekend tijdstip';
  try {
    return new Intl.DateTimeFormat('nl-NL', {
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ZONE,
    }).format(new Date(ms));
  } catch (_e) { return 'onbekend tijdstip'; }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * De melding zelf: wie, welk event, via welk kanaal, wanneer, en wat er staat.
 *
 * Plus de twee dingen die Maxim nodig heeft om te beslissen: dat de plek NOG
 * NIET vervallen is, en wat de deadline was. Zonder die twee moet hij het
 * dossier erbij zoeken om te weten of hij nog tijd heeft.
 */
export function bouwMelding({ attendee, event, auto, treffer, deadline }) {
  const naam      = naamVan(attendee);
  const eventNaam = (event && event.title) || 'onbekend event';
  const eventDag  = event && event.starts_at ? tijdNl(event.starts_at) : 'onbekende datum';
  const kanaal    = treffer.kanaal === 'whatsapp' ? 'WhatsApp' : 'e-mail';
  const wanneer   = tijdNl(treffer.tijdstip);
  const deadlineT = deadline ? formatDeadlineNl(deadline) : 'onbekend (geen belstatus-tijdstip)';

  // EERLIJK OVER DE STAND. De cron kijkt alleen naar lopende runs, dus normaal
  // is de plek er nog. Staat de inschrijving toch al op geannuleerd, dan is de
  // zin 'nog niet vervallen' onwaar en zeggen we dat ook.
  const alGeannuleerd = String(attendee.status || '').toLowerCase() === 'geannuleerd';
  const stand = alGeannuleerd
    ? 'LET OP: de inschrijving staat al op GEANNULEERD. Dit antwoord kwam na het verlopen '
      + 'van de deadline, of de plek is met de hand weggehaald. Wil je hem terug, zet de '
      + 'inschrijving dan handmatig op aangemeld.'
    : 'De plek is NOG NIET vervallen. De automatisatie loopt nog; reageer je hierop, dan '
      + 'kun je hem gewoon op bevestigd zetten.';

  const regels = [
    `${naam} heeft gereageerd via ${kanaal}.`,
    '',
    `Wanneer: ${wanneer}`,
    `Event:   ${eventNaam} (${eventDag})`,
    `Contact: ${attendee.email || 'geen e-mailadres'} / ${attendee.phone || 'geen nummer'}`,
    `Flow:    ${(auto && auto.name) || 'geen gehoor - laatste kans'}`,
    `Deadline in de mail: ${deadlineT}`,
    '',
    'Wat hij stuurde:',
    treffer.tekst,
    '',
    stand,
  ];

  return {
    subject: `Reactie na geen gehoor: ${naam} (${eventNaam})`,
    text   : regels.join('\n'),
    html   :
      `<p><b>${esc(naam)}</b> heeft gereageerd via <b>${esc(kanaal)}</b>.</p>` +
      '<table style="font-size:14px;border-collapse:collapse">' +
      `<tr><td style="padding:2px 10px 2px 0;color:#6b7280">Wanneer</td><td>${esc(wanneer)}</td></tr>` +
      `<tr><td style="padding:2px 10px 2px 0;color:#6b7280">Event</td><td>${esc(eventNaam)} (${esc(eventDag)})</td></tr>` +
      `<tr><td style="padding:2px 10px 2px 0;color:#6b7280">Contact</td><td>${esc(attendee.email || 'geen e-mailadres')} / ${esc(attendee.phone || 'geen nummer')}</td></tr>` +
      `<tr><td style="padding:2px 10px 2px 0;color:#6b7280">Flow</td><td>${esc((auto && auto.name) || 'geen gehoor - laatste kans')}</td></tr>` +
      `<tr><td style="padding:2px 10px 2px 0;color:#6b7280">Deadline</td><td>${esc(deadlineT)}</td></tr>` +
      '</table>' +
      `<p style="margin-top:14px"><b>Wat hij stuurde:</b></p>` +
      `<blockquote style="margin:0;padding:8px 12px;border-left:3px solid #093d54;background:#f7f8fa;white-space:pre-wrap">${esc(treffer.tekst)}</blockquote>` +
      `<p style="margin-top:14px;${alGeannuleerd ? 'color:#b42318' : ''}">${esc(stand)}</p>`,
  };
}

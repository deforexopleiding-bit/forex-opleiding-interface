// api/mijn-calls-vandaag.js
//
// MIJN CALLS VAN VANDAAG — de teller achter de closer-topbar in de v2-shell.
//
// GET /api/mijn-calls-vandaag
//   → 200 {
//       dag            : 'YYYY-MM-DD'   (vandaag, Amsterdam)
//       startdatum     : 'YYYY-MM-DD'   (call_rapportage_startdatum)
//       totaal         : n   relevante calls vandaag (gepland + te beoordelen)
//       te_beoordelen  : n   voorbij duur + 15 min, of al beoordeeld
//       vastgelegd     : n   daarvan met een uitkomst
//       open           : n   te_beoordelen zonder uitkomst
//       gepland_nog    : n   nog niet voorbij, nog geen uitkomst
//       rows           : [{ id, scheduled_at, duration_minutes, staat, vastgelegd }]
//       gisteren       : 'YYYY-MM-DD'
//       gisteren_open  : n   calls van gisteren, te beoordelen, zonder uitkomst
//       heeft_afspraken: bool  bezit deze gebruiker überhaupt afspraken?
//       melding        : { verstuurd: n } | null
//     }
//   → 401 zonder sessie, 403 zonder recht calls.closer.
//
// ── WIE IS EEN CLOSER ───────────────────────────────────────────────────────
// Het recht `calls.closer` (role_permissions / user_permissions), geen rol. Zie
// docs/sql-migrations/2026-10-01-calls-closer-recht.sql voor het waarom. Zonder
// die migratie heeft alleen super_admin het recht (de OR-tak in
// user_has_permission) — en die bezit geen afspraken, dus ziet niets.
//
// ── WAT TELT ────────────────────────────────────────────────────────────────
// De set is relevanteAfspraken() uit het rapport: geannuleerd, verplaatst en
// onbeoordeelbaar vallen weg, net als in de zoomcall-lijst van Maxim — behalve
// een rij die al een uitkomst draagt (zie telMijnCalls). Een call
// is pas 'te beoordelen' na duur + 15 minuten (callStaat). Een call waar Dave
// al een uitkomst bij zette vóór die tijd, telt WEL als beoordeeld: wat
// vastgelegd is, is vastgelegd — anders verdwijnt zijn werk tot de klok
// bijtrekt.
//
// Alleen calls vanaf de startdatum (api/_lib/call-rapportage-start.js). Wat
// daarvoor zonder uitkomst bleef, is geen achterstand van nu.
//
// ── DE MELDING VAN DE VOLGENDE DAG ──────────────────────────────────────────
// Staan er van gisteren nog calls zonder uitkomst, dan krijgen de closer en
// super_admin één melding per Amsterdamse dag. Die wordt HIER gemaakt, bij de
// eerste poll van de topbar, en niet in een cron:
//   - een nieuwe cron is een tweede plek die dezelfde telling moet kennen;
//   - de enige ochtendcron van deze module (cron-opvolging-gezondheid) is met
//     opzet alleen-lezen, en daar een schrijvende stap in hangen breekt dat;
//   - de topbar pollt toch al, dus het moment komt vanzelf.
// Ontdubbeld op een vaste entity_id per (closer, dag): opnieuw pollen maakt
// geen tweede rij. Opent de closer het CRM die dag niet, dan komt er geen
// melding — dan ziet super_admin het in het rapport. Fail-soft: een mislukte
// melding breekt de teller nooit.

import { createHash } from 'node:crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { createNotification } from './_lib/notify.js';
import { leesCallRapportageStart } from './_lib/call-rapportage-start.js';
import { categorieVoorUitkomst } from './_lib/call-uitkomst-categorie.js';
import { nlDayStart, nlDayEndExclusive, nlDateString, _internals } from './_lib/nl-period.js';
import { relevanteAfspraken, callStaat } from './opvolging-rapport.js';

export const CLOSER_RECHT = 'calls.closer';
export const MELDING_TYPE = 'calls.gisteren_open';
export const OPVOLGING_LINK = '/modules/klanten-v2/?v2preview=opvolging&v2tab=Vandaag';
export const RAPPORT_LINK = '/modules/klanten-v2/?v2preview=opvolging&v2tab=Rapport';

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC-moment van 00:00 Amsterdam op een 'YYYY-MM-DD'. */
function nlMiddernachtMs(dag) {
  const [y, m, d] = String(dag).split('-').map(Number);
  return _internals.nlLocalToUtc(y, m, d, 0, 0).getTime();
}

/**
 * De dagen en het tijdvenster voor één poll. Puur, op nuMs.
 * @returns {{ dag, gisteren, vanMs, totMs, startdatum }}
 *   vanMs/totMs = het queryvenster (gisteren 00:00 of de startdatum, wat later
 *   is, tot morgen 00:00). vanMs >= totMs betekent: niets op te halen.
 */
export function vensterVoor(nuMs, startdatum) {
  const nu = new Date(nuMs);
  const dagStart = nlDayStart(nu);
  const gisterStart = nlDayStart(new Date(dagStart.getTime() - 1));
  const start = DATUM_RE.test(String(startdatum || '')) ? nlMiddernachtMs(startdatum) : -Infinity;
  return {
    dag     : nlDateString(nu),
    gisteren: nlDateString(gisterStart),
    vanMs   : Math.max(gisterStart.getTime(), start),
    totMs   : nlDayEndExclusive(nu).getTime(),
    startdatum,
  };
}

/** Heeft deze rij een uitkomst die iets over het gesprek zegt? */
function heeftUitkomst(a) {
  return categorieVoorUitkomst(a && a.uitkomst) !== null;
}

/**
 * DE TELLING — puur, getest in tests/closer-topbar.test.js.
 *
 * @param {Array} afspraken  rijen van follow_up_appointments (één eigenaar)
 * @param {{ nuMs:number, startdatum:string }} opties
 */
export function telMijnCalls(afspraken, { nuMs, startdatum }) {
  const v = vensterVoor(nuMs, startdatum);
  const binnen = (afspraken || []).filter((a) => {
    if (!a || a.is_test === true) return false;
    const t = Date.parse(a.scheduled_at);
    if (!Number.isFinite(t)) return false;
    // Op de Amsterdamse dag, nooit op de UTC-dag: een call om 00:30 's nachts
    // in de zomer staat in UTC nog op de dag ervoor.
    return t >= v.vanMs && t < v.totMs;
  });

  // relevanteAfspraken() + één uitzondering: een rij MET uitkomst blijft
  // staan, ook als de status hem zou laten wegvallen. 'Geen interesse' en
  // 'niet geschikt' zetten de afspraak op 'cancelled' (zie de motor); zonder
  // deze regel verdwijnt elke call die Dave zo afrondt uit de noemer, en zakt
  // 'X/Y beoordeeld' terwijl hij juist werk deed. Een verzette voorganger met
  // een opvolger in de set blijft wél weg (anders telt dezelfde persoon twee
  // keer), en een verwijderde afspraak telt nergens.
  const basis = new Set(relevanteAfspraken(binnen, nuMs));
  const opvolgers = new Set(binnen.map((a) => a.parent_appointment_id).filter(Boolean).map(String));
  const relevant = binnen.filter((a) => basis.has(a) || (
    heeftUitkomst(a)
    && String(a.status || '') !== 'verwijderd'
    && !opvolgers.has(String(a.id))
  ));
  const vandaag = [];
  let gisterenOpen = 0;
  for (const a of relevant) {
    const dag = nlDateString(new Date(Date.parse(a.scheduled_at)));
    const vastgelegd = heeftUitkomst(a);
    const staat = vastgelegd ? 'te_beoordelen' : callStaat(a, nuMs);
    if (dag === v.dag) vandaag.push({ a, staat, vastgelegd });
    else if (dag === v.gisteren && staat === 'te_beoordelen' && !vastgelegd) gisterenOpen += 1;
  }

  const teBeoordelen = vandaag.filter((r) => r.staat === 'te_beoordelen');
  const vastgelegd = teBeoordelen.filter((r) => r.vastgelegd).length;
  vandaag.sort((x, y) => Date.parse(x.a.scheduled_at) - Date.parse(y.a.scheduled_at));

  return {
    dag          : v.dag,
    startdatum   : v.startdatum,
    totaal       : vandaag.length,
    te_beoordelen: teBeoordelen.length,
    vastgelegd,
    open         : teBeoordelen.length - vastgelegd,
    gepland_nog  : vandaag.length - teBeoordelen.length,
    rows         : vandaag.map((r) => ({
      id              : r.a.id,
      scheduled_at    : r.a.scheduled_at,
      duration_minutes: r.a.duration_minutes ?? null,
      staat           : r.staat,
      vastgelegd      : r.vastgelegd,
    })),
    gisteren     : v.gisteren,
    gisteren_open: gisterenOpen,
  };
}

/**
 * Vaste uuid per (closer, dag) — de sleutel waarop de melding ontdubbelt.
 * notifications.entity_id is een uuid, een datum past daar niet in.
 */
export function meldingSleutel(userId, dag) {
  const h = createHash('sha256').update('calls.gisteren_open:' + userId + ':' + dag).digest('hex');
  // Vorm 8-4-4-4-12, versie-nibble 8 (eigen schema), variant 10xx.
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-8' + h.slice(13, 16) + '-' + variant + h.slice(17, 20) + '-' + h.slice(20, 32);
}

function callsWoord(n) { return n === 1 ? '1 call' : n + ' calls'; }

/**
 * De melding van de volgende dag. Fail-soft; geeft het aantal nieuwe rijen.
 * Eerst één goedkope blik of de closer hem vandaag al heeft — dan is er niets
 * te doen en blijft het bij die ene query per poll.
 */
export async function meldGisterenOpen({ db, notify, userId, gisteren, aantal }) {
  if (!(aantal > 0) || !userId || !gisteren) return { verstuurd: 0 };
  const entityId = meldingSleutel(userId, gisteren);
  try {
    const { data: al, error } = await db.from('notifications')
      .select('id').eq('user_id', userId).eq('type', MELDING_TYPE).eq('entity_id', entityId).limit(1);
    if (error) console.warn('[mijn-calls-vandaag] meldingscontrole faalde (soft):', error.message);
    else if (Array.isArray(al) && al.length) return { verstuurd: 0, al_gemeld: true };

    let naam = 'Closer';
    const { data: prof } = await db.from('profiles').select('full_name, email').eq('id', userId).maybeSingle();
    if (prof) naam = prof.full_name || prof.email || naam;

    const gemeen = {
      type: MELDING_TYPE, entityType: 'calls_dag', entityId, priority: 'high',
      dedupWithinMs: 3 * 24 * 3600 * 1000,
    };
    const a = await notify({
      ...gemeen, toUserId: userId,
      title: 'Gisteren nog ' + callsWoord(aantal) + ' zonder uitkomst',
      body: 'Vul de uitkomst nu in: Opvolging → Vandaag, blok ‘Nog af te ronden’ (' + gisteren + ').',
      linkUrl: OPVOLGING_LINK,
    });
    const b = await notify({
      ...gemeen, toRole: 'super_admin',
      title: naam + ': gisteren nog ' + callsWoord(aantal) + ' zonder uitkomst',
      body: 'Calls van ' + gisteren + ' zonder vastgelegde uitkomst. Zie het rapport.',
      linkUrl: RAPPORT_LINK,
    });
    return { verstuurd: (a?.count || 0) + (b?.count || 0) };
  } catch (e) {
    console.warn('[mijn-calls-vandaag] melding faalde (soft):', e?.message || e);
    return { verstuurd: 0, fout: true };
  }
}

/**
 * Handler met injecteerbare afhankelijkheden, zodat de rechtenpoort zonder
 * module-mocks te testen is. De default export gebruikt de echte.
 */
export function maakHandler(deps = {}) {
  const {
    db = supabaseAdmin,
    userVan = async (req) => {
      const { data } = await createUserClient(req).auth.getUser();
      return data?.user || null;
    },
    magHet = (req) => requirePermission(req, CLOSER_RECHT),
    notify = createNotification,
    nu = () => Date.now(),
  } = deps;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

    let user = null;
    try { user = await userVan(req); } catch { user = null; }
    if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    // Strikt, geen fail-open: zonder het recht is er geen topbar.
    if (!(await magHet(req))) {
      return res.status(403).json({
        error: 'Geen rechten (' + CLOSER_RECHT + ')',
        hint : 'Zie docs/sql-migrations/2026-10-01-calls-closer-recht.sql.',
      });
    }

    try {
      const nuMs = nu();
      const startdatum = await leesCallRapportageStart(db);
      const v = vensterVoor(nuMs, startdatum);

      let afspraken = [];
      if (v.vanMs < v.totMs) {
        // EÉN query: gisteren + vandaag, alleen eigen calls, geen testrijen.
        // supabaseAdmin met owner_id = de geverifieerde gebruiker: de filter is
        // de identiteit uit de JWT, niet iets uit de request.
        const { data, error } = await db.from('follow_up_appointments')
          .select('id, scheduled_at, duration_minutes, status, uitkomst, parent_appointment_id, is_test')
          .eq('owner_id', user.id)
          .eq('is_test', false)
          .gte('scheduled_at', new Date(v.vanMs).toISOString())
          .lt('scheduled_at', new Date(v.totMs).toISOString())
          .order('scheduled_at', { ascending: true })
          .limit(500);
        if (error) throw new Error('follow_up_appointments: ' + error.message);
        afspraken = data || [];
      }

      const telling = telMijnCalls(afspraken, { nuMs, startdatum });

      // Goedkope vervolgvraag alleen bij een lege set: bezit deze gebruiker
      // überhaupt afspraken? Nee → de topbar stopt met pollen.
      let heeftAfspraken = afspraken.length > 0;
      if (!heeftAfspraken) {
        const { count, error } = await db.from('follow_up_appointments')
          .select('id', { count: 'exact', head: true })
          .eq('owner_id', user.id).eq('is_test', false).limit(1);
        heeftAfspraken = error ? true : (count || 0) > 0;
      }

      const melding = telling.gisteren_open > 0
        ? await meldGisterenOpen({ db, notify, userId: user.id, gisteren: telling.gisteren, aantal: telling.gisteren_open })
        : null;

      return res.status(200).json({ ...telling, heeft_afspraken: heeftAfspraken, melding });
    } catch (e) {
      console.error('[mijn-calls-vandaag] fout:', e?.message || e);
      return res.status(500).json({ error: 'Interne fout' });
    }
  };
}

export default maakHandler();

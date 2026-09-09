// api/cron-opvolging-no-show.js
//
// EEN NO-SHOW WORDT EEN KAART, OOK ALS DAVE NIET OP DE KNOP DRUKTE.
//
// De keten die dit nodig maakt: de zoomcalls van 8 september die no-show
// werden zijn nooit in de opvolgmodule als no-show gemarkeerd, dus is er nooit
// een kaart ontstaan, dus zijn ze nooit meegekomen naar vandaag.
//
// Deze cron is de tweede aanleiding naast de knop. Zie
// api/_lib/opvolging-no-show.js voor de regel, de harde datumgrens, en waarom
// dit een wachter op de uitkomst is en geen haak in de synchronisatie.
//
// Idempotent op `bron_ref.appointment_id` — de enige sleutel. Drukt Dave zelf
// op no-show en komt de status daarna nog eens langs, dan blijft er één kaart.
//
// Auth: Authorization: Bearer $CRON_SECRET (de Run-knop in Vercel stuurt die
// zelf mee). Methodes: GET (cron) + POST (handmatig).
// Query: ?droog=1 rekent alles uit en schrijft NIETS — gebruik dat om te zien
// wie erin zou komen voordat je de grens verzet.
//
// Leest follow_up_appointments; schrijft uitsluitend in opvolging_taken.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import {
  bepaalNoShowKaart, kaartenPerAfspraak, NO_SHOW_VANAF, REDEN, AANMAKEN,
} from './_lib/opvolging-no-show.js';

const ABORT_MS = 25_000;
const MAX = 500;

const dagInZone = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

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
  const q = { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const droog = String(q.droog || '') === '1' || q.droog === true;

  const summary = {
    grens: NO_SHOW_VANAF,
    droog,
    bekeken     : 0,
    aangemaakt  : 0,
    overgeslagen: {},
    voorbeelden : [],
    errors      : [],
    duration_ms : 0,
  };

  try {
    // ── De no-shows vanaf de grens ───────────────────────────────────────
    // Ruim onder de grens beginnen (26 uur) zodat de tijdzone geen randgeval
    // wegsnijdt; de echte grens ligt in bepaalNoShowKaart, op de Amsterdamse
    // dag van de afspraak.
    const vanafIso = new Date(Date.parse(NO_SHOW_VANAF + 'T00:00:00Z') - 26 * 3600 * 1000).toISOString();
    const { data: noShows, error: e1 } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, zoom_join_url')
      .eq('status', 'no_show')
      .gte('scheduled_at', vanafIso)
      .order('scheduled_at', { ascending: true })
      .limit(MAX);
    if (e1) throw new Error('no-shows lezen: ' + e1.message);
    summary.bekeken = (noShows || []).length;
    if (!noShows || noShows.length === 0) {
      summary.duration_ms = Date.now() - startedAt;
      console.log('[cron-opvolging-no-show] geen no-shows vanaf ' + NO_SHOW_VANAF);
      return res.status(200).json({ ok: true, summary });
    }

    // ── Bestaande kaarten, op appointment_id ─────────────────────────────
    // ALLE niet-gearchiveerde no_show_call-kaarten, ongeacht wie ze maakte:
    // de knop zet dezelfde reden en dezelfde sleutel. Zonder deze stap
    // ontstaat er een tweede kaart naast die van Dave.
    const { data: kaartRijen, error: e2 } = await supabaseAdmin
      .from('opvolging_taken')
      .select('id, status, bron_ref')
      .eq('reden', REDEN)
      .neq('status', 'gearchiveerd')
      .limit(2000);
    if (e2) throw new Error('kaarten lezen: ' + e2.message);
    const kaartPerAfspraak = kaartenPerAfspraak(kaartRijen);

    const vandaag = dagInZone(Date.now());

    for (const a of noShows) {
      if (Date.now() - startedAt > ABORT_MS) {
        summary.errors.push({ fase: 'tijdbudget', message: 'afgebroken voor het einde' });
        break;
      }
      try {
        const besluit = bepaalNoShowKaart({
          afspraak: a,
          kaartVanAfspraak: kaartPerAfspraak.get(String(a.id)) || null,
        });

        if (besluit.actie !== AANMAKEN) {
          summary.overgeslagen[besluit.code] = (summary.overgeslagen[besluit.code] || 0) + 1;
          continue;
        }

        if (summary.voorbeelden.length < 25) {
          summary.voorbeelden.push({ naam: besluit.naam, dag: besluit.dag, tijd: besluit.tijd });
        }
        if (droog) { summary.aangemaakt += 1; continue; }

        const { error } = await supabaseAdmin.from('opvolging_taken')
          .insert({ ...besluit.kaart, due: vandaag, eigenaar_id: null });
        if (error) throw new Error('aanmaken: ' + error.message);
        // Meteen in de kaart-map, zodat een dubbele rij in dezelfde run (twee
        // afspraken met hetzelfde id kan niet, maar defensief) geen tweede
        // kaart oplevert.
        kaartPerAfspraak.set(String(a.id), { id: null });
        summary.aangemaakt += 1;
        console.log('[cron-opvolging-no-show] kaart voor ' + besluit.naam
          + ' (' + besluit.dag + ' ' + besluit.tijd + ')');
      } catch (e) {
        // Per afspraak vangen: één rij die weigert mag de rest niet laten liggen.
        summary.errors.push({ appointment_id: a.id, error: e?.message || String(e) });
        console.error('[cron-opvolging-no-show] afspraak faalde', a.id, e?.message || e);
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    console.log('[cron-opvolging-no-show] klaar', JSON.stringify({
      grens: summary.grens, bekeken: summary.bekeken,
      aangemaakt: summary.aangemaakt, overgeslagen: summary.overgeslagen, droog,
    }));
    return res.status(200).json({ ok: true, summary });
  } catch (e) {
    summary.duration_ms = Date.now() - startedAt;
    console.error('[cron-opvolging-no-show] fataal:', e?.message || e);
    summary.errors.push({ fase: 'fataal', error: e?.message || String(e) });
    return res.status(500).json({ ok: false, summary });
  }
}

// api/_lib/whatsapp-taak.js
//
// Zet één taak klaar in Takenbeheer: "stuur deze lead een WhatsApp".
//
// WANNEER
// Na de tweede vergeefse belpoging op een event-lead. Er is dan nog precies
// één belpoging over, dus dit is het moment om een ander kanaal te proberen
// in plaats van nog eens hetzelfde. Het moment zelf staat niet hier maar in
// _lib/followup-cadans.js (`taakBijPoging`), zodat het per herkomst op één
// plek te verzetten is.
//
// WAAR DE TAAK LANDT
// `taken_items` — dezelfde tabel als de Takenbeheer-module in de zijbalk.
// De lijst "Mijn taken" matcht op `assigned_to_id` OF op een rij in
// `taken_assignees` (api/taken.js r105, r130-134). Wij zetten
// `assigned_to_id`; dat is genoeg om de taak in iemands lijst te krijgen.
// Verder volgen we het patroon van api/cron/future-call-reminder.js, de
// bestaande plek waar een cron een taak aanmaakt: dezelfde velden, en
// `created_by_agent: true` zodat zichtbaar is dat dit geen mens was.
//
// AAN WIE
// NIET hardgecodeerd. De verantwoordelijke staat in `app_settings` onder de
// sleutel `whatsapp_verantwoordelijke`, als { user_id }. Staat daar niets,
// dan valt hij terug op de omgevingsvariabele WHATSAPP_VERANTWOORDELIJKE_ID.
// Is er allebei niets, dan wordt er GEEN taak gemaakt en komt er een
// waarschuwing in de log — een taak zonder eigenaar helpt niemand, en een
// stille taak in het niets is erger dan geen taak.
// Wisselt de verantwoordelijke, dan is dat één rij in app_settings; niemand
// hoeft daarvoor in de code te zoeken.
//
// ÉÉN KEER PER LEAD
// De belmotor kan dezelfde lead vaker langs poging 2 brengen (undo,
// heropenen, een nieuwe ronde). Zonder rem groeit de takenlijst dan vol met
// hetzelfde verzoek. De rem staat op de lead zelf, in `source_ref`:
// `whatsapp_taak_at` en `whatsapp_taak_id`. Staat die er, dan gebeurt er
// niets meer. Zelfde gedachte als de partial unique index die één open
// follow-up per deelnemer afdwingt, maar zonder migratie op een tabel
// waarvan het schema niet in deze repo staat.

import { supabaseAdmin } from '../supabase.js';
import { schrijfLeadNotitie } from './followup-notitie.js';

const APP_SETTING_KEY = 'whatsapp_verantwoordelijke';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Morgen als YYYY-MM-DD. Deadlines in Takenbeheer zijn datums, geen tijden. */
function morgenIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * De ingestelde WhatsApp-verantwoordelijke, of null.
 * Volgorde: app_settings → omgevingsvariabele → niets.
 */
export async function whatsappVerantwoordelijke() {
  try {
    const { data } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', APP_SETTING_KEY).maybeSingle();
    const v = data?.value;
    const uit = (v && typeof v === 'object') ? v.user_id : v;
    if (uit && UUID_RE.test(String(uit))) return String(uit);
  } catch (e) {
    console.warn('[whatsapp-taak] app_settings lezen faalde:', e?.message || e);
  }
  const uitEnv = process.env.WHATSAPP_VERANTWOORDELIJKE_ID || '';
  return UUID_RE.test(uitEnv) ? uitEnv : null;
}

/**
 * Maak de WhatsApp-taak voor één lead. Doet niets als er al één stond of als
 * er geen verantwoordelijke is ingesteld.
 *
 * Gooit nooit: een mislukte taak mag de uitkomst van het gesprek niet
 * tegenhouden. De belmotor heeft zijn werk al gedaan als dit draait.
 *
 * @returns {Promise<{status:'aangemaakt'|'bestond_al'|'geen_verantwoordelijke'|'fout',
 *                    taak_id?:string, source_ref?:object, reden?:string}>}
 */
export async function maakWhatsappTaak({ lead, sourceRef, prioriteit = 'Normaal', pogingNr = 2 }) {
  try {
    const ref = (sourceRef && typeof sourceRef === 'object') ? sourceRef : {};
    if (ref.whatsapp_taak_at) return { status: 'bestond_al' };

    const eigenaar = await whatsappVerantwoordelijke();
    if (!eigenaar) {
      console.warn(
        `[whatsapp-taak] geen verantwoordelijke ingesteld — geen taak voor lead ${lead?.id}. ` +
        `Zet app_settings.${APP_SETTING_KEY} = {"user_id":"<uuid>"}.`,
      );
      return { status: 'geen_verantwoordelijke' };
    }

    const naam = String(lead?.lead_name || '').trim() || 'onbekende lead';
    const telefoon = String(lead?.lead_phone || '').trim();
    const nowIso = new Date().toISOString();

    // De omschrijving moet op zichzelf staan: wie de taak oppakt heeft de
    // context van het belgesprek niet. Telefoonnummer erbij, want zonder
    // nummer kun je geen WhatsApp sturen.
    const regels = [
      `${naam} is na ${pogingNr} belpogingen niet bereikt. Probeer WhatsApp — spraakbericht of tekst.`,
      telefoon ? `Telefoon: ${telefoon}` : 'Telefoonnummer onbekend — zoek de lead op in Follow-up → Werklijst.',
      ref.event_id ? `Komt uit een event (event_id ${ref.event_id}).` : null,
      ref.reason ? `Notitie van het afronden: ${String(ref.reason).slice(0, 300)}` : null,
      lead?.customer_id
        ? 'Het klantdossier hangt aan deze taak.'
        : 'Geen klantdossier gekoppeld — te vinden via Follow-up → Werklijst op naam.',
    ].filter(Boolean);

    const taak = {
      titel           : `WhatsApp uitsturen (spraakbericht of tekst) — ${naam}`,
      omschrijving    : regels.join('\n'),
      prioriteit,
      // Bestaande categorie uit modules/klanten-v2/views/modals/taken-create.js.
      // Bewust geen nieuwe verzonnen.
      categorie       : 'Sales',
      assigned_to_id  : eigenaar,
      customer_id     : lead?.customer_id || null,
      // Morgen, niet vandaag: de derde belpoging komt pas over drie dagen,
      // dus er is een dag lucht, en een deadline van vandaag staat meteen
      // als "te laat" in de tellers.
      deadline        : morgenIso(),
      status          : 'todo',
      notities        : '',
      aangemaakt      : nowIso,
      updated_at      : nowIso,
      created_by      : eigenaar,
      owner_id        : eigenaar,   // legacy mirror, zoals api/taken.js
      created_by_id   : eigenaar,   // legacy mirror
      created_by_agent: true,       // dit was geen mens
    };

    const { data, error } = await supabaseAdmin
      .from('taken_items').insert(taak).select('id').single();
    if (error) {
      console.warn('[whatsapp-taak] insert faalde voor lead', lead?.id, ':', error.message);
      return { status: 'fout', reden: error.message };
    }

    return {
      status: 'aangemaakt',
      taak_id: data?.id || null,
      source_ref: { ...ref, whatsapp_taak_at: nowIso, whatsapp_taak_id: data?.id || null },
    };
  } catch (e) {
    console.warn('[whatsapp-taak] onverwachte fout:', e?.message || e);
    return { status: 'fout', reden: e?.message || 'onbekend' };
  }
}


// ─── DE LUS SLUITEN: TAAK KLAAR → TERUG NAAR DE LEAD ───────────────────────
//
// Zonder dit bestaat de taak los van de lead. Dave stuurt een WhatsApp en
// vinkt hem af, en de volgende beller ziet in de Werklijst niets: geen spoor
// dat er via een ander kanaal contact geprobeerd is, en een belmoment dat
// misschien een uur later valt. Een appje sturen en meteen daarna bellen is
// precies wat we niet willen.
//
// Twee dingen dus, zodra de taak op KLAAR komt:
//   1. één regel in het notitielog van de lead, in gewone taal, met datum;
//   2. het eerstvolgende belmoment een dag opschuiven, zodat het bericht
//      tijd krijgt om te landen.
// Op BEZIG gebeurt er niets — dat de taak in de kolom staat is genoeg.
//
// WAAR DIT VANDAAN GEROEPEN WORDT
// api/taken.js, in de status_change-tak (dat is wat het slepen in de
// Pipeline aanroept) en in de bewerk-tak. Geen webhook en geen trigger
// nodig: elke statuswijziging loopt sowieso door dat endpoint.
//
// HOE DE TAAK BIJ DE LEAD KOMT
// Bij het aanmaken zetten we whatsapp_taak_id in source_ref van de lead.
// Diezelfde sleutel is hier de weg terug — er is dus geen extra kolom op
// taken_items nodig. Is er geen lead met dit taak-id, dan is het gewoon een
// andere taak en gebeurt er niets.

/** Menselijke datum, bv. "27 augustus 2026". */
function datumNl(d) {
  try {
    return new Date(d).toLocaleDateString('nl-NL', {
      timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch (_) { return new Date(d).toISOString().slice(0, 10); }
}

async function naamVan(userId) {
  if (!userId) return null;
  try {
    const { data } = await supabaseAdmin
      .from('profiles').select('full_name').eq('id', userId).maybeSingle();
    const n = String(data?.full_name || '').trim();
    return n || null;
  } catch (_) { return null; }
}

const AFGESLOTEN_STATUSSEN = new Set(['verlengd', 'verloren']);

/**
 * Het belmoment een dag opschuiven. Vanaf het bestaande moment als dat nog
 * in de toekomst ligt, anders vanaf nu — zo is er altijd minstens een dag
 * lucht tussen het bericht en de volgende belpoging, ook als de lead al
 * over tijd was.
 *
 * Apart en geëxporteerd omdat dit het enige stukje rekenwerk is waar een
 * fout stil doorwerkt: een dag te weinig en je belt alsnog te vroeg.
 *
 * @param {string|null} bestaandIso  huidige terugbel_datum, mag leeg zijn
 * @param {Date}        nu
 * @returns {string} ISO-tijdstempel
 */
export function volgendBelmoment(bestaandIso, nu = new Date()) {
  const bestaand = bestaandIso ? new Date(bestaandIso) : null;
  const basis = (bestaand && !isNaN(bestaand.getTime()) && bestaand.getTime() > nu.getTime())
    ? bestaand : nu;
  return new Date(basis.getTime() + 24 * 3600 * 1000).toISOString();
}

/**
 * Reageer op een WhatsApp-taak die zojuist op 'done' is gezet.
 *
 * Gooit nooit en geeft nooit een fout terug die de statuswijziging zou mogen
 * blokkeren: de taak is al afgevinkt, en dat mag niet ongedaan gemaakt worden
 * omdat een vervolgstap misging.
 *
 * @returns {Promise<{status:'bijgewerkt'|'geen_lead'|'al_gedaan'|'lead_gesloten'|'fout', reden?:string}>}
 */
export async function whatsappTaakAfgerond({ taakId, doorUserId = null }) {
  try {
    if (!taakId) return { status: 'geen_lead' };

    // Welke lead hoort bij deze taak? Geen resultaat = niet onze taak.
    const { data: leads, error } = await supabaseAdmin
      .from('follow_up_leads')
      .select('id, lead_status, terugbel_datum, source_ref')
      .filter('source_ref->>whatsapp_taak_id', 'eq', String(taakId))
      .limit(1);
    if (error) {
      console.warn('[whatsapp-taak] lead-lookup faalde:', error.message);
      return { status: 'fout', reden: error.message };
    }
    const lead = leads && leads[0];
    if (!lead) return { status: 'geen_lead' };

    const ref = (lead.source_ref && typeof lead.source_ref === 'object') ? lead.source_ref : {};
    // Twee keer naar klaar en terug mag geen twee notities en twee dagen
    // uitstel opleveren.
    if (ref.whatsapp_taak_afgerond_at) return { status: 'al_gedaan' };

    const nu = new Date();
    const nuIso = nu.toISOString();
    const naam = (await naamVan(doorUserId)) || 'een collega';

    await schrijfLeadNotitie(
      lead.id,
      `WhatsApp verstuurd door ${naam} op ${datumNl(nu)}.`,
      { doorUserId, entryKind: 'system', outcomeCode: 'whatsapp_verstuurd' },
    );

    const patch = { source_ref: { ...ref, whatsapp_taak_afgerond_at: nuIso }, updated_at: nuIso };

    // Belmoment een dag opschuiven — maar alleen bij een lead die nog loopt.
    // Is hij intussen gewonnen of afgesloten, dan blijft de datum met rust;
    // een dichte rij terugzetten op de bellijst zou verwarrend zijn.
    const gesloten = AFGESLOTEN_STATUSSEN.has(String(lead.lead_status || ''));
    if (!gesloten) {
      patch.terugbel_datum = volgendBelmoment(lead.terugbel_datum, nu);
    }

    const { error: upErr } = await supabaseAdmin
      .from('follow_up_leads').update(patch).eq('id', lead.id);
    if (upErr) {
      console.warn('[whatsapp-taak] lead bijwerken faalde:', upErr.message);
      return { status: 'fout', reden: upErr.message };
    }
    return { status: gesloten ? 'lead_gesloten' : 'bijgewerkt' };
  } catch (e) {
    console.warn('[whatsapp-taak] afgerond-afhandeling faalde:', e?.message || e);
    return { status: 'fout', reden: e?.message || 'onbekend' };
  }
}

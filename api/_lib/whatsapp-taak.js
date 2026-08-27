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

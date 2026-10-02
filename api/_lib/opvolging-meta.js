// api/_lib/opvolging-meta.js
//
// 'AGENDA DOORSTUREN' VIA EEN GOEDGEKEURDE META-TEMPLATE — en wat daarna komt.
//
// Maxims beslissing (2 okt): geen vrije tekst meer via de whatsapp-web.js-brug,
// maar zoals bij de event-aanmeldingen en de wanbetalers een officiële
// Meta-template met de agendalink. Daarna loopt er een 24u-venster waarin de
// lead kan antwoorden en Dave vrij kan terugschrijven.
//
// Hier staat alles wat de opvolgmodule met Meta doet, op één plek:
//   · welke lijn (phone_number_id) — standaard DEZELFDE als de afspraak-
//     berichten (resolveWelkomPhoneId, module 'leadsonderhoud'), zodat de lead
//     de link én daarna de bevestiging van één nummer krijgt;
//   · of de template goedgekeurd is (whatsapp_meta_templates.status APPROVED);
//   · een binnenkomend Meta-bericht als contact op de lopende kaart;
//   · een failed-status als zichtbare melding op de kaart, en de kaart terug
//     open als hij nog op wacht_inplanning stond. Nooit stil.
//
// Versturen en loggen gebeurt met wat er al is: sendTemplate/sendText
// (_lib/meta-whatsapp.js), buildSendComponents en logOutboundWa — niets
// daarvan is hier gekopieerd.

import { resolveWelkomPhoneId } from './afspraak-berichten.js';
import { normaliseerNummer } from './whatsapp-brug-nummers.js';

export const TEMPLATE_NAMEN = Object.freeze({
  eerste: 'agenda_doorsturen_v1',
  herinnering: 'agenda_herinnering_v1',
});
export const STANDAARD_MODULE = 'leadsonderhoud';
/** Het voorvoegsel van call_log_id voor pogingen uit Meta. Idempotentiesleutel. */
export const META_SLEUTEL = 'meta:';
export const VENSTER_MS = 24 * 3600 * 1000;
const LOPEND = ['open', 'wacht_inplanning'];

// ═══════════════════════════════════════════════════════════════════════════
// PUUR
// ═══════════════════════════════════════════════════════════════════════════

/** Is deze template-rij bruikbaar? Alleen APPROVED (hoofdletterongevoelig). */
export function templateGoedgekeurd(rij) {
  return !!rij && String(rij.status || '').toUpperCase() === 'APPROVED';
}

/**
 * Welk pad neemt het doorsturen?
 *
 * @returns {{ pad: 'meta' } | { pad: 'brug', reden: string, melding: string }}
 */
export function kiesPad({ kanaal, template, phoneNumberId }) {
  if (String(kanaal || 'meta') === 'brug') {
    return { pad: 'brug', reden: 'kanaal_brug', melding: 'Verstuurd via de WhatsApp-lijn van het CRM (instelling: brug).' };
  }
  if (!phoneNumberId) {
    return { pad: 'brug', reden: 'geen_lijn', melding: 'Geen actieve Meta-lijn gevonden — verstuurd via de WhatsApp-lijn van het CRM.' };
  }
  if (!templateGoedgekeurd(template)) {
    return {
      pad: 'brug', reden: 'template_wacht',
      melding: 'Template wacht op goedkeuring door Meta — verstuurd via de WhatsApp-lijn van het CRM.',
    };
  }
  return { pad: 'meta' };
}

/**
 * De lopende kaart bij een nummer: eerst exact op de volle cijferreeks, dan op
 * de laatste negen — maar alleen bij precies één treffer. Een poging bij de
 * verkeerde persoon maakt het oordeel over twee mensen onwaar.
 * Tweeling van zoekTaak() in api/opvolging-whatsapp-webhook.js.
 */
export function kiesTaakVoorNummer(kandidaten, nummer) {
  const doel = normaliseerNummer(nummer);
  if (!doel) return null;
  const lijst = Array.isArray(kandidaten) ? kandidaten : [];
  const exact = lijst.filter((t) => normaliseerNummer(t.telefoon) === doel);
  if (exact.length > 0) return exact[0];
  const s = doel.length >= 9 ? doel.slice(-9) : null;
  if (!s) return null;
  const staart = lijst.filter((t) => { const c = normaliseerNummer(t.telefoon); return c && c.length >= 9 && c.slice(-9) === s; });
  return staart.length === 1 ? staart[0] : null;
}

/** Het 24u-venster per gesprek: open zolang de laatste inkomende < 24 uur oud is. */
export function vensterVan(berichten, nuMs = Date.now()) {
  const laatsteIn = (Array.isArray(berichten) ? berichten : [])
    .filter((b) => b && b.direction === 'in')
    .map((b) => Date.parse(b.created_at || b.delivered_at || ''))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  if (!Number.isFinite(laatsteIn)) return { open: false, tot: null, laatste_in: null };
  const tot = laatsteIn + VENSTER_MS;
  return { open: nuMs < tot, tot: new Date(tot).toISOString(), laatste_in: new Date(laatsteIn).toISOString() };
}

/** Een whatsapp_messages-rij in de vorm van het gesprekspaneel. */
export function metaBerichtAlsRegel(m) {
  return {
    id: 'meta:' + m.id,
    richting: m.direction === 'in' ? 'in' : 'uit',
    tekst: m.body || (m.template_name ? '[template ' + m.template_name + ']' : null),
    media_type: m.media_type || 'chat',
    tijdstip: m.created_at || m.sent_at || m.delivered_at || null,
    bron: 'meta',
    status: m.status || null,
    failed_reason: m.failed_reason || null,
    template_name: m.template_name || null,
  };
}

/** De resultaattekst voor een failed-status. */
export function nietAfgeleverdTekst(reden) {
  return 'WhatsApp niet afgeleverd: ' + String(reden || 'onbekende reden').slice(0, 200);
}

/**
 * De patch voor een kaart waarvan het Meta-bericht niet afgeleverd werd.
 * Stond hij op wacht_inplanning, dan terug open (vandaag): wachten op een
 * inplanning na een bericht dat nooit aankwam is wachten op niets.
 */
export function failedPatch({ taak, reden, vandaag }) {
  const regel = vandaag + ' · ⚠ ' + nietAfgeleverdTekst(reden) +
    (taak && taak.status === 'wacht_inplanning' ? ' — terug in de lijst.' : '');
  const oud = String((taak && taak.notitie) || '').trim();
  const patch = { notitie: oud ? regel + '\n\n' + oud : regel };
  if (taak && taak.status === 'wacht_inplanning') {
    Object.assign(patch, { status: 'open', due: vandaag, later: false, agenda_doorgestuurd_at: null });
  }
  return patch;
}

// ═══════════════════════════════════════════════════════════════════════════
// MET DE DATABANK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * De Meta-lijn voor het doorsturen. Volgorde: expliciete phone_number_id in
 * de instelling → de module uit de instelling (whatsapp_module_config) →
 * standaard de lijn van de afspraakberichten (resolveWelkomPhoneId).
 */
export async function resolveAgendaLijn(db, instelling) {
  const expliciet = String((instelling && instelling.phone_number_id) || '').trim();
  if (expliciet) return expliciet;
  const module = String((instelling && instelling.module) || STANDAARD_MODULE).trim();
  if (module === STANDAARD_MODULE) return await resolveWelkomPhoneId();
  try {
    const { data } = await db.from('whatsapp_module_config')
      .select('phone_number_id').eq('module', module).eq('is_active', true).maybeSingle();
    if (data && data.phone_number_id) return String(data.phone_number_id).trim();
  } catch (e) {
    console.warn('[opvolging-meta] lijn lookup (soft):', e?.message || e);
  }
  return null;
}

/** De actieve lijnen, voor de dropdown in het instellingenblok. */
export async function actieveLijnen(db) {
  const { data, error } = await db.from('whatsapp_module_config')
    .select('module, phone_number_id, display_label').eq('is_active', true);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({ module: r.module, phone_number_id: r.phone_number_id, label: r.display_label || r.module }));
}

/** De template-rij (taal nl), de goedgekeurde wint. */
export async function leesTemplate(db, naam) {
  const { data, error } = await db.from('whatsapp_meta_templates')
    .select('name, language, status, body_text, header_type, header_content, buttons, meta_param_mapping')
    .eq('name', naam).limit(5);
  if (error) throw new Error(error.message);
  const rijen = (data || []).filter((r) => !r.language || String(r.language).toLowerCase().startsWith('nl'));
  return rijen.find(templateGoedgekeurd) || rijen[0] || null;
}

async function lopendeKaarten(db) {
  const { data, error } = await db.from('opvolging_taken')
    .select('id, telefoon, status, notitie, updated_at')
    .in('status', LOPEND).not('telefoon', 'is', null)
    .order('updated_at', { ascending: false }).limit(2000);
  if (error) throw new Error(error.message);
  return data || [];
}

async function pogingBestaat(db, taakId, sleutel) {
  const { data } = await db.from('opvolging_pogingen').select('id')
    .eq('taak_id', taakId).eq('call_log_id', sleutel).limit(1);
  return !!(data && data[0]);
}

/**
 * Een binnenkomend Meta-bericht als contact op de lopende kaart van dat nummer.
 * Idempotent op wamid. FAIL-SOFT: de inbox-webhook mag hier nooit op breken.
 */
export async function opvolgingMetaInbound(db, { telefoon, wamid, tekst, mediaType, tijdstipIso }) {
  try {
    if (!wamid || !telefoon) return { gekoppeld: false, reden: 'onvolledig' };
    const taak = kiesTaakVoorNummer(await lopendeKaarten(db), telefoon);
    if (!taak) return { gekoppeld: false, reden: 'geen_kaart' };
    const sleutel = META_SLEUTEL + wamid;
    if (await pogingBestaat(db, taak.id, sleutel)) return { gekoppeld: true, hergebruikt: true, taak_id: taak.id };
    const spraak = ['audio', 'ptt', 'voice'].includes(String(mediaType || '').toLowerCase());
    const kort = String(tekst || '').trim().slice(0, 500);
    const { error } = await db.from('opvolging_pogingen').insert({
      taak_id: taak.id,
      soort: spraak ? 'spraakbericht' : 'whatsapp',
      richting: 'in',
      automatisch: true,
      tijdstip: tijdstipIso || new Date().toISOString(),
      resultaat: (spraak ? 'spraakbericht ontvangen (Meta)' : 'antwoord ontvangen (Meta)') + (kort ? ': ' + kort : ''),
      call_log_id: sleutel,
    });
    if (error) throw new Error(error.message);
    await db.from('opvolging_taken').update({ updated_at: new Date().toISOString() }).eq('id', taak.id);
    return { gekoppeld: true, taak_id: taak.id };
  } catch (e) {
    console.warn('[opvolging-meta] inbound (soft):', e?.message || e);
    return { gekoppeld: false, reden: 'fout' };
  }
}

/**
 * Een failed-status van Meta op een bericht dat de opvolgmodule verstuurde.
 * Zichtbaar op de poging én in de notitie; kaart terug open als hij wachtte.
 * FAIL-SOFT, maar luid in het log.
 */
export async function opvolgingMetaFailed(db, { wamid, reden, vandaag }) {
  try {
    if (!wamid) return { gevonden: false };
    const sleutel = META_SLEUTEL + wamid;
    const { data: pog, error } = await db.from('opvolging_pogingen')
      .select('id, taak_id').eq('call_log_id', sleutel).limit(1);
    if (error) throw new Error(error.message);
    const p = pog && pog[0];
    if (!p) return { gevonden: false };
    await db.from('opvolging_pogingen').update({ resultaat: nietAfgeleverdTekst(reden) }).eq('id', p.id);
    const { data: taak } = await db.from('opvolging_taken')
      .select('id, status, notitie').eq('id', p.taak_id).maybeSingle();
    if (!taak) return { gevonden: true, taak_id: p.taak_id };
    const patch = failedPatch({ taak, reden, vandaag });
    const { error: uErr } = await db.from('opvolging_taken')
      .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', taak.id);
    if (uErr) throw new Error(uErr.message);
    console.warn('[opvolging-meta] WhatsApp niet afgeleverd op kaart', taak.id, String(reden || '').slice(0, 120));
    return { gevonden: true, taak_id: taak.id, terug_open: patch.status === 'open' };
  } catch (e) {
    console.error('[opvolging-meta] failed-status verwerken:', e?.message || e);
    return { gevonden: false, fout: true };
  }
}

/**
 * De Meta-kant van het gesprek met één nummer, voor het gesprekspaneel.
 *
 * whatsapp_conversations.phone_number staat als +E.164. Het nummer van de
 * opvolging is cijfers; we zoeken op '+' + cijfers. Een gesprek per lijn kan
 * bestaan; het venster geldt per lijn, dus we geven de lijn mee waarop het
 * venster open is (de laatste inkomende).
 *
 * @returns {{ regels: object[], stand: null | { conversation_id, phone_number_id, venster_open, venster_tot } , fout?: string }}
 */
export async function leesMetaGesprek(db, nummer, nuMs = Date.now()) {
  const cijfers = normaliseerNummer(nummer);
  if (!cijfers) return { regels: [], stand: null };
  try {
    const { data: convs, error } = await db.from('whatsapp_conversations')
      .select('id, phone_number_id, last_message_at').eq('phone_number', '+' + cijfers).limit(5);
    if (error) throw new Error(error.message);
    if (!convs || !convs.length) return { regels: [], stand: null };
    const ids = convs.map((c) => c.id);
    const { data: msgs, error: mErr } = await db.from('whatsapp_messages')
      .select('id, conversation_id, direction, body, media_type, template_name, status, failed_reason, created_at, sent_at, delivered_at')
      .in('conversation_id', ids).order('created_at', { ascending: false }).limit(50);
    if (mErr) throw new Error(mErr.message);
    const rijen = msgs || [];
    // Het gesprek met het meest recente inkomende bericht bepaalt het venster.
    let beste = null;
    for (const c of convs) {
      const v = vensterVan(rijen.filter((m) => m.conversation_id === c.id), nuMs);
      if (!beste || (v.laatste_in && (!beste.v.laatste_in || v.laatste_in > beste.v.laatste_in))) beste = { c, v };
    }
    return {
      regels: rijen.slice().reverse().map(metaBerichtAlsRegel),
      stand: {
        conversation_id: beste.c.id,
        phone_number_id: beste.c.phone_number_id || null,
        venster_open: beste.v.open,
        venster_tot: beste.v.tot,
      },
    };
  } catch (e) {
    console.warn('[opvolging-meta] gesprek lezen (soft):', e?.message || e);
    return { regels: [], stand: null, fout: String(e?.message || e) };
  }
}

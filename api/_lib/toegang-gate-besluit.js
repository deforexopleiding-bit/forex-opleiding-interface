// api/_lib/toegang-gate-besluit.js
//
// Toegang-gate (2026-10-11): MAG dit inkomende WhatsApp-bericht de openstaande
// toegangsaanvraag afronden (status 'gereageerd' → provisioning + "je
// inloggegevens zijn verstuurd")?
//
// Voorheen: ELK inkomend bericht van een nummer met een 'wachtend'-aanvraag.
// Op 10/10 ~22:57 gaf daardoor een tik op "Ja, vertel me meer" onder een
// massa-WhatsApp (massa_heropenen) toegang + het inlogbericht aan een
// testlead met een twee dagen oude minicursus-aanvraag.
//
// Nu:
//   1. Met reply-context (WhatsApp stuurt bij een knop-antwoord en bij
//      "beantwoorden" het message-id mee: msg.context.id): alleen als dat
//      bericht een toegangsbericht is (bevestig_toegang_* / reminder_toegang_*).
//      Verwijst het naar iets anders (massa, afspraak, opvolging…) → NEE.
//   2. Zonder (bruikbare) context — gewoon "ja" getypt:
//      a. binnen GATE_VENSTER_UUR na het laatste toegangsbericht (of na de
//         aanvraag zelf als er nog geen bericht uit is), én
//      b. we hebben sindsdien GEEN ander template-bericht gestuurd (dan hoort
//         het antwoord bij dat latere bericht, bv. een massa-WhatsApp).
//      Vrije tekst van een medewerker telt bij (b) niet mee.
// Wie geen toegang krijgt, blijft 'wachtend' — handmatig "Geef toegang" in
// Leadsonderhoud blijft altijd mogelijk.

export const GATE_TEMPLATE_RE = /^(bevestig_toegang|reminder_toegang)/;
export const GATE_VENSTER_UUR = 72;
export const GATE_AANVRAAG_VELDEN = 'id, voornaam, email, telefoon, soort, provisioned_at, created_at, bevestiging_sent_at, reminder_2u_at, reminder_24u_at, reminder_48u_at';

/** Laatste moment waarop de gate de lead aansprak (of de aanvraag zelf). PURE. */
export function laatsteGateMoment(aanvraag) {
  const ts = ['created_at', 'bevestiging_sent_at', 'reminder_2u_at', 'reminder_24u_at', 'reminder_48u_at']
    .map((k) => (aanvraag && aanvraag[k] ? Date.parse(aanvraag[k]) : NaN))
    .filter(Number.isFinite);
  return ts.length ? Math.max(...ts) : null;
}

/**
 * Het besluit. PURE.
 * @param {object} p
 * @param {object} p.aanvraag            toegang_aanvragen-rij (GATE_AANVRAAG_VELDEN)
 * @param {boolean} p.heeftContext        inkomend bericht had msg.context.id
 * @param {string|null} p.contextTemplate template_name van het bericht waarop gereageerd werd (null = onbekend/geen template)
 * @param {boolean} p.contextGevonden     dat bericht staat in whatsapp_messages
 * @param {string|null} p.latereTemplate  naam van een ANDER template-bericht dat na het laatste gate-moment uitging (of null)
 * @param {number} p.nuMs
 * -> { ok:boolean, reden:string }
 */
export function gateBesluit({ aanvraag, heeftContext = false, contextTemplate = null, contextGevonden = false, latereTemplate = null, nuMs = Date.now() }) {
  if (heeftContext && contextGevonden) {
    return GATE_TEMPLATE_RE.test(String(contextTemplate || ''))
      ? { ok: true, reden: 'antwoord_op_toegangsbericht' }
      : { ok: false, reden: 'antwoord_op_ander_bericht' };
  }
  const laatst = laatsteGateMoment(aanvraag);
  if (laatst == null) return { ok: false, reden: 'geen_gate_moment' };
  if (nuMs - laatst > GATE_VENSTER_UUR * 3600 * 1000) return { ok: false, reden: 'buiten_venster' };
  if (latereTemplate) return { ok: false, reden: 'antwoord_hoort_bij_later_bericht' };
  return { ok: true, reden: heeftContext ? 'context_onbekend_binnen_venster' : 'binnen_venster' };
}

/**
 * Leest wat het besluit nodig heeft uit de DB en beslist. Fail-CLOSED: bij een
 * leesfout geen automatische toegang (handmatig kan altijd) — beter een lead
 * die even wacht dan een massa-"Ja" die toegang geeft.
 * @param {object} sb  service-role client
 * @param {object} p   { aanvraag, contextWamid, convId, nu }
 */
export async function beoordeelToegangGate(sb, { aanvraag, contextWamid = null, convId = null, nu = new Date() }) {
  try {
    let contextTemplate = null;
    let contextGevonden = false;
    if (contextWamid) {
      const { data, error } = await sb.from('whatsapp_messages')
        .select('template_name, direction').eq('meta_wamid', contextWamid).limit(1);
      if (error) throw new Error('context lezen: ' + error.message);
      const rij = (data || [])[0];
      if (rij) { contextGevonden = true; contextTemplate = rij.template_name || null; }
    }
    let latereTemplate = null;
    const laatst = laatsteGateMoment(aanvraag);
    if (!(contextWamid && contextGevonden) && convId && laatst != null) {
      const { data, error } = await sb.from('whatsapp_messages')
        .select('template_name, created_at').eq('conversation_id', convId).eq('direction', 'out')
        .gt('created_at', new Date(laatst).toISOString()).not('template_name', 'is', null)
        .order('created_at', { ascending: false }).limit(20);
      if (error) throw new Error('latere berichten lezen: ' + error.message);
      const ander = (data || []).find((m) => !GATE_TEMPLATE_RE.test(String(m.template_name || '')));
      latereTemplate = ander ? ander.template_name : null;
    }
    const b = gateBesluit({ aanvraag, heeftContext: !!contextWamid, contextTemplate, contextGevonden, latereTemplate, nuMs: nu.getTime() });
    return { ...b, context_template: contextTemplate, later_template: latereTemplate };
  } catch (e) {
    console.error('[toegang-gate] besluit niet te bepalen — geen automatische toegang:', { aanvraag: aanvraag?.id, fout: e?.message || e });
    return { ok: false, reden: 'besluit_fout' };
  }
}

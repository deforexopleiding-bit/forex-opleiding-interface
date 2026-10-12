// api/_lib/inbox-verzenden.js
//
// Eén WhatsApp-bericht de deur uit, met alles eromheen.
//
// ── WAAROM DIT UIT inbox-send.js GEHAALD IS ──────────────────────────────────
// Het uitgestelde versturen (het ongedaan-venster van dertig seconden) heeft
// drie aanroepers nodig die exact hetzelfde doen: het scherm dat na dertig
// seconden het groen licht geeft, de cron die het overneemt als het scherm
// dichtgaat, en het endpoint zelf voor wie niet wil wachten. Dat is precies de
// situatie waarin een tweede verzendweg ontstaat die de eerste na een half jaar
// stilletjes achterna hinkt.
//
// Dus: één functie, drie aanroepers. `api/inbox-send.js` is sinds deze
// wijziging een omhulsel dat alleen HTTP doet.
//
// ── DEZE VERSIE IS GEBOUWD OP main VAN 12 OKTOBER 2026 ───────────────────────
// Een eerdere poging (#1680) was geëxtraheerd uit inbox-send.js van vóór de
// overstap naar 360dialog. Die kopie compileerde en verstuurde, maar miste twee
// dingen die #1729/#1742/#1744 erin gezet hadden:
//
//   1. getModuleContextByPhoneNumberId(..., { customerId }). Op het
//      360dialog-HOOFDNUMMER delen meerdere modules één phone_number_id. Een
//      losse `whatsapp_module_config`-opvraging op dat nummer geeft dus een
//      willekeurige module terug — en die module is de RECHTENCHECK. Te weinig
//      rechten is hinderlijk; te veel is een medewerker die namens een andere
//      module verstuurt.
//   2. hechtAanHuidigeLijn(). Na de nummerwissel leidt de transportlaag een oud
//      lijn-ID om naar de opvolger. Zonder deze stap blijft het gesprek aan de
//      oude lijn hangen en komt het antwoord van de klant in een NIEUW,
//      gesplitst gesprek terecht.
//
// Vandaar deze herbouw. Deel 1 verandert niets aan het gedrag; er staat een
// test op die het oude en het nieuwe pad naast elkaar legt voor het hoofdnummer,
// het klantnummer en een lijnwissel.

import { supabaseAdmin } from '../supabase.js';
import { sendText, sendTemplate, sendMedia, MetaNotConfiguredError } from './meta-whatsapp.js';
import { renderTemplatePreview } from './render-template-preview.js';
import { unpauseRunsForConversation } from './dunning-arrangement-hooks.js';
import { gesprekkenV2Aan } from './gesprekken-vlag.js';
import { werkSleutel } from './gesprekken-werkstand.js';
import { zekerheidVanFout } from './inbox-wachtrij.js';
import { getModuleContextByPhoneNumberId } from './module-context.js';
import { hechtAanHuidigeLijn } from './wa-gesprek-lijn.js';
import { TWENTY_FOUR_HOURS_MS, afwijzing } from './inbox-verzendopdracht.js';

/**
 * Het gesprek ophalen en de poorten erlangs.
 *
 * Apart van het versturen, want het parkeren (deel 2) stelt dezelfde vragen
 * dertig seconden vóór het vertrek: mag deze medewerker dit gesprek, en staat
 * het venster open? Twee plekken die hetzelfde moeten weten, horen dezelfde
 * code te gebruiken — anders parkeer je iets dat straks alsnog geweigerd wordt.
 *
 * @returns {Promise<{ok: true, conv: object, convModule: string, outboundPnId: string|undefined}
 *                  | {ok: false, http: number, payload: object}>}
 */
export async function keurGesprek(opdracht, rechten, { db = supabaseAdmin } = {}) {
  const { convId, mode, mediaKind } = opdracht;
  const { hasFinanceSend, hasSimoneUse, hasOnboardingSend } = rechten;

  // Module-config: finance-WABA-lijn voor outbound routing. Bij ontbreken
  // valt sendText/sendTemplate terug op env-var (huidige gedrag) zodat
  // bestaande deploys zonder DB-config blijven werken.
  let financePnId = null;
  try {
    const { data: modCfg, error: modErr } = await db
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'finance')
      .eq('is_active', true)
      .maybeSingle();
    if (modErr) {
      console.error('[inbox-verzenden] module-config lookup:', modErr.message);
    } else if (modCfg?.phone_number_id) {
      financePnId = modCfg.phone_number_id;
    }
  } catch (e) {
    console.error('[inbox-verzenden] module-config exception:', e.message);
  }

  const { data: conv, error: convErr } = await db
    .from('whatsapp_conversations')
    .select('id, phone_number, phone_number_id, customer_id, last_inbound_at, last_message_preview')
    .eq('id', convId)
    .maybeSingle();
  if (convErr) throw new Error('conversation lookup: ' + convErr.message);
  if (!conv) return afwijzing(404, { error: 'Conversation niet gevonden' });
  if (!conv.phone_number) return afwijzing(400, { error: 'Conversation heeft geen phone_number' });

  // Welke module is dit gesprek? Via module-context, want het
  // 360dialog-hoofdnummer draagt meerdere modules en de juiste hangt af van de
  // KLANT. Een kale whatsapp_module_config-opvraging op het nummer zou daar een
  // willekeurige rij teruggeven, en dat is hier de rechtencheck.
  let convModule = 'finance';
  if (conv.phone_number_id) {
    try {
      const convMod = await getModuleContextByPhoneNumberId(db, conv.phone_number_id, { customerId: conv.customer_id });
      if (convMod?.module) convModule = String(convMod.module).toLowerCase();
    } catch (e) {
      console.error('[inbox-verzenden] conv-module exception:', e.message);
    }
  }
  if (convModule === 'events' && !hasSimoneUse) {
    return afwijzing(403, { error: 'Geen rechten (events.simone.use voor events-conv)' });
  }
  if (convModule === 'onboarding' && !hasOnboardingSend) {
    return afwijzing(403, { error: 'Geen rechten (onboarding.inbox.send voor onboarding-conv)' });
  }
  if (convModule !== 'events' && convModule !== 'onboarding' && !hasFinanceSend) {
    return afwijzing(403, { error: 'Geen rechten (finance.inbox.send voor finance-conv)' });
  }

  // Het 24-uursvenster geldt voor alle vrije berichten: tekst én media.
  if (mode === 'text' || mediaKind) {
    const t = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : 0;
    const withinWindow = t && (Date.now() - t) <= TWENTY_FOUR_HOURS_MS;
    if (!withinWindow) {
      return afwijzing(422, {
        error: '24h_window_expired',
        message: mediaKind
          ? `Buiten 24-uurs venster — vrij ${mediaKind} versturen kan niet meer. Gebruik een approved template met een ${mediaKind}-header.`
          : 'Buiten 24-uurs venster sinds laatste inbound bericht. Gebruik een approved template.',
      });
    }
  }

  // Afzendlijn: liefst de lijn waarop het gesprek binnenkwam, zodat het
  // antwoord bij de klant in dezelfde draad belandt. Daarna de finance-config,
  // en als laatste undefined — dan pakt de transportlaag de env-var.
  const outboundPnId = conv.phone_number_id || financePnId || undefined;

  return { ok: true, conv, convModule, outboundPnId };
}

/**
 * Het bericht bij Meta afleveren.
 *
 * Alleen het netwerkdeel, zodat de foutvertaling op één plek staat. De drie
 * re-engagement-codes van Meta krijgen dezelfde 422-vorm als onze eigen
 * venstercheck: vijf schermen kennen die vorm uit hun hoofd, en of de
 * weigering van ons of van Meta kwam, staat in `source`.
 */
export async function leverAfBijMeta(opdracht, conv, outboundPnId) {
  const { mode, text, templateName, templateLanguage, templateComponents, mediaKind, mediaLink, mediaCaption, mediaFilename } = opdracht;
  try {
    let metaResult;
    if (mode === 'text') {
      metaResult = await sendText({ to: conv.phone_number, body: text, phoneNumberId: outboundPnId });
    } else if (mediaKind) {
      metaResult = await sendMedia({
        to           : conv.phone_number,
        kind         : mediaKind,
        link         : mediaLink,
        caption      : mediaCaption || undefined,
        filename     : mediaFilename || undefined,
        phoneNumberId: outboundPnId,
      });
    } else {
      metaResult = await sendTemplate({
        to: conv.phone_number,
        templateName,
        languageCode: templateLanguage,
        components: templateComponents,
        phoneNumberId: outboundPnId,
      });
    }
    return { ok: true, wamid: metaResult && metaResult.wamid ? String(metaResult.wamid) : null };
  } catch (metaErr) {
    // ── WAT ER BIJ ELKE WEIGERING MEEGAAT ────────────────────────────────────
    // `zekerheid` zegt of we WETEN dat het bericht niet is aangenomen. Het
    // uitgestelde versturen hangt daaraan: 'geweigerd' wordt de eindstand
    // mislukt ("stuur het gerust opnieuw"), 'onzeker' wordt onbekend ("kijk de
    // draad na"). Dat onderscheid hoort HIER gemaakt te worden, want dit is de
    // enige plek die de HTTP-status en de providercode nog ziet; een laag hoger
    // is er alleen nog een statuscode van ons zelf.
    //
    // Het bericht naar de afzender verandert niet. Dit is een veld náást de
    // payload, geen nieuw veld erin: vijf schermen kennen die payload-vormen
    // uit hun hoofd.
    const metZekerheid = (afw, fout) => ({ ...afw, zekerheid: zekerheidVanFout(fout) });

    if (metaErr instanceof MetaNotConfiguredError) {
      // Er is nooit iets aangeboden: de transportlaag gooit vóór de aanroep.
      return metZekerheid(
        afwijzing(503, { error: 'Meta WhatsApp niet geconfigureerd', missing: metaErr.missing }),
        { nooitAangeboden: true },
      );
    }
    const metaCode = Number(metaErr?.metaCode);
    if (metaCode === 131047 || metaCode === 131051 || metaCode === 131026) {
      console.warn('[inbox-verzenden] Meta re-engagement fout — vertaald naar 24h_window_expired:', {
        meta_code   : metaErr.metaCode,
        meta_subcode: metaErr.metaSubcode,
        meta_message: metaErr.metaMessage,
        fbtrace_id  : metaErr.metaFbtrace,
      });
      return metZekerheid(afwijzing(422, {
        error  : '24h_window_expired',
        source : 'meta',
        message: mediaKind
          ? `Meta's 24-uurs venster is verlopen (de klant heeft niet binnen 24u geantwoord). Vrij ${mediaKind} versturen kan niet meer — gebruik de Template-knop voor een goedgekeurde template met ${mediaKind}-header.`
          : 'Meta\'s 24-uurs venster is verlopen (de klant heeft niet binnen 24u geantwoord). Gebruik de Template-knop om een goedgekeurde template te sturen.',
        meta_code: metaErr.metaCode,
      }), metaErr);
    }
    console.error('[inbox-verzenden] Meta API fout:', metaErr.message, {
      http_status: metaErr?.httpStatus ?? null,
      meta_code  : metaErr?.metaCode ?? null,
      zekerheid  : zekerheidVanFout(metaErr),
    });
    return metZekerheid(afwijzing(502, { error: 'Meta API fout', meta_error: metaErr.message }), metaErr);
  }
}

/**
 * Wat er NA het versturen gebeurt.
 *
 * Alles hier is faalzacht, en dat is geen slordigheid: het bericht is op dit
 * punt al bij de klant. Een fout in de boekhouding mag niet leiden tot een
 * 500 die de afzender laat denken dat er niets verstuurd is — want dan stuurt
 * hij het nog een keer.
 */
export async function boekAchteraf(opdracht, conv, wamid, userId, { db = supabaseAdmin, ip = null } = {}) {
  const { convId, mode, text, templateName, templateVariables, templateComponents, mediaKind, mediaLink, mediaCaption, mediaFilename } = opdracht;

  // Verstuurd via de lijn waar dit gesprek NU bij hoort; hecht het daarom ook
  // aan die lijn, zodat het antwoord in DIT gesprek terugkomt in plaats van in
  // een nieuw, gesplitst gesprek. Faalzacht, en zonder effect op de
  // finance- en onboarding-lijnen.
  await hechtAanHuidigeLijn(db, conv);
  const nowIso = new Date().toISOString();

  const insertRow = {
    conversation_id:    convId,
    direction:          'out',
    meta_wamid:         wamid,
    body:               mode === 'text' ? text : (mediaKind ? (mediaCaption || mediaFilename || null) : null),
    template_name:      mode === 'template' ? templateName : null,
    template_variables: mode === 'template' ? (templateVariables || null) : null,
    media_url:          mediaKind ? mediaLink : null,
    media_type:         mediaKind || null,
    status:             'queued',
    sent_at:            nowIso,
    sent_by_user_id:    userId,
  };
  const { data: inserted, error: insErr } = await db
    .from('whatsapp_messages')
    .insert(insertRow)
    .select('id, meta_wamid, status, sent_at')
    .single();
  if (insErr) throw new Error('message insert: ' + insErr.message);

  let preview;
  if (mode === 'text') {
    preview = text.slice(0, 120);
  } else if (mediaKind) {
    preview = ('[' + mediaKind + '] ' + (mediaCaption || mediaFilename || '')).slice(0, 120);
  } else {
    const bodyComp = Array.isArray(templateComponents)
      ? templateComponents.find((c) => c?.type === 'body')
      : null;
    const bodyParams = Array.isArray(bodyComp?.parameters) ? bodyComp.parameters : [];
    const tplVars = bodyParams.length
      ? Object.fromEntries(bodyParams.map((p, i) => [String(i + 1), String(p?.text ?? '')]))
      : null;
    const rendered = await renderTemplatePreview({
      templateName,
      templateVariables: tplVars,
      supabase: db,
    });
    preview = rendered.body.slice(0, 120);
  }
  const { error: updErr } = await db
    .from('whatsapp_conversations')
    .update({ last_message_at: nowIso, last_message_preview: preview })
    .eq('id', convId);
  if (updErr) console.error('[inbox-verzenden] conversation update failed:', updErr.message);

  try {
    await db.from('audit_log').insert({
      user_id:     userId,
      action:      mode === 'text' ? 'whatsapp.outbound_text_sent' : 'whatsapp.outbound_template_sent',
      entity_type: 'whatsapp_message',
      entity_id:   inserted.id,
      after_json:  {
        conversation_id: convId,
        phone_number:    conv.phone_number,
        mode,
        meta_wamid:      wamid,
        template_name:   mode === 'template' ? templateName : null,
      },
      ip_address:  ip,
    });
  } catch (auditErr) {
    console.error('[inbox-verzenden] audit insert exception:', auditErr.message);
  }

  // Onze reply ontpauzeert de dunning-run en zet de reminder-teller terug. De
  // cron begint zo pas opnieuw bij een NIEUWE klant-inbound.
  try {
    const r = await unpauseRunsForConversation(convId);
    if (r && !r.ok && r.error) {
      console.warn('[inbox-verzenden] unpause soft-fail:', r.error);
    }
  } catch (unpauseErr) {
    console.warn('[inbox-verzenden] unpause exception (fail-soft):', unpauseErr?.message || unpauseErr);
  }

  // G5 — dit gesprek wacht nu op de KLANT. Zonder dit blijft het in het filter
  // "wacht op ons" staan nadat je het net beantwoord hebt, en een filter dat
  // je eigen werk niet ziet, leert je binnen een dag het filter te negeren.
  if (gesprekkenV2Aan()) {
    try {
      const sleutel = werkSleutel(convId);
      if (sleutel) {
        const { error: wFout } = await db
          .from('iris_gesprekken')
          .update({ status: 'wacht_op_klant', bijgewerkt_op: new Date().toISOString() })
          .eq('extern_uniek', sleutel)
          // 'geregeld' en 'belofte_loopt' zijn standen die een mens bewust
          // koos. Die overschrijven met een automatisme is hoe je iemands werk
          // kwijtraakt.
          .in('status', ['nieuw', 'wacht_op_ons']);
        if (wFout) console.warn('[inbox-verzenden] werkstand niet bijgewerkt:', wFout.message);
      }
    } catch (wEx) {
      console.warn('[inbox-verzenden] werkstand uitzondering (faalzacht):', wEx?.message || wEx);
    }
  }

  return inserted;
}

/**
 * De hele weg: keuren, versturen, boeken.
 *
 * ── voorAflevering ───────────────────────────────────────────────────────────
 * Een haakje tussen het keuren en het aanbieden. Het uitgestelde versturen
 * gebruikt het om vast te leggen dat de transportlaag NU aangeroepen wordt, en
 * dat moet precies hier: na de keuring (anders stempel je rijen die alsnog
 * geweigerd worden) en vóór de aanroep (anders is de stempel waardeloos — hij
 * bestaat juist om het geval te dekken waarin er daarna niets meer gebeurt).
 *
 * Geeft het haakje false terug, dan wordt er NIET afgeleverd. Dat is de veilige
 * kant: liever een bericht dat niet vertrok en dat luid zegt, dan een bericht
 * waarvan niemand meer kan vaststellen wat ermee gebeurd is.
 *
 * Zonder haakje — zoals /api/inbox-send het aanroept — is dit pad ongewijzigd.
 *
 * @returns {Promise<{ok: true, payload: object} | {ok: false, http: number, payload: object}>}
 */
export async function verstuurInGesprek(opdracht, rechten, userId, { db = supabaseAdmin, ip = null, voorAflevering = null } = {}) {
  const gekeurd = await keurGesprek(opdracht, rechten, { db });
  if (!gekeurd.ok) return gekeurd;

  if (typeof voorAflevering === 'function') {
    const mag = await voorAflevering();
    if (mag === false) {
      return afwijzing(500, {
        error: 'verzending_niet_vastgelegd',
        message: 'Het vastleggen van de verzending lukte niet, dus er is niets verstuurd. Probeer het opnieuw.',
      });
    }
  }

  const afgeleverd = await leverAfBijMeta(opdracht, gekeurd.conv, gekeurd.outboundPnId);
  if (!afgeleverd.ok) return afgeleverd;

  const inserted = await boekAchteraf(opdracht, gekeurd.conv, afgeleverd.wamid, userId, { db, ip });

  return {
    ok: true,
    payload: {
      success: true,
      message_id: inserted.id,
      meta_wamid: afgeleverd.wamid,
    },
  };
}

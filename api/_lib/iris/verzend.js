// api/_lib/iris/verzend.js
//
// Het bericht daadwerkelijk de deur uit doen.
//
// ── WAAROM DIT EEN OMHULSEL IS EN GEEN NIEUWE VERZENDWEG ─────────────────────
// De gesprekken-module heeft al een verzendweg die werkt: sendText/sendTemplate
// naar Meta, sendEmailViaSmtp naar Strato. Die wordt óók door de aanmaanmotor
// gebruikt. Er een tweede naast zetten zou betekenen dat een verandering aan de
// Meta-API op twee plekken doorgevoerd moet worden, en dat de tweede plek de
// eerste stilletjes achterna hinkt.
//
// Dus: Iris roept aan wat er staat. Wat ze zelf bijhoudt — dat een bericht van
// haar kwam, welk concept erachter zat — staat in haar eigen tabellen, gekoppeld
// via het externe id. Nul wijzigingen aan de bestaande weg, dus de aanmaanmotor
// merkt er niets van.
//
// ── DE VIER POORTEN, IN DEZE VOLGORDE ────────────────────────────────────────
//   1. De tekst. [invullen] blokkeert altijd, ook bij een mens.
//   2. Het venster. Binnen 24 uur vrije tekst, daarbuiten een template.
//   3. De stille uren. Alleen voor wat Iris uit zichzelf doet.
//   4. De dosering. Hoeveel er per persoon per dag mag.
//
// Ze staan in deze volgorde omdat de goedkoopste controle vooraan hoort: de
// tekst nakijken kost niets, het venster één veld, de dosering een opvraging.
// En omdat een mens die een blokkade te zien krijgt, het liefst de meest
// concrete reden ziet — "er staat nog [invullen] in" is bruikbaarder dan "het
// venster is dicht" als allebei waar zijn.

import { sendText, sendTemplate, MetaNotConfiguredError } from '../meta-whatsapp.js';
import { sendEmailViaSmtp } from '../send-email-core.js';
import { zetInVerzonden } from './verzonden-map.js';
import { keurTekst } from './toon.js';
import { magVersturen } from './venster.js';

/** Wat er misging, in een vorm die de aanroeper kan afhandelen. */
export class VerzendFout extends Error {
  constructor(bericht, code, extra = {}) {
    super(bericht);
    this.name = 'VerzendFout';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Kijk na of dit bericht nú weg mag.
 *
 * Zuiver, op één opvraging na die de aanroeper meegeeft. Zo is elke poort
 * afzonderlijk te testen, en dat is nodig: dit is de laatste deur vóór een
 * klant iets leest.
 *
 * @returns {{mag: boolean, vorm: 'tekst'|'template'|null, blokkades: string[], waarschuwingen: string[]}}
 */
export function keurVerzending({
  tekst,
  kanaal = 'whatsapp',
  laatsteInbound = null,
  stilleUrenInstelling = null,
  doorMens = false,
  neutraleHerinnering = false,
  alGestuurdVandaag = 0,
  maxPerDag = 2,
  nu = new Date(),
} = {}) {
  const blokkades = [];
  const waarschuwingen = [];

  // 1. De tekst.
  const t = keurTekst(tekst, { kanaal, neutraleHerinnering, doorMens });
  blokkades.push(...t.blokkades);
  waarschuwingen.push(...t.waarschuwingen);

  // 2 en 3. Venster en stille uren.
  const v = magVersturen({
    laatsteInbound,
    stilleUrenInstelling,
    automatisch: !doorMens,
    nu,
  });
  if (!v.mag) blokkades.push(v.reden);

  // Mail kent het venster niet — dat is een regel van Meta over WhatsApp.
  const vorm = kanaal === 'email' ? 'tekst' : v.vorm;

  // 4. De dosering. Ook hier: alleen voor wat Iris uit zichzelf doet. Een mens
  // die drie keer op een dag iets moet sturen, heeft daar een reden voor.
  if (!doorMens && alGestuurdVandaag >= maxPerDag) {
    blokkades.push(
      `Er zijn vandaag al ${alGestuurdVandaag} berichten naar deze persoon gegaan; ` +
      `het maximum is ${maxPerDag}. Meer wordt aandringen.`
    );
  }

  return { mag: blokkades.length === 0, vorm, blokkades, waarschuwingen, venster: v.venster };
}

/**
 * Verstuur via WhatsApp, langs de bestaande weg.
 *
 * @returns {Promise<{ok: true, extern_id: string} | {ok: false, code: string, fout: string}>}
 */
export async function verstuurWhatsapp({ naar, tekst, vorm, templateNaam, templateTaal = 'nl', templateVars = [], phoneNumberId = null }) {
  try {
    if (vorm === 'template') {
      if (!templateNaam) {
        return { ok: false, code: 'GEEN_TEMPLATE', fout: 'Het venster is dicht en er is geen template gekozen.' };
      }
      const r = await sendTemplate({
        to: naar,
        templateName: templateNaam,
        languageCode: templateTaal,
        variables: templateVars,
        phoneNumberId: phoneNumberId || undefined,
      });
      return { ok: true, extern_id: r?.wamid || r?.messages?.[0]?.id || null };
    }
    const r = await sendText({ to: naar, body: tekst, phoneNumberId: phoneNumberId || undefined });
    return { ok: true, extern_id: r?.wamid || r?.messages?.[0]?.id || null };
  } catch (e) {
    if (e instanceof MetaNotConfiguredError) {
      return { ok: false, code: 'META_NIET_GECONFIGUREERD', fout: e.message, ontbreekt: e.missing };
    }
    console.error('[iris/verzend] WhatsApp mislukt:', e?.message || e);
    return { ok: false, code: 'META_FOUT', fout: e?.message || 'Meta gaf een fout' };
  }
}

/**
 * Verstuur een mail, langs de bestaande weg.
 *
 * `inReplyTo` en `references` zorgen dat het antwoord in dezelfde draad blijft
 * hangen in de mailbox van de klant. Zonder die twee begint elk antwoord een
 * nieuw gesprek, en dan staat de geschiedenis wél bij ons en niet bij hem.
 */
export async function verstuurMail({ vanMailbox, naar, onderwerp, tekst, inReplyTo = null, references = null }) {
  try {
    const r = await sendEmailViaSmtp({
      fromMailbox: vanMailbox,
      to: naar,
      subject: onderwerp,
      text: tekst,
      inReplyTo: inReplyTo || undefined,
      references: references || inReplyTo || undefined,
    });
    if (!r?.ok) {
      return { ok: false, code: r?.code || 'SMTP_FOUT', fout: r?.reason || 'Mail niet verstuurd' };
    }

    // De kopie in de map Verzonden. Strato's SMTP zet hem er niet neer, dus
    // zonder dit staat onze eigen mail alleen in ons systeem en niet in de
    // mailbox — gat G7 uit de audit. Bewust NIET awaited op een manier die de
    // verzending kan laten mislukken: de mail is op dit punt al weg, en een
    // ontbrekende kopie verandert daar niets aan.
    let kopie = null;
    try {
      kopie = await zetInVerzonden({
        mailbox: vanMailbox,
        naar,
        onderwerp,
        tekst,
        messageId: r.messageId || null,
        inReplyTo: inReplyTo || null,
      });
      if (!kopie.ok) console.warn('[iris/verzend] geen kopie in Verzonden:', kopie.reden);
    } catch (e) {
      console.warn('[iris/verzend] kopie in Verzonden mislukte:', e?.message || e);
    }

    return { ok: true, extern_id: r.messageId || null, kopie_in_verzonden: !!kopie?.ok };
  } catch (e) {
    console.error('[iris/verzend] mail mislukt:', e?.message || e);
    return { ok: false, code: 'SMTP_FOUT', fout: e?.message || 'Mail niet verstuurd' };
  }
}

/**
 * Hoeveel berichten zijn er vandaag al naar deze persoon gegaan?
 *
 * Alleen wat Iris zelf stuurde. Wat een mens stuurde telt niet mee voor de
 * dosering — die afspraak gaat over aandringen door software, niet over een
 * collega die antwoordt.
 */
export async function alGestuurdVandaag(supabase, gesprekId, nu = new Date()) {
  if (!supabase || !gesprekId) return 0;
  const middernacht = new Date(nu);
  middernacht.setUTCHours(0, 0, 0, 0);
  try {
    const { count, error } = await supabase
      .from('iris_concepten')
      .select('id', { count: 'exact', head: true })
      .eq('gesprek_id', gesprekId)
      .eq('status', 'verzonden')
      .is('verzonden_door', null)               // null = Iris zelf
      .gte('verzonden_op', middernacht.toISOString());
    if (error) throw new Error(error.message);
    return count || 0;
  } catch (e) {
    console.error('[iris/verzend] dagteller niet gelezen:', e?.message || e);
    // Bij een leesfout doen we alsof de grens bereikt is. Niet kunnen tellen
    // is geen reden om ongelimiteerd te mogen sturen.
    return Number.MAX_SAFE_INTEGER;
  }
}

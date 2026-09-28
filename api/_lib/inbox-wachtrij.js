// api/_lib/inbox-wachtrij.js
//
// De vorm van een geparkeerd bericht — zonder database.
//
// ── WAAROM DIT APART STAAT ───────────────────────────────────────────────────
// Dit is de derde keer in deze bouw dat dezelfde les terugkomt: zodra een
// bestand `supabaseAdmin` importeert, kan een test die alleen de zuivere logica
// nakijkt niet meer geladen worden zonder SUPABASE_URL. Hij valt dan om op iets
// dat niets met het onderwerp te maken heeft, en een test die om zo'n reden
// faalt, leert je alleen maar de test te negeren.
//
// Vandaar de regel die we inmiddels drie keer toegepast hebben: wat zuiver kan
// zijn, staat in een bestand dat niets importeert. De database-kant importeert
// dit, nooit andersom.
//
// Wat hier woont, is de vertaling tussen "een opdracht om te versturen" en "een
// rij in de wachtrij". Die vertaling moet twee kanten op kloppen — wat eruit
// komt moet exact zijn wat erin ging — en dat is precies het soort ding dat je
// zonder database wilt kunnen nakijken.

/** Hoelang een bericht in de wacht staat voor het vertrekt. */
export const UITSTEL_MS = 30_000;

/**
 * Wanneer een claim als "hangend" geldt.
 *
 * Een Vercel-functie mag hooguit 60 s draaien, dus een claim van vijf minuten
 * oud hoort bij een proces dat niet meer bestaat. Korter zou claims vrijgeven
 * van processen die nog gewoon bezig zijn.
 */
export const CLAIM_VERVAL_MINUTEN = 5;

/** De enige status waarin een rij nog iets kan worden. */
export const OPEN_STATUS = 'gepland';

/** De media-modes, gelijk aan die in inbox-verzendopdracht.js. */
const MEDIA_SOORTEN = ['image', 'document', 'video'];

/**
 * Het moment waarop dit bericht mag vertrekken.
 *
 * Onzin erin mag nooit een onleesbaar moment opleveren: dan valt de rij buiten
 * elke opvraging en blijft hij eeuwig staan — het stilste soort storing dat er
 * is.
 */
export function verstuurMoment(nu = new Date(), uitstelMs = UITSTEL_MS) {
  const basis = (nu instanceof Date && !Number.isNaN(nu.getTime())) ? nu.getTime() : Date.now();
  const ruw = Number(uitstelMs);
  const ms = Number.isFinite(ruw) ? ruw : UITSTEL_MS;
  return new Date(basis + Math.max(0, ms)).toISOString();
}

/**
 * Van verzendopdracht naar een rij voor de wachtrij.
 *
 * De kolomnamen staan één keer hier en niet verspreid over drie endpoints —
 * dat is precies het soort ding dat uit de pas loopt zodra er een vierde
 * aanroeper bij komt.
 */
export function naarWachtrij(opdracht, { module = 'finance', doorGebruiker = null, nu = new Date() } = {}) {
  const o = opdracht || {};
  return {
    conversation_id    : o.convId,
    module             : String(module || 'finance'),
    mode               : o.mode,
    body               : o.mode === 'text' ? o.text : null,
    template_name      : o.mode === 'template' ? o.templateName : null,
    template_language  : o.mode === 'template' ? o.templateLanguage : null,
    template_variables : o.mode === 'template' ? (o.templateVariables || null) : null,
    template_components: o.mode === 'template' ? (o.templateComponents || null) : null,
    media_link         : o.mediaKind ? o.mediaLink : null,
    media_caption      : o.mediaKind ? (o.mediaCaption || null) : null,
    media_filename     : o.mediaKind ? (o.mediaFilename || null) : null,
    aangemaakt_door    : doorGebruiker,
    verstuur_na        : verstuurMoment(nu),
    status             : OPEN_STATUS,
  };
}

/**
 * En weer terug.
 *
 * De vorm is precies die van leesVerzendOpdracht(), zodat verstuurInGesprek()
 * niet hoeft te weten of de opdracht net binnenkwam of dertig seconden in de
 * wacht stond.
 */
export function uitWachtrij(rij) {
  const r = rij || {};
  const mediaKind = MEDIA_SOORTEN.includes(r.mode) ? r.mode : null;
  return {
    convId            : r.conversation_id,
    mode              : r.mode,
    text              : r.body || '',
    templateName      : r.template_name || '',
    templateLanguage  : r.template_language || 'nl',
    templateVariables : r.template_variables || null,
    templateComponents: Array.isArray(r.template_components) ? r.template_components : [],
    mediaKind,
    mediaLink         : r.media_link || '',
    mediaCaption      : r.media_caption || '',
    mediaFilename     : r.media_filename || '',
  };
}

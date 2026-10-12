// api/_lib/inbox-verzendopdracht.js
//
// Wat er verstuurd moet worden, en of dat überhaupt kan kloppen.
//
// ── WAAROM DIT APART STAAT VAN HET VERSTUREN ─────────────────────────────────
// Hier zit geen database en geen netwerk. Dat is geen toeval: dit is de laag
// die bepaalt of een bericht de moeite van het versturen waard is, en die wil
// je kunnen nakijken zonder een halve wereld op te starten. Zou dit in
// inbox-verzenden.js staan, dan trekt een test die alleen de keuring nakijkt de
// hele Supabase-laag mee en valt hij om op een ontbrekende omgevingsvariabele —
// een test die faalt om een reden die niets met de keuring te maken heeft,
// leert je alleen maar de test te negeren.
//
// Sinds het uitgestelde versturen is er nog een reden: het parkeren keurt de
// opdracht óók, dertig seconden vóór het versturen. Twee plekken die dezelfde
// vraag stellen, horen hem met dezelfde code te stellen — anders parkeer je iets
// dat straks alsnog geweigerd wordt, en dan staat er een bericht in de wacht dat
// nooit vertrekt.

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_BODY = 4096; // Meta text limit
export const MAX_TEMPLATE_NAME = 200;
export const MEDIA_SOORTEN = Object.freeze(['image', 'document', 'video']);

/** Een afwijzing in de vorm die een endpoint rechtstreeks kan teruggeven. */
export function afwijzing(http, payload) {
  return { ok: false, http, payload };
}

/**
 * Lees en keur een verzendopdracht.
 *
 * De teksten en statuscodes zijn letterlijk overgenomen uit inbox-send.js:
 * vijf schermen hangen aan dat endpoint en kennen die vormen uit hun hoofd.
 *
 * @returns {{ok: true, opdracht: object} | {ok: false, http: number, payload: object}}
 */
export function leesVerzendOpdracht(body) {
  const b = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};

  const convId = String(b.conversation_id || '').trim();
  const mode = String(b.mode || '').toLowerCase();
  const text = b.body !== undefined ? String(b.body || '').trim() : '';
  const templateName = String(b.template_name || '').trim();
  const templateLanguage = String(b.template_language || 'nl').trim().toLowerCase() || 'nl';
  const templateVariables = b.template_variables && typeof b.template_variables === 'object'
    ? b.template_variables : null;
  const templateComponents = Array.isArray(b.template_components) ? b.template_components : [];
  // Media-mode: link uit de whatsapp-media bucket + optionele caption of
  // bestandsnaam. Vrij verkeer, net als tekst, dus het 24-uursvenster geldt.
  const mediaKind = MEDIA_SOORTEN.includes(mode) ? mode : null;
  const mediaLink = mediaKind ? String(b.media_link || '').trim() : '';
  const mediaCaption = mediaKind && b.caption ? String(b.caption).trim().slice(0, 1024) : '';
  // Meta negeert een bestandsnaam bij image en video; alleen document doet er
  // iets mee.
  const mediaFilename = mediaKind === 'document' && b.filename ? String(b.filename).trim().slice(0, 200) : '';

  if (!convId) return afwijzing(400, { error: 'conversation_id vereist' });
  if (!UUID_RE.test(convId)) return afwijzing(400, { error: 'conversation_id moet geldige uuid zijn' });
  if (mode !== 'text' && mode !== 'template' && !mediaKind) {
    return afwijzing(400, { error: "mode moet 'text', 'template', 'image', 'document' of 'video' zijn" });
  }
  if (mode === 'text') {
    if (!text) return afwijzing(400, { error: 'body vereist bij mode=text' });
    if (text.length > MAX_BODY) return afwijzing(400, { error: `body max ${MAX_BODY} chars` });
  }
  if (mode === 'template') {
    if (!templateName) return afwijzing(400, { error: 'template_name vereist bij mode=template' });
    if (templateName.length > MAX_TEMPLATE_NAME) return afwijzing(400, { error: `template_name max ${MAX_TEMPLATE_NAME} chars` });
  }
  if (mediaKind) {
    if (!mediaLink) return afwijzing(400, { error: `media_link vereist bij mode=${mediaKind}` });
    if (!/^https:\/\//i.test(mediaLink)) return afwijzing(400, { error: 'media_link moet https:// zijn' });
  }

  return {
    ok: true,
    opdracht: {
      convId, mode, text,
      templateName, templateLanguage, templateVariables, templateComponents,
      mediaKind, mediaLink, mediaCaption, mediaFilename,
    },
  };
}

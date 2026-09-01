// api/_lib/lisa-message-type.js
//
// BP3 (2026-09-01) — helpers voor Lisa-berichten van GHL/Instagram.
// Gebruikt door zowel de webhook (api/lisa-ghl-webhook.js) als de poll-cron
// (api/cron-lisa-conversations-poll.js) zodat beide paden dezelfde
// normalisatie hanteren.
//
// Waarom deze helpers?
//   - GHL levert `type`/`messageType` in verschillende vormen (string,
//     numeriek enum, snake/upper case). isInstagram() vangt varianten op.
//   - `lisa_messages.message_type` heeft sinds migratie 2026-09-01 een
//     harde CHECK-whitelist. `normalizeMessageType` mapt ALTIJD naar een
//     whitelist-waarde (fallback 'unknown') — ruwe GHL-strings direct
//     doorschrijven zou de INSERT breken en het bericht verliezen.
//   - `lisa_messages.content` is NOT NULL. Voor media-berichten die geen
//     tekst-body hebben leveren we een korte NL-placeholder via
//     `mediaPlaceholder()` zodat het bericht wél opgeslagen wordt en in
//     de inbox verschijnt.

// De 9 whitelist-waarden uit de CHECK-constraint. Zie
// docs/sql-migrations/2026-09-01-lisa-messages-media-type-dedup.sql.
export const MESSAGE_TYPES = Object.freeze([
  'text', 'photo', 'video', 'audio', 'reel',
  'story_reply', 'sticker', 'file', 'unknown',
]);

const _WHITELIST = new Set(MESSAGE_TYPES);

/**
 * True als deze GHL-payload (message of conversation-summary) een IG-bericht is.
 * Tolerant voor: 'IG' | 'Instagram' | 'instagram' | 'instagram_dm' | 'TYPE_IG'
 * | 'TYPE_INSTAGRAM_MESSAGE' | 'type_instagram_message' | numeriek '8'.
 * Ook checked worden: messageType / type / lastMessageType op de input.
 */
export function isInstagram(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const raw = String(
    obj.messageType ||
    obj.type ||
    obj.lastMessageType ||
    ''
  ).trim().toLowerCase();
  if (!raw) return false;
  // GHL numeriek enum — 8 = Instagram DM.
  if (raw === '8') return true;
  return raw.includes('instagram') || raw === 'ig' || raw === 'type_ig';
}

/**
 * Normaliseer een GHL-berichttype naar een lisa_messages.message_type-whitelist-
 * waarde. Fallback: 'unknown'. NIET-whitelist-strings worden NOOIT doorgeschreven.
 *
 * Aanroep-vormen:
 *   normalizeMessageType({ type, messageType, attachments, body })
 *   normalizeMessageType('image')
 *
 * Detectie-volgorde:
 *   1. Attachment-type (image/video/audio/file/reel/story) — meest specifiek.
 *   2. Type-string patronen (reel, story, sticker, image, foto, voice…).
 *   3. Als body niet-leeg én geen media-signaal → 'text'.
 *   4. Fallback → 'unknown'.
 */
export function normalizeMessageType(input) {
  const obj = (input && typeof input === 'object') ? input : { type: String(input || '') };

  // 1) Attachments (GHL /messages levert attachments-array met .type).
  const atts = Array.isArray(obj.attachments) ? obj.attachments : [];
  for (const a of atts) {
    const at = String(a?.type || a?.mimeType || a?.mediaType || '').toLowerCase();
    if (!at) continue;
    if (at.startsWith('image/') || at === 'image' || at === 'photo')       return 'photo';
    if (at.startsWith('video/') || at === 'video')                          return 'video';
    if (at.startsWith('audio/') || at === 'audio' || at === 'voice')        return 'audio';
    if (at.includes('reel'))                                                 return 'reel';
    if (at.includes('story'))                                                return 'story_reply';
    if (at.includes('sticker'))                                              return 'sticker';
    if (at.startsWith('application/') || at === 'file' || at === 'document') return 'file';
  }

  // 2) Type-string patronen. Combineer alle bekende velden voor breedte.
  const raw = String(
    obj.messageType || obj.type || obj.mediaType || obj.subType || ''
  ).toLowerCase();
  if (raw) {
    if (raw.includes('reel'))                        return 'reel';
    if (raw.includes('story'))                       return 'story_reply';
    if (raw.includes('sticker'))                     return 'sticker';
    if (raw.includes('image') || raw.includes('photo') || raw.includes('foto')) return 'photo';
    if (raw.includes('video'))                       return 'video';
    if (raw.includes('audio') || raw.includes('voice')) return 'audio';
    if (raw.includes('file') || raw.includes('attachment') || raw.includes('document')) return 'file';
    // 'IG' / 'Instagram' / 'text_message' e.d. — nog geen media-signaal.
  }

  // 3) Body aanwezig → 'text'. Body leeg → 'unknown' (fallback in stap 4).
  const body = (obj.body != null ? obj.body : (obj.text != null ? obj.text : obj.message)) || '';
  const bodyStr = String(body || '').trim();
  if (bodyStr.length > 0) return 'text';

  // 4) Niets kunnen bepalen — expliciet 'unknown' zodat de INSERT valid blijft.
  return 'unknown';
}

/**
 * Placeholder-content voor een media-bericht. Kort NL-label (geschikt voor
 * bericht-preview in de inbox). Voor 'text' returnt geen placeholder (null).
 * NIET-whitelist-input valt terug op de 'unknown'-tekst.
 */
export function mediaPlaceholder(messageType) {
  const mt = _WHITELIST.has(messageType) ? messageType : 'unknown';
  switch (mt) {
    case 'text':        return null;
    case 'photo':       return '📷 Foto';
    case 'video':       return '🎥 Video';
    case 'audio':       return '🎤 Spraakbericht';
    case 'reel':        return '🎬 Reel gedeeld';
    case 'story_reply': return '📖 Reactie op story';
    case 'sticker':     return 'Sticker';
    case 'file':        return '📎 Bijlage';
    case 'unknown':
    default:            return '📎 Media-bericht';
  }
}

/**
 * Convenience: bepaal (message_type, content) voor een insert in lisa_messages.
 * - content is NOOIT leeg (kolom is NOT NULL).
 * - message_type is ALTIJD een whitelist-waarde (fallback 'unknown').
 *
 * @param {object} payload - GHL bericht-object (webhook customData of poll msg).
 *                           Verwacht optioneel .body/.text/.message + .type/
 *                           .messageType + .attachments.
 * @returns {{ message_type: string, content: string }}
 */
export function resolveContent(payload) {
  const message_type = normalizeMessageType(payload || {});
  const rawBody = payload?.body ?? payload?.text ?? payload?.message ?? '';
  const bodyStr = String(rawBody || '').trim();
  if (message_type === 'text' && bodyStr.length > 0) {
    return { message_type: 'text', content: bodyStr };
  }
  // Media-bericht (of tekstbericht zonder body — dan behandelen we 'em als
  // unknown-media). Placeholder gebruiken zodat NOT NULL-content voldaan is.
  const placeholder = mediaPlaceholder(message_type) || '📎 Media-bericht';
  return { message_type, content: placeholder };
}

/**
 * Whitelist-guard (defensief, voor code die zelf message_type wil kiezen).
 * Retourneert 'unknown' als de input niet in de whitelist zit.
 */
export function safeMessageType(mt) {
  return _WHITELIST.has(mt) ? mt : 'unknown';
}

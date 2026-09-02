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
 * Parse `attachments` uit een GHL-payload naar een array van http(s)-URLs.
 * GHL levert dit veld in verschillende vormen — deze functie accepteert
 * ALLES en geeft ALTIJD een array van geldige URLs terug (leeg als niks).
 *
 * Vormen die we ondersteunen:
 *   - Array van strings: ['https://…', 'https://…']
 *   - Array van objecten: [{ url, mediaUrl, href, link, src }, …]
 *   - JSON-string van bovenstaande arrays: '["https://…"]'
 *   - Komma-gescheiden string: 'https://a, https://b'
 *   - Losse URL-string: 'https://…'
 *   - null/undefined/anders → []
 *
 * Filtert non-http(s) en whitespace-only entries eruit.
 */
export function parseAttachments(raw) {
  if (raw == null) return [];
  const _urlish = /^https?:\/\/\S+$/i;
  const _extract = (item) => {
    if (item == null) return null;
    if (typeof item === 'string') return item.trim();
    if (typeof item === 'object') {
      return String(item.url || item.mediaUrl || item.href || item.link || item.src || '').trim();
    }
    return null;
  };

  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    // Probeer JSON-parse (array of object). Fail-soft.
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        const parsed = JSON.parse(s);
        items = Array.isArray(parsed) ? parsed : [parsed];
      } catch (_) {
        items = [s]; // fallback: als 't geen valid JSON is, behandel als string
      }
    } else if (s.includes(',')) {
      items = s.split(',');
    } else {
      items = [s];
    }
  } else if (typeof raw === 'object') {
    items = [raw];
  }

  const out = [];
  for (const it of items) {
    const url = _extract(it);
    if (url && _urlish.test(url)) out.push(url);
  }
  return out;
}

/**
 * Bepaal message_type uit een URL — kijkt naar de bestandsextensie.
 * Fallback: 'file' (onbekend type maar wel een attachment).
 * jpg/jpeg/png/webp/gif/heic → photo
 * mp4/mov/webm/m4v          → video
 * mp3/m4a/ogg/wav/aac       → audio
 * anders                    → file
 */
export function typeFromUrl(url) {
  if (!url || typeof url !== 'string') return 'file';
  // Strip querystring en fragment → puur path voor extensie-detectie.
  const path = url.split('?')[0].split('#')[0].toLowerCase();
  const m = path.match(/\.([a-z0-9]{2,5})$/);
  const ext = m ? m[1] : '';
  if (['jpg','jpeg','png','webp','gif','heic','heif'].includes(ext)) return 'photo';
  if (['mp4','mov','webm','m4v','avi','mkv'].includes(ext))          return 'video';
  if (['mp3','m4a','ogg','wav','aac','opus'].includes(ext))          return 'audio';
  return 'file';
}

/**
 * Convenience: bepaal (message_type, content, attachment_url) voor een insert
 * in lisa_messages.
 * - content is NOOIT leeg (kolom is NOT NULL).
 * - message_type is ALTIJD een whitelist-waarde (fallback 'unknown').
 * - attachment_url is de EERSTE URL uit attachments (null als geen).
 *
 * Detectie-volgorde:
 *   1. parseAttachments(payload.attachments) — als er URLs zijn:
 *      → message_type = typeFromUrl(eerste URL)
 *      → attachment_url = eerste URL
 *      → content = body-tekst als aanwezig, anders placeholder
 *   2. Anders: normalizeMessageType(payload) valt terug op body/type-detectie
 *      (bestaande logica, whitelist-gegarandeerd).
 *
 * @param {object} payload - GHL bericht-object (webhook customData of poll msg).
 * @returns {{ message_type: string, content: string, attachment_url: string|null }}
 */
export function resolveContent(payload) {
  const p = payload || {};
  const rawBody = p.body ?? p.text ?? p.message ?? '';
  const bodyStr = String(rawBody || '').trim();

  // Stap 1: attachments winnen — dat is het meest specifieke signaal.
  const urls = parseAttachments(p.attachments);
  if (urls.length > 0) {
    const first = urls[0];
    const mt = typeFromUrl(first);
    const placeholder = mediaPlaceholder(mt) || '📎 Media-bericht';
    return {
      message_type:   mt,
      content:        bodyStr.length > 0 ? bodyStr : placeholder,
      attachment_url: first,
    };
  }

  // Stap 2: geen attachments → val terug op type/body-detectie.
  const message_type = normalizeMessageType(p);
  if (message_type === 'text' && bodyStr.length > 0) {
    return { message_type: 'text', content: bodyStr, attachment_url: null };
  }
  const placeholder = mediaPlaceholder(message_type) || '📎 Media-bericht';
  return {
    message_type,
    content:        bodyStr.length > 0 ? bodyStr : placeholder,
    attachment_url: null,
  };
}

/**
 * Whitelist-guard (defensief, voor code die zelf message_type wil kiezen).
 * Retourneert 'unknown' als de input niet in de whitelist zit.
 */
export function safeMessageType(mt) {
  return _WHITELIST.has(mt) ? mt : 'unknown';
}

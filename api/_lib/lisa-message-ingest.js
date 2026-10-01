// api/_lib/lisa-message-ingest.js
//
// Eén ingest-pad voor lisa_messages, gedeeld door de webhook
// (api/lisa-ghl-webhook.js), de poll-cron (api/cron-lisa-conversations-poll.js)
// en het backfill-script (scripts/lisa-ig-backfill.mjs).
//
// ── WAAROM DIT BESTAAT ──────────────────────────────────────────────────────
// Sinds #1523 (8 sep 2026) weigerde de webhook elk bericht zonder GHL
// messageId, en omdat de "ensure conversation"-stap NA die guard stond, werd
// er voor NIEUWE Instagram-contacten ook geen lisa_conversations-rij meer
// gemaakt. De poll-cron kent alleen bestaande gesprekken, dus nieuwe leads
// verdwenen volledig (0 nieuwe gesprekken sinds 8 sep).
//
// De reden voor die guard was echt: hetzelfde inbound-bericht kwam één keer
// MET id en één keer ZONDER id binnen (~3 s uit elkaar, twee GHL-varianten).
// De partial UNIQUE-index op ghl_message_id (WHERE NOT NULL) vangt dat niet.
// Een synthetische id alléén lost dat ook niet op: 'syn:abc' ≠ 'ZihKL…'.
//
// ── HET ONTWERP: TWEELING-REGEL + UPGRADE ───────────────────────────────────
// Een "tweeling" = rij in hetzelfde gesprek, zelfde richting, zelfde inhoud
// (media-placeholders tellen onderling als gelijk), sent_at binnen
// ±TWIN_WINDOW_MS van het referentiemoment.
//
//   ZONDER echte id (webhook-variant zonder 'Message Id'):
//     1. Bestaat er al een tweeling (met welke id dan ook)? → duplicaat, skip.
//     2. Anders insert met een stabiele synthetische id 'syn:<sha256>'
//        (gesprek|richting|inhoud|bijlage|tijdsbucket). Twee gelijktijdige
//        id-loze fires botsen zo op de UNIQUE-index (23505 → duplicaat).
//
//   MET echte id (webhook-variant mét id, poll, backfill):
//     1. Bestaat ghl_message_id al? → duplicaat.
//     2. Is er een tweeling ZONDER echte id (syn:… of NULL, geen is_system)?
//        → UPGRADE die rij naar de echte id (conditionele update, dus
//        race-veilig) i.p.v. een tweede rij. De poll zet daarbij ook sent_at
//        recht op GHL's dateAdded.
//     3. Anders gewoon insert; 23505 → duplicaat.
//
// Zo verliest geen enkele volgorde een bericht en ontstaat er geen dubbele rij:
//   id-loos eerst  → syn-rij → id-variant/poll upgradet hem.
//   id eerst       → echte rij → id-loze variant ziet de tweeling en skipt.
//
// ── PRIJS VAN DEZE KEUZE (bewust) ──────────────────────────────────────────
// Twee ÉCHT verschillende, letterlijk gelijke berichten ("ok", "ok") binnen
// het venster, waarvan de tweede id-loos binnenkomt: die tweede wordt door de
// webhook als duplicaat gezien (geen AI-reactie). De poll ziet 'm later wél
// met zijn eigen echte id en voegt 'm alsnog in — verlies is dus tijdelijk.
// Het venster is ruim (10 min) omdat de data liet zien dat de webhook tot ~6
// minuten NA GHL's dateAdded binnen kan komen (poll-rij sent_at = dateAdded,
// webhook-rij sent_at = ontvangstmoment).
//
// Restrisico: id-loze en id-variant die op exact hetzelfde moment parallel
// lopen kunnen allebei "geen tweeling" zien. Dat is het oude 3 s-scenario
// teruggebracht tot een race van milliseconden; de poll ruimt het niet op
// (er bestaat dan al een rij met de echte id), maar het is zichtbaar via de
// verificatie-query in docs/sql-migrations/2026-09-07-…sql.

import crypto from 'crypto';
import { MESSAGE_TYPES, mediaPlaceholder } from './lisa-message-type.js';

export const SYN_PREFIX     = 'syn:';
export const TWIN_WINDOW_MS = 10 * 60 * 1000;
export const SYN_BUCKET_MS  = 2 * 60 * 1000;

// Alle mogelijke media-placeholders: webhook en GHL-API kunnen voor hetzelfde
// media-bericht een ander type afleiden ('📎 Media-bericht' vs '📷 Foto'),
// dus voor de tweeling-regel zijn ze onderling uitwisselbaar.
const PLACEHOLDERS = Array.from(new Set(
  [...MESSAGE_TYPES.map((t) => mediaPlaceholder(t)), '📎 Media-bericht'].filter(Boolean),
));

export function isSyntheticId(id) {
  return typeof id === 'string' && id.startsWith(SYN_PREFIX);
}

/** Een id telt als "echt" (GHL) als hij gevuld en niet synthetisch is. */
export function isRealId(id) {
  return typeof id === 'string' && id.trim().length > 0 && !isSyntheticId(id);
}

export function normalizeContent(content) {
  return String(content ?? '').replace(/\s+/g, ' ').trim();
}

/** Inhoud-sleutels waarop een tweeling mag matchen. */
export function twinContentKeys(content) {
  const c = String(content ?? '').trim();
  if (PLACEHOLDERS.includes(c)) return PLACEHOLDERS.slice();
  return [c];
}

/**
 * Stabiele synthetische id voor een bericht zonder GHL-id.
 * Deterministisch binnen één tijdsbucket → gelijktijdige dubbele fires botsen
 * op de UNIQUE-index i.p.v. twee rijen te maken.
 */
export function syntheticMessageId({ conversationId, direction, content, attachmentUrl, atMs }) {
  const bucket = Math.floor((Number.isFinite(atMs) ? atMs : Date.now()) / SYN_BUCKET_MS);
  const key = [conversationId || '', direction || '', normalizeContent(content), attachmentUrl || '', bucket].join('|');
  return SYN_PREFIX + crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);
}

/** Dichtstbijzijnde kandidaat op sent_at (pure functie, getest). */
export function pickClosestTwin(rows, refMs, { onlyUnanchored = false } = {}) {
  let best = null, bestDelta = Infinity;
  for (const r of rows || []) {
    if (!r) continue;
    if (onlyUnanchored) {
      if (r.is_system) continue;
      if (r.ghl_message_id != null && !isSyntheticId(r.ghl_message_id)) continue;
    }
    const t = new Date(r.sent_at).getTime();
    const d = Number.isFinite(t) ? Math.abs(t - refMs) : Infinity;
    if (d < bestDelta || (best === null && d === Infinity)) { best = r; bestDelta = d; }
  }
  return best;
}

async function findTwins(db, { conversationId, direction, content, refMs }) {
  const lo = new Date(refMs - TWIN_WINDOW_MS).toISOString();
  const hi = new Date(refMs + TWIN_WINDOW_MS).toISOString();
  const { data, error } = await db.from('lisa_messages')
    .select('id, ghl_message_id, sent_at, is_system')
    .eq('conversation_id', conversationId)
    .eq('direction', direction)
    .in('content', twinContentKeys(content))
    .gte('sent_at', lo)
    .lte('sent_at', hi)
    .limit(20);
  return { rows: data || [], error };
}

/**
 * Alleen-lezen variant van ingestLisaMessage(): wat ZOU er gebeuren?
 * Gebruikt door het backfill-script in --dry-run. Zelfde queries, geen writes.
 * @returns {Promise<'present'|'twin_present'|'upgrade'|'insert'|'error'>}
 */
export async function classifyLisaMessage(db, m) {
  const nowMs = Number.isFinite(m.nowMs) ? m.nowMs : Date.now();
  const realId = isRealId(m.ghlMessageId) ? String(m.ghlMessageId).trim() : null;
  const refMs = m.sentAt && Number.isFinite(new Date(m.sentAt).getTime()) ? new Date(m.sentAt).getTime() : nowMs;
  if (realId) {
    const { data: existing, error } = await db.from('lisa_messages')
      .select('id').eq('ghl_message_id', realId).limit(1).maybeSingle();
    if (error) return 'error';
    if (existing) return 'present';
  }
  const { rows, error } = await findTwins(db, { conversationId: m.conversationId, direction: m.direction, content: m.content, refMs });
  if (error) return 'error';
  if (!realId) return pickClosestTwin(rows, refMs) ? 'twin_present' : 'insert';
  return pickClosestTwin(rows, refMs, { onlyUnanchored: true }) ? 'upgrade' : 'insert';
}

/**
 * Sla één bericht op volgens de tweeling-regel hierboven.
 *
 * @param {object} db  supabase-client (supabaseAdmin of een test-dubbel)
 * @param {object} m
 * @param {string} m.conversationId  lisa_conversations.id
 * @param {'in'|'out'} m.direction
 * @param {string} m.content         niet-leeg (resolveContent garandeert dat)
 * @param {string} m.messageType
 * @param {string|null} [m.attachmentUrl]
 * @param {string|null} [m.ghlMessageId]  echte GHL-id of null
 * @param {string|null} [m.sentAt]   ISO; leeg = DB-default now() (webhook)
 * @param {number} [m.nowMs]         referentie voor id-loze berichten (tests)
 * @returns {Promise<{status:'inserted'|'upgraded'|'duplicate'|'error', row_id?:string,
 *   ghl_message_id?:string, synthetic?:boolean, error?:{code?:string,message:string}}>}
 */
export async function ingestLisaMessage(db, m) {
  const {
    conversationId, direction, content, messageType,
    attachmentUrl = null, sentAt = null,
  } = m;
  const nowMs = Number.isFinite(m.nowMs) ? m.nowMs : Date.now();
  const realId = isRealId(m.ghlMessageId) ? String(m.ghlMessageId).trim() : null;
  const refMs = sentAt && Number.isFinite(new Date(sentAt).getTime()) ? new Date(sentAt).getTime() : nowMs;

  const baseRow = {
    conversation_id: conversationId,
    direction,
    content,
    message_type:    messageType,
    attachment_url:  attachmentUrl,
    ai_generated:    false,
  };
  if (sentAt) baseRow.sent_at = sentAt;

  const insert = async (ghlId, synthetic) => {
    const { data, error } = await db.from('lisa_messages')
      .insert({ ...baseRow, ghl_message_id: ghlId }).select('id').single();
    if (error) {
      if (error.code === '23505') return { status: 'duplicate', ghl_message_id: ghlId, synthetic };
      return { status: 'error', error: { code: error.code, message: error.message }, ghl_message_id: ghlId, synthetic };
    }
    return { status: 'inserted', row_id: data?.id, ghl_message_id: ghlId, synthetic };
  };

  if (!realId) {
    // ── Pad A: geen echte id ──────────────────────────────────────────────
    const { rows, error } = await findTwins(db, { conversationId, direction, content, refMs });
    if (error) return { status: 'error', error: { code: error.code, message: 'twin_lookup: ' + error.message } };
    const twin = pickClosestTwin(rows, refMs);
    if (twin) return { status: 'duplicate', row_id: twin.id, ghl_message_id: twin.ghl_message_id, synthetic: true };
    const synId = syntheticMessageId({ conversationId, direction, content, attachmentUrl, atMs: refMs });
    return insert(synId, true);
  }

  // ── Pad B: echte id ────────────────────────────────────────────────────
  const { data: existing, error: exErr } = await db.from('lisa_messages')
    .select('id').eq('ghl_message_id', realId).limit(1).maybeSingle();
  if (exErr) return { status: 'error', error: { code: exErr.code, message: 'id_lookup: ' + exErr.message } };
  if (existing) return { status: 'duplicate', row_id: existing.id, ghl_message_id: realId };

  const { rows, error: twErr } = await findTwins(db, { conversationId, direction, content, refMs });
  if (twErr) return { status: 'error', error: { code: twErr.code, message: 'twin_lookup: ' + twErr.message } };
  const twin = pickClosestTwin(rows, refMs, { onlyUnanchored: true });
  if (twin) {
    const patch = { ghl_message_id: realId };
    if (sentAt) patch.sent_at = sentAt;
    // Conditioneel op de huidige id: als een parallelle run hem al upgradede,
    // raakt deze update 0 rijen en vallen we door naar de gewone insert
    // (die dan 23505 geeft → duplicaat).
    let q = db.from('lisa_messages').update(patch).eq('id', twin.id);
    q = twin.ghl_message_id == null ? q.is('ghl_message_id', null) : q.eq('ghl_message_id', twin.ghl_message_id);
    const { data: upd, error: updErr } = await q.select('id');
    if (updErr) {
      if (updErr.code === '23505') return { status: 'duplicate', ghl_message_id: realId };
      return { status: 'error', error: { code: updErr.code, message: 'upgrade: ' + updErr.message } };
    }
    if (Array.isArray(upd) && upd.length > 0) {
      return { status: 'upgraded', row_id: twin.id, ghl_message_id: realId, previous_id: twin.ghl_message_id };
    }
  }
  return insert(realId, false);
}

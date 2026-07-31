// api/_lib/gesprek-actie-helpers.js
//
// Pure helpers voor de Gesprekken "→ Actie maken"-flow (Blok 2/3) —
// geen supabase-imports zodat unit-tests direct kunnen draaien zonder
// SUPABASE_URL env-vars.
//
// Twee stukjes pure logica die anders vervuild raken in HTTP-handlers:
//
// 1. buildFollowupPayload(rawBody) — normaliseert body-input voor de
//    /api/tasks-create-followup route zodat de payload jsonb kolom een
//    stabiele, verwacht-genormaliseerde vorm heeft (title/note/kind
//    optioneel + geclamped).
//
// 2. filterActiveProfilesForPicker(rows) — filtert de raw profiles-
//    query naar wat de UI kan gebruiken (id + non-empty full_name).

/**
 * Bouwt de payload-jsonb voor een MANUAL_FOLLOWUP pending_action.
 * Neemt alle input-velden as-is aan (moet al gevalideerd zijn — dat is
 * de verantwoordelijkheid van de HTTP-handler), en past clamping toe.
 *
 * @param {object} body   raw body (source/reason/title/note/kind optioneel)
 * @param {string} userId user.id (voor created_by_user_id audit-veld)
 * @returns {object} payload-jsonb dat direct in pending_actions.payload past
 */
export function buildFollowupPayload(body, userId) {
  const b = (body && typeof body === 'object') ? body : {};
  const source = b.source ? String(b.source).trim() : 'inbox';
  const reason = b.reason ? String(b.reason).trim().slice(0, 500) : '';
  const title  = b.title  ? String(b.title).trim().slice(0, 200)  : '';
  const note   = b.note   ? String(b.note).trim().slice(0, 2000)  : '';
  const kind   = b.kind   ? String(b.kind).trim().slice(0, 40)    : '';

  const payload = {
    source,
    reason: reason || null,
    created_from: 'inbox',
    created_by_user_id: userId || null,
  };
  if (title) payload.title = title;
  if (note)  payload.note  = note;
  if (kind)  payload.kind  = kind;

  return payload;
}

/**
 * Filtert een profiles-rowset voor de assignee-picker in de Gesprekken-UI.
 * Alleen rows met id + non-empty full_name overleven — anders krijg je
 * lege dropdown-opties die niets toevoegen.
 *
 * @param {Array<object>} rows raw profiles-query resultaat
 * @returns {Array<{id:string, full_name:string, role:string}>}
 */
export function filterActiveProfilesForPicker(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((p) => p && p.id && typeof p.full_name === 'string' && p.full_name.trim() !== '')
    .map((p) => ({
      id: p.id,
      full_name: p.full_name,
      role: p.role || '',
    }));
}

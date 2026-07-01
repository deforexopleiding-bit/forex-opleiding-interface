// api/_lib/notify.js
//
// Fail-soft helper voor het aanmaken van rijen in public.notifications.
// Bedoeld om vanuit ANDERE endpoints aangeroepen te worden nadat een
// hoofd-actie geslaagd is — een mislukte melding mag de hoofd-actie
// nooit breken, dus we vangen ALLES intern op en throwen nooit door.
//
// Schema (public.notifications):
//   id uuid, user_id uuid, type text, title text, body text,
//   link_url text, entity_type text, entity_id uuid,
//   priority text ('low'|'normal'|'high'), created_by uuid,
//   created_at timestamptz, read_at timestamptz (null = ongelezen)
//
// Gebruik:
//   await createNotification({
//     toUserId: someUserId,                  // OF toRole: 'manager' | ['manager','super_admin']
//     type:     'mentor_status',
//     title:    'Mentor-update: Geen gehoor',
//     body:     'Optioneel',
//     linkUrl:  '/modules/onboarding-hub.html?open=<uuid>',
//     entityType: 'onboarding',
//     entityId:   '<uuid>',
//     priority:   'normal',
//     createdBy:  callerUserId,
//     dedupWithinMs: 5 * 60 * 1000,          // optioneel
//   });
//
// toRole kan een string of een array van strings zijn. Bij een array worden
// user_ids van alle rollen samengevoegd en gededupt (Set) — een user met
// meerdere rollen (bv. manager + super_admin) krijgt dus maar ÉÉN rij.
//
// Return: { ok: boolean, count: number }
//   - count = aantal rijen daadwerkelijk geïnsert (excl. dedup-skips).
//   - ok=false als input invalid of er een fout afgevangen werd; nooit
//     throw — caller blijft 200 geven aan de eindgebruiker.

import { supabaseAdmin } from '../supabase.js';

const ALLOWED_PRIORITIES = new Set(['low', 'normal', 'high']);

function _now() { return new Date().toISOString(); }

/**
 * @param {object} opts
 * @param {string} [opts.toUserId]    - exact-één-van met toRole
 * @param {string} [opts.toRole]      - exact-één-van met toUserId (fan-out)
 * @param {string} opts.type          - korte slug, bv 'mentor_status'
 * @param {string} opts.title         - korte koptekst
 * @param {string} [opts.body]        - lange tekst (optioneel)
 * @param {string} [opts.linkUrl]     - deep-link (optioneel)
 * @param {string} [opts.entityType]  - 'onboarding'|'invoice'|...
 * @param {string} [opts.entityId]    - uuid van entity (voor dedup)
 * @param {'low'|'normal'|'high'} [opts.priority='normal']
 * @param {string} [opts.createdBy]   - actor user_id (audit)
 * @param {number} [opts.dedupWithinMs] - skip per ontvanger als er al
 *   een rij bestaat met zelfde (type, entity_id) binnen window
 * @returns {Promise<{ok: boolean, count: number, error?: string}>}
 */
export async function createNotification(opts) {
  try {
    if (!opts || typeof opts !== 'object') {
      return { ok: false, count: 0, error: 'opts vereist' };
    }
    const {
      toUserId,
      toRole,
      type,
      title,
      body          = null,
      linkUrl       = null,
      entityType    = null,
      entityId      = null,
      priority      = 'normal',
      createdBy     = null,
      dedupWithinMs = 0,
    } = opts;

    if (!type  || typeof type  !== 'string' || !type.trim())  return { ok: false, count: 0, error: 'type vereist' };
    if (!title || typeof title !== 'string' || !title.trim()) return { ok: false, count: 0, error: 'title vereist' };
    const prio = ALLOWED_PRIORITIES.has(priority) ? priority : 'normal';

    // Exact één van toUserId / toRole — niet beide, niet geen van beide.
    // toRole kan een string of een array van strings zijn.
    const hasUser  = !!(toUserId && typeof toUserId === 'string');
    const roleList = Array.isArray(toRole)
      ? toRole.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim())
      : (typeof toRole === 'string' && toRole.trim() ? [toRole.trim()] : []);
    const hasRole = roleList.length > 0;
    if (hasUser === hasRole) {
      return { ok: false, count: 0, error: 'exact één van toUserId / toRole vereist' };
    }

    // 1) Bepaal de ontvanger-lijst. Multi-rol: query met .in('role', […])
    //    en dedup de user_ids via een Set zodat een user met meerdere
    //    rollen (bv. manager + super_admin) niet dubbel geraakt wordt.
    let recipients = [];
    if (hasUser) {
      recipients = [toUserId];
    } else {
      const { data: rows, error } = await supabaseAdmin
        .from('user_roles')
        .select('user_id')
        .in('role', roleList);
      if (error) {
        console.warn('[notify] user_roles fetch faalde:', error.message);
        return { ok: false, count: 0, error: error.message };
      }
      recipients = Array.from(new Set((rows || []).map((r) => r.user_id).filter(Boolean)));
    }
    if (recipients.length === 0) return { ok: true, count: 0 };

    // 2) Optionele dedup: skip ontvangers die al een rij met dezelfde
    //    (type, entity_id) binnen de window hebben. Werkt alleen zinvol
    //    met entityId — zonder entityId zou elke nieuwe melding van
    //    hetzelfde type per ontvanger ten onrechte geskipt worden.
    let toInsert = recipients;
    if (dedupWithinMs > 0 && entityId) {
      const sinceIso = new Date(Date.now() - Math.max(0, dedupWithinMs)).toISOString();
      try {
        const { data: dups, error: dupErr } = await supabaseAdmin
          .from('notifications')
          .select('user_id')
          .in('user_id', recipients)
          .eq('type', type)
          .eq('entity_id', entityId)
          .gte('created_at', sinceIso);
        if (dupErr) {
          console.warn('[notify] dedup lookup faalde (soft):', dupErr.message);
        } else if (Array.isArray(dups)) {
          const dupSet = new Set(dups.map((r) => r.user_id).filter(Boolean));
          toInsert = recipients.filter((uid) => !dupSet.has(uid));
        }
      } catch (e) {
        console.warn('[notify] dedup exception (soft):', e?.message || e);
      }
    }
    if (toInsert.length === 0) return { ok: true, count: 0 };

    // 3) Batch-insert. Eén rij per ontvanger.
    const nowIso = _now();
    const rows = toInsert.map((uid) => ({
      user_id:     uid,
      type:        String(type).trim(),
      title:       String(title).trim(),
      body:        body         || null,
      link_url:    linkUrl      || null,
      entity_type: entityType   || null,
      entity_id:   entityId     || null,
      priority:    prio,
      created_by:  createdBy    || null,
      created_at:  nowIso,
    }));
    const { data: ins, error: insErr } = await supabaseAdmin
      .from('notifications')
      .insert(rows)
      .select('id');
    if (insErr) {
      console.warn('[notify] insert faalde:', insErr.message);
      return { ok: false, count: 0, error: insErr.message };
    }
    return { ok: true, count: (ins || []).length };
  } catch (e) {
    console.warn('[notify] exception (soft):', e?.message || e);
    return { ok: false, count: 0, error: e?.message || String(e) };
  }
}

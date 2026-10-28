// api/_lib/onboarding-portal-kolommen.js
//
// portal_gestart_op / portal_geopend_op (migratie 2026-10-28-onboarding-
// portal-gestart.sql) — apart en faalzacht gelezen, zodat het overzicht, het
// detail, de LMS-spiegel en de portal blijven werken zolang de migratie niet
// gedraaid is.
//
// Afspraak voor de afleiding (onboarding-antwoorden.js `portalVoortgang`):
//   · de sleutel staat op de rij (ook als null) → de kolom is gelezen;
//   · de sleutel ontbreekt (undefined)          → niet gelezen: geen
//     onderscheid oude/nieuwe wizard, terugval op de oude afleiding.

export const PORTAL_KOLOMMEN = Object.freeze(['portal_gestart_op', 'portal_geopend_op']);

/** Ontbreekt (een van) de portalkolommen nog? PURE. */
export function isPortalKolomOntbreekt(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '');
  return (code === '42703' || code === 'PGRST204' || /does not exist|schema cache/i.test(msg))
    && PORTAL_KOLOMMEN.some((k) => msg.includes(k));
}

/**
 * id → { portal_gestart_op, portal_geopend_op } voor een lijst onboardings,
 * of `null` als de kolommen (nog) niet te lezen zijn. Gooit niet.
 */
export async function leesPortalKolommen(db, ids) {
  const lijst = [...new Set((ids || []).filter(Boolean))];
  const uit = new Map();
  if (!lijst.length) return uit;
  try {
    for (let i = 0; i < lijst.length; i += 200) {
      const { data, error } = await db.from('onboardings')
        .select('id, ' + PORTAL_KOLOMMEN.join(', '))
        .in('id', lijst.slice(i, i + 200));
      if (error) {
        if (isPortalKolomOntbreekt(error)) {
          console.warn('[onboarding-portal-kolommen] kolommen ontbreken nog — draai 2026-10-28-onboarding-portal-gestart.sql');
        } else {
          console.error('[onboarding-portal-kolommen] lezen:', error.message);
        }
        return null;
      }
      for (const r of data || []) {
        uit.set(r.id, { portal_gestart_op: r.portal_gestart_op || null, portal_geopend_op: r.portal_geopend_op || null });
      }
    }
    return uit;
  } catch (e) {
    console.error('[onboarding-portal-kolommen] lezen:', e?.message || e);
    return null;
  }
}

/** Zet de portalkolommen op de rij (in place) als ze te lezen zijn. Gooit niet. */
export async function vulPortalKolommenAan(db, ob) {
  if (!ob?.id) return ob;
  const m = await leesPortalKolommen(db, [ob.id]);
  if (m) Object.assign(ob, m.get(ob.id) || { portal_gestart_op: null, portal_geopend_op: null });
  return ob;
}

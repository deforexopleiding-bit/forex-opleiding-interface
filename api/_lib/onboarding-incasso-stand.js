// api/_lib/onboarding-incasso-stand.js
//
// STAAT DEZE ONBOARDING IN INCASSO-OPVOLGING? — alleen lezen en beslissen
// (6 oktober 2026). Apart van onboarding-incasso.js (dat ook schrijft en de
// startdatum-route aanroept), zodat de spiegel naar het LMS deze regel kan
// gebruiken zonder iets binnen te halen dat meldingen verstuurt.

export const INCASSO_KOLOMMEN = 'id, incasso_op, incasso_door, incasso_reden, incasso_terug_op, incasso_terug_door';

/** "De kolom bestaat nog niet". PURE. */
export function isIncassoKolomOntbreekt(err) {
  const code = String(err?.code || '');
  if (code !== 'PGRST204' && code !== '42703') return false;
  return /incasso_/.test(String(err?.message || ''));
}

/** Staat deze onboarding nu in incasso-opvolging? PURE. */
export function inIncasso(ob) {
  if (!ob?.incasso_op) return false;
  if (!ob.incasso_terug_op) return true;
  return Date.parse(ob.incasso_terug_op) < Date.parse(ob.incasso_op);
}

let _ontbreektGemeld = false;

/**
 * Vul de incasso-velden aan op rijen die al uit `onboardings` gelezen zijn.
 * Faalzacht: vóór de migratie (of bij een fout) blijft niemand in incasso.
 */
export async function vulIncassoAan(db, rijen) {
  const lijst = Array.isArray(rijen) ? rijen : (rijen ? [rijen] : []);
  const ids = [...new Set(lijst.map((r) => r?.id).filter(Boolean))];
  if (!ids.length) return rijen;
  try {
    const kaart = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db.from('onboardings').select(INCASSO_KOLOMMEN).in('id', ids.slice(i, i + 200));
      if (error) {
        if (isIncassoKolomOntbreekt(error)) {
          if (!_ontbreektGemeld) {
            console.warn('[onboarding-incasso] kolommen ontbreken nog (migratie 2026-10-06-onboarding-incasso.sql)');
            _ontbreektGemeld = true;
          }
          return rijen;
        }
        throw new Error(error.message);
      }
      for (const r of data || []) kaart.set(r.id, r);
    }
    for (const r of lijst) {
      const h = r?.id ? kaart.get(r.id) : null;
      r.incasso_op = h?.incasso_op || null;
      r.incasso_door = h?.incasso_door || null;
      r.incasso_reden = h?.incasso_reden || null;
      r.incasso_terug_op = h?.incasso_terug_op || null;
      r.incasso_terug_door = h?.incasso_terug_door || null;
    }
  } catch (e) {
    console.warn('[onboarding-incasso] niet gelezen:', e?.message || e);
  }
  return rijen;
}


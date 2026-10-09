// api/_lib/in-porties.js
//
// `.in(kolom, ids)` in porties. PostgREST zet de hele id-lijst in de URL; vanaf
// ~400 uuid's wordt die te lang en faalt het request ('fetch failed'). Ook bij
// minder ids kapt PostgREST op max-rows (1000) af. Met porties van ~100 blijft
// elke URL klein; de caller combineert de rijen.
//
// Gebruik:
//   const { data, error } = await selectInPorties(convIds, (deel) =>
//     supabaseAdmin.from('whatsapp_messages').select('conversation_id').in('conversation_id', deel));
//
// Gooit niet. Bij een fout in een portie: `error` = de eerste fout, `data` = de
// rijen van de porties die wél lukten. De caller beslist of dat genoeg is —
// en logt de fout (stil negeren was precies de bug in leadsonderhoud-gesprekken).

export const PORTIE = 100;

export async function selectInPorties(ids, maakQuery, { grootte = PORTIE } = {}) {
  const lijst = Array.from(new Set((ids || []).filter(Boolean)));
  const data = [];
  let error = null;
  for (let i = 0; i < lijst.length; i += grootte) {
    try {
      const r = await maakQuery(lijst.slice(i, i + grootte));
      if (r?.error) { error = error || r.error; continue; }
      if (Array.isArray(r?.data)) data.push(...r.data);
    } catch (e) {
      error = error || e;
    }
  }
  return { data, error };
}

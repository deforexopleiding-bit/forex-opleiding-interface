// api/_lib/bubbleStudentMentors.js
//
// getStudentMentorMap() — bulk-resolve van klant/student-e-mail → mentor-
// naam uit Bubble. Bedoeld voor readers zoals sales-retention die per
// klant de mentor willen tonen zonder per-klant API-call.
//
// Werking:
//   1. fetchAllBubbleStudents() — alle Bubble-users met role=student.
//      Uit elke user extraheren we {email, mentor_bubble_user_id} via
//      mapBubbleStudentRow.
//   2. Bulk-fetch alle Bubble-users met role=mentor en bouw een
//      Map<bubble_user_id, displayName>.
//   3. Combineer tot Map<lower(email), mentorName> — alleen entries met
//      een geresolvde mentor (studenten zonder mentor of onbekende id
//      vallen weg).
//
// CACHE: module-scope met TTL 15 min. Bij een warme container betaalt
// slechts de eerste caller de Bubble round-trip.
//
// FAIL-SOFT: bij een Bubble-fout (BUBBLE_CONFIG_MISSING / netwerk / HTTP)
// returnen we een LEGE Map en loggen we een warning. De caller (bv.
// sales-retention) hoort dan gewoon door te gaan; UI toont "Niet
// toegewezen" waar de match ontbreekt.

import { bubbleList, bubbleUserDisplay } from './bubble.js';
import { fetchAllBubbleStudents, mapBubbleStudentRow } from './mentorStudents.js';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

// _cache bestaat 1x per Node-runtime. Bij een cold-start is dit leeg;
// bij een warme herbruikte container is de tweede caller binnen 15 min
// direct raak.
let _cache = { at: 0, map: null, promise: null };

/**
 * Returnt Map<lower(email), mentorName>. Bij fout: lege Map.
 * @returns {Promise<Map<string,string>>}
 */
export async function getStudentMentorMap() {
  const now = Date.now();
  if (_cache.map && (now - _cache.at) < CACHE_TTL_MS) return _cache.map;

  // Coalesce parallelle callers op één in-flight promise, anders spawnt
  // een spike (multi-request boot) N tegelijk dezelfde Bubble-fetch.
  if (_cache.promise) return _cache.promise;

  const p = (async () => {
    const map = new Map();
    try {
      // 1) Alle studenten org-breed.
      const students = await fetchAllBubbleStudents();

      // 2) Verzamel {email → mentorId} + unieke mentor-ids.
      const mentorIds = new Set();
      const studentToMentor = [];
      for (const s of (students || [])) {
        const mapped = mapBubbleStudentRow(s);
        const email = mapped.email ? String(mapped.email).trim().toLowerCase() : '';
        const mid   = mapped.mentor_bubble_user_id;
        if (!email || !mid) continue;
        studentToMentor.push({ email, mentorId: String(mid) });
        mentorIds.add(String(mid));
      }

      // 3) Bulk-fetch mentors → Map<id, displayName>.
      if (mentorIds.size) {
        const constraints = [
          { key: 'role_option_os___roles', constraint_type: 'equals', value: 'mentor' },
        ];
        const { results } = await bubbleList('user', constraints, { limit: 500 });
        const mentorNameById = new Map();
        for (const u of (results || [])) {
          const id = String(u?._id || '');
          if (!id) continue;
          // Alleen mentors bewaren waar minstens 1 student naar wijst;
          // spaart wat geheugen bij grote org's zonder impact op correctheid.
          if (!mentorIds.has(id)) continue;
          const { name, email } = bubbleUserDisplay(u);
          const display = (name && name.trim()) || (email && email.trim()) || null;
          if (display) mentorNameById.set(id, display);
        }

        // 4) Combine.
        for (const { email, mentorId } of studentToMentor) {
          const nm = mentorNameById.get(mentorId);
          if (nm) map.set(email, nm);
        }
      }

      _cache = { at: Date.now(), map, promise: null };
      return map;
    } catch (e) {
      console.warn('[bubbleStudentMentors] fail-soft:', e?.code || '', e?.message || e);
      // Cache de lege map NIET met een lange TTL — retry snel bij transiente
      // fout. We resetten de in-flight promise wel zodat volgende callers
      // opnieuw kunnen proberen.
      _cache.promise = null;
      return new Map();
    }
  })();

  _cache.promise = p;
  return p;
}

// api/_lib/sales-streak-compute.js
// Streak = aantal opeenvolgende ACTIEVE dagen met ≥1 getekende offerte.
//
// Actieve dagen: ma-vr altijd; zaterdag alleen als er die dag een published
// event is; zondag nooit.
// Terugkijkend vanaf vandaag:
//   - niet-actief → skip (breekt niet)
//   - actief + ≥1 sale → +1
//   - actief + 0 sales → STOP
// Vandaag-uitzondering: vandaag actief + 0 sales → begin bij VORIGE actieve
// dag i.p.v. te stoppen op vandaag. Terugloop-limiet 60 dagen.

import { nlDateString } from './nl-period.js';

const LOOK_BACK = 60;
const CREATED_BUFFER_DAYS = 90;  // deal accepted-vs-created lag-buffer

function effectiveAcceptedAt(d) {
  return d.tl_quotation_accepted_at || d.tl_quotation_signed_at || d.created_at || null;
}
function nlDayOfWeek(dateObj) {
  const wk = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', weekday: 'short' }).format(dateObj);
  return { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[wk];
}

export async function computeSalesStreak({ supabaseAdmin, todayDayStart }) {
  const startWindow  = new Date(todayDayStart.getTime() - LOOK_BACK * 86400000);
  const endWindow    = new Date(todayDayStart.getTime() + 86400000);
  // 90-dag buffer op SQL-filter zodat we geen deal missen waarvan created_at
  // buiten window valt maar effective accepted_at binnen window (deal-cyclus
  // is normaal < 30d — 90d is ruim). Client-side filteren we alsnog op
  // effective binnen [startWindow, endWindow).
  const bufferedStart = new Date(startWindow.getTime() - CREATED_BUFFER_DAYS * 86400000);

  const [dealsRes, evtsRes] = await Promise.all([
    supabaseAdmin.from('deals')
      .select('tl_quotation_accepted_at, tl_quotation_signed_at, created_at')
      .eq('tl_quotation_status', 'accepted')
      .is('tl_quotation_declined_at', null).is('archived_at', null)
      .gte('created_at', bufferedStart.toISOString()).lt('created_at', endWindow.toISOString()),
    supabaseAdmin.from('events').select('starts_at')
      .eq('status', 'published')
      .gte('starts_at', startWindow.toISOString()).lt('starts_at', endWindow.toISOString()),
  ]);

  const salesDays = new Set();
  for (const d of (dealsRes.data || [])) {
    const eff = effectiveAcceptedAt(d);
    if (!eff) continue;
    const effMs = new Date(eff).getTime();
    if (effMs < startWindow.getTime() || effMs >= endWindow.getTime()) continue;
    salesDays.add(nlDateString(new Date(eff)));
  }
  const eventDays = new Set();
  for (const e of (evtsRes.data || [])) eventDays.add(nlDateString(new Date(e.starts_at)));

  const isActive = (dateObj, key) => {
    const dow = nlDayOfWeek(dateObj);
    if (dow === 0) return false;               // zondag nooit
    if (dow >= 1 && dow <= 5) return true;     // ma-vr altijd
    return eventDays.has(key);                 // zaterdag alleen met event
  };

  let streak = 0;
  const todayKey = nlDateString(todayDayStart);
  let cursor = new Date(todayDayStart);
  let isFirstStep = true;
  for (let i = 0; i < LOOK_BACK; i++) {
    const key = nlDateString(cursor);
    const active = isActive(cursor, key);
    if (active) {
      if (salesDays.has(key))                        { streak += 1; isFirstStep = false; }
      else if (isFirstStep && key === todayKey)      { isFirstStep = false; /* skip today */ }
      else                                            { break; }
    }
    cursor = new Date(cursor.getTime() - 86400000);
  }
  return streak;
}

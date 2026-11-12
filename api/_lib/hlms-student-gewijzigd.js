// api/_lib/hlms-student-gewijzigd.js
//
// Puur en zonder imports — bewust een eigen bestand, zodat tests die
// dfo-lms-db.js nabootsen deze helper niet hoeven mee te leveren.

/**
 * Elke UPDATE op `hlms_student` zet ook `gewijzigd_op` (12 nov 2026). De kolom
 * heeft enkel `default now()` (geldt bij een insert) en geen trigger: het LMS
 * zet hem zelf bij elke wijziging, en het CRM deed dat nergens. Gemeten bij de
 * eerste echte offertewissel (onboarding 3ae3ce0f, 12 nov): traject, calls en
 * eind_datum veranderden, gewijzigd_op bleef op 21 okt. PURE: geeft een NIEUW
 * object terug, de invoer blijft ongemoeid.
 * @param {object} patch
 * @param {Date} [nu]
 */
export function metGewijzigdOp(patch, nu = new Date()) {
  return { ...(patch || {}), gewijzigd_op: nu.toISOString() };
}

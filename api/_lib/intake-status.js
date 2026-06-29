// api/_lib/intake-status.js
//
// Afgeleide intake-status voor een toekomstige onboarding. **Spiegel** van
// _futureIntakeState() / _INTAKE_META in modules/mentor-students.html (Fase 1).
// Mentor-frontend en admin-backend MOETEN deze logica identiek toepassen —
// als je hier iets aanpast, pas het OOK aan in mentor-students.html.
//
// Prioriteit (hoog → laag) — bepaalt welke status van toepassing is:
//   1) gestart           — er bestaat een AFGERONDE 1-op-1 voor deze bubble_user_id.
//   2) wil_niet          — mentor heeft handmatig 'wil_niet' gezet.
//   3) no_show           — er is een no-show voor deze bubble_user_id (en geen
//                          afgeronde call daarna; gestart wint, dus dat dekt
//                          de "geen afgeronde call na no-show"-regel vanzelf).
//   4) geen_gehoor       — handmatig 'geen_gehoor'.
//   5) wil_later         — handmatig 'wil_later'.
//   6) call_ingepland    — er bestaat een GEPLANDE (toekomstige) 1-op-1.
//   7) nog_te_benaderen  — default.
//
// Server-rank (problemen-bovenaan) — bepaalt sort-volgorde in admin-overzichten:
//   nog_geen_mentor(-1) → wil_niet(0) → no_show(1) → geen_gehoor(2)
//   → wil_later(3) → nog_te_benaderen(4) → call_ingepland(5) → gestart(9)
//
// nog_geen_mentor staat hoger dan wil_niet omdat de manager hier de eerste
// blokkade ziet: zonder mentor kan de student niets. Dat MOET bovenaan.

const INTAKE_RANK = Object.freeze({
  nog_geen_mentor:  -1,
  wil_niet:         0,
  no_show:          1,
  geen_gehoor:      2,
  wil_later:        3,
  nog_te_benaderen: 4,
  call_ingepland:   5,
  gestart:          9,
});

export const INTAKE_STATUS_KEYS = Object.freeze([
  'gestart', 'wil_niet', 'no_show', 'geen_gehoor', 'wil_later',
  'call_ingepland', 'nog_te_benaderen', 'nog_geen_mentor',
]);

// Voor de mentor-view (mentor-students.html) bestaat de 'nog_geen_mentor'-
// case niet — een mentor ziet alleen z'n eigen toegewezen onboardings. Dat
// pad blijft in _futureIntakeState in mentor-students.html zonder deze key.
// Pas je een wijziging aan hier en raakt 'm óók de mentor-prioriteit, hou
// die mirror dan synchroon.
export function deriveIntakeStatus(signals) {
  const s = signals || {};
  // Geen mentor toegewezen → highest priority (manager moet eerst toewijzen).
  // Behalve als de student al gestart is (afgeronde call wint nog steeds —
  // dat is in de praktijk vrijwel onmogelijk zonder mentor, maar de
  // semantiek "gestart" is sterker).
  if (s.hasCompletedSession)                  return 'gestart';
  if (s.hasMentor === false)                  return 'nog_geen_mentor';
  if (s.mentor_intake_status === 'wil_niet')  return 'wil_niet';
  if (s.hasNoshow)                            return 'no_show';
  if (s.mentor_intake_status === 'geen_gehoor') return 'geen_gehoor';
  if (s.mentor_intake_status === 'wil_later')   return 'wil_later';
  if (s.hasFutureCall)                        return 'call_ingepland';
  return 'nog_te_benaderen';
}

export function intakeStatusRank(status) {
  return Object.prototype.hasOwnProperty.call(INTAKE_RANK, status)
    ? INTAKE_RANK[status]
    : 99;
}

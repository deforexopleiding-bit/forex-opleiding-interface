// api/_lib/dunning-skip-helpers.js
//
// Pure helper voor api/finance-dunning-run-skip-step.js. Bepaalt vanuit
// een sorteerbare stap-lijst welke stap de huidige is en welke daar direct
// op volgt. Getest zonder DB.
//
// Aanname: dunning_workflow_steps heeft UNIQUE(workflow_id, step_order),
// dus de "volgende stap" is deterministisch te vinden door alle stappen
// van deze workflow op step_order oplopend te sorteren en de eerste te
// pakken waarvan step_order > current.step_order.

/**
 * @param {Array<{id, step_order, step_type, config?}>} steps
 *   Alle steps van de betrokken workflow. Volgorde van de input maakt
 *   niet uit — we sorteren zelf.
 * @param {string} currentStepId
 * @returns {{ current: object|null, next: object|null }}
 *   current = de huidige stap-rij (null als niet gevonden — engine-glitch)
 *   next    = de eerstvolgende stap (null als laatste)
 */
export function findNextStep(steps, currentStepId) {
  const list = Array.isArray(steps) ? [...steps] : [];
  if (list.length === 0 || !currentStepId) {
    return { current: null, next: null };
  }
  list.sort((a, b) => (Number(a.step_order) || 0) - (Number(b.step_order) || 0));
  const idx = list.findIndex((s) => s.id === currentStepId);
  if (idx === -1) return { current: null, next: null };
  return {
    current: list[idx],
    next:    idx + 1 < list.length ? list[idx + 1] : null,
  };
}

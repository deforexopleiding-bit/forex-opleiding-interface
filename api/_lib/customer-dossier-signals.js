// api/_lib/customer-dossier-signals.js
//
// Pure functie: gegeven de rauwe klant-data uit customer-dossier.js,
// detecteer een lijst van AFGELEIDE SIGNALEN die aandacht behoeven.
// Signalen zijn NOOIT harde fouten — het zijn heuristieken die het
// operationele team helpen om "vergeten" klanten op te sporen.
//
// Elk signaal:
//   { code:     'ARRANGEMENT_APPROVED_NOT_EXECUTED',
//     severity: 'warning' | 'info' | 'critical',
//     message:  'Regeling goedgekeurd op 5 jul, nog niet verwerkt.',
//     evidence: { arrangement_id, days_open, ... } }
//
// Volledig zonder DB-calls zodat unit-testbaar.

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((nowMs - t) / DAY_MS);
}

/**
 * @param {object} input
 * @param {Array}  input.arrangements      payment_arrangements rows
 * @param {Array}  input.pendingActions    pending_actions rows (open + gesloten)
 * @param {Array}  input.runs              dunning_workflow_runs rows
 * @param {Array}  input.invoices          invoices rows (met amount_open)
 * @param {Array}  input.dunningLog        dunning_log rows (nieuwste eerst)
 * @param {Array}  input.whatsappMessages  whatsapp_messages rows (nieuwste eerst)
 * @param {number} [input.nowMs]           Date.now() equivalent — injecteerbaar voor tests
 * @returns {Array<{code, severity, message, evidence}>}
 */
export function detectSignals(input) {
  const nowMs = Number.isFinite(input?.nowMs) ? input.nowMs : Date.now();
  const arrangements     = Array.isArray(input?.arrangements) ? input.arrangements : [];
  const pendingActions   = Array.isArray(input?.pendingActions) ? input.pendingActions : [];
  const runs             = Array.isArray(input?.runs) ? input.runs : [];
  const invoices         = Array.isArray(input?.invoices) ? input.invoices : [];
  const dunningLog       = Array.isArray(input?.dunningLog) ? input.dunningLog : [];
  const whatsappMessages = Array.isArray(input?.whatsappMessages) ? input.whatsappMessages : [];

  const signals = [];

  // ── 1. Regeling APPROVED maar > 2 dagen niet EXECUTED ──────────────────
  // pending_actions.status='APPROVED' AND executed_at IS NULL AND
  // approved_at ouder dan 2 dagen. Duidt op TL-executor die vastloopt of
  // een handmatige actie die vergeten is.
  for (const pa of pendingActions) {
    if (String(pa.status || '').toUpperCase() !== 'APPROVED') continue;
    if (pa.executed_at) continue;
    const days = daysSince(pa.approved_at, nowMs);
    if (days == null || days < 2) continue;
    signals.push({
      code: 'ACTION_APPROVED_NOT_EXECUTED',
      severity: days >= 7 ? 'critical' : 'warning',
      message: `Actie is ${days} dagen geleden goedgekeurd maar nog niet uitgevoerd.`,
      evidence: {
        pending_action_id: pa.id,
        action_type:       pa.action_type,
        approved_at:       pa.approved_at,
        days_open:         days,
      },
    });
  }

  // ── 2. Gepauzeerde run zonder openstaande actie ────────────────────────
  // dunning_workflow_runs.status='paused' EN geen enkele open pending_action
  // (PENDING of APPROVED). Niemand pakt het op — klant hangt in limbo.
  const openActionCount = pendingActions.filter((pa) => {
    const s = String(pa.status || '').toUpperCase();
    return s === 'PENDING' || s === 'APPROVED';
  }).length;
  const pausedRuns = runs.filter((r) => String(r.status || '').toLowerCase() === 'paused');
  if (pausedRuns.length > 0 && openActionCount === 0) {
    signals.push({
      code: 'RUN_PAUSED_NO_OWNER',
      severity: 'warning',
      message: `Aanmaan-flow staat gepauzeerd maar er ligt geen openstaande actie — niemand pakt dit op.`,
      evidence: {
        run_ids: pausedRuns.map((r) => r.id),
        paused_since: pausedRuns[0]?.updated_at || null,
      },
    });
  }

  // ── 3. Herhaald skipped_open_action (3× of vaker) ──────────────────────
  // Klant staat stil doordat een actie niet wordt afgesloten. In de
  // dunning_log filteren op event_type + tellen per run_id.
  const skipCountByRun = new Map();
  for (const row of dunningLog) {
    if (row.event_type !== 'skipped_open_action') continue;
    skipCountByRun.set(row.run_id, (skipCountByRun.get(row.run_id) || 0) + 1);
  }
  for (const [runId, count] of skipCountByRun.entries()) {
    if (count < 3) continue;
    signals.push({
      code: 'REPEATED_SKIP_OPEN_ACTION',
      severity: count >= 7 ? 'critical' : 'warning',
      message: `Workflow werd ${count}× overgeslagen wegens openstaande actie. Waarschijnlijk vergeten.`,
      evidence: { run_id: runId, skip_count: count },
    });
  }

  // ── 4. Open facturen zonder actieve run en zonder actieve regeling ─────
  // Er zijn openstaande facturen maar niemand maant aan — geen active run,
  // geen ACTIEF/VOORGESTELD arrangement. Kritiek want zonder actie glijdt
  // dit af naar incasso.
  const hasOpenInvoice = invoices.some((iv) => Number(iv.amount_open) > 0);
  const hasActiveRun = runs.some((r) => String(r.status || '').toLowerCase() === 'active');
  const hasActiveArrangement = arrangements.some((a) => {
    const s = String(a.status || '').toUpperCase();
    return s === 'ACTIEF' || s === 'VOORGESTELD';
  });
  if (hasOpenInvoice && !hasActiveRun && !hasActiveArrangement) {
    const totalOpen = invoices.reduce((sum, iv) => sum + (Number(iv.amount_open) || 0), 0);
    signals.push({
      code: 'OPEN_INVOICES_NO_DUNNING',
      severity: 'critical',
      message: `Openstaande facturen zonder actieve aanmaan-flow of regeling — niemand maant aan.`,
      evidence: {
        invoice_count: invoices.filter((iv) => Number(iv.amount_open) > 0).length,
        total_open_amount: Math.round(totalOpen * 100) / 100,
      },
    });
  }

  // ── 5. Klant reageerde, geen antwoord terug ────────────────────────────
  // dunning_log.paused_customer_replied (recent) + géén outbound whatsapp
  // (of email) sindsdien. Als de laatste reactie >2 dagen geleden is en
  // niemand heeft geantwoord: signaal.
  const lastPauseReply = dunningLog.find((r) => r.event_type === 'paused_customer_replied');
  if (lastPauseReply?.created_at) {
    const pauseTs = Date.parse(lastPauseReply.created_at);
    if (Number.isFinite(pauseTs)) {
      const daysSincePause = Math.floor((nowMs - pauseTs) / DAY_MS);
      if (daysSincePause >= 2) {
        // Kijk of er outbound whatsapp is NA de pause-tijd.
        const hasOutboundSince = whatsappMessages.some((m) => {
          const dir = String(m.direction || '').toLowerCase();
          const isOut = dir === 'out' || dir === 'outbound';
          if (!isOut) return false;
          const t = Date.parse(m.sent_at || m.created_at || '');
          return Number.isFinite(t) && t > pauseTs;
        });
        if (!hasOutboundSince) {
          signals.push({
            code: 'CUSTOMER_REPLIED_NO_RESPONSE',
            severity: daysSincePause >= 5 ? 'critical' : 'warning',
            message: `Klant reageerde ${daysSincePause} dagen geleden — nog geen antwoord teruggestuurd.`,
            evidence: {
              paused_at: lastPauseReply.created_at,
              days_silent: daysSincePause,
            },
          });
        }
      }
    }
  }

  // ── 6. Meerdere ACTIEVE regelingen tegelijk (data-integriteit) ─────────
  // Er zou maximaal 1 arrangement in status ACTIEF of VOORGESTELD moeten
  // zijn per klant. Meer = dubbel voorstel / data-glitch die aandacht
  // vereist.
  const liveArrangements = arrangements.filter((a) => {
    const s = String(a.status || '').toUpperCase();
    return s === 'ACTIEF' || s === 'VOORGESTELD';
  });
  if (liveArrangements.length >= 2) {
    signals.push({
      code: 'MULTIPLE_LIVE_ARRANGEMENTS',
      severity: 'critical',
      message: `${liveArrangements.length} regelingen tegelijk actief of voorgesteld — data-integriteit-alarm.`,
      evidence: {
        arrangement_ids: liveArrangements.map((a) => a.id),
        types:           liveArrangements.map((a) => a.type),
        statuses:        liveArrangements.map((a) => a.status),
      },
    });
  }

  // ── 7. Verbroken regeling zonder follow-up ─────────────────────────────
  // Extra signaal: laatste arrangement is VERBROKEN maar er is sindsdien
  // geen nieuwe pending_action (opvolging) aangemaakt. VERBROKEN moet altijd
  // een operationele opvolging krijgen (nieuwe regeling / escalatie).
  const brokenArr = arrangements.find((a) => String(a.status || '').toUpperCase() === 'VERBROKEN');
  if (brokenArr?.updated_at) {
    const brokenTs = Date.parse(brokenArr.updated_at);
    if (Number.isFinite(brokenTs)) {
      const daysSinceBroken = Math.floor((nowMs - brokenTs) / DAY_MS);
      const hasFollowupSince = pendingActions.some((pa) => {
        const t = Date.parse(pa.created_at || '');
        return Number.isFinite(t) && t > brokenTs;
      });
      if (!hasFollowupSince && daysSinceBroken >= 3) {
        signals.push({
          code: 'BROKEN_ARRANGEMENT_NO_FOLLOWUP',
          severity: daysSinceBroken >= 14 ? 'critical' : 'warning',
          message: `Regeling verbroken op ${brokenArr.updated_at?.slice(0,10) || '?'} — geen opvolging aangemaakt.`,
          evidence: {
            arrangement_id: brokenArr.id,
            broken_at:      brokenArr.updated_at,
            days_open:      daysSinceBroken,
          },
        });
      }
    }
  }

  return signals;
}

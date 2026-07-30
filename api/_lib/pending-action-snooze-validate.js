// api/_lib/pending-action-snooze-validate.js
//
// Pure helpers voor pending-action-snooze — extract voor unit-testbaarheid
// zonder DB/HTTP-mocks. Twee onafhankelijke checks:
//
//   validateSnoozeInput({ id, scheduled_for, now, minFutureMs? })
//     -> { ok: true,  scheduledForIso, minFutureMs }
//     -> { ok: false, code, error }
//
//   checkCanSnooze(row)
//     -> { ok: true }
//     -> { ok: false, code, error, current_status? }
//
// Reden voor splitsing: input-validatie (formaat + toekomst-buffer) heeft
// geen DB-kennis nodig; row-check hangt af van de row uit de DB. Door ze
// gescheiden te houden kunnen we beide 100% dekken zonder mocks.
//
// De endpoint-handler ketent ze in dezelfde volgorde en voegt daaraan toe:
//   1. auth (JWT + RBAC)
//   2. validateSnoozeInput
//   3. supabase.select() → row load
//   4. checkCanSnooze(row)
//   5. supabase.update() met eq('status','PENDING') als race-guard

// Veiligheids-buffer: snooze-datum moet minimaal N ms in de toekomst zijn.
// Default 60s. Bij <60s kan clock-drift tussen client en Supabase de
// pending-actions-list-filter (scheduled_for <= now) alsnog laten "hit"-en
// waardoor de taak per ongeluk in Te doen blijft staan.
export const DEFAULT_MIN_FUTURE_MS = 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Input-validatie ────────────────────────────────────────────────────
export function validateSnoozeInput({ id, scheduled_for, now, minFutureMs } = {}) {
  const buffer = Number.isFinite(minFutureMs) ? minFutureMs : DEFAULT_MIN_FUTURE_MS;

  const idStr = id ? String(id).trim() : '';
  if (!idStr || !UUID_RE.test(idStr)) {
    return { ok: false, code: 'MISSING_ID', error: 'id ontbreekt of is geen UUID' };
  }

  const rawStr = scheduled_for ? String(scheduled_for).trim() : '';
  if (!rawStr) {
    return { ok: false, code: 'MISSING_SCHEDULED_FOR', error: 'scheduled_for ontbreekt' };
  }

  const dt = new Date(rawStr);
  if (Number.isNaN(dt.getTime())) {
    return {
      ok: false,
      code: 'MISSING_SCHEDULED_FOR',
      error: 'scheduled_for is geen geldige ISO-datum',
    };
  }

  const nowMs = Number.isFinite(now) ? now : Date.now();
  if (dt.getTime() < nowMs + buffer) {
    return {
      ok: false,
      code: 'SCHEDULED_FOR_PAST',
      error: `scheduled_for moet minimaal ${Math.round(buffer / 1000)} seconden in de toekomst liggen`,
      min_future_ms: buffer,
    };
  }

  return { ok: true, scheduledForIso: dt.toISOString(), minFutureMs: buffer };
}

// ── Row-check ──────────────────────────────────────────────────────────
export function checkCanSnooze(row) {
  if (!row) {
    return { ok: false, code: 'NOT_FOUND', error: 'pending_action niet gevonden' };
  }
  const status = String(row.status || '').toUpperCase();
  if (status !== 'PENDING') {
    return {
      ok: false,
      code: 'NOT_PENDING',
      error: `Alleen PENDING taken kunnen gesnoozed worden (status=${row.status})`,
      current_status: row.status,
    };
  }
  return { ok: true };
}

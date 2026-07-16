// api/cron-arrangements-breach-check.js
// D5 — Breach-detection cron voor payment_arrangements.
//
// Scant alle ACTIEF arrangements en bepaalt of ze NAGEKOMEN of VERBROKEN
// moeten worden op basis van type + huidige tijd + factuur-status.
//
// Type-gedrag:
//   UITSTEL        — als now > details.ends_on (of legacy new_due_date):
//                    alle invoices paid  -> NAGEKOMEN
//                    minstens 1 open     -> VERBROKEN
//   SPLITSING      — verstreken termijn niet betaald -> VERBROKEN
//                    alle invoices paid (alle parts voldaan) -> NAGEKOMEN
//   ABONNEMENT_PAUZE — als now > pause_until -> NAGEKOMEN (pauze afgelopen)
//   ABONNEMENT_STOP  — skip (stop = final)
//   KWIJTSCHELDING   — skip (final)
//   TOEZEGGING       — LICHT type (geen TL-actie). Per part:
//                      * part.invoice_id gezet + verstreken → check die factuur
//                      * part.invoice_id NULL + verstreken → check alle
//                        arrangement invoice_ids (geldt voor 'alles op X')
//                      Alle parts nagekomen (facturen paid) -> NAGEKOMEN
//                      Minstens 1 verstreken part met open bedrag -> VERBROKEN
//
// Per state-change wordt een audit_log row geschreven met action
// 'finance.arrangement.breach_check_state_change'. Aan het eind een
// summary-row 'cron.arrangements_breach_check_run'.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth, zelfde patroon als
// cron-dunning-engine / cron-finance-sync).
//
// Methodes: GET (Vercel cron) + POST (handmatige debug-trigger).
// Schedule: dagelijks 06:00 UTC (zie vercel.json).

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { isDryRunEnabled } from './_lib/dunning-dry-run.js';

const ABORT_MS = 50_000;
const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const startedAt = Date.now();
  // ── DRY-RUN KILLSWITCH ──────────────────────────────────────────────
  // Bewuste keuze (fundament voor Fase 2b acties):
  //   * Status-flips VOORGESTELD/ACTIEF -> NAGEKOMEN/VERBROKEN blijven ook
  //     in dry-run doorgaan. Reden: het zijn zuivere administratie-updates
  //     in ONZE eigen DB (geen externe zij-effecten), en de status is de
  //     bron van waarheid waarop de rest van de UI + toekomstige action-
  //     hooks al vertrouwen. Als we die zouden stoppen zou de sandbox een
  //     valse indruk geven ("afspraak nog ACTIEF"), en zouden Fase 2b-
  //     acties bij Live-modus ineens allemaal tegelijk vuren.
  //   * De `dry`-vlag wordt WEL vastgelegd in de summary + in elke audit_log
  //     state-change entry (before_json.dry_run + after_json.dry_run),
  //     zodat Fase 2b action-hooks (WhatsApp / taak / workflow hervatten)
  //     de vlag kunnen inspecteren en hard skip'en in dry-run.
  //   * Log-regel bij start + eind maakt zichtbaar of dry-run aan stond,
  //     zodat je in Vercel-logs direct ziet: 'wel geflipt, geen acties'
  //     vs 'echt geflipt + echte acties'.
  const dry = await isDryRunEnabled().catch((e) => {
    console.warn('[cron-arrangements-breach-check] dry-run lookup faalde, fail-safe naar dry=true:', e?.message || e);
    return true;
  });
  console.log('[cron-arrangements-breach-check] start dry_run=' + dry);
  const summary = {
    dry_run: dry,
    checked_count: 0,
    transitioned_to_nagekomen: 0,
    transitioned_to_verbroken: 0,
    skipped: 0,
    errors: [],
    duration_ms: 0,
  };

  try {
    const { data: arrangements, error: arrErr } = await supabaseAdmin
      .from('payment_arrangements')
      .select('id, customer_id, type, status, invoice_ids, details, created_at, updated_at')
      .in('status', ['ACTIEF', 'actief']);
    if (arrErr) throw arrErr;

    for (const arr of arrangements || []) {
      if (Date.now() - startedAt > ABORT_MS) {
        summary.errors.push({ phase: 'time_budget', message: 'aborted before completion' });
        break;
      }
      summary.checked_count++;

      try {
        const decision = await evaluateArrangement(arr);
        if (!decision || !decision.newStatus) {
          summary.skipped++;
          continue;
        }

        const { newStatus, reason } = decision;
        const nowIso = new Date().toISOString();

        const { error: updErr } = await supabaseAdmin
          .from('payment_arrangements')
          .update({ status: newStatus, updated_at: nowIso })
          .eq('id', arr.id)
          .in('status', ['ACTIEF', 'actief']);
        if (updErr) throw new Error('update: ' + updErr.message);

        if (newStatus === 'NAGEKOMEN') summary.transitioned_to_nagekomen++;
        if (newStatus === 'VERBROKEN') summary.transitioned_to_verbroken++;

        // ── Fase 2b hook (NAGEKOMEN) ─────────────────────────────────
        // Facturen zijn betaald; de door dit arrangement gepauzeerde
        // aanmaan-runs kunnen definitief afgesloten worden. Fail-soft.
        // Bij VERBROKEN doen we NIETS — de dunning-engine picked die op
        // via trigger_conditions.arrangement_breached (Deel 2), zodat
        // Jeffrey via de workflow-editor bepaalt wat er gebeurt.
        if (newStatus === 'NAGEKOMEN') {
          try {
            const { completeRunsFromArrangement } = await import('./_lib/dunning-arrangement-hooks.js');
            await completeRunsFromArrangement(arr.id);
          } catch (e) {
            console.warn('[cron-arrangements-breach-check hook complete]', e?.message || e);
          }
        }

        try {
          await supabaseAdmin.from('audit_log').insert({
            user_id:     null,
            action:      'finance.arrangement.breach_check_state_change',
            entity_type: 'payment_arrangement',
            entity_id:   arr.id,
            before_json: { status: arr.status, dry_run: dry },
            after_json:  {
              arrangement_id: arr.id,
              type:           arr.type,
              old_status:     arr.status,
              new_status:     newStatus,
              reason,
              dry_run:        dry, // Fase 2b action-hooks moeten hier op branchen
            },
            reason_text: reason,
          });
        } catch (e) {
          console.error('[cron-arrangements-breach-check audit]', e.message);
        }
      } catch (e) {
        summary.errors.push({
          arrangement_id: arr.id,
          type: arr.type,
          error: e?.message || String(e),
        });
        console.error('[cron-arrangements-breach-check] eval failed', arr.id, e?.message);
      }
    }

    summary.duration_ms = Date.now() - startedAt;

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     null,
        action:      'cron.arrangements_breach_check_run',
        entity_type: 'cron',
        entity_id:   null,
        after_json:  summary,
      });
    } catch (e) {
      console.error('[cron-arrangements-breach-check audit summary]', e.message);
    }

    console.log('[cron-arrangements-breach-check]', JSON.stringify(summary));
    return res.status(200).json(summary);
  } catch (e) {
    summary.duration_ms = Date.now() - startedAt;
    summary.errors.push({ phase: 'fatal', error: e?.message || String(e) });
    console.error('[cron-arrangements-breach-check] fatal', e);
    return res.status(500).json(summary);
  }
}

// ---------------------------------------------------------------------------
// Evaluatie per arrangement-type
// ---------------------------------------------------------------------------

function todayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isoToMs(iso) {
  if (!iso) return null;
  const ymd = String(iso).slice(0, 10);
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

function isInvoicePaid(inv) {
  if (!inv) return false;
  const status = String(inv.status || '').toLowerCase();
  if (status === 'paid') return true;
  // Defensief: open-bedrag <= 0 telt als voldaan (TL-sync soms traag met status).
  const total = Number(inv?.amount_total) || 0;
  const paid = Number(inv?.amount_paid) || 0;
  const credited = Number(inv?.credited_amount) || 0;
  const open = total - paid - credited;
  return open <= 0.01;
}

async function fetchInvoicesByIds(invoiceIds) {
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from('invoices')
    .select('id, status, amount_total, amount_paid, credited_amount, due_date, invoice_number')
    .in('id', invoiceIds);
  if (error) throw new Error('invoices-fetch: ' + error.message);
  return Array.isArray(data) ? data : [];
}

/**
 * Beslist of een arrangement van status moet wisselen.
 * Returns { newStatus, reason } of null (geen wijziging).
 *
 * Exported sinds sandbox-run-breach-check zodat de sandbox de exact zelfde
 * evaluatie doet zonder logica te dupliceren.
 */
export async function evaluateArrangement(arr) {
  const type = String(arr.type || '').toUpperCase();
  const details = arr.details || {};
  const todayMs = todayMidnightMs();

  switch (type) {
    case 'UITSTEL': {
      // D1.5 canonical: details.ends_on; legacy fallback: details.new_due_date.
      const deadlineIso = details.ends_on || details.new_due_date || null;
      const deadlineMs = isoToMs(deadlineIso);
      if (deadlineMs == null) {
        return null; // Geen deadline -> niets te besluiten.
      }
      if (todayMs <= deadlineMs) {
        return null; // Deadline nog niet verstreken.
      }
      const invoices = await fetchInvoicesByIds(arr.invoice_ids || []);
      if (invoices.length === 0) {
        return {
          newStatus: 'NAGEKOMEN',
          reason: `UITSTEL deadline ${deadlineIso} verstreken, geen invoices meer aan arrangement gekoppeld`,
        };
      }
      const allPaid = invoices.every(isInvoicePaid);
      if (allPaid) {
        return {
          newStatus: 'NAGEKOMEN',
          reason: `UITSTEL deadline ${deadlineIso} verstreken, alle ${invoices.length} facturen voldaan`,
        };
      }
      const openInvoices = invoices.filter((i) => !isInvoicePaid(i));
      return {
        newStatus: 'VERBROKEN',
        reason: `UITSTEL deadline ${deadlineIso} verstreken, ${openInvoices.length} van ${invoices.length} facturen nog open`,
      };
    }

    case 'SPLITSING': {
      // details.parts is voor SPLITSING per arrangement een platte lijst van
      // termijnen (recon: per factuur 1 pending_action, maar het arrangement
      // zelf heeft details.parts als deadline-bron).
      const parts = Array.isArray(details.parts) ? details.parts : [];
      const invoices = await fetchInvoicesByIds(arr.invoice_ids || []);
      const allInvoicesPaid =
        invoices.length > 0 && invoices.every(isInvoicePaid);

      // NAGEKOMEN: alle facturen voldaan (alle termijnen verwerkt).
      if (allInvoicesPaid) {
        return {
          newStatus: 'NAGEKOMEN',
          reason: `SPLITSING: alle ${invoices.length} facturen voldaan`,
        };
      }

      // VERBROKEN: minstens 1 termijn verstreken EN niet alle facturen paid.
      // We gebruiken de oudste verstreken part als signaal.
      let oldestOverduePart = null;
      for (const p of parts) {
        const due = p?.due_date ? isoToMs(p.due_date) : null;
        if (due != null && todayMs > due) {
          if (!oldestOverduePart || isoToMs(oldestOverduePart.due_date) > due) {
            oldestOverduePart = p;
          }
        }
      }
      if (oldestOverduePart) {
        return {
          newStatus: 'VERBROKEN',
          reason: `SPLITSING: termijn due ${oldestOverduePart.due_date} verstreken, niet alle facturen voldaan`,
        };
      }
      return null;
    }

    case 'ABONNEMENT_PAUZE': {
      const untilIso = details.pause_until || null;
      const untilMs = isoToMs(untilIso);
      if (untilMs == null) return null;
      if (todayMs > untilMs) {
        return {
          newStatus: 'NAGEKOMEN',
          reason: `ABONNEMENT_PAUZE afgelopen op ${untilIso}`,
        };
      }
      return null;
    }

    case 'ABONNEMENT_STOP':
    case 'KWIJTSCHELDING':
      // Final actions — er is geen breach-evaluatie. Pending_actions-executor
      // markeert deze als NAGEKOMEN bij EXECUTED via mark-executed cascade.
      return null;

    case 'TOEZEGGING': {
      // Licht type zonder TL-actie. Bewaking uit details.parts:
      //   part.invoice_id gezet → die specifieke factuur moet paid zijn op/vóór due_date
      //   part.invoice_id NULL  → alle arrangement invoice_ids moeten paid zijn
      // Alle parts nagekomen (invoices paid) -> NAGEKOMEN
      // Minstens 1 part verstreken met openstaand bedrag -> VERBROKEN
      const parts = Array.isArray(details.parts) ? details.parts : [];
      if (parts.length === 0) return null;

      const invoices = await fetchInvoicesByIds(arr.invoice_ids || []);
      const invById = new Map(invoices.map((i) => [i.id, i]));

      // Vroegtijdige NAGEKOMEN: alle betrokken facturen zijn paid, ongeacht
      // of alle parts al verstreken zijn — de afspraak is volledig voldaan.
      const allInvoicesPaid = invoices.length > 0 && invoices.every(isInvoicePaid);
      if (allInvoicesPaid) {
        return {
          newStatus: 'NAGEKOMEN',
          reason: `TOEZEGGING: alle ${invoices.length} facturen voldaan`,
        };
      }

      // Zoek de oudste verstreken part met een niet-betaalde factuur.
      let oldestBreachedPart = null;
      for (const p of parts) {
        const dueMs = p?.due_date ? isoToMs(p.due_date) : null;
        if (dueMs == null || todayMs <= dueMs) continue; // niet verstreken

        // Bepaal welke facturen deze part dekt.
        const partInvoices = p.invoice_id
          ? (invById.has(p.invoice_id) ? [invById.get(p.invoice_id)] : [])
          : invoices; // NULL invoice_id = alle facturen
        if (partInvoices.length === 0) continue; // arrangement invoice_id weg? skip

        const anyOpen = partInvoices.some((i) => !isInvoicePaid(i));
        if (anyOpen) {
          if (!oldestBreachedPart || isoToMs(oldestBreachedPart.due_date) > dueMs) {
            oldestBreachedPart = p;
          }
        }
      }
      if (oldestBreachedPart) {
        return {
          newStatus: 'VERBROKEN',
          reason: `TOEZEGGING: afgesproken datum ${oldestBreachedPart.due_date} verstreken, factuur nog niet voldaan`,
        };
      }
      return null;
    }

    default:
      // Onbekend type: skip stil.
      return null;
  }
}

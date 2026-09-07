#!/usr/bin/env node
// scripts/dunning-workflow-tijdlijn.js
//
// Rekent per stap van een dunning-workflow uit op welke DAG NA DE VERVALDATUM
// hij landt — vóór deze branch en erna — en zet het verschil ernaast.
//
// ══════════════════════════════════════════════════════════════════════════
//  READ-ONLY. Uitsluitend SELECT-queries. Verstuurt niets, schrijft niets.
// ══════════════════════════════════════════════════════════════════════════
//
// Waarom: sinds deze branch mikt `next_action_at` na een wait-stap op de
// LADDERDAG van de eerstvolgende SEND-stap in plaats van op "nu + N dagen".
// Send-stappen landen daardoor exact op hun ladder-sport, maar de stappen die
// TUSSEN een wait en de volgende send zitten — de bel-taken voor Dave —
// schuiven mee naar diezelfde ladderdag. Dit script maakt zichtbaar hoeveel
// dat per stap scheelt.
//
// Gebruik met de database:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/dunning-workflow-tijdlijn.js --workflow=9805c900-1c74-4326-9d15-a1e49f754eb0
//
// Gebruik zonder database (stappen uit een JSON-bestand):
//   node scripts/dunning-workflow-tijdlijn.js --fixture=stappen.json
//
// Het fixture-bestand heeft de vorm:
//   { "name": "Aanmaningen", "trigger_conditions": {},
//     "ladder": { "aanmaning_dag7": 1, ... },
//     "steps":     [ { "step_order": 0, "step_type": "whatsapp", "config": {"template_id":"…"} }, … ],
//     "templates": { "<template_id>": { "name": "…", "meta_template_name": "…" } } }
//
// Opties:
//   --workflow=<uuid|naam>   welke workflow (default: de eerste actieve)
//   --fixture=pad.json       lees stappen uit een bestand i.p.v. Supabase
//   --md=pad.md              schrijf de tabel weg als markdown

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  parseLadder, parseMaxSendsPerDay, resolveStepTierDays, resolveWorkflowStartDays,
  channelOfStepType, DEFAULT_LADDER, DEFAULT_MAX_SENDS_PER_DAY,
} from '../api/_lib/dunning-overdue-guard.js';
import { isSendStep } from '../api/_lib/dunning-office-hours.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

// ── De rekenkern ──────────────────────────────────────────────────────────
// PURE: geen DB, geen tijd. "Dag N" = N dagen na de vervaldatum; dag 0 is de
// vervaldag zelf.

/**
 * Loop de stappen af zoals de motor dat doet en noteer per stap de landingsdag.
 *
 * @param {object} opts
 *   - steps         gesorteerd op step_order
 *   - templates     { id: { name, meta_template_name } }
 *   - ladder        templatenaam → dag na vervaldatum
 *   - caps          { whatsapp, email } dagcap per kanaal
 *   - startDay      dag waarop de run start
 *   - ladderGating  true = send-stappen wachten op hun ladder-sport (NA)
 *   - waitTargetsLadder true = na een wait mikken we op de ladderdag van de
 *                       volgende send-stap, geklemd op een latere dag (NA)
 *   - dailyCap      true = dagcap per kanaal toepassen (NA)
 * @returns {Array<{step_order, step_type, label, dag}>}
 */
export function loopStappen({
  steps, templates = {}, ladder = DEFAULT_LADDER, caps = DEFAULT_MAX_SENDS_PER_DAY,
  startDay = 1, ladderGating = true, waitTargetsLadder = true, dailyCap = true,
} = {}) {
  const gesorteerd = (steps || []).slice().sort((a, b) => Number(a.step_order) - Number(b.step_order));
  const tierVan = (st) => resolveStepTierDays(st, templates[st?.config?.template_id] || null, ladder);
  const volgendeSendTier = (na) => {
    const nxt = gesorteerd.find((st) => Number(st.step_order) > Number(na) && isSendStep(st.step_type));
    return nxt ? tierVan(nxt) : null;
  };

  let dag = startDay;
  const gebruiktPerDag = new Map();   // `${dag}|${kanaal}` → aantal
  const rijen = [];

  for (const st of gesorteerd) {
    if (isSendStep(st.step_type)) {
      if (ladderGating) {
        const tier = tierVan(st);
        if (tier != null && dag < tier) dag = tier;
      }
      if (dailyCap) {
        const kanaal = channelOfStepType(st.step_type);
        const cap = caps[kanaal] ?? 1;
        // Schuif een dag op zolang dit kanaal die dag al vol zit.
        let pogingen = 0;
        while (kanaal && (gebruiktPerDag.get(`${dag}|${kanaal}`) || 0) >= cap && pogingen++ < 60) dag += 1;
        if (kanaal) gebruiktPerDag.set(`${dag}|${kanaal}`, (gebruiktPerDag.get(`${dag}|${kanaal}`) || 0) + 1);
      }
      rijen.push({ step_order: st.step_order, step_type: st.step_type, label: labelVan(st, templates), dag });
      continue;
    }

    if (st.step_type === 'wait') {
      const wachtDagen = Number(st?.config?.days) || 0;
      rijen.push({ step_order: st.step_order, step_type: 'wait', label: `wacht ${wachtDagen} dag(en)`, dag });
      let doel = dag + wachtDagen;
      if (waitTargetsLadder) {
        const tier = volgendeSendTier(st.step_order);
        if (tier != null) doel = tier;
        // KLEM: nooit terug in de tijd of op dezelfde dag → minstens morgen.
        if (doel <= dag) doel = dag + 1;
      }
      dag = doel;
      continue;
    }

    if (st.step_type === 'stop') {
      rijen.push({ step_order: st.step_order, step_type: 'stop', label: 'stop', dag });
      break;
    }

    // task / resume_dunning / overig: draait op de dag waarop de run wakker is.
    rijen.push({ step_order: st.step_order, step_type: st.step_type, label: labelVan(st, templates), dag });
  }
  return rijen;
}

function labelVan(st, templates) {
  if (isSendStep(st.step_type)) {
    const t = templates[st?.config?.template_id] || null;
    return t?.meta_template_name || t?.name || `(template ${st?.config?.template_id || '?'})`;
  }
  if (st.step_type === 'task') return st?.config?.title || 'taak';
  return st.step_type;
}

/**
 * Bouwt de vergelijkingstabel: dag VOOR deze branch, dag ERNA, en het verschil.
 * PURE.
 */
export function bouwTijdlijn({ steps, templates, triggerConditions = {}, ladder = DEFAULT_LADDER, caps = DEFAULT_MAX_SENDS_PER_DAY }) {
  const gesorteerd = (steps || []).slice().sort((a, b) => Number(a.step_order) - Number(b.step_order));
  const sendTiers = gesorteerd
    .filter((st) => isSendStep(st.step_type))
    .map((st) => resolveStepTierDays(st, templates[st?.config?.template_id] || null, ladder))
    .filter((n) => Number.isFinite(n));

  // VOOR: minDays uit trigger_conditions; -1 zodra min_days_since_invoice_date
  // of arrangement_breached gezet was, anders default 14. De teller was op 0
  // geclampt, dus -1 betekende in de praktijk: start op dag 0.
  const tc = triggerConditions || {};
  const hadIssueTrigger = Number.isFinite(tc.min_days_since_invoice_date);
  const hadBreach       = tc.arrangement_breached === true;
  const minDaysVoor = Number.isFinite(tc.min_days_overdue)
    ? Number(tc.min_days_overdue)
    : ((hadIssueTrigger || hadBreach) ? -1 : 14);
  const startVoor = Math.max(0, minDaysVoor);

  // NA: laagste ladder-sport van de eigen send-stappen, nooit onder 1.
  const startNa = resolveWorkflowStartDays({
    triggerConditions: tc, stepTierDays: sendTiers, fallbackDays: hadBreach ? 1 : 14,
  });

  const voor = loopStappen({
    steps: gesorteerd, templates, ladder, caps, startDay: startVoor,
    ladderGating: false, waitTargetsLadder: false, dailyCap: false,
  });
  const na = loopStappen({
    steps: gesorteerd, templates, ladder, caps, startDay: startNa,
    ladderGating: true, waitTargetsLadder: true, dailyCap: true,
  });

  const naPerStap = new Map(na.map((r) => [r.step_order, r]));
  const rijen = voor.map((r) => {
    const n = naPerStap.get(r.step_order) || null;
    return {
      step_order: r.step_order,
      step_type: r.step_type,
      label: r.label,
      dag_voor: r.dag,
      dag_na: n ? n.dag : null,
      verschil: n ? (n.dag - r.dag) : null,
    };
  });
  return { start_voor: startVoor, start_na: startNa, rijen };
}

// ── Rendering ─────────────────────────────────────────────────────────────
export function renderTabel(naam, tijdlijn, ladder) {
  const L = [];
  const p = (s = '') => L.push(s);
  p(`# Tijdlijn workflow "${naam}"`);
  p('');
  p('Dagen geteld vanaf de **vervaldatum**; dag 0 is de vervaldag zelf.');
  p(`Ladder: ${Object.entries(ladder).map(([k, v]) => `${k}=dag ${v}`).join(', ')}`);
  p(`Run start: dag ${tijdlijn.start_voor} (voor) → dag ${tijdlijn.start_na} (na)`);
  p('');
  p('| Stap | Type | Wat | Dag VOOR | Dag NA | Verschil |');
  p('|---:|---|---|---:|---:|---:|');
  for (const r of tijdlijn.rijen) {
    const v = r.verschil;
    const teken = v == null ? '—' : (v === 0 ? '0' : (v > 0 ? `+${v}` : String(v)));
    p(`| ${r.step_order} | ${r.step_type} | ${r.label} | ${r.dag_voor} | ${r.dag_na ?? '—'} | ${teken} |`);
  }
  p('');
  const taken = tijdlijn.rijen.filter((r) => r.step_type === 'task' && r.verschil !== 0 && r.verschil != null);
  if (taken.length) {
    p(`Taak-stappen die verschuiven: ${taken.length}`);
    for (const t of taken) {
      p(`  stap ${t.step_order} "${t.label}": dag ${t.dag_voor} → ${t.dag_na} (${t.verschil > 0 ? '+' : ''}${t.verschil})`);
    }
  } else {
    p('Geen taak-stappen die verschuiven.');
  }
  return L.join('\n');
}

// ── Snapshot uit Supabase ─────────────────────────────────────────────────
let _db = null;
function client() {
  if (_db) return _db;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY zijn vereist (read-only gebruikt).');
  }
  _db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _db;
}

async function loadFromDb(which) {
  const db = client();
  let q = db.from('dunning_workflows').select('id, name, trigger_conditions, is_active');
  if (which && /^[0-9a-f-]{36}$/i.test(which)) q = q.eq('id', which);
  else if (which)                               q = q.eq('name', which);
  else                                          q = q.eq('is_active', true);
  const { data: wfs, error } = await q;
  if (error) throw new Error(error.message);
  const wf = (wfs || [])[0];
  if (!wf) throw new Error('workflow niet gevonden');

  const { data: steps } = await db.from('dunning_workflow_steps')
    .select('id, step_order, step_type, config').eq('workflow_id', wf.id).order('step_order', { ascending: true });
  const ids = Array.from(new Set((steps || []).map((s) => s?.config?.template_id).filter(Boolean)));
  const { data: tpls } = ids.length
    ? await db.from('dunning_templates').select('id, name, meta_template_name').in('id', ids)
    : { data: [] };
  const { data: ladderRow } = await db.from('app_settings').select('value').eq('key', 'dunning_ladder').maybeSingle();
  const { data: capRow }    = await db.from('app_settings').select('value').eq('key', 'dunning_max_sends_per_day').maybeSingle();

  return {
    name: wf.name,
    trigger_conditions: wf.trigger_conditions || {},
    steps: steps || [],
    templates: Object.fromEntries((tpls || []).map((t) => [t.id, t])),
    ladder: ladderRow ? parseLadder(ladderRow.value) : { ...DEFAULT_LADDER },
    caps: capRow ? parseMaxSendsPerDay(capRow.value) : { ...DEFAULT_MAX_SENDS_PER_DAY },
  };
}

async function main() {
  const snap = typeof args.fixture === 'string'
    ? (() => {
        const f = JSON.parse(readFileSync(args.fixture, 'utf8'));
        return {
          name: f.name || '(fixture)',
          trigger_conditions: f.trigger_conditions || {},
          steps: f.steps || [],
          templates: f.templates || {},
          ladder: f.ladder ? parseLadder(f.ladder) : { ...DEFAULT_LADDER },
          caps: f.caps ? parseMaxSendsPerDay(f.caps) : { ...DEFAULT_MAX_SENDS_PER_DAY },
        };
      })()
    : await loadFromDb(typeof args.workflow === 'string' ? args.workflow : null);

  const tijdlijn = bouwTijdlijn({
    steps: snap.steps, templates: snap.templates,
    triggerConditions: snap.trigger_conditions, ladder: snap.ladder, caps: snap.caps,
  });
  const tekst = renderTabel(snap.name, tijdlijn, snap.ladder);
  console.log(tekst);
  if (typeof args.md === 'string') { writeFileSync(args.md, tekst); console.error(`[tijdlijn] → ${args.md}`); }
  console.error('[tijdlijn] read-only: er is niets gewijzigd en niets verstuurd.');
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  main().catch((e) => { console.error('[tijdlijn] fout:', e?.message || e); process.exit(1); });
}

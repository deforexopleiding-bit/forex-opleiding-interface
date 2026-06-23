// api/cron/archive-completed-onboardings.js
//
// Onboarding Fase 3 — dagelijkse cron die 1op1-onboardings auto-archiveert
// zodra de student in Bubble z'n 2e call heeft afgerond
// (1_call_completed_number >= 2).
//
// Wat dit endpoint NIET doet:
//   - Geen money-mutatie.
//   - Geen Bubble-write — alleen LEZEN uit Bubble.
//   - Geen mail / geen webhook-side-effects.
//   - Membership-onboardings worden overgeslagen — die hebben een vaste
//     duur en archiveren via een ander pad (niet door call-tellers).
//
// AUTH: Authorization: Bearer ${CRON_SECRET} (zelfde patroon als
//       generate-monthly-concepts). Geldt ook voor handmatige test via curl.
//
// Query (vereisen nog steeds het CRON_SECRET):
//   ?dry=1    → rapporteer wat er gearchiveerd ZOU worden, zonder DB-mutatie.
//   ?limit=N  → override op MAX_PER_RUN (1..1000). Default 300.
//
// Response 200:
//   { ok, checked, eligible_1op1, archived:[ids], skipped_no_field,
//     errors:[{onboarding_id, reason}], dry }
//
// Failure-modes (fail-soft per rij):
//   - Bubble GET faalt voor één student → error noteren, anderen doorgaan.
//   - 1_call_completed_number ontbreekt of niet-numeriek → skipped_no_field.
//   - DB-update faalt voor één rij → error noteren, anderen doorgaan.
//
// Cap (MAX_PER_RUN): voorkomt dat een grote backlog de Bubble-API overspoelt
// in één run. Bij dagelijkse run schaalt 300 ruim voor een normale instroom.

import { supabaseAdmin } from '../supabase.js';
import { bubbleGet } from '../_lib/bubble.js';

const DEFAULT_MAX_PER_RUN = 300;
const TRAJECT_TYPE_1OP1   = '1op1';
const REQUIRED_COMPLETED  = 2;

// Lees het 1_call_completed_number-veld defensief: Bubble omit lege/null
// velden, dus afwezig = null. Niet-numerieke string → null. Niet-positieve
// getallen worden gewoon teruggegeven; de drempel-check filtert ze later.
function readCallsCompleted(user) {
  if (!user || typeof user !== 'object') return null;
  const raw = user['1_call_completed_number'];
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // AUTH — identiek aan generate-monthly-concepts.
  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dry = req.query?.dry === '1' || req.query?.dry === 'true';

  // limit-override: input-clamping 1..1000 zodat een typo geen runaway-run wordt.
  let maxPerRun = DEFAULT_MAX_PER_RUN;
  if (req.query?.limit) {
    const n = Number(req.query.limit);
    if (Number.isFinite(n) && n >= 1) {
      maxPerRun = Math.min(1000, Math.floor(n));
    }
  }

  const archived         = [];
  const errors           = [];
  let   skippedNoField   = 0;
  let   eligible1op1     = 0;

  try {
    // STAP 1: kandidaten ophalen. WHERE-filter zo strak mogelijk zodat de
    // bubble-lookup-set klein blijft.
    //   - status != 'gearchiveerd' (al gearchiveerd → skip)
    //   - bubble_user_id IS NOT NULL (geen koppeling → niets te lezen)
    //   - traject:onboarding_trajecten(type) joinen voor de '1op1'-filter
    // Caveat: PostgREST kan een filter op een joined kolom moeilijk
    // serveren zonder een specifieke RPC. We doen de join client-side
    // (eenvoudige set traject_id → type) zodat we niet vastlopen op
    // PostgREST-syntaxis.
    const { data: rows, error: rowErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, status, bubble_user_id, traject_id, archived_at')
      .neq('status', 'gearchiveerd')
      .not('bubble_user_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(2000);
    if (rowErr) throw new Error('onboardings fetch: ' + rowErr.message);

    const list = Array.isArray(rows) ? rows : [];
    const trajectIds = Array.from(new Set(list.map((r) => r.traject_id).filter(Boolean)));

    let trajectTypeMap = new Map();
    if (trajectIds.length > 0) {
      const { data: trs, error: trErr } = await supabaseAdmin
        .from('onboarding_trajecten')
        .select('id, type')
        .in('id', trajectIds);
      if (trErr) throw new Error('onboarding_trajecten fetch: ' + trErr.message);
      for (const t of (trs || [])) {
        if (t && t.id) trajectTypeMap.set(t.id, t.type || null);
      }
    }

    // Filter op 1op1 + cap. checked = aantal rijen waarvoor we daadwerkelijk
    // een Bubble-leesactie doen (na 1op1-filter en cap).
    const candidates = [];
    for (const r of list) {
      const ttype = trajectTypeMap.get(r.traject_id) || null;
      if (ttype !== TRAJECT_TYPE_1OP1) continue;
      eligible1op1++;
      if (candidates.length < maxPerRun) candidates.push(r);
    }

    let checked = 0;

    // STAP 2 + 3: sequentieel per kandidaat de Bubble-user lezen + threshold
    // check + eventueel archiveren. Sequentieel houdt de Bubble-API-load
    // voorspelbaar (rate-limit-safe) en de logs leesbaar.
    for (const ob of candidates) {
      checked++;
      let user;
      try {
        user = await bubbleGet('user', ob.bubble_user_id);
      } catch (e) {
        // BUBBLE_CONFIG_MISSING is een environment-issue, geen rij-fout —
        // gooi door naar buitenste catch zodat de hele run met 503 eindigt.
        if (e?.code === 'BUBBLE_CONFIG_MISSING') throw e;
        const msg = (e?.code || 'BUBBLE_ERROR') + ': ' + (e?.message || e);
        console.error('[archive-completed-onboardings] bubbleGet fail:',
          ob.id, msg);
        errors.push({ onboarding_id: ob.id, reason: msg.slice(0, 300) });
        continue;
      }
      if (!user) {
        // 404 op de user-id → niet meer in Bubble. Geen archive-actie;
        // wel als skipped tellen zodat de operator dit ziet.
        skippedNoField++;
        continue;
      }
      const completed = readCallsCompleted(user);
      if (completed === null) {
        skippedNoField++;
        continue;
      }
      if (completed < REQUIRED_COMPLETED) continue;

      if (dry) {
        archived.push(ob.id);
        continue;
      }

      // DB-archive met optimistic lock op status != gearchiveerd (race-
      // safe als een andere admin tegelijkertijd handmatig archiveerde).
      try {
        const { data: upd, error: updErr } = await supabaseAdmin
          .from('onboardings')
          .update({
            status      : 'gearchiveerd',
            archived_at : new Date().toISOString(),
          })
          .eq('id', ob.id)
          .neq('status', 'gearchiveerd')
          .select('id')
          .maybeSingle();
        if (updErr) throw new Error(updErr.message);
        if (upd && upd.id) archived.push(upd.id);
      } catch (e) {
        const msg = 'archive update: ' + (e?.message || e);
        console.error('[archive-completed-onboardings] db fail:', ob.id, msg);
        errors.push({ onboarding_id: ob.id, reason: msg.slice(0, 300) });
      }
    }

    return res.status(200).json({
      ok                 : true,
      dry,
      checked,
      eligible_1op1      : eligible1op1,
      archived,
      skipped_no_field   : skippedNoField,
      errors,
    });
  } catch (e) {
    console.error('[archive-completed-onboardings]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

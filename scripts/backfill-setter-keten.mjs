#!/usr/bin/env node
// scripts/backfill-setter-keten.mjs
//
// EENMALIG: setter_user_id (en, als die leeg is, booking_source) op verzette
// opvolgers zetten die hem niet meekregen.
//
// Tot 1 oktober 2026 namen api/_lib/verzet-afspraak.js en de vervolg-call in
// api/follow-up-outcomes.js de setter niet mee naar de nieuwe rij. Vanaf die
// PR wel (api/_lib/setter-keten.js → erfSetterVelden). Dit script repareert
// de rijen van daarvoor.
//
// Scope, generiek maar smal: een rij komt alleen in het plan als
//   - hij ZELF geen setter_user_id heeft, én
//   - hij een parent_appointment_id heeft, én
//   - ergens omhoog in die keten een rij mét setter_user_id staat.
// De setter komt van de dichtstbijzijnde voorganger mét setter. booking_source
// wordt alleen gevuld als de rij er zelf geen heeft. Rijen met is_test=true
// worden overgeslagen, tenzij --met-test.
//
// GEBRUIK
//   node --env-file=<.env> scripts/backfill-setter-keten.mjs            # dry-run (default)
//   node --env-file=<.env> scripts/backfill-setter-keten.mjs --apply    # schrijven
//
// Env: SUPABASE_URL (of NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY.
//
// DRY-RUN IS ECHT READ-ONLY: de client zit in een Proxy die insert / update /
// upsert / delete / rpc laat falen. Een fout in dit script kan in dry-run dus
// niets schrijven.
//
// --apply schrijft per rij met een voorwaardelijke update
// (`.is('setter_user_id', null)`): draait het twee keer, of zette iemand er
// tussendoor al een setter op, dan wordt er niets overschreven. Idempotent.

import { createClient } from '@supabase/supabase-js';
import { planSetterBackfill } from '../api/_lib/setter-keten.js';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const MET_TEST = args.has('--met-test');

const URL_ = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error('SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY zijn vereist.');
  process.exit(1);
}

const VERBODEN = new Set(['insert', 'update', 'upsert', 'delete', 'rpc']);
/** Proxy die elke schrijfmethode laat falen — ook op geneste builders. */
function alleenLezen(o) {
  return new Proxy(o, {
    get(t, p) {
      if (VERBODEN.has(p)) throw new Error('READ-ONLY (dry-run): ' + String(p) + ' is geblokkeerd');
      const v = t[p];
      if (typeof v === 'function') {
        return (...a) => {
          const r = v.apply(t, a);
          // Elke builder die terugkomt opnieuw inpakken; een Promise (het
          // resultaat van await) niet — daar valt niets meer te schrijven.
          return (r && typeof r === 'object' && !(r instanceof Promise)) ? alleenLezen(r) : r;
        };
      }
      return v;
    },
  });
}

const ruw = createClient(URL_, KEY, { auth: { persistSession: false } });
const db = APPLY ? ruw : alleenLezen(ruw);

const KOLOMMEN = 'id, lead_name, scheduled_at, status, is_test, parent_appointment_id, setter_user_id, booking_source';
const PAGINA = 1000;

async function haalOpvolgers() {
  const uit = [];
  for (let van = 0; ; van += PAGINA) {
    const { data, error } = await db.from('follow_up_appointments')
      .select(KOLOMMEN)
      .not('parent_appointment_id', 'is', null)
      .order('id', { ascending: true })
      .range(van, van + PAGINA - 1);
    if (error) throw new Error('opvolgers lezen: ' + error.message);
    uit.push(...(data || []));
    if (!data || data.length < PAGINA) break;
  }
  return uit;
}

/** Voorgangers ophalen tot elke keten rond is (of een schakel ontbreekt). */
async function vulKetens(rijen) {
  const perId = new Map(rijen.map((r) => [String(r.id), r]));
  for (let ronde = 0; ronde < 25; ronde += 1) {
    const missend = [...new Set(
      [...perId.values()].map((r) => r.parent_appointment_id).filter(Boolean).map(String),
    )].filter((id) => !perId.has(id));
    if (!missend.length) break;
    for (let i = 0; i < missend.length; i += 200) {
      const blok = missend.slice(i, i + 200);
      const { data, error } = await db.from('follow_up_appointments').select(KOLOMMEN).in('id', blok);
      if (error) throw new Error('voorgangers lezen: ' + error.message);
      for (const r of data || []) perId.set(String(r.id), r);
      // Een id die niet terugkomt bestaat niet meer: markeer hem zodat we hem
      // niet blijven vragen.
      for (const id of blok) if (!perId.has(id)) perId.set(id, { id, parent_appointment_id: null, setter_user_id: null, _ontbreekt: true });
    }
  }
  return [...perId.values()].filter((r) => !r._ontbreekt);
}

async function main() {
  console.log(APPLY ? '== APPLY — er wordt geschreven ==' : '== DRY-RUN — read-only, er wordt niets geschreven ==');
  const opvolgers = await haalOpvolgers();
  const alle = await vulKetens(opvolgers);
  const volledig = planSetterBackfill(alle);
  const plan = MET_TEST ? volledig : volledig.filter((p) => !p.is_test);
  const overgeslagenTest = volledig.length - plan.length;

  console.log(`opvolgers (parent_appointment_id gevuld): ${opvolgers.length}`);
  console.log(`rijen in het plan: ${plan.length}` + (overgeslagenTest ? ` (+${overgeslagenTest} testrij(en) overgeslagen; --met-test om ze mee te nemen)` : ''));
  for (const p of plan) {
    console.log(JSON.stringify(p));
  }

  if (!APPLY) {
    console.log('Dry-run klaar. Draai met --apply om bovenstaande rijen bij te werken.');
    return;
  }

  let ok = 0; let overgeslagen = 0; let fout = 0;
  for (const p of plan) {
    try {
      const { data, error } = await db.from('follow_up_appointments')
        .update(p.zet)
        .eq('id', p.id)
        .is('setter_user_id', null)
        .select('id');
      if (error) { fout += 1; console.error('[backfill] fout', p.id, error.message); continue; }
      if (!data || !data.length) { overgeslagen += 1; console.log('[backfill] al gezet, overgeslagen', p.id); continue; }
      ok += 1;
    } catch (e) {
      fout += 1; console.error('[backfill] exception', p.id, e?.message || e);
    }
  }
  console.log(`klaar: ${ok} bijgewerkt, ${overgeslagen} overgeslagen, ${fout} fout`);
  if (fout) process.exitCode = 1;
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });

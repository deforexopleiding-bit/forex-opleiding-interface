// tests/hlms-student-gewijzigd-op.test.js — elke UPDATE die het CRM op
// hlms_student doet, zet ook gewijzigd_op (12 nov 2026). Aanleiding: de eerste
// echte offertewissel (onboarding 3ae3ce0f, student bc04c9e3) veranderde
// traject_maanden, calls_totaal en eind_datum, maar gewijzigd_op bleef op
// 21 okt staan. De kolom heeft enkel `default now()` (insert) en geen trigger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { metGewijzigdOp } from '../api/_lib/hlms-student-gewijzigd.js';

test('HELPER: voegt gewijzigd_op toe als ISO, laat de invoer ongemoeid', () => {
  const nu = new Date('2026-11-12T10:00:00Z');
  const p = { mentor_id: 'm1' };
  const r = metGewijzigdOp(p, nu);
  assert.deepEqual(r, { mentor_id: 'm1', gewijzigd_op: '2026-11-12T10:00:00.000Z' });
  assert.deepEqual(p, { mentor_id: 'm1' }, 'nieuw object, geen mutatie');
  assert.match(metGewijzigdOp({}).gewijzigd_op, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(metGewijzigdOp(null)), ['gewijzigd_op']);
});

function jsBestanden(dir) {
  const uit = [];
  for (const naam of readdirSync(dir)) {
    const p = join(dir, naam);
    if (statSync(p).isDirectory()) uit.push(...jsBestanden(p));
    else if (naam.endsWith('.js')) uit.push(p);
  }
  return uit;
}

test('BRON: elke .from(\'hlms_student\') … .update(…) in api/ gaat via metGewijzigdOp (of zet gewijzigd_op zelf)', () => {
  const api = new URL('../api', import.meta.url).pathname;
  const zonder = [];
  let gezien = 0;
  for (const f of jsBestanden(api)) {
    const s = readFileSync(f, 'utf8');
    // Ook met regelopmerkingen tussen .from() en .update(): zo ontsnapt er geen.
    const re = /from\(\s*['"`]hlms_student['"`]\s*\)(?:\s|\/\/[^\n]*\n)*\.update\(/g;
    let m;
    while ((m = re.exec(s))) {
      gezien++;
      const na = s.slice(m.index + m[0].length, m.index + m[0].length + 200);
      if (!/^\s*metGewijzigdOp\(/.test(na) && !/gewijzigd_op/.test(na.split(')')[0])) {
        zonder.push(f.replace(api, 'api') + ':' + s.slice(0, m.index).split('\n').length);
      }
    }
  }
  assert.ok(gezien >= 11, 'verwacht minstens de 11 bekende schrijfpaden, gezien: ' + gezien);
  assert.deepEqual(zonder, [], 'hlms_student-update zonder gewijzigd_op');
});

test('BRON: syncDfoLmsMentor en de koppelpaden zetten gewijzigd_op', () => {
  const s = readFileSync(new URL('../api/_lib/dfo-lms-student.js', import.meta.url), 'utf8');
  assert.match(s, /\.update\(metGewijzigdOp\(\{ mentor_id: mentorId \}\)\)/);
  assert.equal((s.match(/\.update\(metGewijzigdOp\(\{ crm_onboarding_id: onboardingId \}\)\)/g) || []).length, 3);
  assert.match(s, /\.update\(metGewijzigdOp\(patch\)\)/);
});

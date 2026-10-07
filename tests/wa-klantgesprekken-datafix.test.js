// tests/wa-klantgesprekken-datafix.test.js
//
// Vorm van docs/sql-migrations/2026-10-07-whatsapp-klantgesprekken-samenvoegen.sql:
// één DO-block, backup vóór elke wijziging, parkeert i.p.v. verwijdert, raakt
// alleen de klantlijnen, en neemt gepauzeerde aanmaan-runs + Joost-status mee.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const KLANT = '1399327383258229';
const OUD_FIN = '1194351613761790';
const OUD_ONB = '1163203046877082';
const HOOFD = '1273723375834177';

const actief = readFileSync(new URL('../docs/sql-migrations/2026-10-07-whatsapp-klantgesprekken-samenvoegen.sql', import.meta.url), 'utf8')
  .split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');

test('SQL datafix: één DO-block, backup vóór wijziging, geen DELETE, leads ongemoeid, runs + Joost-status mee', () => {
  assert.equal((actief.match(/\bDO \$\$/g) || []).length, 1);
  assert.doesNotMatch(actief, /\bdelete\s+from\b/i);
  assert.doesNotMatch(actief, /\bdrop\s+table\b/i);
  for (const id of [KLANT, OUD_FIN, OUD_ONB]) assert.match(actief, new RegExp(id));
  for (const id of [HOOFD, '758003047390806', '1232908829908396', '1156034510929407']) assert.doesNotMatch(actief, new RegExp(id));
  assert.match(actief, /paused_by_conversation_id = surv/);
  assert.match(actief, /joost_conversation_state SET conversation_id = surv/);
  const backup = actief.indexOf('INSERT INTO public.wa_lijnfix_20261007_gesprekken');
  assert.ok(backup > 0 && backup < actief.search(/update\s+public\.whatsapp_conversations/i));
});

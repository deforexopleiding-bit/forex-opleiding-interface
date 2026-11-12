// tests/commissie-event-afronden-aanwezig.test.js
//
// Regel D (12 nov 2026): bij "Event afronden" mag een gekoppelde sale zonder
// Aanwezig niet meer stil verloren gaan. De echte helpers uit events-v2.js
// draaien hier in een node:vm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const VIEW = readFileSync('modules/klanten-v2/views/events-v2.js', 'utf8');

function knip(naam) {
  const start = VIEW.indexOf('  function ' + naam + '(');
  assert.ok(start > 0, naam + ' niet gevonden');
  const lichaam = VIEW.indexOf('{', VIEW.indexOf(')', start));
  let diep = 0; let eind = -1;
  for (let n = lichaam; n < VIEW.length; n += 1) {
    const ch = VIEW[n];
    if (ch === "'" || ch === '`' || ch === '"') { const q = VIEW.indexOf(ch, n + 1); if (q < 0) break; n = q; continue; }
    if (ch === '{') diep += 1;
    else if (ch === '}') { diep -= 1; if (diep === 0) { eind = n; break; } }
  }
  return VIEW.slice(start, eind + 1);
}

const ctx = createContext({
  asArr: (v) => (Array.isArray(v) ? v : []),
  esc: (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
});
runInContext(knip('_completeSalesZonderAanwezig') + '\n' + knip('_completeSalesWarnBlok'), ctx);
const zonder = runInContext('_completeSalesZonderAanwezig', ctx);
const blok = runInContext('_completeSalesWarnBlok', ctx);

const ATT = [
  { id: 'a', first_name: 'Larissa', last_name: 'Vlaar', has_signed_deal: true, status: 'aangemeld' },
  { id: 'b', first_name: 'Bram', has_signed_deal: true, status: 'aangemeld' },
  { id: 'c', first_name: 'Cor', has_signed_deal: true, status: 'aangemeld', bonus_excluded: true },
  { id: 'd', first_name: 'Dirk', has_signed_deal: false, status: 'aangemeld' },
  { id: 'e', first_name: 'Eva', has_signed_deal: true, status: 'switched_to_other_event' },
];

test('gekoppelde sale zonder Aanwezig wordt gevonden (ook zonder enige status)', () => {
  const form = { attendees: { b: { attendance_status: 'aanwezig' } } };
  assert.deepEqual(zonder(form, ATT).map((a) => a.id), ['a']);
  const form2 = { attendees: { a: { attendance_status: 'no_show' } } };
  assert.deepEqual(zonder(form2, ATT).map((a) => a.id), ['a', 'b']);
});

test('uitgesloten bonus, geen sale of verplaatst → geen waarschuwing', () => {
  const form = { attendees: { a: { attendance_status: 'aanwezig' }, b: { attendance_status: 'aanwezig' } } };
  assert.equal(zonder(form, ATT).length, 0);
});

test('waarschuwing toont tekst + de twee knoppen; pas na afronden-klik', () => {
  const form = { attendees: {}, salesWarn: false };
  assert.equal(blok(form, ATT), '');
  form.salesWarn = true;
  const h = blok(form, ATT);
  assert.match(h, /2 gekoppelde sales staan niet op Aanwezig — die krijgen geen commissie/);
  assert.match(h, /Larissa Vlaar, Bram/);
  assert.match(h, /Zet ze op Aanwezig · Klant geworden/);
  assert.match(h, /Toch afronden/);
});

test('submit vraagt eerst, toast bij koppelen klopt', () => {
  assert.match(VIEW, /if \(!form\.salesWarnBevestigd && _completeSalesZonderAanwezig\(form, _live\.attendees\.data\[m\.event_id\]\)\.length\)/);
  assert.match(VIEW, /attendance_status: 'aanwezig', outcome: 'klant_geworden'/);
  assert.ok(!VIEW.includes('bonus wordt bij afronden meegerekend'));
  assert.match(VIEW, /telt mee zodra de deelnemer op Aanwezig staat/);
});

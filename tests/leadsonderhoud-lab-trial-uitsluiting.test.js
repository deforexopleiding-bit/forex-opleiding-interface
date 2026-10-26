// tests/leadsonderhoud-lab-trial-uitsluiting.test.js
//
// De OUDE leadsonderhoud-motor (cron-leadsonderhoud, view onderhoud_wachtrij)
// mag een lead met een trial in het ECHTE LMS niets meer sturen: de view ziet
// hem als "nooit ingelogd" en zou niet_ingelogd sturen met een link naar
// deforexopleiding.nl/lms. Webinar-berichten blijven (die gaan over het webinar).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heeftLabTrial, LAB_TRIAL_TRAJECTEN } from '../api/cron-leadsonderhoud.js';

const S = (o = {}) => ({ emails: new Set(o.emails || []), leadIds: new Set(o.leadIds || []), fout: !!o.fout });

test('minicursus/7-daagse met een Lab-trial: overslaan (op lead_id of e-mail)', () => {
  assert.equal(heeftLabTrial({ traject: '7-daagse', lead_id: 'l1', email: 'x@y.be' }, S({ leadIds: ['l1'] })), true);
  assert.equal(heeftLabTrial({ traject: 'minicursus', lead_id: null, email: 'X@Y.be' }, S({ emails: ['x@y.be'] })), true);
  assert.equal(heeftLabTrial({ traject: '7-daagse', lead_id: 'l2', email: 'z@y.be' }, S({ leadIds: ['l1'] })), false, 'oude trial: motor loopt gewoon');
});

test('webinar-traject blijft; leesfout = fail-closed voor minicursus/7-daagse', () => {
  assert.equal(heeftLabTrial({ traject: 'webinar', lead_id: 'l1', email: 'x@y.be' }, S({ leadIds: ['l1'] })), false);
  assert.equal(heeftLabTrial({ traject: '7-daagse', lead_id: 'l9', email: 'q@y.be' }, S({ fout: true })), true);
  assert.equal(heeftLabTrial({ traject: 'webinar', lead_id: 'l9', email: 'q@y.be' }, S({ fout: true })), false);
  assert.deepEqual([...LAB_TRIAL_TRAJECTEN], ['minicursus', '7-daagse']);
});

test('bedrading: de check staat in de lus, vóór één-per-dag en vóór het versturen', () => {
  const src = readFileSync(new URL('../api/cron-leadsonderhoud.js', import.meta.url), 'utf8');
  const lus = src.indexOf('for (const r of wachtrij || [])');
  const check = src.indexOf('if (heeftLabTrial(r, labTrial))');
  assert.ok(lus > 0 && check > lus && check < src.indexOf('if (alVandaag.has(r.gebruiker_id))', lus));
});

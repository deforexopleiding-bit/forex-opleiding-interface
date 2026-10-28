// tests/dagrapport-pdf.test.js
//
// De PDF-generator is puur (geen DB). Deze test dekt twee dingen:
//   1. een volledige dataset rendert naar een niet-triviale PDF-buffer;
//   2. een dataset met alleen null-waarden (alles "n.v.t.") rendert ZONDER te
//      crashen - dat is precies het pad waar een niet-sourcebaar cijfer langs
//      komt, en het mag nooit een 0 of een exception worden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDagrapportPdf } from '../api/_lib/dagrapport-pdf.js';

const VOL = {
  datumLabel: 'woensdag 28 oktober 2026',
  datumIso: '2026-10-28',
  blok1: { salesVandaag: 3, omzetInclBtw: 5397, nieuweMrr: null, salesPerCall: 0.33 },
  blok2: { offertes: [{ klant: 'Jan de Vries', product: 'Membership', bedrag: 1997, startdatum: '2026-11-01', termijnen: 1, perTermijn: 1997 }], totaal: 1997 },
  blok3: { gepland: 9, afgerond: 6, noShows: 3, nogInTeVullen: 1, uitkomsten: { klantGeworden: 3, geenKlant: 2, opvolgingNodig: 1 } },
  blok4: { rijen: [{ agenda: 'Opstartsessie (Dave)', aantal: 4 }], totaal: 4 },
  blok5: { minuten: 187, gesprekken: 36, gemTijd: '5:12', opvolging: { gebeld: 14, bereikt: 8, afspraak: 3, voicememo: 6 }, belpot: { gebeld: 22, bereikt: 11, afspraak: 5, nietBereikt: 11 } },
  blok6: { rijen: [{ funnel: 'Webinar', nieuw: 5, callGepland: null, gebeld: null, nietAangeraakt: null }], totaal: { nieuw: 5, callGepland: 0, gebeld: 0, nietAangeraakt: 0 }, actieRegel: '0 nieuwe leads.' },
  blok7: { opvolgingenOverTijd: 6, outcomesOntbrekend: 24, voicememosUitstaand: 13, totaal: 43 },
};

const LEEG = {
  datumLabel: 'woensdag 28 oktober 2026',
  datumIso: '2026-10-28',
  blok1: { salesVandaag: null, omzetInclBtw: null, nieuweMrr: null, salesPerCall: null },
  blok2: { offertes: [], totaal: 0 },
  blok3: { gepland: null, afgerond: null, noShows: null, nogInTeVullen: null, uitkomsten: { klantGeworden: null, geenKlant: null, opvolgingNodig: null } },
  blok4: { rijen: [], totaal: null },
  blok5: { minuten: null, gesprekken: null, gemTijd: null, opvolging: { gebeld: null, bereikt: null, afspraak: null, voicememo: null }, belpot: { gebeld: null, bereikt: null, afspraak: null, nietBereikt: null } },
  blok6: { rijen: [], totaal: { nieuw: 0, callGepland: 0, gebeld: 0, nietAangeraakt: 0 }, actieRegel: '' },
  blok7: { opvolgingenOverTijd: null, outcomesOntbrekend: null, voicememosUitstaand: null, totaal: null },
};

test('volledige dataset rendert naar een PDF-buffer', async () => {
  const buf = await buildDagrapportPdf(VOL);
  assert.ok(Buffer.isBuffer(buf), 'moet een Buffer zijn');
  assert.ok(buf.length > 2000, 'PDF moet niet-triviaal zijn');
  assert.equal(buf.slice(0, 4).toString('latin1'), '%PDF', 'moet een PDF-header hebben');
});

test('alleen-null dataset rendert zonder crash (n.v.t.-pad)', async () => {
  const buf = await buildDagrapportPdf(LEEG);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.slice(0, 4).toString('latin1'), '%PDF');
});

test('lege data ({}) crasht niet', async () => {
  const buf = await buildDagrapportPdf({});
  assert.ok(Buffer.isBuffer(buf));
});

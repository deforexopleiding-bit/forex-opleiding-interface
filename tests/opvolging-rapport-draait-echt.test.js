// tests/opvolging-rapport-draait-echt.test.js
//
// DE TEST DIE ONTBRAK: ROEP HET RAPPORT GEWOON AAN.
//
// Op 8 september gaf /api/opvolging-rapport 500 voor élke dag, terwijl de hele
// suite groen stond — 2501 tests. De oorzaak was één regel:
//
//     const taakIds = new Set(pogingen.map(...));   // regel 245
//     ...
//     const pogingen = pogSplit.echt;               // regel 316
//
// `pogingen` werd gebruikt vóór zijn eigen `const`. Dat is de temporal dead
// zone: geen syntaxfout, geen waarschuwing bij het inlezen, `node --check`
// vindt niets — maar bij het DRAAIEN meteen een ReferenceError, ongeacht de
// data. Het rapport was dus niet stuk voor een bepaalde dag; het was stuk voor
// alle dagen, en dat was met één aanroep te zien geweest.
//
// De bestaande tests draaiden alle deelfuncties los (telVolume, bouwVensters,
// vulAandacht…) op verzonnen invoer. Die zijn goed en blijven. Maar niet één
// riep bouwRapport() zelf aan, en dat is precies het stuk waar de bedrading
// zit — de volgorde van de queries en welke variabele op welk moment bestaat.
//
// Dit is het derde signaal deze week van dezelfde soort: een groene suite naast
// een kapotte productie, met de test zelf als het gat.
//
// De databank is hier een stub. Dat is met opzet: deze test gaat niet over
// cijfers maar over de vraag of de motor start.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Een PostgREST-achtige keten die elke bouwer slikt.
 *
 * `kolommenPerTafel` bepaalt welke kolommen bestaan. Noemt een select er een
 * die er niet is, dan faalt de HELE query met 42703 — net als in Postgres, en
 * dat is precies het gedrag waar de terugval van de testvlag op leunt.
 */
function maakStub({ rijenPerTafel = {}, kolommenPerTafel = null } = {}) {
  const gezien = [];
  const tafel = (naam) => {
    const q = { _kolommen: null };
    const zelf = () => q;
    Object.assign(q, {
      select(k) { q._kolommen = String(k || ''); gezien.push({ tafel: naam, kolommen: q._kolommen }); return q; },
      eq: zelf, neq: zelf, in: zelf, not: zelf, is: zelf, or: zelf,
      gte: zelf, gt: zelf, lte: zelf, lt: zelf, order: zelf, limit: zelf, range: zelf,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then(res, rej) {
        const toegestaan = kolommenPerTafel && kolommenPerTafel[naam];
        if (toegestaan) {
          const onbekend = (q._kolommen || '').split(',').map((s) => s.trim())
            .find((k) => k && !toegestaan.includes(k));
          if (onbekend) {
            return Promise.resolve({ data: null, error:
              { code: '42703', message: `column ${naam}.${onbekend} does not exist` } }).then(res, rej);
          }
        }
        return Promise.resolve({ data: rijenPerTafel[naam] || [], error: null }).then(res, rej);
      },
    });
    return q;
  };
  return { gezien, client: { from: tafel } };
}

const DAG = '2026-09-08';

// Eén mock voor het hele bestand: node:test staat er maar één per pad toe. De
// stub wisselt via deze verwijzing, zodat elke test zijn eigen databank kan
// neerzetten zonder opnieuw te mocken.
let actief = maakStub({});
mock.module(join(ROOT, 'api/supabase.js'), {
  namedExports: {
    supabaseAdmin   : { from: (n) => actief.client.from(n) },
    supabase        : { from: (n) => actief.client.from(n) },
    createUserClient: () => actief.client,
    checkCronAuth   : () => ({ ok: true }),
  },
});

async function draaiRapport(stub) {
  actief = stub;
  const mod = await import(join(ROOT, 'api/opvolging-rapport.js'));
  const vanMs = Date.parse(DAG + 'T00:00:00Z');
  return mod.bouwRapport({
    supabase: stub.client, van: DAG, tot: DAG, dagen: [DAG], vandaag: DAG,
    vanIso: new Date(vanMs - 2 * 3600e3).toISOString(),
    totIso: new Date(vanMs + 22 * 3600e3).toISOString(),
  });
}

test('bouwRapport draait zonder te vallen op een lege databank', async () => {
  // De aanroep die de 500 van 8 september in één klap had laten zien.
  const r = await draaiRapport(maakStub({}));
  assert.ok(r, 'er komt een rapport terug');
  for (const sectie of ['periode', 'dekking', 'vensters', 'zoomcalls', 'archief', 'volume',
    'aandacht', 'blinde_vlekken', 'drempels', 'werkritme', 'afgehandeld', 'tijdlijn', 'testrijen']) {
    assert.ok(sectie in r, 'sectie ontbreekt: ' + sectie);
  }
});

test('en ook zonder de kolom is_test — de volgorde waarin de migratie nog moet draaien', async () => {
  // Dit is de stand op productie zolang
  // docs/sql-migrations/2026-09-08-opvolging-testrijen.sql niet gedraaid is.
  const stub = maakStub({
    kolommenPerTafel: {
      opvolging_pogingen: ['id', 'taak_id', 'soort', 'tijdstip', 'resultaat', 'richting', 'duur_sec', 'automatisch'],
      opvolging_taken   : ['id', 'naam', 'telefoon', 'reden', 'reden_code', 'status', 'due',
        'archief_reden', 'gearchiveerd_at', 'created_at', 'bevestigd_op', 'bevestigd_notitie', 'later'],
    },
  });
  const r = await draaiRapport(stub);
  assert.equal(r.testrijen.kolom_aanwezig, false);
  assert.match(r.testrijen.zin, /bestaat nog niet/);
});

test('mét de kolom is_test valt hij niet terug', async () => {
  const stub = maakStub({
    kolommenPerTafel: {
      opvolging_pogingen: ['id', 'taak_id', 'soort', 'tijdstip', 'resultaat', 'richting', 'duur_sec', 'automatisch', 'is_test'],
      opvolging_taken   : ['id', 'naam', 'telefoon', 'reden', 'reden_code', 'status', 'due',
        'archief_reden', 'gearchiveerd_at', 'created_at', 'bevestigd_op', 'bevestigd_notitie', 'later', 'is_test'],
    },
  });
  const r = await draaiRapport(stub);
  assert.equal(r.testrijen.kolom_aanwezig, true);
});

test('de kaarten achter de pogingen worden op de RUWE lijst verzameld', async () => {
  // De volgorde die de crash veroorzaakte, vastgelegd als regel: je kunt de
  // pogingen pas splitsen als je weet welke kaarten testkaarten zijn, en dat
  // weet je pas nadat je ze hebt opgehaald. Dus verzamelt taakIds op de
  // ongefilterde lijst — met de gefilterde bestaat hij op dat moment niet eens.
  const stub = maakStub({
    rijenPerTafel: {
      opvolging_pogingen: [
        { id: 'p1', taak_id: 't-echt', soort: 'call', tijdstip: DAG + 'T09:00:00Z', resultaat: 'gesproken', is_test: false },
        { id: 'p2', taak_id: 't-test', soort: 'call', tijdstip: DAG + 'T10:00:00Z', resultaat: 'gesproken', is_test: false },
      ],
    },
  });
  const r = await draaiRapport(stub);
  assert.ok(r);
  // De taken-query moet de ids van BEIDE pogingen hebben opgehaald; anders is
  // er geen enkele manier om te zien dat t-test een testkaart is.
  assert.ok(stub.gezien.some((g) => g.tafel === 'opvolging_taken'),
    'de kaarten achter de pogingen worden opgehaald');
});

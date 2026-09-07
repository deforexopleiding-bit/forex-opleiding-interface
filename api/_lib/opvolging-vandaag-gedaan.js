// api/_lib/opvolging-vandaag-gedaan.js
//
// WAT IS ER VANDAAG GEDAAN? — één berekening, twee schermen.
//
// Dave drukte op 7 september om 18:12 bij Bryan Van Der Heyden en om 18:35 bij
// Peter Tournelle op Bevestigd, vanuit de opwarmronde. Hun kaarten gingen naar
// event min vier en bleven open — precies goed — maar ze stonden nergens meer,
// en daardoor leek het alsof dat werk verdwenen was. Anais, Joelle en Valerie
// deden diezelfde handeling en verschenen wél bij Afgerond, want bij hen was
// het de laatste ronde.
//
// Zelfde knop, twee uitkomsten in beeld. De oorzaak is dat het scherm naar de
// UITKOMST van een kaart keek, terwijl de vraag aan het eind van de dag is wat
// er GEDAAN is. Dat is een ander soort vraag.
//
// DRIE GROEPEN, EN EEN KAART ZIT IN PRECIES ÉÉN:
//
//   afgesloten    — definitief dicht, met de reden erbij.
//   doorgeschoven — er is vandaag een beslissing op genomen én de kaart komt
//                   terug. Geen mislukking en geen afronding: een derde ding.
//   aangeraakt    — vandaag gebeld of geappt zonder dat er een beslissing viel.
//                   Ook dat is gedaan werk.
//
// DE ONTDUBBELING IS GEEN DETAIL. Wie een beslissing kreeg hoort niet óók in
// 'aangeraakt' te staan: bij een bevestiging wordt een poging geschreven, dus
// zonder aftrek staat Bryan twee keer op het scherm. Dat is dezelfde fout als
// de dubbele Yasmine in het rapport.
//
// ÉÉN BEREKENING VOOR HET SCHERM ÉN HET RAPPORT. Twee tellingen worden vroeg
// of laat zeven tegenover acht, en dan weet niemand welke van de twee liegt.

/** Een kaart die vandaag dicht ging. */
function afsluitDag(t) {
  return t && t.gearchiveerd_at ? String(t.gearchiveerd_at).slice(0, 10) : null;
}

/**
 * @param {object} p
 * @param {object[]} p.taken       opvolgtaken (open én gearchiveerd)
 * @param {object[]} p.pogingen    pogingen van die dag, met taak_id
 * @param {string}   p.dag         YYYY-MM-DD in lokale tijd
 * @param {(ts:string)=>string} p.dagVan  tijdstip → lokale dag
 */
export function verdeelVandaagGedaan({ taken, pogingen, dag, dagVan }) {
  const alle = Array.isArray(taken) ? taken : [];
  const gebruikt = new Set();

  // ── 1 · Afgesloten ───────────────────────────────────────────────────────
  const afgesloten = [];
  for (const t of alle) {
    if (afsluitDag(t) !== dag) continue;
    gebruikt.add(t.id);
    afgesloten.push({
      taak_id: t.id, naam: t.naam || 'Naamloos',
      reden: t.archief_reden || null,
      om: t.gearchiveerd_at || null,
    });
  }

  // ── 2 · Doorgeschoven ────────────────────────────────────────────────────
  // Vandaag bevestigd, kaart staat nog open, en de due wijst vooruit. Die drie
  // samen zijn precies 'beslissing genomen én komt terug'; twee ervan zou ook
  // een kaart vangen die gewoon nog nooit is aangeraakt.
  const doorgeschoven = [];
  for (const t of alle) {
    if (gebruikt.has(t.id)) continue;
    if (!t.bevestigd_op || dagVan(t.bevestigd_op) !== dag) continue;
    if (String(t.status || '') !== 'open') continue;
    if (!t.due || String(t.due) <= dag) continue;
    gebruikt.add(t.id);
    doorgeschoven.push({
      taak_id: t.id, naam: t.naam || 'Naamloos',
      wat: 'bevestigd', terug_op: t.due, om: t.bevestigd_op,
      notitie: t.bevestigd_notitie || null,
    });
  }

  // ── 3 · Aangeraakt maar nog open ─────────────────────────────────────────
  // Alles wat vandaag een poging kreeg, MINUS wie hierboven al staat.
  const perTaak = new Map();
  for (const p of pogingen || []) {
    if (!p || !p.taak_id) continue;
    if (dagVan(p.tijdstip) !== dag) continue;
    if (gebruikt.has(p.taak_id)) continue;
    if (!perTaak.has(p.taak_id)) perTaak.set(p.taak_id, []);
    perTaak.get(p.taak_id).push(p);
  }
  const naamVan = new Map(alle.map((t) => [t.id, t.naam || 'Naamloos']));
  const aangeraakt = [...perTaak.entries()].map(([taakId, rij]) => ({
    taak_id: taakId,
    naam   : naamVan.get(taakId) || 'Naamloos',
    pogingen: rij.length,
    laatste : rij.map((p) => p.tijdstip).sort().at(-1) || null,
  })).sort((a, b) => String(a.naam).localeCompare(String(b.naam), 'nl'));

  return {
    dag,
    afgesloten,
    doorgeschoven,
    aangeraakt,
    aantallen: {
      afgesloten: afgesloten.length,
      doorgeschoven: doorgeschoven.length,
      aangeraakt: aangeraakt.length,
    },
  };
}

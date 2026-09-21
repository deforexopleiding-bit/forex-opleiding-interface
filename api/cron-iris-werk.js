// api/cron-iris-werk.js
//
// Het werk van Iris, elke vijf minuten.
//
// ── WAT ER IN DEZE FASE GEBEURT ──────────────────────────────────────────────
// Opnemen, koppelen, indelen. Meer niet. Er wordt niets verstuurd, er wordt
// geen concept geschreven, er gaat niets naar een klant. Dat is de schaduw-
// modus, en die is geen tussenstap die we snel voorbij willen: het is de enige
// manier om dagenlang te kunnen meekijken of Iris berichten goed begrijpt,
// zonder dat een verkeerd begrip iemand bereikt.
//
// Latere fases hangen hun werk aan dezelfde ronde, elk achter een eigen
// schakelaar. De volgorde hier is de volgorde waarin dat gebeurt.
//
// ── FAALZACHT PER BERICHT, NIET PER RONDE ────────────────────────────────────
// Elke lus heeft try/catch per stuk. Eén bericht dat struikelt mag de andere
// honderdnegenennegentig niet meenemen. Lesson learned 3 in CLAUDE.md.
//
// En: elke mislukking krijgt een console.error MET de tekst van de fout. Een
// teller zonder tekst maakt zoeken onmogelijk — dat heeft in mei 2026 drieënhalf
// uur stilstand onzichtbaar gehouden.
//
// ── TIJDSGRENS ───────────────────────────────────────────────────────────────
// Vercel kapt deze functie na 30 seconden af (vercel.json). We stoppen zelf bij
// 25 zodat de ronde netjes afsluit en rapporteert wat er wel gelukt is. Wat
// blijft liggen, ligt er over vijf minuten nog — het verzamelverschil in
// opname.js kent geen cursor die eroverheen loopt.
//
// Auth: Authorization: Bearer $CRON_SECRET.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { haalInstellingen } from './_lib/iris/instellingen.js';
import { zorgVoorContact } from './_lib/iris/koppel.js';
import { deelIn } from './_lib/iris/classificeer.js';
import { verstuurConcept } from './iris-verstuur.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { haalSignalen } from './_lib/iris/signalen.js';
import {
  OPNAME_PER_RONDE,
  bronSleutel,
  filterNieuw,
  vormWa,
  vormMail,
  terugblikVanaf,
} from './_lib/iris/opname.js';

const STOP_NA_MS = 25_000;
const INDELEN_PER_RONDE = 25;
const MAX_FOUTEN_IN_LOG = 3;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Alleen GET en POST' });
  }
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const start = Date.now();
  const opTijd = () => (Date.now() - start) < STOP_NA_MS;

  const rapport = {
    opgenomen_wa: 0,
    opgenomen_mail: 0,
    gekoppeld: 0,
    te_bevestigen: 0,
    ingedeeld: 0,
    indeel_fouten: 0,
    verstuurd: 0,
    verstuur_fouten: 0,
    signalen_nieuw: 0,
    overgeslagen_tijd: false,
    fouten: [],
    duur_ms: 0,
  };
  const meldFout = (waar, e) => {
    const tekst = e?.message || String(e);
    console.error(`[cron-iris-werk] ${waar}:`, tekst);
    if (rapport.fouten.length < MAX_FOUTEN_IN_LOG) rapport.fouten.push(`${waar}: ${tekst}`);
  };

  try {
    const instellingen = await haalInstellingen(supabaseAdmin);

    // De hoofdschakelaar bepaalt niet of we KIJKEN — alleen of er ooit iets
    // vertrekt. Opnemen en indelen mag altijd; dat is precies wat schaduwmodus
    // betekent. Zonder dit onderscheid zou Maxim niets te beoordelen hebben
    // voordat hij de schakelaar omzet, en dan is het omzetten een sprong in
    // het donker.
    const sinds = terugblikVanaf();

    // ── 1. Wat staat er al in? ───────────────────────────────────────────────
    const bekend = new Set();
    try {
      const { data, error } = await supabaseAdmin
        .from('iris_berichten')
        .select('bron_uniek')
        .gte('ontvangen_op', sinds);
      if (error) throw new Error(error.message);
      for (const r of (data || [])) bekend.add(r.bron_uniek);
    } catch (e) {
      meldFout('bekende sleutels lezen', e);
      // Zonder deze verzameling zouden we alles opnieuw willen opnemen. De
      // UNIQUE-constraint vangt dat op, maar dan draaien we honderden inserts
      // die allemaal botsen. Beter deze ronde overslaan.
      rapport.duur_ms = Date.now() - start;
      return res.status(200).json({ ok: false, reden: 'bekende sleutels niet gelezen', rapport });
    }

    // ── 2. WhatsApp opnemen ──────────────────────────────────────────────────
    if (opTijd()) {
      try {
        const { data, error } = await supabaseAdmin
          .from('whatsapp_messages')
          .select('id, conversation_id, direction, body, media_type, template_name, created_at, sent_at')
          .gte('created_at', sinds)
          .order('created_at', { ascending: true })
          .limit(OPNAME_PER_RONDE);
        if (error) throw new Error(error.message);

        const nieuw = filterNieuw(data, bekend, 'whatsapp');
        for (const rij of nieuw) {
          if (!opTijd()) { rapport.overgeslagen_tijd = true; break; }
          try {
            const uit = await neemWaOp(rij, rapport);
            if (uit) rapport.opgenomen_wa++;
          } catch (e) {
            meldFout(`wa-bericht ${rij.id}`, e);
          }
        }
      } catch (e) {
        meldFout('whatsapp lezen', e);
      }
    }

    // ── 3. Mail opnemen ──────────────────────────────────────────────────────
    if (opTijd()) {
      try {
        const mailboxen = Array.isArray(instellingen.mailboxen?.lezen) && instellingen.mailboxen.lezen.length
          ? instellingen.mailboxen.lezen
          : ['administratie', 'info', 'onboarding'];

        const { data, error } = await supabaseAdmin
          .from('email_messages')
          .select('id, mailbox, from_address, from_name, subject, snippet, body_text, date_received, customer_id')
          .in('mailbox', mailboxen)
          .gte('date_received', sinds)
          .order('date_received', { ascending: true })
          .limit(OPNAME_PER_RONDE);
        if (error) throw new Error(error.message);

        const nieuw = filterNieuw(data, bekend, 'email');
        for (const rij of nieuw) {
          if (!opTijd()) { rapport.overgeslagen_tijd = true; break; }
          try {
            const uit = await neemMailOp(rij, rapport);
            if (uit) rapport.opgenomen_mail++;
          } catch (e) {
            meldFout(`mail ${rij.id}`, e);
          }
        }
      } catch (e) {
        meldFout('mail lezen', e);
      }
    }

    // ── 4. Indelen ───────────────────────────────────────────────────────────
    if (opTijd()) {
      try {
        const { data, error } = await supabaseAdmin
          .from('iris_berichten')
          .select('id, bron, gesprek_id, richting, tekst_kort, ontvangen_op')
          .is('verwerkt_op', null)
          .eq('richting', 'in')
          .order('ontvangen_op', { ascending: false })
          .limit(INDELEN_PER_RONDE);
        if (error) throw new Error(error.message);

        for (const b of (data || [])) {
          if (!opTijd()) { rapport.overgeslagen_tijd = true; break; }
          try {
            const gelukt = await deelBerichtIn(b, instellingen, meldFout);
            if (gelukt) rapport.ingedeeld++;
            else rapport.indeel_fouten++;
          } catch (e) {
            rapport.indeel_fouten++;
            meldFout(`indelen ${b.id}`, e);
          }
        }
      } catch (e) {
        meldFout('werkvoorraad lezen', e);
      }
    }

    // ── 5. Het vangnet onder het ongedaan-venster ────────────────────────────
    // iris-verstuur.js plant de verzending zelf in met waitUntil() zodat een
    // bericht na dertig seconden echt weg is en niet pas bij de volgende ronde
    // — dat is wat de opdracht vraagt. Wat hier staat is voor het geval die
    // functie sneuvelt: dan blijft het concept op 'goedgekeurd' staan met een
    // verstuur_na in het verleden, en pikt deze ronde het alsnog op.
    //
    // De claim in verstuurConcept() (goedgekeurd -> verzonden, voorwaardelijk)
    // zorgt dat een bericht nooit twee keer vertrekt, ook niet als de
    // wachtende taak en deze ronde elkaar precies kruisen.
    if (opTijd()) {
      try {
        const { data, error } = await supabaseAdmin
          .from('iris_concepten')
          .select('id, gesprek_id')
          .eq('status', 'goedgekeurd')
          .lte('verstuur_na', new Date().toISOString())
          .order('verstuur_na', { ascending: true })
          .limit(20);
        if (error) throw new Error(error.message);

        for (const c of (data || [])) {
          if (!opTijd()) { rapport.overgeslagen_tijd = true; break; }
          try {
            const uit = await verstuurConcept(c.id);
            if (uit?.ok) rapport.verstuurd++;
            else if (uit?.reden !== 'niet_geclaimd') rapport.verstuur_fouten++;
          } catch (e) {
            rapport.verstuur_fouten++;
            meldFout(`versturen ${c.id}`, e);
          }
        }
      } catch (e) {
        meldFout('wachtrij lezen', e);
      }
    }

    // ── 6. Mentorsignalen uit het LMS ────────────────────────────────────────
    // Alleen lezen. Een LMS dat even niet bereikbaar is, mag de post niet
    // stilleggen — vandaar een waarschuwing en geen fout.
    if (opTijd()) {
      try {
        const uit = await haalSignalen({ crmDb: supabaseAdmin, lmsClient: getDfoLmsClient() });
        rapport.signalen_nieuw = uit.nieuw || 0;
        if (uit.fout) console.warn('[cron-iris-werk] signalen:', uit.fout);
      } catch (e) {
        meldFout('signalen ophalen', e);
      }
    }

    rapport.duur_ms = Date.now() - start;
    console.log('[cron-iris-werk]', JSON.stringify(rapport));

    // Een ronde zonder werk hoeft niet in het logboek — dat zou het logboek
    // vol zetten met stilte.
    if (rapport.opgenomen_wa || rapport.opgenomen_mail || rapport.ingedeeld || rapport.verstuurd || rapport.signalen_nieuw || rapport.fouten.length) {
      const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
        wat: 'werkronde',
        resultaat: rapport.fouten.length ? 'deels' : 'ok',
        fout: rapport.fouten.length ? rapport.fouten.join(' | ').slice(0, 1000) : null,
        details: rapport,
      });
      if (logFout) console.warn('[cron-iris-werk] logregel mislukt:', logFout.message);
    }

    return res.status(200).json({ ok: true, schaduwmodus: true, rapport });
  } catch (e) {
    rapport.duur_ms = Date.now() - start;
    console.error('[cron-iris-werk] ronde afgebroken:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Interne fout', rapport });
  }
}

// ── Eén WhatsApp-bericht opnemen ─────────────────────────────────────────────

async function neemWaOp(rij, rapport) {
  // De conversatie geeft ons het telefoonnummer en de bestaande klantkoppeling.
  const { data: conv, error: convFout } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id, phone_number, display_name, customer_id, last_inbound_at')
    .eq('id', rij.conversation_id)
    .maybeSingle();
  if (convFout) throw new Error('conversatie: ' + convFout.message);
  if (!conv) return false;

  const contact = await zorgVoorContact(supabaseAdmin, {
    telefoon: conv.phone_number,
    naam: conv.display_name,
  });
  if (contact) {
    if (contact.koppelstatus === 'gekoppeld') rapport.gekoppeld++;
    else rapport.te_bevestigen++;
  }

  const gesprek = await zorgVoorGesprek({
    contactId: contact?.id || null,
    kanaal: 'whatsapp',
    externId: conv.id,
    laatsteInbound: conv.last_inbound_at,
  });

  const vorm = vormWa(rij);
  const { error } = await supabaseAdmin.from('iris_berichten').insert({
    ...vorm,
    gesprek_id: gesprek?.id || null,
    contact_id: contact?.id || null,
  });
  if (error) {
    // Een botsing op bron_uniek betekent dat een gelijktijdige ronde hem al
    // had. Dat is geen fout, dat is de idempotentie die werkt.
    if (String(error.code) === '23505') return false;
    throw new Error('bericht opslaan: ' + error.message);
  }
  return true;
}

// ── Eén mail opnemen ─────────────────────────────────────────────────────────

async function neemMailOp(rij, rapport) {
  // Voor een inkomende mail is het afzenderadres de persoon. Voor een mail die
  // wij verstuurden is dat ONS adres — daar valt geen contact uit af te leiden.
  // We nemen hem wel op (de draad hoort compleet te zijn) maar koppelen via de
  // klant die er al aan hing.
  const vorm = vormMail(rij);

  let contact = null;
  if (vorm.richting === 'in') {
    contact = await zorgVoorContact(supabaseAdmin, {
      email: rij.from_address,
      naam: rij.from_name,
    });
    if (contact) {
      if (contact.koppelstatus === 'gekoppeld') rapport.gekoppeld++;
      else rapport.te_bevestigen++;
    }
  } else if (rij.customer_id) {
    const { data } = await supabaseAdmin
      .from('iris_contacten')
      .select('id')
      .eq('customer_id', rij.customer_id)
      .limit(1)
      .maybeSingle();
    contact = data || null;
  }

  // Het gesprek hangt aan het adres van de KLANT, niet aan onze mailbox. Bij
  // een uitgaande mail is dat adres niet uit from_address te halen, dus dan
  // hangen we hem aan het gesprek van het contact als dat er is.
  let gesprek = null;
  if (vorm.richting === 'in' && rij.from_address) {
    gesprek = await zorgVoorGesprek({
      contactId: contact?.id || null,
      kanaal: 'email',
      externId: String(rij.from_address).toLowerCase().trim(),
      laatsteInbound: rij.date_received,
    });
  } else if (contact?.id) {
    const { data } = await supabaseAdmin
      .from('iris_gesprekken')
      .select('id')
      .eq('contact_id', contact.id)
      .eq('kanaal', 'email')
      .limit(1)
      .maybeSingle();
    gesprek = data || null;
  }

  const { error } = await supabaseAdmin.from('iris_berichten').insert({
    ...vorm,
    gesprek_id: gesprek?.id || null,
    contact_id: contact?.id || null,
  });
  if (error) {
    if (String(error.code) === '23505') return false;
    throw new Error('mail opslaan: ' + error.message);
  }
  return true;
}

// ── Het gesprek ──────────────────────────────────────────────────────────────

async function zorgVoorGesprek({ contactId, kanaal, externId, laatsteInbound }) {
  const uniek = `${kanaal}:${externId}`;
  const { data: bestaand, error: zoekFout } = await supabaseAdmin
    .from('iris_gesprekken')
    .select('id, contact_id, status, laatste_inbound')
    .eq('extern_uniek', uniek)
    .maybeSingle();
  if (zoekFout) throw new Error('gesprek zoeken: ' + zoekFout.message);

  if (bestaand) {
    const bij = {};
    // Een gesprek dat zonder contact begon en er nu wel een heeft, hoort dat
    // alsnog te krijgen. Andersom niet: een bestaande koppeling wordt nooit
    // overschreven door een lege.
    if (!bestaand.contact_id && contactId) bij.contact_id = contactId;
    if (laatsteInbound && (!bestaand.laatste_inbound || laatsteInbound > bestaand.laatste_inbound)) {
      bij.laatste_inbound = laatsteInbound;
    }
    if (Object.keys(bij).length) {
      bij.bijgewerkt_op = new Date().toISOString();
      const { error } = await supabaseAdmin.from('iris_gesprekken').update(bij).eq('id', bestaand.id);
      if (error) console.warn('[cron-iris-werk] gesprek bijwerken:', error.message);
    }
    return bestaand;
  }

  const { data: nieuw, error: maakFout } = await supabaseAdmin
    .from('iris_gesprekken')
    .insert({
      contact_id: contactId,
      kanaal,
      extern_id: String(externId),
      extern_uniek: uniek,
      laatste_inbound: laatsteInbound || null,
      status: 'nieuw',
    })
    .select('id, contact_id, status, laatste_inbound')
    .single();
  if (maakFout) {
    // Gelijktijdige ronde was ons voor. Haal zijn rij op.
    if (String(maakFout.code) === '23505') {
      const { data } = await supabaseAdmin
        .from('iris_gesprekken')
        .select('id, contact_id, status, laatste_inbound')
        .eq('extern_uniek', uniek)
        .maybeSingle();
      return data || null;
    }
    throw new Error('gesprek aanmaken: ' + maakFout.message);
  }
  return nieuw;
}

// ── Eén bericht indelen ──────────────────────────────────────────────────────

async function deelBerichtIn(bericht, instellingen, meldFout) {
  let voorgeschiedenis = [];
  if (bericht.gesprek_id) {
    const { data } = await supabaseAdmin
      .from('iris_berichten')
      .select('richting, tekst_kort, ontvangen_op')
      .eq('gesprek_id', bericht.gesprek_id)
      .lt('ontvangen_op', bericht.ontvangen_op)
      .order('ontvangen_op', { ascending: false })
      .limit(6);
    voorgeschiedenis = (data || []).reverse();
  }

  const uit = await deelIn({
    tekst: bericht.tekst_kort,
    kanaal: bericht.bron,
    voorgeschiedenis,
    model: instellingen.model?.redeneren,
    temperatuur: 0,
  });

  if (!uit.ok) {
    // Het bericht blijft ONVERWERKT staan. Het als 'overig' wegschrijven zou
    // een verkeerde indeling definitief laten lijken; nu probeert de volgende
    // ronde het gewoon opnieuw. Wel de fout opslaan zodat er iets te zien is.
    const { error } = await supabaseAdmin
      .from('iris_berichten')
      .update({ verwerk_fout: String(uit.fout).slice(0, 500) })
      .eq('id', bericht.id);
    if (error) meldFout(`fout opslaan bij ${bericht.id}`, error);
    return false;
  }

  const { error } = await supabaseAdmin
    .from('iris_berichten')
    .update({
      categorie: uit.uitkomst.categorie,
      categorie_reden: uit.uitkomst.reden,
      zekerheid: uit.uitkomst.zekerheid,
      samenvatting: uit.uitkomst.samenvatting,
      verwerkt_op: new Date().toISOString(),
      verwerk_fout: null,
    })
    .eq('id', bericht.id);
  if (error) throw new Error('indeling opslaan: ' + error.message);

  // Het gesprek erft de categorie van zijn meest recente inkomende bericht,
  // en gaat op "wacht op ons" staan. Dat is de hele reden dat er een status is.
  if (bericht.gesprek_id) {
    const { error: gFout } = await supabaseAdmin
      .from('iris_gesprekken')
      .update({
        categorie: uit.uitkomst.categorie,
        status: 'wacht_op_ons',
        bijgewerkt_op: new Date().toISOString(),
      })
      .eq('id', bericht.gesprek_id)
      .in('status', ['nieuw', 'wacht_op_klant']);
    if (gFout) meldFout(`gesprek bijwerken bij ${bericht.id}`, gFout);
  }

  return true;
}

export { bronSleutel };

// api/iris-belrij.js
//
// De belrij: wie moet er gebeld worden, en wat kwam eruit.
//
//   GET  ?eigenaar=mij|alle&status=open
//   POST { actie: 'poging',     belrij_id?, contact_id, call_log_id?, outcome_hint?, notitie? }
//   POST { actie: 'afronden',   belrij_id, resultaat? }
//   POST { actie: 'toevoegen',  contact_id, reden, bron?, eigenaar?, prioriteit? }
//
// Recht: iris.belrij.
//
// ── DE SOFTPHONE BLIJFT DE BRON ──────────────────────────────────────────────
// Bellen gebeurt via de bestaande KlxSoftphone; die schrijft naar call_log.
// Dit endpoint neemt die uitkomst over in iris_belpogingen, met de vertaling
// uit _lib/iris/belrij.js. De softphone zelf wordt niet aangepast: de
// context-parameter die Iris meegeeft (irisDossierId) gaat in call_log.meta,
// en dat veld is er uitdrukkelijk voor.
//
// opvolging_pogingen blijft van Dave. Daar wordt hier niet in geschreven.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalInstellingen } from './_lib/iris/instellingen.js';
import {
  uitCallLog, telPogingen, moetEscaleren, sorteerBelrij, redenTekst, MAX_PER_DAG,
} from './_lib/iris/belrij.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });
  if (!(await requirePermission(req, 'iris.belrij'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.belrij)' });
  }

  try {
    if (req.method === 'GET') return await geefLijst(req, res, user);
    if (req.method === 'POST') {
      const actie = String(req.body?.actie || '').trim();
      if (actie === 'poging') return await noteerPoging(req, res, user);
      if (actie === 'afronden') return await afronden(req, res, user);
      if (actie === 'toevoegen') return await toevoegen(req, res, user);
      return res.status(400).json({ error: `onbekende actie: ${actie || '(leeg)'}` });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Alleen GET en POST' });
  } catch (e) {
    console.error('[iris-belrij]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// ── De lijst ─────────────────────────────────────────────────────────────────

async function geefLijst(req, res, user) {
  const eigenaar = String(req.query?.eigenaar || 'alle');
  const status = String(req.query?.status || 'open');
  const nu = new Date();

  let vraag = supabaseAdmin
    .from('iris_belrij')
    .select('id, contact_id, reden, reden_detail, eigenaar, prioriteit, status, bron, laatste_poging_op, pogingen_totaal, dagen_met_poging, aangemaakt_op')
    .limit(200);
  if (status === 'open') vraag = vraag.in('status', ['open', 'bezig']);
  else if (status && status !== 'alle') vraag = vraag.eq('status', status);
  if (eigenaar === 'mij') vraag = vraag.eq('eigenaar', user.id);

  const { data, error } = await vraag;
  if (error) throw new Error('belrij: ' + error.message);

  const rijen = sorteerBelrij(data || []);
  const contactIds = [...new Set(rijen.map((r) => r.contact_id).filter(Boolean))];

  const [contacten, pogingen] = await Promise.all([
    haalContacten(contactIds),
    haalPogingen(contactIds),
  ]);

  const instellingen = await haalInstellingen(supabaseAdmin);

  const items = rijen.map((r) => {
    const telling = telPogingen(pogingen.get(r.contact_id) || [], { nu });
    const escalatie = moetEscaleren(telling, instellingen.escalatie, { nu });
    const c = contacten.get(r.contact_id);
    return {
      id: r.id,
      contact_id: r.contact_id,
      naam: c?.weergavenaam || c?.emails?.[0] || c?.telefoons?.[0] || 'Onbekend',
      telefoon: c?.telefoons?.[0] || null,
      customer_id: c?.customer_id || null,
      reden: redenTekst(r.bron, r.reden_detail || r.reden),
      bron: r.bron,
      eigenaar: r.eigenaar,
      prioriteit: r.prioriteit,
      status: r.status,
      telling,
      mag_vandaag_nog: telling.mag_vandaag_nog,
      escalatie,
      aangemaakt_op: r.aangemaakt_op,
    };
  });

  return res.status(200).json({ items, max_per_dag: MAX_PER_DAG, escalatie_drempel: instellingen.escalatie });
}

async function haalContacten(ids) {
  const kaart = new Map();
  if (!ids.length) return kaart;
  const { data } = await supabaseAdmin
    .from('iris_contacten')
    .select('id, customer_id, emails, telefoons, weergavenaam')
    .in('id', ids);
  for (const c of (data || [])) kaart.set(c.id, c);
  return kaart;
}

async function haalPogingen(contactIds) {
  const kaart = new Map();
  if (!contactIds.length) return kaart;
  const { data } = await supabaseAdmin
    .from('iris_belpogingen')
    .select('contact_id, uitkomst, afgebroken_voor_opname, gebeld_op')
    .in('contact_id', contactIds)
    .order('gebeld_op', { ascending: false })
    .limit(contactIds.length * 20);
  for (const p of (data || [])) {
    if (!kaart.has(p.contact_id)) kaart.set(p.contact_id, []);
    kaart.get(p.contact_id).push(p);
  }
  return kaart;
}

// ── Een poging noteren ───────────────────────────────────────────────────────

async function noteerPoging(req, res, user) {
  const contactId = String(req.body?.contact_id || '').trim();
  if (!UUID_RE.test(contactId)) return res.status(400).json({ error: 'contact_id moet een geldige uuid zijn' });

  const belrijId = String(req.body?.belrij_id || '').trim() || null;
  const callLogId = String(req.body?.call_log_id || '').trim() || null;
  const notitie = req.body?.notitie ? String(req.body.notitie).slice(0, 1000) : null;
  const notitieBron = ['spraak', 'tekst'].includes(req.body?.notitie_bron) ? req.body.notitie_bron : (notitie ? 'tekst' : null);

  // De uitkomst komt bij voorkeur uit call_log — dat is de bron. Wordt er een
  // uitkomst meegegeven zonder call_log, dan is dat een handmatige notitie en
  // nemen we die over.
  let uitkomst = String(req.body?.uitkomst || '').trim();
  let afgebroken = req.body?.afgebroken_voor_opname === true;
  let duurSec = null;

  if (callLogId && UUID_RE.test(callLogId)) {
    const { data: call } = await supabaseAdmin
      .from('call_log')
      .select('outcome_hint, duration_sec')
      .eq('id', callLogId)
      .maybeSingle();
    if (call) {
      const vertaald = uitCallLog(call.outcome_hint);
      uitkomst = vertaald.uitkomst;
      afgebroken = vertaald.afgebroken;
      duurSec = call.duration_sec ?? null;
    }
  }

  if (!uitkomst) {
    const vertaald = uitCallLog(req.body?.outcome_hint);
    uitkomst = vertaald.uitkomst;
    afgebroken = vertaald.afgebroken;
  }

  const { data: poging, error } = await supabaseAdmin
    .from('iris_belpogingen')
    .insert({
      belrij_id: belrijId,
      contact_id: contactId,
      call_log_id: callLogId,
      uitkomst,
      afgebroken_voor_opname: afgebroken,
      duur_sec: duurSec,
      notitie,
      notitie_bron: notitieBron,
      gebeld_door: user.id,
    })
    .select('*')
    .single();
  if (error) throw new Error('poging opslaan: ' + error.message);

  // De tellers op de belrij-rij bijwerken. Een afgebroken poging telt niet
  // mee — anders kost één mispiek iemand de rest van de dag.
  if (belrijId && !afgebroken) {
    const { data: alle } = await supabaseAdmin
      .from('iris_belpogingen')
      .select('uitkomst, afgebroken_voor_opname, gebeld_op')
      .eq('contact_id', contactId);
    const telling = telPogingen(alle || []);
    const { error: bFout } = await supabaseAdmin
      .from('iris_belrij')
      .update({
        pogingen_totaal: telling.meetellend,
        dagen_met_poging: telling.dagen_met_poging,
        laatste_poging_op: new Date().toISOString(),
        status: uitkomst === 'gesproken' ? 'gedaan' : 'bezig',
        bijgewerkt_op: new Date().toISOString(),
      })
      .eq('id', belrijId);
    if (bFout) console.warn('[iris-belrij] tellers bijwerken:', bFout.message);
  }

  // Moet er geëscaleerd worden? We beslissen het hier en melden het, maar
  // versturen niets: dat loopt via een concept dat langs de gewone poorten
  // gaat. Zo is er geen tweede verzendweg die haar eigen regels heeft.
  const instellingen = await haalInstellingen(supabaseAdmin);
  const { data: alle } = await supabaseAdmin
    .from('iris_belpogingen')
    .select('uitkomst, afgebroken_voor_opname, gebeld_op')
    .eq('contact_id', contactId);
  const telling = telPogingen(alle || []);

  const { data: gesprek } = await supabaseAdmin
    .from('iris_gesprekken')
    .select('id, laatste_inbound')
    .eq('contact_id', contactId)
    .order('laatste_inbound', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const escalatie = moetEscaleren(telling, instellingen.escalatie, {
    laatsteInbound: gesprek?.laatste_inbound || null,
  });

  const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
    wie: user.id,
    wat: `belpoging: ${uitkomst}${afgebroken ? ' (afgebroken, telt niet)' : ''}`,
    contact_id: contactId,
    resultaat: 'ok',
    details: { belrij_id: belrijId, telt_mee: !afgebroken },
  });
  if (logFout) console.warn('[iris-belrij] logregel mislukt:', logFout.message);

  return res.status(200).json({ poging, telling, escalatie, gesprek_id: gesprek?.id || null });
}

// ── Afronden en toevoegen ────────────────────────────────────────────────────

async function afronden(req, res, user) {
  const id = String(req.body?.belrij_id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'belrij_id moet een geldige uuid zijn' });
  const resultaat = ['gedaan', 'vervallen'].includes(req.body?.resultaat) ? req.body.resultaat : 'gedaan';

  const { data, error } = await supabaseAdmin
    .from('iris_belrij')
    .update({ status: resultaat, bijgewerkt_op: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['open', 'bezig'])
    .select('id, status')
    .maybeSingle();
  if (error) throw new Error('afronden: ' + error.message);
  if (!data) return res.status(409).json({ error: 'Deze regel staat niet meer open' });
  return res.status(200).json({ ok: true, status: data.status });
}

async function toevoegen(req, res, user) {
  const contactId = String(req.body?.contact_id || '').trim();
  if (!UUID_RE.test(contactId)) return res.status(400).json({ error: 'contact_id moet een geldige uuid zijn' });

  const { data, error } = await supabaseAdmin
    .from('iris_belrij')
    .insert({
      contact_id: contactId,
      reden: String(req.body?.reden || 'handmatig toegevoegd').slice(0, 200),
      reden_detail: req.body?.detail ? String(req.body.detail).slice(0, 500) : null,
      eigenaar: req.body?.eigenaar && UUID_RE.test(String(req.body.eigenaar)) ? req.body.eigenaar : null,
      prioriteit: Number.isFinite(Number(req.body?.prioriteit)) ? Number(req.body.prioriteit) : 50,
      bron: ['wanbetaler', 'onboarding', 'mentorsignaal', 'geen_reactie', 'hand'].includes(req.body?.bron)
        ? req.body.bron : 'hand',
    })
    .select('*')
    .single();
  if (error) throw new Error('toevoegen: ' + error.message);
  return res.status(200).json({ regel: data });
}

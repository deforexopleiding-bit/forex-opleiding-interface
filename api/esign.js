// api/esign.js — E-handtekening, CRM-kant (fase 1, 2026-11-09)
//
// GET  ?actie=lijst                        → envelopes + ontvangers (esign.view)
// GET  ?actie=detail&id=                   → pakket + events + signed URL origineel (esign.view)
// GET  ?actie=download&id=&soort=getekend|origineel → { url } (5 min) (esign.view)
// GET  ?actie=teamleden                    → actieve profielen met e-mail (esign.send)
// GET  ?actie=klanten&q=                   → klanten zoeken voor de koppeling (esign.send)
// POST { actie: 'aanmaken', titel, bericht?, volgorde, ontvangers:[profile_id], entiteit? }
// POST { actie: 'bijwerken', id, titel?, bericht?, volgorde?, ontvangers?, entiteit? }   (concept)
// POST { actie: 'upload_url', id, naam }                → signed upload URL (concept)
// POST { actie: 'document_registreren', id, naam }      → controle PDF + hash + pagina's
// POST { actie: 'velden_opslaan', id, velden:[…] }      (concept)
// POST { actie: 'versturen', id }
// POST { actie: 'opnieuw_versturen', id }
// POST { actie: 'intrekken', id, reden? }
// POST { actie: 'afronden', id }                        (opnieuw proberen na een fout)
//
// Rechten: esign.view (lezen) en esign.send (al het andere). Keuze Jeffrey
// 9 nov 2026: ALLEEN super_admin (impliciet via user_has_permission); anderen
// per persoon via user_permissions. Zie docs/sql-migrations/2026-11-09-e-handtekening-fase1-tabellen.sql.
// Elke mutatie schrijft een audit-event (methode 'crm_login', IP + user-agent).

import { supabase, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendMail } from './mailer.js';
import {
  BUCKET, MAX_ONTVANGERS, MAX_PDF_BYTES, klaarOmTeVersturen, valideerVeldDefinities, sha256Hex, ACTIEF,
} from './_lib/esign-core.js';
import {
  laadEnvelope, laadEvents, logEvent, verzoekInfo, nodigVolgendeUit, verstuurOpnieuw, rondAf,
  downloadBytes, signedUrl, isMigratieFout,
} from './_lib/esign-server.js';
import { leesPaginas } from './_lib/esign-pdf.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITEIT_TYPES = new Set(['klant', 'teamlid', 'onboarding', 'deal', 'overig']);

async function gebruiker(req) {
  const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data: { user } = {}, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data: p } = await supabaseAdmin.from('profiles').select('id, email, full_name, role').eq('id', user.id).maybeSingle();
  return { id: user.id, email: p?.email || user.email, naam: p?.full_name || p?.email || user.email };
}

function fout(res, status, error, extra = {}) { return res.status(status).json({ error, ...extra }); }

function migratieOfFout(res, e, label) {
  if (isMigratieFout(e?.dbError || e)) {
    return fout(res, 503, 'De e-handtekening-module is nog niet geïnstalleerd (SQL-migratie ontbreekt).', { code: 'MIGRATIE_NODIG' });
  }
  console.error(`[esign] ${label}:`, e?.message || e);
  return fout(res, 500, `${label} mislukt: ${e?.message || e}`);
}

// Ontvangers uit profile-id's: altijd intern in fase 1, naam + e-mail als momentopname.
async function ontvangersUitProfielen(ids) {
  if (!Array.isArray(ids)) return { fout: 'ontvangers moet een lijst van profiel-id\'s zijn' };
  const uniek = [...new Set(ids.map(String))];
  if (uniek.length === 0) return { lijst: [] };
  if (uniek.length > MAX_ONTVANGERS) return { fout: `maximaal ${MAX_ONTVANGERS} ondertekenaars` };
  if (uniek.some((id) => !UUID_RE.test(id))) return { fout: 'ongeldig profiel-id' };
  const { data, error } = await supabaseAdmin.from('profiles').select('id, email, full_name, is_active').in('id', uniek);
  if (error) return { fout: 'profielen lezen: ' + error.message };
  const per = new Map((data || []).map((p) => [p.id, p]));
  const lijst = [];
  for (const id of uniek) {
    const p = per.get(id);
    if (!p || p.is_active === false || !p.email) return { fout: 'Een gekozen teamlid bestaat niet, is niet actief of heeft geen e-mail.' };
    lijst.push({ profile_id: p.id, naam: p.full_name || p.email, email: p.email });
  }
  return { lijst };
}

function entiteitUit(body) {
  const e = body?.entiteit;
  if (e == null) return { entiteit_type: null, entiteit_id: null };
  if (!ENTITEIT_TYPES.has(e.type) || !UUID_RE.test(String(e.id || ''))) return null;
  return { entiteit_type: e.type, entiteit_id: e.id };
}

// Zet de ontvangers van een concept gelijk aan `lijst` (volgorde = positie).
// Velden van wie eruit gaat, verdwijnen mee.
async function zetOntvangers(envelopeId, lijst) {
  const { data: huidig, error } = await supabaseAdmin.from('esign_ontvangers').select('id, profile_id').eq('envelope_id', envelopeId);
  if (error) throw error;
  const blijft = new Set(lijst.map((o) => o.profile_id));
  const weg = (huidig || []).filter((o) => !blijft.has(o.profile_id)).map((o) => o.id);
  if (weg.length) {
    const r1 = await supabaseAdmin.from('esign_velden').delete().in('ontvanger_id', weg);
    if (r1.error) throw r1.error;
    const r2 = await supabaseAdmin.from('esign_ontvangers').delete().in('id', weg);
    if (r2.error) throw r2.error;
  }
  // Eerst tijdelijke volgnummers (uniek per envelope), dan de echte.
  const bestaand = new Map((huidig || []).filter((o) => blijft.has(o.profile_id)).map((o) => [o.profile_id, o.id]));
  let tmp = 1000;
  for (const id of bestaand.values()) {
    const r = await supabaseAdmin.from('esign_ontvangers').update({ volgnummer: tmp++ }).eq('id', id);
    if (r.error) throw r.error;
  }
  for (const [i, o] of lijst.entries()) {
    const rij = { volgnummer: i + 1, naam: o.naam, email: o.email };
    const id = bestaand.get(o.profile_id);
    const r = id
      ? await supabaseAdmin.from('esign_ontvangers').update(rij).eq('id', id)
      : await supabaseAdmin.from('esign_ontvangers').insert({ ...rij, envelope_id: envelopeId, profile_id: o.profile_id, soort: 'intern', rol: 'ondertekenaar' });
    if (r.error) throw r.error;
  }
}

function samenvatting(pakket) {
  const { envelope, ontvangers, velden, documenten } = pakket;
  return {
    ...envelope,
    documenten: documenten.map((d) => ({ id: d.id, naam: d.naam, sha256: d.sha256, grootte_bytes: d.grootte_bytes, paginas: d.paginas })),
    ontvangers: ontvangers.map((o) => ({
      id: o.id, volgnummer: o.volgnummer, soort: o.soort, profile_id: o.profile_id, naam: o.naam, email: o.email,
      status: o.status, uitgenodigd_op: o.uitgenodigd_op, geopend_op: o.geopend_op, getekend_op: o.getekend_op,
      token_verloopt_op: o.token_verloopt_op,
    })),
    velden: velden.map((v) => ({
      id: v.id, document_id: v.document_id, ontvanger_id: v.ontvanger_id, type: v.type, pagina: v.pagina,
      x: Number(v.x), y: Number(v.y), breedte: Number(v.breedte), hoogte: Number(v.hoogte), verplicht: v.verplicht,
      ingevuld: v.waarde != null,
    })),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const actie = String((req.method === 'GET' ? req.query?.actie : req.body?.actie) || '');
  const leesActies = new Set(['lijst', 'detail', 'download']);
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return fout(res, 405, 'Methode niet toegestaan'); }

  const recht = leesActies.has(actie) && req.method === 'GET' ? 'esign.view' : 'esign.send';
  if (!(await requirePermission(req, recht))) return fout(res, 403, `Toegang geweigerd. \`${recht}\`-recht vereist.`);
  const ik = await gebruiker(req);
  if (!ik) return fout(res, 401, 'Niet ingelogd');
  const info = verzoekInfo(req);
  const audit = (envelope_id, type, details = {}, ontvanger_id = null) => logEvent(supabaseAdmin, {
    envelope_id, ontvanger_id, type, methode: 'crm_login', actor_id: ik.id, ...info, details: { door_naam: ik.naam, ...details },
  });

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (actie === 'lijst') {
        const { data: env, error } = await supabaseAdmin.from('esign_envelopes').select('*').order('created_at', { ascending: false }).limit(500);
        if (error) throw Object.assign(error, { dbError: error });
        const ids = (env || []).map((e) => e.id);
        const { data: ont, error: oErr } = ids.length
          ? await supabaseAdmin.from('esign_ontvangers').select('id, envelope_id, volgnummer, naam, email, status, getekend_op').in('envelope_id', ids).order('volgnummer')
          : { data: [], error: null };
        if (oErr) throw Object.assign(oErr, { dbError: oErr });
        const door = [...new Set((env || []).map((e) => e.aangemaakt_door).filter(Boolean))];
        const { data: prof } = door.length ? await supabaseAdmin.from('profiles').select('id, full_name, email').in('id', door) : { data: [] };
        const pn = new Map((prof || []).map((p) => [p.id, p.full_name || p.email]));
        return res.status(200).json({
          envelopes: (env || []).map((e) => ({
            ...e, aangemaakt_door_naam: pn.get(e.aangemaakt_door) || null,
            ontvangers: (ont || []).filter((o) => o.envelope_id === e.id),
          })),
        });
      }
      const id = String(req.query?.id || '');
      if (!UUID_RE.test(id)) return fout(res, 400, 'Ongeldig envelope-id');
      const pakket = await laadEnvelope(supabaseAdmin, id);
      if (!pakket) return fout(res, 404, 'Envelope niet gevonden');
      if (actie === 'detail') {
        const events = await laadEvents(supabaseAdmin, id);
        const doc = pakket.documenten[0];
        const url = doc ? await signedUrl(supabaseAdmin, doc.pad, 600) : null;
        return res.status(200).json({ envelope: samenvatting(pakket), events, document_url: url });
      }
      if (actie === 'download') {
        const soort = String(req.query?.soort || 'getekend');
        const pad = soort === 'origineel' ? pakket.documenten[0]?.pad : pakket.envelope.eind_pad;
        if (!pad) return fout(res, 404, soort === 'origineel' ? 'Nog geen document' : 'Nog niet voltooid');
        return res.status(200).json({ url: await signedUrl(supabaseAdmin, pad, 300) });
      }
    }

    if (req.method === 'GET' && actie === 'teamleden') {
      const { data, error } = await supabaseAdmin.from('profiles').select('id, full_name, email, role, is_active')
        .eq('is_active', true).not('email', 'is', null).order('full_name');
      if (error) throw error;
      return res.status(200).json({ teamleden: (data || []).map((p) => ({ id: p.id, naam: p.full_name || p.email, email: p.email, rol: p.role })) });
    }
    if (req.method === 'GET' && actie === 'klanten') {
      const q = String(req.query?.q || '').trim().replace(/[%,()]/g, ' ').slice(0, 60);
      if (q.length < 2) return res.status(200).json({ klanten: [] });
      const { data, error } = await supabaseAdmin.from('customers')
        .select('id, first_name, last_name, company_name, is_company, email')
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,company_name.ilike.%${q}%,email.ilike.%${q}%`)
        .is('archived_at', null).limit(15);
      if (error) throw error;
      return res.status(200).json({
        klanten: (data || []).map((c) => ({
          id: c.id, email: c.email,
          naam: c.is_company ? (c.company_name || c.email) : [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email,
        })),
      });
    }
    if (req.method === 'GET') return fout(res, 400, 'Onbekende actie');

    // ── POST ───────────────────────────────────────────────────────────────
    const b = req.body || {};

    if (actie === 'aanmaken') {
      const titel = String(b.titel || '').trim().slice(0, 200);
      if (!titel) return fout(res, 400, 'Titel is verplicht', { field: 'titel' });
      const volgorde = b.volgorde === 'parallel' ? 'parallel' : 'sequentieel';
      const ent = entiteitUit(b); if (!ent) return fout(res, 400, 'Ongeldige koppeling');
      const ont = await ontvangersUitProfielen(b.ontvangers || []);
      if (ont.fout) return fout(res, 400, ont.fout, { field: 'ontvangers' });
      const { data: env, error } = await supabaseAdmin.from('esign_envelopes').insert({
        titel, volgorde, bericht: String(b.bericht || '').trim().slice(0, 2000) || null,
        aangemaakt_door: ik.id, ...ent,
      }).select('*').single();
      if (error) throw Object.assign(error, { dbError: error });
      await zetOntvangers(env.id, ont.lijst);
      await audit(env.id, 'aangemaakt', { titel, volgorde, ontvangers: ont.lijst.map((o) => o.email) });
      return res.status(201).json({ envelope: samenvatting(await laadEnvelope(supabaseAdmin, env.id)) });
    }

    const id = String(b.id || '');
    if (!UUID_RE.test(id)) return fout(res, 400, 'Ongeldig envelope-id');
    const pakket = await laadEnvelope(supabaseAdmin, id);
    if (!pakket) return fout(res, 404, 'Envelope niet gevonden');
    const { envelope } = pakket;
    const isConcept = envelope.status === 'concept';

    if (actie === 'bijwerken') {
      if (!isConcept) return fout(res, 409, 'Alleen een concept kan gewijzigd worden.');
      const patch = {};
      if (b.titel !== undefined) { const t = String(b.titel || '').trim().slice(0, 200); if (!t) return fout(res, 400, 'Titel is verplicht', { field: 'titel' }); patch.titel = t; }
      if (b.bericht !== undefined) patch.bericht = String(b.bericht || '').trim().slice(0, 2000) || null;
      if (b.volgorde !== undefined) patch.volgorde = b.volgorde === 'parallel' ? 'parallel' : 'sequentieel';
      if (b.entiteit !== undefined) { const ent = entiteitUit(b); if (!ent) return fout(res, 400, 'Ongeldige koppeling'); Object.assign(patch, ent); }
      if (Object.keys(patch).length) {
        const { error } = await supabaseAdmin.from('esign_envelopes').update(patch).eq('id', id).eq('status', 'concept');
        if (error) throw error;
      }
      if (b.ontvangers !== undefined) {
        const ont = await ontvangersUitProfielen(b.ontvangers);
        if (ont.fout) return fout(res, 400, ont.fout, { field: 'ontvangers' });
        await zetOntvangers(id, ont.lijst);
      }
      return res.status(200).json({ envelope: samenvatting(await laadEnvelope(supabaseAdmin, id)) });
    }

    if (actie === 'upload_url') {
      if (!isConcept) return fout(res, 409, 'Alleen in een concept kun je het document vervangen.');
      const pad = `envelopes/${id}/origineel-${Date.now()}.pdf`;
      const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(pad);
      if (error) {
        if (/bucket/i.test(error.message || '')) return fout(res, 503, 'De opslag-bucket e-handtekening ontbreekt (SQL-migratie).', { code: 'MIGRATIE_NODIG' });
        throw error;
      }
      return res.status(200).json({ pad, signed_url: data.signedUrl, token: data.token, bucket: BUCKET });
    }

    if (actie === 'document_registreren') {
      if (!isConcept) return fout(res, 409, 'Alleen in een concept kun je het document vervangen.');
      const pad = String(b.pad || '');
      if (!pad.startsWith(`envelopes/${id}/origineel-`) || !pad.endsWith('.pdf') || pad.includes('..')) return fout(res, 400, 'Ongeldig pad');
      const naam = String(b.naam || 'document.pdf').trim().slice(0, 200) || 'document.pdf';
      let bytes;
      try { bytes = await downloadBytes(supabaseAdmin, pad); } catch (e) { return fout(res, 400, 'Upload niet gevonden. Probeer opnieuw.'); }
      const weg = async () => { await supabaseAdmin.storage.from(BUCKET).remove([pad]).catch(() => {}); };
      if (bytes.length > MAX_PDF_BYTES) { await weg(); return fout(res, 400, 'De PDF is groter dan 25 MB.'); }
      if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') { await weg(); return fout(res, 400, 'Dit bestand is geen PDF.'); }
      let paginas;
      try { paginas = await leesPaginas(bytes); }
      catch (e) { await weg(); return fout(res, 400, /encrypt/i.test(e?.message || '') ? 'De PDF is beveiligd met een wachtwoord. Upload een onbeveiligde versie.' : 'De PDF kan niet gelezen worden.'); }
      if (!paginas.length) { await weg(); return fout(res, 400, 'De PDF heeft geen pagina\'s.'); }
      // Vorig document (en zijn velden) weg.
      for (const d of pakket.documenten) {
        const r1 = await supabaseAdmin.from('esign_velden').delete().eq('document_id', d.id); if (r1.error) throw r1.error;
        const r2 = await supabaseAdmin.from('esign_documenten').delete().eq('id', d.id); if (r2.error) throw r2.error;
        await supabaseAdmin.storage.from(BUCKET).remove([d.pad]).catch(() => {});
      }
      const { data: doc, error } = await supabaseAdmin.from('esign_documenten').insert({
        envelope_id: id, volgnummer: 1, naam, pad, sha256: sha256Hex(bytes), grootte_bytes: bytes.length, paginas,
      }).select('*').single();
      if (error) throw error;
      return res.status(200).json({ document: { id: doc.id, naam: doc.naam, sha256: doc.sha256, paginas: doc.paginas, grootte_bytes: doc.grootte_bytes } });
    }

    if (actie === 'velden_opslaan') {
      if (!isConcept) return fout(res, 409, 'Alleen in een concept kun je velden wijzigen.');
      const v = valideerVeldDefinities(b.velden, pakket);
      if (!v.ok) return fout(res, 400, v.fout);
      const r1 = await supabaseAdmin.from('esign_velden').delete().eq('envelope_id', id);
      if (r1.error) throw r1.error;
      if (v.velden.length) {
        const r2 = await supabaseAdmin.from('esign_velden').insert(v.velden.map((x) => ({ ...x, envelope_id: id })));
        if (r2.error) throw r2.error;
      }
      return res.status(200).json({ envelope: samenvatting(await laadEnvelope(supabaseAdmin, id)) });
    }

    if (actie === 'versturen') {
      const problemen = klaarOmTeVersturen(pakket);
      if (problemen.length) return fout(res, 400, problemen[0], { problemen });
      const nu = new Date().toISOString();
      const { data: claim, error } = await supabaseAdmin.from('esign_envelopes')
        .update({ status: 'verzonden', verzonden_op: nu }).eq('id', id).eq('status', 'concept').select('*');
      if (error) throw error;
      if (!claim || claim.length === 0) return fout(res, 409, 'Deze envelope is al verstuurd.');
      await audit(id, 'verzonden', { volgorde: envelope.volgorde, document_sha256: pakket.documenten[0].sha256 });
      const vers = await laadEnvelope(supabaseAdmin, id);
      const uitnodigingen = await nodigVolgendeUit(supabaseAdmin, { pakket: vers, afzender: ik.naam, req, actor_id: ik.id, methode: 'crm_login', mail: sendMail });
      return res.status(200).json({ envelope: samenvatting(await laadEnvelope(supabaseAdmin, id)), uitnodigingen });
    }

    if (actie === 'opnieuw_versturen') {
      if (!ACTIEF.includes(envelope.status)) return fout(res, 409, 'Alleen een lopende envelope kan opnieuw verstuurd worden.');
      const resultaat = await verstuurOpnieuw(supabaseAdmin, { pakket, afzender: ik.naam, req, actor_id: ik.id, mail: sendMail });
      return res.status(200).json({ envelope: samenvatting(await laadEnvelope(supabaseAdmin, id)), uitnodigingen: resultaat });
    }

    if (actie === 'intrekken') {
      if (!['concept', ...ACTIEF].includes(envelope.status)) return fout(res, 409, 'Deze envelope kan niet meer ingetrokken worden.');
      if (envelope.afronden_gestart_op) return fout(res, 409, 'De envelope wordt net afgerond.');
      const reden = String(b.reden || '').trim().slice(0, 500) || null;
      const { data: upd, error } = await supabaseAdmin.from('esign_envelopes').update({
        status: 'ingetrokken', ingetrokken_op: new Date().toISOString(), ingetrokken_door: ik.id, ingetrokken_reden: reden,
      }).eq('id', id).in('status', ['concept', ...ACTIEF]).is('afronden_gestart_op', null).select('id');
      if (error) throw error;
      if (!upd || upd.length === 0) return fout(res, 409, 'De status veranderde net; vernieuw en probeer opnieuw.');
      // Links werken meteen niet meer: de tekenroute weigert elke niet-actieve envelope.
      await audit(id, 'ingetrokken', { reden });
      return res.status(200).json({ envelope: samenvatting(await laadEnvelope(supabaseAdmin, id)) });
    }

    if (actie === 'afronden') {
      if (envelope.status === 'voltooid') return fout(res, 409, 'Al voltooid.');
      const r = await rondAf(supabaseAdmin, id, { mail: sendMail });
      if (!r.ok) return fout(res, r.overgeslagen ? 409 : 500, r.overgeslagen || r.fout);
      return res.status(200).json({ ok: true, sha256: r.sha256, mails: r.mails });
    }

    return fout(res, 400, 'Onbekende actie');
  } catch (e) {
    return migratieOfFout(res, e, actie || 'esign');
  }
}

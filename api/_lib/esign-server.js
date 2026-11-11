// api/_lib/esign-server.js
//
// E-handtekening — IO rond de pure regels van esign-core.js: envelope laden,
// audit-events schrijven, uitnodigen (token + mail) en afronden (PDF inbranden,
// opslaan, hashen, mailen). Gebruikt door api/esign.js (CRM) en
// api/esign-teken.js (publieke tekenpagina).
//
// Elke functie krijgt `db` (supabaseAdmin) en optioneel `mail` (sendMail) mee,
// zodat tests een nep-database en nep-mail kunnen geven.

import { BUCKET, maakToken, aanDeBeurt, iedereenGetekend, sha256Hex, teUitnodigen } from './esign-core.js';
import { maakGetekendePdf } from './esign-pdf.js';
import { uitnodigingMail, voltooidMail, getekendBestandsnaam } from './esign-mail.js';
import { extractClientIp } from './assessment-validation.js';

export const MIGRATIE_CODES = new Set(['42P01', 'PGRST205', '42703', 'PGRST204']);
export function isMigratieFout(error) {
  return !!error && (MIGRATIE_CODES.has(error.code) || /esign_\w+.*(does not exist|not find)/i.test(String(error.message || '')));
}

export function verzoekInfo(req) {
  if (!req || !req.headers) return { ip: null, user_agent: null };
  const ua = String(req?.headers?.['user-agent'] || '').slice(0, 500) || null;
  return { ip: extractClientIp(req) || null, user_agent: ua };
}

/** Basis-URL voor de links in de mail: env, anders de preview-URL, anders het CRM-domein. */
export function basisUrl(env = process.env) {
  if (env.ESIGN_BASIS_URL) return String(env.ESIGN_BASIS_URL).replace(/\/+$/, '');
  if (env.VERCEL_ENV === 'preview' && env.VERCEL_BRANCH_URL) return `https://${env.VERCEL_BRANCH_URL}`;
  return 'https://crm.deforexopleiding.nl';
}
export function tekenLink(token, env = process.env) {
  // Token in de #-hash: gaat niet mee in Referer, server- of proxylogs.
  return `${basisUrl(env)}/teken#t=${token}`;
}

// ── Laden ───────────────────────────────────────────────────────────────────

export async function laadEnvelope(db, id) {
  const { data: envelope, error } = await db.from('esign_envelopes').select('*').eq('id', id).maybeSingle();
  if (error) throw Object.assign(new Error('envelope: ' + error.message), { dbError: error });
  if (!envelope) return null;
  const [d, o, v] = await Promise.all([
    db.from('esign_documenten').select('*').eq('envelope_id', id).order('volgnummer'),
    db.from('esign_ontvangers').select('*').eq('envelope_id', id).order('volgnummer'),
    db.from('esign_velden').select('*').eq('envelope_id', id).order('pagina').order('y'),
  ]);
  for (const [naam, r] of [['documenten', d], ['ontvangers', o], ['velden', v]]) {
    if (r.error) throw Object.assign(new Error(naam + ': ' + r.error.message), { dbError: r.error });
  }
  return { envelope, documenten: d.data || [], ontvangers: o.data || [], velden: v.data || [] };
}

export async function laadEvents(db, envelopeId) {
  const { data, error } = await db.from('esign_events').select('*').eq('envelope_id', envelopeId).order('tijdstip').order('id');
  if (error) throw new Error('events: ' + error.message);
  return data || [];
}

// ── Audit ───────────────────────────────────────────────────────────────────

/** Schrijft één audit-event. Gooit bij een fout: zonder audit geen actie. */
export async function logEvent(db, { envelope_id, ontvanger_id = null, type, methode, actor_id = null, ip = null, user_agent = null, details = {} }) {
  const { error } = await db.from('esign_events').insert({
    envelope_id, ontvanger_id, type, methode, actor_id, ip, user_agent, details,
  });
  if (error) throw new Error(`audit-event ${type}: ${error.message}`);
}

// ── Uitnodigen ──────────────────────────────────────────────────────────────

/**
 * Nieuw token + mail voor één ontvanger. Een eventueel oud token vervalt meteen
 * (de hash wordt overschreven). Een mislukte mail laat het token staan: dan kan
 * "opnieuw versturen" het later nog eens proberen.
 * @returns {Promise<{ ok:boolean, mail_ok:boolean, fout?:string }>}
 */
export async function nodigUit(db, { envelope, ontvanger, afzender, opnieuw = false, req, actor_id = null, methode = 'crm_login', mail, nu = new Date(), env = process.env }) {
  const t = maakToken(nu);
  const patch = {
    token_hash: t.hash,
    token_verloopt_op: t.verloopt_op,
    uitgenodigd_op: nu.toISOString(),
    ...(ontvanger.status === 'wacht' ? { status: 'uitgenodigd' } : {}),
  };
  const { data: upd, error } = await db.from('esign_ontvangers').update(patch)
    .eq('id', ontvanger.id).neq('status', 'getekend').select('id');
  if (error) return { ok: false, mail_ok: false, fout: 'token opslaan: ' + error.message };
  if (!upd || upd.length === 0) return { ok: false, mail_ok: false, fout: 'ontvanger heeft al getekend' };

  const m = uitnodigingMail({ envelope, ontvanger, link: tekenLink(t.token, env), afzender, verlooptOp: t.verloopt_op, opnieuw });
  let mailOk = false; let mailFout = null;
  try {
    const r = await mail({ to: ontvanger.email, subject: m.subject, html: m.html, text: m.text });
    mailOk = !!r?.success; if (!mailOk) mailFout = r?.error || 'onbekend';
  } catch (e) { mailFout = e?.message || String(e); }
  if (!mailOk) console.error('[esign] uitnodiging mislukt:', ontvanger.email, mailFout);

  const info = verzoekInfo(req);
  await logEvent(db, {
    envelope_id: envelope.id, ontvanger_id: ontvanger.id,
    type: mailOk ? (opnieuw ? 'opnieuw_verzonden' : 'uitgenodigd') : 'mail_mislukt',
    methode, actor_id, ...info,
    details: { email: ontvanger.email, token_verloopt_op: t.verloopt_op, ...(mailFout ? { fout: String(mailFout).slice(0, 300) } : {}) },
  });
  return { ok: true, mail_ok: mailOk, ...(mailFout ? { fout: mailFout } : {}) };
}

/** Nodig iedereen uit die nu aan de beurt is en nog geen uitnodiging had. */
export async function nodigVolgendeUit(db, { pakket, afzender, req, actor_id = null, methode, mail }) {
  const uit = [];
  for (const o of teUitnodigen(pakket.ontvangers, pakket.envelope.volgorde)) {
    try {
      uit.push({ ontvanger_id: o.id, ...(await nodigUit(db, { envelope: pakket.envelope, ontvanger: o, afzender, req, actor_id, methode, mail })) });
    } catch (e) {
      console.error('[esign] uitnodigen mislukt:', o.id, e?.message || e);
      uit.push({ ontvanger_id: o.id, ok: false, mail_ok: false, fout: e?.message || String(e) });
    }
  }
  return uit;
}

/** "Opnieuw versturen": nieuwe link voor wie nu aan de beurt is. */
export async function verstuurOpnieuw(db, { pakket, afzender, req, actor_id, mail }) {
  const uit = [];
  for (const o of aanDeBeurt(pakket.ontvangers, pakket.envelope.volgorde)) {
    try {
      uit.push({ ontvanger_id: o.id, ...(await nodigUit(db, { envelope: pakket.envelope, ontvanger: o, afzender, opnieuw: true, req, actor_id, mail })) });
    } catch (e) {
      console.error('[esign] opnieuw versturen mislukt:', o.id, e?.message || e);
      uit.push({ ontvanger_id: o.id, ok: false, mail_ok: false, fout: e?.message || String(e) });
    }
  }
  return uit;
}

// ── Opslag ──────────────────────────────────────────────────────────────────

export async function downloadBytes(db, pad) {
  const { data, error } = await db.storage.from(BUCKET).download(pad);
  if (error || !data) throw new Error(`download ${pad}: ${error?.message || 'leeg'}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function signedUrl(db, pad, seconden = 300) {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(pad, seconden);
  if (error || !data?.signedUrl) throw new Error(`signed url ${pad}: ${error?.message || 'leeg'}`);
  return data.signedUrl;
}

// ── Afronden ────────────────────────────────────────────────────────────────

/**
 * Als iedereen getekend heeft: één definitieve PDF (ingebrand + certificaat),
 * SHA-256, opslaan, envelope 'voltooid', mailen naar alle partijen.
 * Claimt eerst atomair (afronden_gestart_op), zodat twee gelijktijdige laatste
 * handtekeningen nooit twee eindversies maken. Bij een fout wordt de claim
 * vrijgegeven en is "Afronden opnieuw proberen" in het CRM mogelijk.
 * @returns {Promise<{ ok:boolean, overgeslagen?:string, sha256?:string, mails?:object[], fout?:string }>}
 */
export async function rondAf(db, envelopeId, { mail, nu = () => new Date() } = {}) {
  const start = nu().toISOString();
  const { data: claim, error: cErr } = await db.from('esign_envelopes')
    .update({ afronden_gestart_op: start, afronden_fout: null })
    .eq('id', envelopeId).is('afronden_gestart_op', null).in('status', ['verzonden', 'deels_getekend'])
    .select('id');
  if (cErr) return { ok: false, fout: 'claim: ' + cErr.message };
  if (!claim || claim.length === 0) return { ok: false, overgeslagen: 'al bezig of niet actief' };

  try {
    const pakket = await laadEnvelope(db, envelopeId);
    if (!iedereenGetekend(pakket.ontvangers)) {
      await db.from('esign_envelopes').update({ afronden_gestart_op: null }).eq('id', envelopeId);
      return { ok: false, overgeslagen: 'nog niet iedereen getekend' };
    }
    const doc = pakket.documenten[0];
    const origineel = await downloadBytes(db, doc.pad);
    if (sha256Hex(origineel) !== doc.sha256) throw new Error('origineel is gewijzigd sinds het uploaden (hash klopt niet)');

    const beelden = new Map();
    for (const v of pakket.velden) {
      if ((v.type !== 'handtekening' && v.type !== 'paraaf') || !v.waarde) continue;
      const per = beelden.get(v.ontvanger_id) || {};
      if (!per[v.type]) per[v.type] = Buffer.from(await downloadBytes(db, v.waarde));
      beelden.set(v.ontvanger_id, per);
    }
    const voltooidOp = nu().toISOString();
    const envelope = { ...pakket.envelope, voltooid_op: voltooidOp };
    const events = await laadEvents(db, envelopeId);
    events.push({ type: 'voltooid', tijdstip: voltooidOp, methode: 'systeem', ip: null, ontvanger_id: null, details: {} });

    const bytes = await maakGetekendePdf({ origineel, document: doc, envelope, ontvangers: pakket.ontvangers, velden: pakket.velden, beelden, events });
    const hash = sha256Hex(bytes);
    const pad = `envelopes/${envelopeId}/getekend.pdf`;
    const { error: upErr } = await db.storage.from(BUCKET).upload(pad, Buffer.from(bytes), { contentType: 'application/pdf', upsert: false });
    if (upErr && !/exists|duplicate/i.test(upErr.message || '')) throw new Error('upload getekend: ' + upErr.message);
    if (upErr) {
      // Een eerdere poging zette het bestand al neer maar rondde niet af: vervang het.
      const { error: rErr } = await db.storage.from(BUCKET).update(pad, Buffer.from(bytes), { contentType: 'application/pdf' });
      if (rErr) throw new Error('vervang getekend: ' + rErr.message);
    }

    const { error: uErr } = await db.from('esign_envelopes').update({
      status: 'voltooid', voltooid_op: voltooidOp, eind_pad: pad, eind_sha256: hash, afronden_fout: null,
    }).eq('id', envelopeId);
    if (uErr) throw new Error('envelope voltooien: ' + uErr.message);
    await logEvent(db, { envelope_id: envelopeId, type: 'voltooid', methode: 'systeem', details: { sha256: hash, pad } });

    // Mailen: alle ondertekenaars + de aanmaker. Per persoon apart.
    const bestandsnaam = getekendBestandsnaam(envelope.titel);
    const partijen = new Map(pakket.ontvangers.map((o) => [o.email.toLowerCase(), o.naam]));
    if (envelope.aangemaakt_door) {
      const { data: p } = await db.from('profiles').select('email, full_name').eq('id', envelope.aangemaakt_door).maybeSingle();
      if (p?.email && !partijen.has(p.email.toLowerCase())) partijen.set(p.email.toLowerCase(), p.full_name || p.email);
    }
    const mails = [];
    for (const [email, naam] of partijen) {
      const m = voltooidMail({ envelope, naam, sha256: hash, bestandsnaam });
      try {
        const r = await mail({ to: email, subject: m.subject, html: m.html, text: m.text,
          attachments: [{ filename: bestandsnaam, content: Buffer.from(bytes), contentType: 'application/pdf' }] });
        mails.push({ email, ok: !!r?.success, ...(r?.success ? {} : { fout: r?.error || 'onbekend' }) });
        if (!r?.success) console.error('[esign] afrondingsmail mislukt:', email, r?.error);
      } catch (e) {
        console.error('[esign] afrondingsmail mislukt:', email, e?.message || e);
        mails.push({ email, ok: false, fout: e?.message || String(e) });
      }
    }
    const mislukt = mails.filter((m) => !m.ok);
    if (mislukt.length) {
      await logEvent(db, { envelope_id: envelopeId, type: 'mail_mislukt', methode: 'systeem', details: { soort: 'afronding', mislukt } })
        .catch((e) => console.error('[esign] audit mail_mislukt:', e?.message || e));
    }
    return { ok: true, sha256: hash, mails };
  } catch (e) {
    const fout = e?.message || String(e);
    console.error('[esign] afronden mislukt:', envelopeId, fout);
    await db.from('esign_envelopes').update({ afronden_gestart_op: null, afronden_fout: fout.slice(0, 500) }).eq('id', envelopeId);
    try { await logEvent(db, { envelope_id: envelopeId, type: 'afronden_mislukt', methode: 'systeem', details: { fout: fout.slice(0, 500) } }); }
    catch (e2) { console.error('[esign] audit afronden_mislukt:', e2?.message || e2); }
    return { ok: false, fout };
  }
}

// api/esign-teken.js — E-handtekening, publieke tekenroute (fase 1, 2026-11-09)
//
// Geen login: de sleutel is het persoonlijke token uit de uitnodigingsmail
// (32 willekeurige bytes; in de DB staat alleen de SHA-256). De tekenpagina
// (/teken) leest het token uit de #-hash en stuurt het in de BODY mee — nooit
// in de URL, dus niet in logs of Referer.
//
// POST { actie: 'open',  token }  → document (signed URL 10 min) + eigen velden
// POST { actie: 'teken', token, akkoord: true, waarden, handtekening, paraaf }
//
// Beveiliging:
//   - rate limit per IP: open 30/min, teken 10 per 10 min (checkRateLimit);
//   - onbekend en verlopen token geven HETZELFDE antwoord (geen orakel);
//   - alleen een envelope met status verzonden/deels_getekend is te openen;
//     ingetrokken = 410;
//   - sequentieel: tekenen pas als alle eerdere ondertekenaars getekend hebben;
//   - IP + user-agent uit het verzoek van de ONDERTEKENAAR (x-real-ip van
//     Vercel), vastgelegd in esign_events (alleen toevoegen).

import { supabaseAdmin } from './supabase.js';
import { sendMail } from './mailer.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { BUCKET, ACTIEF, hashToken, tokenVorm, magTekenen, valideerInvulling, iedereenGetekend, statusUitOntvangers } from './_lib/esign-core.js';
import { laadEnvelope, logEvent, verzoekInfo, nodigVolgendeUit, rondAf, signedUrl, isMigratieFout } from './_lib/esign-server.js';

const ONGELDIG = 'Deze link is ongeldig of verlopen. Vraag de afzender om een nieuwe link.';

function fout(res, status, error, extra = {}) { return res.status(status).json({ error, ...extra }); }

/** Token → { pakket, ontvanger } of een HTTP-fout. */
async function zoekOntvanger(token) {
  if (!tokenVorm(token)) return { status: 404, error: ONGELDIG };
  const { data: o, error } = await supabaseAdmin.from('esign_ontvangers').select('id, envelope_id, token_verloopt_op')
    .eq('token_hash', hashToken(token)).maybeSingle();
  if (error) {
    if (isMigratieFout(error)) return { status: 503, error: 'Ondertekenen is tijdelijk niet beschikbaar.' };
    console.error('[esign-teken] token lookup:', error.message);
    return { status: 500, error: 'Er ging iets mis. Probeer het zo opnieuw.' };
  }
  if (!o || !o.token_verloopt_op || new Date(o.token_verloopt_op).getTime() < Date.now()) return { status: 404, error: ONGELDIG };
  const pakket = await laadEnvelope(supabaseAdmin, o.envelope_id);
  if (!pakket) return { status: 404, error: ONGELDIG };
  if (pakket.envelope.status === 'ingetrokken') return { status: 410, error: 'Dit document is ingetrokken door de afzender. Je hoeft niets meer te doen.' };
  const ontvanger = pakket.ontvangers.find((x) => x.id === o.id);
  if (!ontvanger) return { status: 404, error: ONGELDIG };
  return { pakket, ontvanger };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return fout(res, 405, 'Methode niet toegestaan'); }
  const b = req.body || {};
  const actie = String(b.actie || '');
  if (actie !== 'open' && actie !== 'teken') return fout(res, 400, 'Onbekende actie');

  const rl = await checkRateLimit(actie === 'open'
    ? { req, bucket: 'esign-open', maxHits: 30, withinSeconds: 60 }
    : { req, bucket: 'esign-teken', maxHits: 10, withinSeconds: 600 });
  if (rl.limited) return fout(res, 429, 'Te veel pogingen. Wacht even en probeer het opnieuw.');

  try {
    const z = await zoekOntvanger(String(b.token || ''));
    if (z.error) return fout(res, z.status, z.error);
    const { pakket, ontvanger } = z;
    const { envelope } = pakket;
    const info = verzoekInfo(req);
    const eigenVelden = pakket.velden.filter((v) => v.ontvanger_id === ontvanger.id);

    if (actie === 'open') {
      const actief = ACTIEF.includes(envelope.status);
      const kan = actief && magTekenen(ontvanger, pakket.ontvangers, envelope.volgorde);
      if (actief && ontvanger.status !== 'getekend') {
        await logEvent(supabaseAdmin, { envelope_id: envelope.id, ontvanger_id: ontvanger.id, type: 'geopend', methode: 'email_token_link', ...info });
        if (!ontvanger.geopend_op || ontvanger.status === 'uitgenodigd') {
          const { error } = await supabaseAdmin.from('esign_ontvangers')
            .update({ status: 'geopend', ...(ontvanger.geopend_op ? {} : { geopend_op: new Date().toISOString() }) })
            .eq('id', ontvanger.id).eq('status', 'uitgenodigd');
          if (error) console.error('[esign-teken] geopend zetten:', error.message);
        }
      }
      const doc = pakket.documenten[0];
      const getekendEerst = pakket.ontvangers.filter((o) => o.volgnummer < ontvanger.volgnummer && o.status !== 'getekend');
      return res.status(200).json({
        envelope: { titel: envelope.titel, bericht: envelope.bericht, status: envelope.status, volgorde: envelope.volgorde },
        ontvanger: { naam: ontvanger.naam, email: ontvanger.email, status: ontvanger.status },
        mag_tekenen: kan && ontvanger.status !== 'getekend',
        reden: ontvanger.status === 'getekend' ? 'al_getekend'
          : envelope.status === 'voltooid' ? 'voltooid'
            : !kan && envelope.volgorde === 'sequentieel' && getekendEerst.length ? 'wacht_op_anderen' : null,
        ondertekenaars: pakket.ontvangers.map((o) => ({ naam: o.naam, status: o.status === 'getekend' ? 'getekend' : 'open', ik: o.id === ontvanger.id })),
        document: doc && ontvanger.status !== 'getekend' && kan
          ? { naam: doc.naam, url: await signedUrl(supabaseAdmin, doc.pad, 600), paginas: doc.paginas }
          : null,
        velden: kan ? eigenVelden.map((v) => ({
          id: v.id, type: v.type, pagina: v.pagina, x: Number(v.x), y: Number(v.y),
          breedte: Number(v.breedte), hoogte: Number(v.hoogte), verplicht: v.verplicht,
        })) : [],
      });
    }

    // ── teken ──────────────────────────────────────────────────────────────
    if (!ACTIEF.includes(envelope.status)) return fout(res, 409, 'Dit document kan niet meer ondertekend worden.');
    if (ontvanger.status === 'getekend') return fout(res, 409, 'Je hebt dit document al ondertekend.', { code: 'AL_GETEKEND' });
    if (!magTekenen(ontvanger, pakket.ontvangers, envelope.volgorde)) return fout(res, 409, 'Je bent nog niet aan de beurt.');

    const nu = new Date();
    const v = valideerInvulling(eigenVelden, b, ontvanger, nu);
    if (!v.ok) return fout(res, 400, v.fout, v.veld_id ? { veld_id: v.veld_id } : {});

    // 1) Beelden opslaan (vóór de claim: mislukt de opslag, dan is er niets getekend).
    const beeldPad = {};
    for (const [soort, beeld] of Object.entries(v.beelden)) {
      const pad = `envelopes/${envelope.id}/handtekeningen/${ontvanger.id}-${soort}.png`;
      const { error } = await supabaseAdmin.storage.from(BUCKET).upload(pad, beeld.png, { contentType: 'image/png', upsert: true });
      if (error) { console.error('[esign-teken] beeld opslaan:', error.message); return fout(res, 500, 'Je handtekening kon niet opgeslagen worden. Probeer het opnieuw.'); }
      beeldPad[soort] = pad;
    }

    // 2) Atomaire claim: alleen wie nog niet getekend heeft.
    const { data: claim, error: cErr } = await supabaseAdmin.from('esign_ontvangers').update({
      status: 'getekend', getekend_op: nu.toISOString(),
      handtekening_methode: v.beelden.handtekening?.methode || null,
      paraaf_methode: v.beelden.paraaf?.methode || null,
    }).eq('id', ontvanger.id).in('status', ['uitgenodigd', 'geopend']).select('id');
    if (cErr) { console.error('[esign-teken] claim:', cErr.message); return fout(res, 500, 'Er ging iets mis. Probeer het opnieuw.'); }
    if (!claim || claim.length === 0) return fout(res, 409, 'Je hebt dit document al ondertekend.', { code: 'AL_GETEKEND' });

    // 3) Waarden in de velden.
    try {
      for (const veld of eigenVelden) {
        const waarde = veld.type === 'handtekening' || veld.type === 'paraaf' ? beeldPad[veld.type] : v.waarden.get(veld.id);
        const { error } = await supabaseAdmin.from('esign_velden').update({ waarde: waarde ?? null, ingevuld_op: nu.toISOString() }).eq('id', veld.id);
        if (error) throw new Error(error.message);
      }
    } catch (e) {
      console.error('[esign-teken] velden opslaan:', e?.message || e);
      await supabaseAdmin.from('esign_ontvangers').update({ status: 'geopend', getekend_op: null, handtekening_methode: null, paraaf_methode: null }).eq('id', ontvanger.id);
      return fout(res, 500, 'Je handtekening kon niet opgeslagen worden. Probeer het opnieuw.');
    }

    // 4) Audit.
    await logEvent(supabaseAdmin, {
      envelope_id: envelope.id, ontvanger_id: ontvanger.id, type: 'getekend', methode: 'email_token_link', ...info,
      details: {
        akkoord_elektronisch: true,
        handtekening_methode: v.beelden.handtekening?.methode || null,
        paraaf_methode: v.beelden.paraaf?.methode || null,
        velden: eigenVelden.length,
        document_sha256: pakket.documenten[0]?.sha256 || null,
      },
    });

    // 5) Volgende stap: afronden, of status bijwerken + de volgende uitnodigen.
    const vers = await laadEnvelope(supabaseAdmin, envelope.id);
    let afgerond = null;
    if (iedereenGetekend(vers.ontvangers)) {
      afgerond = await rondAf(supabaseAdmin, envelope.id, { mail: sendMail });
    } else {
      const st = statusUitOntvangers(vers.ontvangers);
      if (st !== vers.envelope.status) {
        const { error } = await supabaseAdmin.from('esign_envelopes').update({ status: st }).eq('id', envelope.id).in('status', ACTIEF);
        if (error) console.error('[esign-teken] status bijwerken:', error.message);
      }
      // Methode 'systeem' zonder req: het IP van deze ondertekenaar hoort niet bij de uitnodiging van de volgende.
      await nodigVolgendeUit(supabaseAdmin, { pakket: vers, afzender: null, req: null, methode: 'systeem', mail: sendMail });
    }
    return res.status(200).json({ ok: true, voltooid: !!afgerond?.ok });
  } catch (e) {
    if (isMigratieFout(e?.dbError || e)) return fout(res, 503, 'Ondertekenen is tijdelijk niet beschikbaar.');
    console.error('[esign-teken]', actie, e?.message || e);
    return fout(res, 500, 'Er ging iets mis. Probeer het zo opnieuw.');
  }
}

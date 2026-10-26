/**
 * Massa-WhatsApp: reactie op de knoppen van een massa-template afhandelen
 * (bv. `massa_aanbod`: "Ja, stuur maar" / "Nu even niet").
 *
 * Een knopantwoord komt binnen via de Meta-webhook (api/inbox-webhook.js) met
 * `msg.context.id` = de wamid van de verzonden template = `massa_items.extern_id`.
 * Daarmee vinden we het item + de campagne, en dan:
 *   "Ja"           → vervolgtekst van de campagne (free-form, binnen het
 *                    24-uursvenster dat de klant zelf net opende) met
 *                    {{voornaam}} + {{link}};
 *   "Nu even niet" → korte afsluiting + leads.wa_nu_niet_op (volgende
 *                    massa-WhatsApps slaan de lead over);
 *   stop/afmelden  → alleen markeren, géén bericht terug.
 * Per item telt alleen de EERSTE reactie (atomaire claim op reactie IS NULL),
 * dus een tweede klik of een Meta-retry stuurt niets dubbel.
 *
 * Fail-soft: gooit nooit — de webhook mag hier niet op breken. Zonder de
 * migratie 2026-10-26-massa-wa-reacties.sql doet dit niets.
 */
import { sendText } from './meta-whatsapp.js';
import { logOutboundWa } from './wa-outbound-log.js';

// Free-form mag alleen binnen 24 uur na het laatste bericht van de klant. Kleine
// marge zodat een vertraagde webhook nooit nét buiten het venster verstuurt.
const VENSTER_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;

export const STANDAARD_VERVOLG_JA = 'Top, {{voornaam}}! Hier is alles over het gratis webinar: {{link}} Je kunt je daar direct aanmelden. Tot dan!';
export const STANDAARD_VERVOLG_NEE = 'Helemaal goed, {{voornaam}}. We sturen je hierover niets meer. Fijne dag!';

const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFKD').replace(/\p{M}+/gu, '')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Knoptekst/payload → 'ja' | 'nee' | 'stop' | null. PURE.
 * Onbekende knoppen (of vrije tekst) → null: die laten we aan de inbox.
 */
export function herkenReactie(...teksten) {
  for (const t of teksten.map(norm).filter(Boolean)) {
    if (/^(stop|afmelden|uitschrijven|unsubscribe)\b/.test(t) || /\bstop (promoties|promotions|marketing)\b/.test(t)) return 'stop';
    if (/\bnu (even )?niet\b/.test(t) || /^(nee|niet|liever niet|geen interesse)\b/.test(t)) return 'nee';
    if (/^(ja|jazeker|graag|yes)\b/.test(t)) return 'ja';
  }
  return null;
}

/**
 * Plaatshouders invullen. PURE. Zonder voornaam verdwijnt ", {{voornaam}}"
 * netjes ("Top!" i.p.v. "Top, !").
 */
export function vulVervolg(tekst, { voornaam = '', link = '' } = {}) {
  const vn = String(voornaam || '').trim().split(/\s+/)[0] || '';
  let uit = String(tekst || '')
    .replace(/\{\{\s*voornaam\s*\}\}/gi, vn)
    .replace(/\{\{\s*link\s*\}\}/gi, String(link || '').trim());
  if (!vn) uit = uit.replace(/,\s*(?=[!.?])/g, '').replace(/,\s*,/g, ',');
  return uit.replace(/[ \t]{2,}/g, ' ').replace(/ +([!.?,])/g, '$1').trim();
}

const kolomOntbreekt = (e) => ['42703', 'PGRST204', 'PGRST200', '42P01'].includes(String(e?.code || ''));

/**
 * @param {object} sb  supabase (service role)
 * @param {object} p   { contextWamid, tekst, payload, telefoon (+E.164), phoneNumberId, ontvangenOp (Date) }
 * @param {object} [o] test-injectie: { verstuur, log, nu }
 * -> { verwerkt, reactie?, vervolg_status?, reden? }
 */
export async function verwerkMassaReactie(sb, p = {}, o = {}) {
  const verstuur = o.verstuur || sendText;
  const log = o.log || logOutboundWa;
  const nu = o.nu || new Date();
  try {
    const contextWamid = String(p.contextWamid || '').trim();
    if (!contextWamid) return { verwerkt: false, reden: 'geen_context' };
    const reactie = herkenReactie(p.payload, p.tekst);
    if (!reactie) return { verwerkt: false, reden: 'onbekende_knop' };

    const { data: item, error: iErr } = await sb.from('massa_items')
      .select('id, campagne_id, lead_id, reactie')
      .eq('kanaal', 'whatsapp').eq('extern_id', contextWamid).maybeSingle();
    if (iErr) {
      if (kolomOntbreekt(iErr)) return { verwerkt: false, reden: 'migratie_nodig' };
      console.error('[massa-wa-reactie] item zoeken mislukt:', iErr.message);
      return { verwerkt: false, reden: 'fout' };
    }
    if (!item) return { verwerkt: false, reden: 'geen_massa_bericht' };
    if (item.reactie) return { verwerkt: false, reden: 'al_gereageerd', reactie: item.reactie };

    // Atomaire claim: alleen de eerste reactie wint.
    const { data: claim, error: cErr } = await sb.from('massa_items')
      .update({ reactie, reactie_op: nu.toISOString(), vervolg_status: 'bezig' })
      .eq('id', item.id).is('reactie', null).select('id');
    if (cErr) {
      if (kolomOntbreekt(cErr)) return { verwerkt: false, reden: 'migratie_nodig' };
      console.error('[massa-wa-reactie] claim mislukt:', cErr.message);
      return { verwerkt: false, reden: 'fout' };
    }
    if (!claim || !claim.length) return { verwerkt: false, reden: 'al_gereageerd' };

    const zet = async (patch) => {
      const { error } = await sb.from('massa_items').update(patch).eq('id', item.id);
      if (error) console.error('[massa-wa-reactie] item bijwerken mislukt:', { item: item.id, fout: error.message });
    };

    // "Nu even niet" / stop → lead markeren (eerste keer telt).
    if ((reactie === 'nee' || reactie === 'stop') && item.lead_id) {
      const { error } = await sb.from('leads').update({ wa_nu_niet_op: nu.toISOString() })
        .eq('id', item.lead_id).is('wa_nu_niet_op', null);
      if (error) console.error('[massa-wa-reactie] wa_nu_niet_op zetten mislukt:', { lead: item.lead_id, fout: error.message });
    }
    if (reactie === 'stop') {
      await zet({ vervolg_status: 'geen_tekst' });
      return { verwerkt: true, reactie, vervolg_status: 'geen_tekst' };
    }

    const { data: camp, error: kErr } = await sb.from('massa_campagnes')
      .select('wa_vervolg_ja, wa_vervolg_ja_link, wa_vervolg_nee').eq('id', item.campagne_id).maybeSingle();
    if (kErr) console.error('[massa-wa-reactie] campagne lezen mislukt:', { campagne: item.campagne_id, fout: kErr.message });
    const sjabloon = String((reactie === 'ja' ? camp?.wa_vervolg_ja : camp?.wa_vervolg_nee) || '').trim();
    const link = String(camp?.wa_vervolg_ja_link || '').trim();
    if (!sjabloon || (/\{\{\s*link\s*\}\}/i.test(sjabloon) && !link)) {
      await zet({ vervolg_status: 'geen_tekst' });
      return { verwerkt: true, reactie, vervolg_status: 'geen_tekst' };
    }

    const ontvangen = p.ontvangenOp instanceof Date && !Number.isNaN(p.ontvangenOp.getTime()) ? p.ontvangenOp : nu;
    if (nu.getTime() - ontvangen.getTime() > VENSTER_MS) {
      await zet({ vervolg_status: 'buiten_venster' });
      return { verwerkt: true, reactie, vervolg_status: 'buiten_venster' };
    }

    let voornaam = '';
    if (item.lead_id) {
      const { data: lead, error: lErr } = await sb.from('leads').select('voornaam').eq('id', item.lead_id).maybeSingle();
      if (lErr) console.error('[massa-wa-reactie] lead lezen mislukt:', { lead: item.lead_id, fout: lErr.message });
      voornaam = lead?.voornaam || '';
    }
    const body = vulVervolg(sjabloon, { voornaam, link });

    try {
      const r = await verstuur({ to: p.telefoon, body, phoneNumberId: p.phoneNumberId });
      await zet({ vervolg_status: 'verstuurd', vervolg_op: nu.toISOString(), vervolg_fout: null });
      try {
        await log(sb, { toPhone: p.telefoon, phoneNumberId: p.phoneNumberId, body, wamid: r?.wamid || null, source: 'massa-vervolg' });
      } catch (e) {
        console.warn('[massa-wa-reactie] in de draad loggen mislukt (soft):', e?.message || e);
      }
      return { verwerkt: true, reactie, vervolg_status: 'verstuurd' };
    } catch (e) {
      const fout = String(e?.message || e).slice(0, 500);
      console.error('[massa-wa-reactie] vervolg versturen mislukt:', { item: item.id, fout });
      await zet({ vervolg_status: 'mislukt', vervolg_fout: fout });
      return { verwerkt: true, reactie, vervolg_status: 'mislukt' };
    }
  } catch (e) {
    console.error('[massa-wa-reactie] onverwacht:', e?.message || e);
    return { verwerkt: false, reden: 'fout' };
  }
}

// api/_lib/lisa-ig-stilte.js
//
// Stilte-alarm voor de Instagram-instroom van Lisa. Draait mee in
// api/cron-lisa-conversations-poll.js (elke 15 min) — geen eigen cron.
//
// ── WAAROM ──────────────────────────────────────────────────────────────────
// Van 8 tot en met 30 sep 2026 kwam er geen enkel nieuw IG-gesprek binnen
// (webhook liet alles zonder messageId vallen) en niemand merkte het: de
// poll-cron hield bestaande gesprekken wel bij, dus het scherm zag er "levend"
// uit. Twee signalen hadden het gevangen:
//
//   1. geen_ig_activiteit — géén nieuw (niet-sandbox) gesprek ÉN géén
//      inbound-bericht in de laatste X uur. Algemene stilte.
//   2. webhook_stil — de webhook heeft al X uur niets geaccepteerd
//      (lisa_settings.ghl_webhook_last_received_at), terwijl de poll intussen
//      wél nieuwere inbound-berichten vond. Dan komen berichten dus binnen
//      maar de webhook verwerkt ze niet → nieuwe contacten lopen weg. Dit is
//      precies het september-incident.
//
// ── NOOIT STIL "OK" ─────────────────────────────────────────────────────────
// Een meting die faalt is NIET GEMETEN, niet "geen stilte". Dan geen alarm
// (we weten het niet), maar wel een console.error.
//
// ── EEN KEER PER STORING ────────────────────────────────────────────────────
// Config + geheugen in app_settings[ALARM_KEY]:
//   { drempel_uren (48), throttle_uren (24), uit (false), gemeld_op, laatste_redenen }
// Melden mag pas weer na throttle_uren. Zodra de stilte voorbij is wordt
// gemeld_op gewist, zodat een volgende storing direct weer meldt.

import { supabaseAdmin } from '../supabase.js';

export const ALARM_KEY = 'lisa_ig_stilte_alarm';
export const DEFAULT_DREMPEL_UREN  = 48;
export const DEFAULT_THROTTLE_UREN = 24;

const UUR = 3600 * 1000;

function ms(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Pure beslisfunctie.
 *
 * @param {object} p
 * @param {number} p.nuMs
 * @param {string|null} p.laatsteNieuweConvIso   created_at nieuwste niet-sandbox gesprek
 * @param {string|null} p.laatsteInboundIso      sent_at nieuwste inbound (niet-sandbox)
 * @param {string|null} p.laatsteWebhookIso      lisa_settings.ghl_webhook_last_received_at
 * @param {number} [p.drempelUren]
 * @param {number} [p.throttleUren]
 * @param {string|null} [p.gemeldOpIso]
 * @param {boolean} [p.uit]
 * @returns {{ alarm: boolean, redenen: string[], magMelden: boolean, wisGemeld: boolean,
 *   uren: { conv: number|null, inbound: number|null, webhook: number|null } }}
 */
export function beoordeelIgStilte(p) {
  const nuMs = Number.isFinite(p?.nuMs) ? p.nuMs : Date.now();
  const drempel  = Number(p?.drempelUren)  > 0 ? Number(p.drempelUren)  : DEFAULT_DREMPEL_UREN;
  const throttle = Number(p?.throttleUren) > 0 ? Number(p.throttleUren) : DEFAULT_THROTTLE_UREN;
  const conv = ms(p?.laatsteNieuweConvIso);
  const inb  = ms(p?.laatsteInboundIso);
  const wh   = ms(p?.laatsteWebhookIso);
  const uren = (t) => (t == null ? null : Math.round(((nuMs - t) / UUR) * 10) / 10);
  const ouderDan = (t) => t == null || (nuMs - t) >= drempel * UUR;

  const redenen = [];
  if (ouderDan(conv) && ouderDan(inb)) redenen.push('geen_ig_activiteit');
  // Alleen als er inbound NA de laatste webhook-ontvangst is: anders is het
  // gewoon rustig (en dekt reden 1 het al).
  if (ouderDan(wh) && inb != null && (wh == null || inb > wh)) redenen.push('webhook_stil');

  const alarm = !p?.uit && redenen.length > 0;
  const gemeld = ms(p?.gemeldOpIso);
  const magMelden = alarm && (gemeld == null || (nuMs - gemeld) >= throttle * UUR);
  const wisGemeld = !alarm && gemeld != null;
  return { alarm, redenen, magMelden, wisGemeld, uren: { conv: uren(conv), inbound: uren(inb), webhook: uren(wh) } };
}

export function alarmTekst(oordeel, { drempelUren }) {
  const r = [];
  r.push(`Lisa / Instagram: ${oordeel.redenen.length} stilte-signaal(en) (drempel ${drempelUren} uur).`);
  if (oordeel.redenen.includes('geen_ig_activiteit')) {
    r.push(`- Geen nieuw IG-gesprek (${oordeel.uren.conv ?? 'nooit'} u) én geen inbound IG-bericht (${oordeel.uren.inbound ?? 'nooit'} u).`);
  }
  if (oordeel.redenen.includes('webhook_stil')) {
    r.push(`- De GHL-webhook heeft al ${oordeel.uren.webhook ?? '∞'} u niets geaccepteerd, terwijl de poll wél nieuwere inbound vond (${oordeel.uren.inbound} u geleden). Nieuwe contacten worden dan NIET aangemaakt.`);
  }
  r.push('Check: lisa_settings.ghl_webhook_last_error, app_settings.lisa_webhook_laatste_skip en de GHL-workflow "Custom Webhook".');
  return r.join('\n');
}

async function laatste(q) {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Meet, beslis en meld. Faalzacht: gooit nooit.
 * @param {object} [deps] { db, notify, mail, nuMs } — injecteerbaar voor tests.
 */
export async function controleerIgStilte(deps = {}) {
  const db = deps.db || supabaseAdmin;
  const nuMs = Number.isFinite(deps.nuMs) ? deps.nuMs : Date.now();
  try {
    const { data: cfgRow, error: cfgErr } = await db.from('app_settings').select('value').eq('key', ALARM_KEY).maybeSingle();
    if (cfgErr) throw new Error('config: ' + cfgErr.message);
    const cfg = (cfgRow?.value && typeof cfgRow.value === 'object') ? cfgRow.value : {};

    const conv = await laatste(db.from('lisa_conversations').select('created_at')
      .eq('is_sandbox', false).order('created_at', { ascending: false }).limit(1).maybeSingle());
    const inb = await laatste(db.from('lisa_messages').select('sent_at, lisa_conversations!inner(is_sandbox)')
      .eq('direction', 'in').eq('lisa_conversations.is_sandbox', false)
      .order('sent_at', { ascending: false }).limit(1).maybeSingle());
    const st = await laatste(db.from('lisa_settings').select('ghl_webhook_last_received_at').eq('id', 1).maybeSingle());

    const drempelUren = Number(cfg.drempel_uren) > 0 ? Number(cfg.drempel_uren) : DEFAULT_DREMPEL_UREN;
    const oordeel = beoordeelIgStilte({
      nuMs,
      laatsteNieuweConvIso: conv?.created_at || null,
      laatsteInboundIso:    inb?.sent_at || null,
      laatsteWebhookIso:    st?.ghl_webhook_last_received_at || null,
      drempelUren,
      throttleUren: cfg.throttle_uren,
      gemeldOpIso:  cfg.gemeld_op || null,
      uit:          cfg.uit === true,
    });

    let gemeld = false;
    if (oordeel.magMelden) {
      const tekst = alarmTekst(oordeel, { drempelUren });
      const titel = 'Lisa/Instagram: geen nieuwe instroom — check de GHL-webhook';
      let okNotify = false, okMail = false;
      try {
        const r = await deps.notify?.({
          toRole: ['manager', 'super_admin'], type: 'lisa_ig_stilte', title: titel, body: tekst,
          linkUrl: '/modules/lisa.html', priority: 'high',
        });
        okNotify = !!r?.ok && (r.count ?? 1) > 0;
      } catch (e) { console.error('[lisa-ig-stilte] notificatie faalde:', e?.message || e); }
      try {
        const r = await deps.mail?.({
          subject: titel,
          html: `<pre style="font-family:ui-monospace,monospace;font-size:13px;white-space:pre-wrap">${
            tekst.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`,
        });
        okMail = !!r?.sent;
        if (r && !r.sent) console.warn('[lisa-ig-stilte] alarmmail niet verstuurd:', r.reason);
      } catch (e) { console.error('[lisa-ig-stilte] mail faalde:', e?.message || e); }
      gemeld = okNotify || okMail;
      if (gemeld) {
        const { error } = await db.from('app_settings').upsert({
          key: ALARM_KEY,
          value: { ...cfg, gemeld_op: new Date(nuMs).toISOString(), laatste_redenen: oordeel.redenen },
        }, { onConflict: 'key' });
        if (error) console.warn('[lisa-ig-stilte] gemeld_op opslaan faalde:', error.message);
      }
    } else if (oordeel.wisGemeld) {
      const { gemeld_op: _weg, ...rest } = cfg;
      const { error } = await db.from('app_settings').upsert({ key: ALARM_KEY, value: rest }, { onConflict: 'key' });
      if (error) console.warn('[lisa-ig-stilte] gemeld_op wissen faalde:', error.message);
    }
    return { gemeten: true, ...oordeel, gemeld };
  } catch (e) {
    console.error('[lisa-ig-stilte] NIET GEMETEN:', e?.message || e);
    return { gemeten: false, alarm: false, fout: e?.message || String(e) };
  }
}

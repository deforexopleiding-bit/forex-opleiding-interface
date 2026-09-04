// api/_lib/afspraak-bevestig.js
//
// Additieve bevestig-detectie voor de afspraak-flow. Wordt aangeroepen vanuit
// inbox-webhook.js én follow-up-ghl-conversation-webhook.js — NÁÁST de
// toegang-gate (die volledig ongemoeid blijft).
//
// Wanneer een lead op de quick-reply "Ik ben erbij" tikt (of dat typt), zet dit
// bevestigd_at op de eerstvolgende geplande afspraak die op telefoon-laatste-9
// matcht. Dat onderdrukt de 30-minuten-reminder (cron-guard: bevestigd_at IS
// NULL). Volledig fail-soft: mag een webhook NOOIT breken.

function isBevestigTekst(tekst) {
  const t = String(tekst || '').trim().toLowerCase().replace(/[.!]+$/,'');
  if (!t) return false;
  // Exacte quick-reply-titel + wat natuurlijke varianten.
  return t === 'ik ben erbij' || t.includes('ik ben erbij') || t === 'ik ben er bij';
}

function laatste9(telefoon) {
  const digits = String(telefoon || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : (digits || null);
}

/**
 * @returns {Promise<{matched:boolean, id?:string, reden?:string}>}
 */
export async function markeerAfspraakBevestigd(supabaseAdmin, { telefoon, tekst } = {}) {
  try {
    if (!isBevestigTekst(tekst)) return { matched: false, reden: 'geen-bevestig-tekst' };
    const last9 = laatste9(telefoon);
    if (!last9) return { matched: false, reden: 'geen-telefoon' };

    const nowIso = new Date().toISOString();
    // Kandidaten: geplande afspraken in de (nabije) toekomst, nog niet bevestigd.
    const { data: rows, error } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, lead_phone, scheduled_at, status, bevestigd_at')
      .eq('status', 'scheduled')
      .is('bevestigd_at', null)
      .gt('scheduled_at', new Date(Date.now() - 30 * 60 * 1000).toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(50);
    if (error) { console.warn('[afspraak-bevestig] query (soft):', error.message); return { matched: false, reden: 'query-fout' }; }

    const match = (rows || []).find((r) => laatste9(r.lead_phone) === last9);
    if (!match) return { matched: false, reden: 'geen-match' };

    // Atomair: alleen zetten zolang nog NULL (race-veilig t.o.v. dubbele webhooks).
    const { data: claimed } = await supabaseAdmin
      .from('follow_up_appointments')
      .update({ bevestigd_at: nowIso })
      .eq('id', match.id)
      .is('bevestigd_at', null)
      .select('id')
      .maybeSingle();

    if (claimed?.id) {
      console.log('[afspraak-bevestig] bevestigd_at gezet voor afspraak', match.id);
      return { matched: true, id: match.id };
    }
    return { matched: false, reden: 'al-bevestigd' };
  } catch (e) {
    console.warn('[afspraak-bevestig] exception (soft):', e?.message || e);
    return { matched: false, reden: 'exception' };
  }
}

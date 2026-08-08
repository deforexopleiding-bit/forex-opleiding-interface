// B2 — E-mail (Strato IMAP-inbox, master-detail)
// Scaffold uit systeemprototype-v45.html r2559-2756.

(function () {
  if (!window.DFO) return;
  const { I, svg } = window.DFO;
  const { av, pill, previewBadge } = window.V2Shared || {};
  if (!av) { console.error('[email-v2] V2Shared niet geladen'); return; }

  const MAILS = [
    { van: 'Nico Berghorst',   ond: 'Re: Tweede betalingsherinnering', tijd: '09:14',    ongelezen: true,  bijlage: false },
    { van: 'Mollie',           ond: 'Nieuwe betaling ontvangen — €600,00', tijd: '08:52', ongelezen: true,  bijlage: false },
    { van: 'Emile Rabaut',     ond: 'Betalingsbewijs traject', tijd: 'gisteren', ongelezen: true,  bijlage: true },
    { van: 'Stéphane Seutin',  ond: 'Vraag over de startdatum', tijd: 'gisteren', ongelezen: false, bijlage: false },
    { van: 'Teamleader',       ond: 'Offerte OFF-2026-219 bekeken', tijd: '2 dagen', ongelezen: false, bijlage: false },
  ];

  window.DFO.VIEWS['email/'] = () => `${previewBadge()}
    <div style="display:grid;grid-template-columns:360px 1fr;gap:0;height:calc(100vh - 160px);border:1px solid var(--border);border-radius:var(--r);margin:14px 20px;overflow:hidden;background:var(--surface)">

      <div style="border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--surface-2)">
        <div style="padding:14px;border-bottom:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap">
          <button class="chip on" style="font-size:11.5px">Inbox <span style="opacity:.7;margin-left:4px">3</span></button>
          <button class="chip" style="font-size:11.5px">Verzonden</button>
          <button class="chip" style="font-size:11.5px">Spam</button>
          <button class="chip" style="font-size:11.5px">Concept</button>
        </div>
        <div style="flex:1;overflow-y:auto">
          ${MAILS.map((m, i) => `<div style="padding:12px 14px;border-bottom:1px solid var(--border);cursor:pointer;${i === 0 ? 'background:var(--surface)' : ''}"
            onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background='${i === 0 ? 'var(--surface)' : 'transparent'}'">
            <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:3px">
              <span style="font-size:13px;font-weight:${m.ongelezen ? '600' : '400'};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.van}</span>
              <span style="font-size:11px;color:var(--text-3);flex-shrink:0">${m.tijd}</span>
            </div>
            <div style="font-size:12.5px;color:${m.ongelezen ? 'var(--text)' : 'var(--text-3)'};font-weight:${m.ongelezen ? '500' : '400'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.ond}</div>
            ${m.bijlage ? `<div style="margin-top:5px;font-size:10.5px;color:var(--text-3);display:flex;align-items:center;gap:4px">${svg(I.paperclip || I.file, 'width:11px;height:11px')}bijlage</div>` : ''}
          </div>`).join('')}
        </div>
        <div style="padding:12px 14px;border-top:1px solid var(--border)">
          <button class="btn btn-primary" style="width:100%">${svg(I.plus)}Nieuwe e-mail</button>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;background:var(--surface);overflow:hidden">
        <div style="padding:16px 24px;border-bottom:1px solid var(--border)">
          <div style="font-size:17px;font-weight:600;margin-bottom:6px">Re: Tweede betalingsherinnering</div>
          <div style="display:flex;align-items:center;gap:10px">
            ${av('Nico Berghorst', 32)}
            <div style="flex:1"><div style="font-size:13px;font-weight:500">Nico Berghorst</div>
              <div style="font-size:11.5px;color:var(--text-3)">nico@voorbeeld.nl · aan: jeffrey@dfo.nl · 09:14</div></div>
            <button class="btn btn-ghost btn-sm">${svg(I.doc)}Klantdossier</button>
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;padding:24px 40px;font-size:14px;line-height:1.65;color:var(--text-2)">
          <p style="margin:0 0 12px">Hoi Jeffrey,</p>
          <p style="margin:0 0 12px">Bedankt voor de herinnering. Er is bij mij een misverstand ontstaan — ik dacht dat de eerste termijn pas in september zou lopen. Kunnen we alsnog een betaalregeling afspreken over 3 maanden?</p>
          <p style="margin:0 0 12px">Laat maar weten hoe je dat wilt regelen.</p>
          <p style="margin:0">Groet,<br>Nico</p>
        </div>
        <div style="padding:16px 24px;border-top:1px solid var(--border);display:flex;gap:8px">
          <button class="btn btn-primary">${svg(I.up)}Beantwoorden</button>
          <button class="btn btn-ghost">${svg(I.arrDown || I.doc)}Doorsturen</button>
          <button class="btn btn-ghost" style="margin-left:auto">${svg(I.check2)}Archiveer</button>
        </div>
      </div>
    </div>`;

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('email');
  else window.KV_V2_PENDING = (window.KV_V2_PENDING || []).concat('email');
})();

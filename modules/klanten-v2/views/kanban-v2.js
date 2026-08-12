// modules/klanten-v2/views/kanban-v2.js
//
// Generieke kanban-component voor tickets + takenbeheer + toekomstige modules.
// Native HTML5 drag-and-drop, geen externe lib. Kaarten worden per status-kolom
// gegroepeerd; drop op andere kolom triggert onMove(id, newStatusKey).
//
// Gebruik in een module:
//   window.KV_V2.kanban.register('tickets', {
//     statuses: [
//       { key: 'open',        label: 'Open',            color: 'rose'    },
//       { key: 'in_progress', label: 'Bezig',           color: 'blue'    },
//       { key: 'resolved',    label: 'Opgelost',        color: 'emerald' },
//       { key: 'closed',      label: 'Gesloten',        color: 'slate'   },
//     ],
//     getItems: () => TICKETS_ARRAY,          // async ok — of items array direct
//     statusOf: (item) => item.status,        // getter voor huidige status
//     renderCard: (item) => `<b>${item.title}</b>...`,   // card-body HTML
//     onMove: async (id, newStatus) => { ... await api call },
//     itemId: (item) => item.id,              // default: item.id
//   });
//
//   Render (in view HTML):
//     window.KV_V2.kanban.html('tickets')
//
// Ronde 5 (Pipeline PR). Dormant. Blijft naast lijst-view via view-toggle.

(function () {
  if (!window.DFO) { console.error('[kanban-v2] DFO shell niet geladen.'); return; }
  const svg = window.DFO.svg;

  const REGISTRY = new Map(); // moduleKey → config

  function register(moduleKey, config) {
    REGISTRY.set(moduleKey, {
      statuses: config.statuses || [],
      getItems: config.getItems || (() => []),
      statusOf: config.statusOf || ((it) => it.status),
      renderCard: config.renderCard || ((it) => JSON.stringify(it).slice(0, 80)),
      onMove: config.onMove || (async (_id, _st) => { console.info('[kanban-v2] no onMove for', moduleKey); }),
      itemId: config.itemId || ((it) => it.id),
    });
  }

  // Renders the kanban HTML for a given module (view-safe: returns a string).
  function html(moduleKey) {
    const cfg = REGISTRY.get(moduleKey);
    if (!cfg) return `<div class="sv-empty">Kanban-config voor "${moduleKey}" niet geregistreerd.</div>`;
    let items = [];
    try {
      const gi = cfg.getItems();
      items = Array.isArray(gi) ? gi : [];
    } catch (e) {
      console.warn('[kanban-v2] getItems threw', e?.message);
    }
    // Groepeer per status-key.
    const byStatus = new Map(cfg.statuses.map(s => [s.key, []]));
    for (const it of items) {
      const st = cfg.statusOf(it);
      if (byStatus.has(st)) byStatus.get(st).push(it);
      else {
        // Onbekende status → parkeer in eerste kolom.
        const first = cfg.statuses[0]?.key;
        if (first) byStatus.get(first).push(it);
      }
    }
    return `<div class="kv-kanban" data-kanban-module="${escAttr(moduleKey)}">
      ${cfg.statuses.map(s => {
        const list = byStatus.get(s.key) || [];
        return `<div class="kv-kanban-col" data-status-key="${escAttr(s.key)}"
                     ondragover="event.preventDefault();this.classList.add('is-drop-target')"
                     ondragleave="this.classList.remove('is-drop-target')"
                     ondrop="event.preventDefault();this.classList.remove('is-drop-target');window.KV_V2.kanban._drop(event,'${escAttr(moduleKey)}','${escAttr(s.key)}')">
          <div class="kv-kanban-col-head" style="--kc:var(--${s.color || 'slate'})">
            <span class="kv-kanban-col-dot"></span>
            <span class="kv-kanban-col-lbl">${escHtml(s.label)}</span>
            <span class="kv-kanban-col-cnt">${list.length}</span>
          </div>
          <div class="kv-kanban-col-body">
            ${list.length ? list.map(it => {
              const id = cfg.itemId(it);
              // onCardClick (optioneel per module) → klik-op-kaart handler.
              // Browsers vuren `click` NIET na een geslaagde drag-drop, dus
              // dit conflict niet met de HTML5 drag-flow. Cursor:pointer
              // hint dat de kaart klikbaar is.
              const clickAttr = cfg.onCardClick
                ? `onclick="window.KV_V2.kanban._cardClick('${escAttr(moduleKey)}','${escAttr(String(id))}')" style="cursor:pointer"`
                : '';
              return `<div class="kv-kanban-card" draggable="true"
                          data-item-id="${escAttr(String(id))}"
                          ondragstart="window.KV_V2.kanban._dragStart(event,'${escAttr(moduleKey)}','${escAttr(String(id))}')"
                          ondragend="this.classList.remove('is-dragging')"
                          ${clickAttr}>
                ${cfg.renderCard(it)}
              </div>`;
            }).join('') : `<div class="kv-kanban-col-empty">Sleep hier</div>`}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  // Global drag-state (single-drag context per user gesture).
  const _drag = { moduleKey: null, itemId: null };

  function _dragStart(ev, moduleKey, itemId) {
    _drag.moduleKey = moduleKey;
    _drag.itemId = itemId;
    try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', itemId); } catch (_) {}
    ev.currentTarget.classList.add('is-dragging');
  }

  async function _drop(ev, moduleKey, newStatus) {
    if (!_drag.itemId || _drag.moduleKey !== moduleKey) return;
    const cfg = REGISTRY.get(moduleKey);
    if (!cfg) return;
    const id = _drag.itemId;
    _drag.itemId = null; _drag.moduleKey = null;
    // Optimistic UI: laat onMove de state muteren + render triggeren.
    try {
      await cfg.onMove(id, newStatus);
    } catch (e) {
      console.warn('[kanban-v2] onMove failed:', e?.message);
      alert('Verplaatsen mislukt: ' + (e?.message || 'onbekende fout'));
    }
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  }

  function escAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, "&#39;"); }
  function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  window.KV_V2 = window.KV_V2 || {};
  // Card-click dispatcher (optioneel per module via cfg.onCardClick).
  // Wordt aangeroepen vanuit inline onclick op de kaart-div. Ophaalt het
  // item via cfg.getItems + itemId-match zodat de callback de HELE row
  // krijgt (net als bij drag+drop de id).
  function _cardClick(moduleKey, itemId) {
    const cfg = REGISTRY.get(moduleKey);
    if (!cfg || typeof cfg.onCardClick !== 'function') return;
    try {
      const items = (typeof cfg.getItems === 'function' ? cfg.getItems() : []) || [];
      const it = items.find((x) => String(cfg.itemId(x)) === String(itemId));
      cfg.onCardClick(it || { id: itemId });
    } catch (e) { console.warn('[kanban-v2] onCardClick failed:', e?.message); }
  }
  window.KV_V2.kanban = { register, html, _drop, _dragStart, _cardClick, _registry: REGISTRY };
  console.debug('[kanban-v2] registered');
})();

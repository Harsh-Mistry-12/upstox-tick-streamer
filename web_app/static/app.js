'use strict';
/* ============================================================
   UpstoxPro — Frontend Logic
   WebSocket client, table renderer, charts, formula builder
============================================================ */

// ── Socket.IO ─────────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

// ── Application State ─────────────────────────────────────
const App = {
  page: 'live',
  currentExpiry: null,
  expiries: [],
  priorityExpiries: [],       // [current, next] — always streamed in background
  chainData: {},       // { expiry: [rows] }
  prevData: {},       // previous snapshot for % change
  formulaResults: {},       // { expiry: { strike: { fid: result } } }
  formulas: [],
  showPct: true,    // % change badges visible by default
  showGreeks: true,
  formulaPrecision: 4,
  underlying: 'NSE_INDEX|Nifty 50',
  greeksCharts: {},
  greeksStrike: null,
  greeksExpiry: null,
  streaming: localStorage.getItem('upstox_streaming') === 'true',
  tokenValid: localStorage.getItem('upstox_token_valid') === 'true',
  onDemandPollTimer: null,
  onDemandExpiry: null,
  historyRows: [],
  historyExpiry: '',
  modalChart: null,     // Chart instance for the Greeks modal
};

// ── DOM Helpers ───────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = tag => document.createElement(tag);

function fmt(v, d = 2) {
  if (v === null || v === undefined) return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtInt(v) {
  const n = parseInt(v);
  return isNaN(n) ? '—' : n.toLocaleString('en-IN');
}
function fmtPct(v, d = 1) {
  const n = parseFloat(v);
  if (isNaN(n)) return '';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(d)}%`;
}
function shortUnderlying(s) {
  if (!s) return 'Nifty 50';
  const map = {
    'Nifty 50': 'Nifty 50', 'Nifty Bank': 'Bank Nifty',
    'Nifty Fin Service': 'Fin Nifty', 'NIFTY MID SELECT': 'Midcap Select',
    'SENSEX': 'Sensex',
  };
  const part = s.split('|')[1] || s;
  return map[part] || part;
}

// ── Toasts ────────────────────────────────────────────────
function toast(msg, type = 'info', ms = 4000) {
  const icons = { ok: '✅', err: '❌', info: 'ℹ️', warn: '⚠️' };
  const wrap = $('toast-wrap');
  const div = el('div');
  div.className = `toast ${type}`;
  div.innerHTML = `<span>${icons[type] || '●'}</span> <span>${msg}</span>
    <span class="toast-close" onclick="this.parentElement.remove()">×</span>`;
  wrap.appendChild(div);
  setTimeout(() => div.remove(), ms);
}

// ── Navigation ────────────────────────────────────────────
function navigate(page) {
  // Stop on-demand polling when leaving the Live Chain page
  if (App.page === 'live' && page !== 'live') {
    stopOnDemandPolling();
  }
  App.page = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageEl = $(page + '-page');
  if (pageEl) pageEl.classList.add('active');

  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');

  // auto-refresh
  if (page === 'greeks' && App.greeksExpiry && App.greeksStrike) loadGreeksHistory();
  if (page === 'formulas') fetchAndRenderFormulas();
}

document.querySelectorAll('.nav-item[data-page]').forEach(n => {
  n.addEventListener('click', () => navigate(n.dataset.page));
});

// ── WebSocket ─────────────────────────────────────────────
socket.on('connect', () => {
  // If we already know the state from a previous session, keep showing it
  // instead of flashing "Connecting…". The server will send status_update
  // shortly and correct it if needed.
  if (App.streaming && App.tokenValid) {
    updateBadge('live');
  } else if (App.tokenValid) {
    updateBadge('paused');
  } else {
    updateBadge('connected');
  }
});
socket.on('disconnect', () => updateBadge('disconnected'));

function updateIndiaVix(data) {
  const elVal = $('h-india-vix');
  const elChg = $('h-india-vix-chg');
  if (!elVal) return;

  if (data && typeof data === 'object' && data.last_price) {
    elVal.textContent = fmt(data.last_price, 2);
    if (elChg && data.change !== undefined && data.p_change !== undefined) {
      const isUp = data.change >= 0;
      const sign = isUp ? '+' : '';
      const color = isUp ? 'var(--up-color, #22c55e)' : 'var(--down-color, #ef4444)';
      elChg.textContent = `${sign}${fmt(data.change, 2)} (${sign}${fmt(data.p_change, 2)}%)`;
      elChg.style.color = color;
    }
  } else if (typeof data === 'number' && data > 0) {
    elVal.textContent = fmt(data, 2);
    if (elChg) elChg.textContent = '';
  } else {
    elVal.textContent = '—';
    if (elChg) elChg.textContent = '';
  }
}

let _vixInterval = null;

async function pollIndiaVix() {
  try {
    const res = await fetch('/api/vix');
    if (res.ok) {
      const data = await res.json();
      updateIndiaVix(data);
    }
  } catch (err) {
    console.warn('India VIX fetch error:', err);
  }
}

function startVixPolling() {
  if (_vixInterval) clearInterval(_vixInterval);
  pollIndiaVix();
  const intervalSec = App.refreshInterval || 5;
  _vixInterval = setInterval(pollIndiaVix, Math.max(3, intervalSec) * 1000);
}

socket.on('status_update', d => {
  App.streaming = d.streaming;
  App.tokenValid = d.token_valid;
  // Persist so the next page load shows correct state immediately
  try {
    localStorage.setItem('upstox_streaming', String(d.streaming));
    localStorage.setItem('upstox_token_valid', String(d.token_valid));
  } catch (_) { }
  updateBadge(d.streaming && d.token_valid ? 'live' : d.token_valid ? 'paused' : 'auth');
  updateStreamButtons();
  syncTokenBadge(d.token_valid);
});

socket.on('option_chain_update', d => {
  App.underlying = d.underlying || App.underlying;
  App.expiries = d.expiries || [];
  // `priority_expiries` is the subset the background always streams
  App.priorityExpiries = d.priority_expiries || App.expiries.slice(0, 2);
  App.formulaResults = Object.assign({}, App.formulaResults, d.formula_results || {});
  App.prevData = JSON.parse(JSON.stringify(App.chainData));
  // Merge incoming data (only priority expiries) into cached chainData
  const incoming = d.data || {};
  Object.keys(incoming).forEach(exp => { App.chainData[exp] = incoming[exp]; });

  // counters
  const ft = $('h-fetch-time');
  const fc = $('sb-fetch-count');
  if (ft) ft.textContent = d.fetch_time ? d.fetch_time.substring(11, 19) : '—';
  if (fc) fc.textContent = `Fetch #${d.fetch_count || 0}`;

  // underlying in header
  const hu = $('h-underlying');
  if (hu) hu.textContent = shortUnderlying(d.underlying);
  const ks = $('kpi-underlying-sub');
  if (ks) ks.textContent = shortUnderlying(d.underlying);

  renderExpiryTabs();
  updateKPIs();
  updateSpotTicker();

  // Only re-render the table if the active expiry is a priority one
  // (on-demand expiries re-render via on_demand_expiry_update)
  if (App.page === 'live') {
    const isActivePriority = App.priorityExpiries.includes(App.currentExpiry);
    if (isActivePriority) renderChainTable();
  }
});

// ── On-Demand Expiry Update ───────────────────────────────
socket.on('on_demand_expiry_update', d => {
  const incoming = d.data || {};
  Object.keys(incoming).forEach(exp => { App.chainData[exp] = incoming[exp]; });
  App.formulaResults = Object.assign({}, App.formulaResults, d.formula_results || {});

  const ft = $('h-fetch-time');
  if (ft) ft.textContent = d.fetch_time ? d.fetch_time.substring(11, 19) : '—';

  // Re-render only if this expiry is currently shown
  if (App.page === 'live' && App.currentExpiry === d.expiry) {
    renderChainTable();
    updateKPIs();
    updateSpotTicker();
  }
});

// ── Stream badge ──────────────────────────────────────────
function updateBadge(state) {
  const b = $('ws-badge');
  if (!b) return;
  const states = {
    live: { cls: 'live', text: 'LIVE', pulse: true },
    paused: { cls: 'stopped', text: 'PAUSED', pulse: false },
    auth: { cls: 'stopped', text: 'AUTH REQUIRED', pulse: false },
    connected: { cls: 'waiting', text: 'Connecting…', pulse: true },
    disconnected: { cls: 'stopped', text: 'DISCONNECTED', pulse: false },
  };
  const s = states[state] || states.connected;
  b.className = `stream-badge ${s.cls}`;
  b.innerHTML = `<span class="pulse${s.pulse ? ' anim' : ''}"></span>${s.text}`;
}

function updateStreamButtons() {
  const start = $('btn-start');
  const stop = $('btn-stop');
  if (start) start.disabled = App.streaming;
  if (stop) stop.disabled = !App.streaming;
}

function syncTokenBadge(valid) {
  const b = $('token-status-badge');
  if (!b) return;
  b.className = valid ? 'auth-status ok' : 'auth-status bad';
  b.innerHTML = valid
    ? '<span>✅</span> Authenticated — streaming active'
    : '<span>❌</span> Not authenticated — streaming paused';
}

// ── Spot Ticker ───────────────────────────────────────────
let _prevSpot = null;
function updateSpotTicker() {
  const expiry = App.currentExpiry;
  const rows = expiry ? App.chainData[expiry] : null;
  const spot = rows?.[0]?.spot_price;
  const el = $('spot-ticker');
  if (!el) return;

  el.textContent = spot ? `₹ ${fmt(spot, 2)}` : '₹ —';
  el.className = 'spot-ticker';
  if (_prevSpot && spot > _prevSpot) el.classList.add('up');
  else if (_prevSpot && spot < _prevSpot) el.classList.add('down');
  _prevSpot = spot;
}

// ── KPI Cards ─────────────────────────────────────────────
function updateKPIs() {
  const exp = App.currentExpiry || App.expiries[0];
  const rows = exp ? App.chainData[exp] : null;
  if (!rows?.length) return;

  const spot = rows[0]?.spot_price;
  const atm = rows.find(r => r.is_atm);
  const pcr = rows[0]?.pcr;
  const callOI = rows.reduce((s, r) => s + (r.call_oi || 0), 0);
  const putOI = rows.reduce((s, r) => s + (r.put_oi || 0), 0);

  setText('kpi-spot', spot ? fmt(spot, 2) : '—');
  setText('kpi-atm', atm ? fmt(atm.strike_price, 0) : '—');
  setText('kpi-pcr', pcr ? parseFloat(pcr).toFixed(3) : '—');
  setText('kpi-call-oi', fmtInt(callOI));
  setText('kpi-put-oi', fmtInt(putOI));

  // PCR badge
  const pcrBadge = $('kpi-pcr-badge');
  if (pcrBadge && pcr) {
    const n = parseFloat(pcr);
    if (n > 1.1) { pcrBadge.className = 'kpi-badge bear'; pcrBadge.textContent = 'Bearish Trend'; }
    else if (n < 0.9) { pcrBadge.className = 'kpi-badge bull'; pcrBadge.textContent = 'Bullish Trend'; }
    else { pcrBadge.className = 'kpi-badge neut'; pcrBadge.textContent = 'Neutral'; }
  }
}

function setText(id, v) { const e = $(id); if (e) e.textContent = v; }

// ── Sidebar collapse ──────────────────────────────────────────
function toggleSidebar() {
  const layout = document.querySelector('.layout');
  const collapsed = layout.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('upstox_sidebar_collapsed', collapsed ? '1' : '0'); } catch (_) { }
}

// ── Expiry Tabs ───────────────────────────────────────────

/**
 * Trigger a single on-demand fetch for `expiry` via the REST endpoint.
 * The server will emit `on_demand_expiry_update` which updates the table.
 */
async function fetchOnDemandExpiry(expiry) {
  try {
    await fetch('/api/fetch_expiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiry }),
    });
    // The actual data arrives via the 'on_demand_expiry_update' WS event
  } catch (e) {
    console.warn('On-demand fetch error:', e);
  }
}

/** Start polling a non-priority expiry every `intervalMs` ms. */
function startOnDemandPolling(expiry, intervalMs = 5000) {
  stopOnDemandPolling(); // clear any existing poll
  App.onDemandExpiry = expiry;
  fetchOnDemandExpiry(expiry); // immediate first fetch
  App.onDemandPollTimer = setInterval(() => {
    if (App.onDemandExpiry === expiry && App.streaming) {
      fetchOnDemandExpiry(expiry);
    }
  }, intervalMs);
}

/** Stop any active on-demand polling. */
function stopOnDemandPolling() {
  if (App.onDemandPollTimer !== null) {
    clearInterval(App.onDemandPollTimer);
    App.onDemandPollTimer = null;
  }
  App.onDemandExpiry = null;
}

function renderExpiryTabs() {
  const container = $('expiry-tabs');
  if (!container) return;

  if (!App.currentExpiry && App.expiries.length > 0) {
    App.currentExpiry = App.expiries[0];
    App.greeksExpiry = App.expiries[0];
  }

  container.innerHTML = '';
  App.expiries.forEach((exp, idx) => {
    const isPriority = idx < 2;  // current + next are always streamed
    const btn = el('button');
    btn.className = 'exp-tab' + (exp === App.currentExpiry ? ' active' : '');
    // Visual hint for on-demand tabs
    if (!isPriority) btn.title = 'Fetched on-demand when opened';
    btn.textContent = exp;
    btn.onclick = () => {
      const prev = App.currentExpiry;
      App.currentExpiry = exp;
      renderExpiryTabs();
      updateKPIs();
      updateSpotTicker();

      if (isPriority) {
        // Priority expiry: data is already in cache, just render it
        stopOnDemandPolling();
        renderChainTable();
      } else {
        // Non-priority: start on-demand polling only if streaming is active
        if (App.streaming) {
          startOnDemandPolling(exp, 5000);
        } else {
          // Streaming is paused — do a one-time fetch to show latest cached data
          fetchOnDemandExpiry(exp);
        }
        // Show loading state while waiting for first response
        if (!App.chainData[exp] || !App.chainData[exp].length) {
          const wrapper = $('chain-table-wrapper');
          if (wrapper) wrapper.innerHTML = `<div class="empty-state">
            <div class="loading-ring"></div>
            <div class="empty-title">Fetching ${exp}…</div>
            <div class="empty-desc">Loading on-demand data for this expiry.</div>
          </div>`;
          hideInfoBar();
        } else {
          renderChainTable(); // show stale data immediately while fresh data loads
        }
      }
    };
    container.appendChild(btn);
  });

  // Sync expiry selects on other pages
  ['greeks-expiry-sel', 'history-expiry-sel'].forEach(id => {
    const sel = $(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = App.expiries.map(e => `<option value="${e}" ${e === cur ? 'selected' : ''}>${e}</option>`).join('');
    if (!cur && App.currentExpiry) sel.value = App.currentExpiry;
  });
}

// ── Option Chain Table ────────────────────────────────────
const CALL_COLS = [
  { key: 'call_volume', label: 'Volume', fmt: fmtInt, tip: 'Traded volume today' },
  { key: 'call_vega', label: 'Vega V', fmt: v => fmt(v, 4), tip: 'Price change per 1% IV increase' },
  { key: 'call_gamma', label: 'Gamma Γ', fmt: v => fmt(v, 5), tip: 'Rate of Delta change per ₹1 spot move' },
  { key: 'call_theta', label: 'Theta Θ', fmt: v => fmt(v, 2), tip: 'Daily time decay in ₹ (always negative)' },
  { key: 'call_delta', label: 'Delta Δ', fmt: v => fmt(v, 4), tip: 'Price change per ₹1 spot move (0 → 1)' },
  { key: 'call_chg_oi', label: 'Chg OI', fmt: fmtInt, tip: 'Change in OI from previous close' },
  { key: 'call_oi', label: 'OI', fmt: fmtInt, tip: 'Open Interest — total outstanding contracts' },
  { key: 'call_ltp', label: 'LTP', fmt: v => fmt(v, 2), tip: 'Last Traded Price' },
  { key: 'call_iv', label: 'IV %', fmt: v => fmt(v, 2), tip: 'Implied Volatility (%)' },
];
const PUT_COLS = [
  { key: 'put_iv', label: 'IV %', fmt: v => fmt(v, 2), tip: 'Put Implied Volatility' },
  { key: 'put_ltp', label: 'LTP', fmt: v => fmt(v, 2), tip: 'Put Last Traded Price' },
  { key: 'put_oi', label: 'OI', fmt: fmtInt, tip: 'Put Open Interest' },
  { key: 'put_chg_oi', label: 'Chg OI', fmt: fmtInt, tip: 'Put OI change from prev close' },
  { key: 'put_delta', label: 'Delta Δ', fmt: v => fmt(v, 4), tip: 'Put Delta (-1 → 0)' },
  { key: 'put_theta', label: 'Theta Θ', fmt: v => fmt(v, 2), tip: 'Put daily time decay' },
  { key: 'put_gamma', label: 'Gamma Γ', fmt: v => fmt(v, 5), tip: 'Put Gamma' },
  { key: 'put_vega', label: 'Vega V', fmt: v => fmt(v, 4), tip: 'Put Vega' },
  { key: 'put_volume', label: 'Volume', fmt: fmtInt, tip: 'Put volume today' },
];

function pctChange(cur, prev, key) {
  if (!App.showPct || !prev || prev[key] == null) return '';
  const c = parseFloat(cur[key]), p = parseFloat(prev[key]);
  if (isNaN(c) || isNaN(p) || p === 0) return '';
  const pct = ((c - p) / Math.abs(p)) * 100;
  if (Math.abs(pct) < 0.01) return '';
  // No ▲▼ arrows — just a clean colored percentage
  return pct >= 0
    ? `<span class="pct-up">+${Math.abs(pct).toFixed(1)}%</span>`
    : `<span class="pct-dn">−${Math.abs(pct).toFixed(1)}%</span>`;
}

function rowClass(row) {
  if (row.is_atm) return 'row-atm';
  const s = row.spot_price, k = row.strike_price;
  if (s != null) {
    if (k < s) return 'row-itm-call';
    if (k > s) return 'row-itm-put';
  }
  return '';
}

function renderChainTable() {
  const expiry = App.currentExpiry;
  const rows = expiry ? App.chainData[expiry] : null;
  const wrapper = $('chain-table-wrapper');
  if (!wrapper) return;

  if (!rows?.length) {
    wrapper.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📊</div>
      <div class="empty-title">Waiting for live data…</div>
      <div class="empty-desc">Option chain data will appear here once streaming starts.</div>
    </div>`;
    hideInfoBar(); return;
  }

  // prev data map
  const prevMap = {};
  (App.prevData[expiry] || []).forEach(r => prevMap[r.strike_price] = r);

  // info bar
  showInfoBar(rows, expiry);

  // active formulas
  const fCols = App.formulas.filter(f => f.active !== false);
  const frExp = App.formulaResults[expiry] || {};
  const hasFormulas = fCols.length > 0;

  // Filter columns based on Greeks toggle
  const activeCallCols = App.showGreeks
    ? CALL_COLS
    : CALL_COLS.filter(c => !['call_delta', 'call_gamma', 'call_theta', 'call_vega'].includes(c.key));

  const activePutCols = App.showGreeks
    ? PUT_COLS
    : PUT_COLS.filter(c => !['put_delta', 'put_gamma', 'put_theta', 'put_vega'].includes(c.key));

  const totalCols = activeCallCols.length + 1 + activePutCols.length + fCols.length;
  const spotVal = rows[0]?.spot_price;
  let spotLineDrawn = false;

  // ── build table ──
  let h = `<table class="oc-table">
    <thead>
      <tr class="group-row">
        <th class="gh-call" colspan="${activeCallCols.length}">CALLS</th>
        <th class="gh-strike" colspan="1">STRIKE</th>
        <th class="gh-put" colspan="${activePutCols.length}">PUTS</th>
        ${hasFormulas ? `<th class="gh-formula" colspan="${fCols.length}">FORMULAS</th>` : ''}
      </tr>
      <tr class="col-row">
        ${activeCallCols.map(c => `<th class="ch-call" title="${c.tip || ''}">${c.label}</th>`).join('')}
        <th class="ch-strike">Strike</th>
        ${activePutCols.map(c => `<th class="ch-put" title="${c.tip || ''}">${c.label}</th>`).join('')}
        ${fCols.map(f => `<th style="background:rgba(99,102,241,0.06);color:${f.color};font-size:0.58rem;text-transform:uppercase;letter-spacing:0.04em;padding:6px 6px;border-bottom:1px solid var(--border)">${f.name}</th>`).join('')}
      </tr>
    </thead>
    <tbody>`;

  rows.forEach((row, idx) => {
    const rc = rowClass(row) || (idx % 2 === 0 ? 'row-even' : '');
    const prev = prevMap[row.strike_price] || null;

    h += `<tr class="${rc}" data-strike="${row.strike_price}">`;

    // Call cells
    activeCallCols.forEach(col => {
      const v = row[col.key];
      const pct = App.showPct ? pctChange(row, prev, col.key) : '';
      const isItm = spotVal != null && row.strike_price < spotVal;
      const itmClass = isItm ? ' itm-call' : '';
      h += `<td class="call-side text-right${itmClass}" title="${col.tip || ''}">${col.fmt(v)}${pct}</td>`;
    });

    // Strike cell
    h += `<td class="strike-td">${fmt(row.strike_price, 0)}</td>`;

    // Put cells
    activePutCols.forEach(col => {
      const v = row[col.key];
      const pct = App.showPct ? pctChange(row, prev, col.key) : '';
      const isItm = spotVal != null && row.strike_price > spotVal;
      const itmClass = isItm ? ' itm-put' : '';
      h += `<td class="put-side text-right${itmClass}" title="${col.tip || ''}">${col.fmt(v)}${pct}</td>`;
    });

    // Formula cells
    fCols.forEach(f => {
      const sk = Number(row.strike_price) % 1 === 0 ? String(parseInt(row.strike_price)) : String(row.strike_price);
      const fr = frExp[sk]?.[String(f.id)];
      if (!fr) h += `<td class="text-right text-muted">—</td>`;
      else if (fr.error) h += `<td class="text-right text-muted" title="${fr.error}">Err</td>`;
      else h += `<td class="text-right" style="color:${fr.color}">${fmt(fr.value, App.formulaPrecision)}</td>`;
    });

    h += '</tr>';
  });

  h += '</tbody></table>';
  wrapper.innerHTML = h;

  // make rows clickable → Greeks Dashboard (pre-fill + auto-load)
  wrapper.querySelectorAll('tr[data-strike]').forEach(tr => {
    tr.addEventListener('click', () => {
      const strike = tr.dataset.strike;

      // Update App state
      App.greeksStrike = strike;
      App.greeksExpiry = expiry;

      // Pre-fill the Greeks form inputs
      const expSel = $('greeks-expiry-sel');
      if (expSel) expSel.value = expiry;

      const strikeInp = $('greeks-strike-input');
      if (strikeInp) strikeInp.value = strike;

      const limitSel = $('greeks-limit');
      if (limitSel) limitSel.value = '100';   // default 100 points

      // Navigate then auto-load so charts appear immediately
      navigate('greeks');
      loadGreeksHistory();
    });
  });
}

function showInfoBar(rows, expiry) {
  const bar = $('table-infobar');
  if (!bar) return;
  bar.style.display = 'flex';

  const spot = rows[0]?.spot_price;
  const pcr = rows[0]?.pcr;
  const pcrNum = parseFloat(pcr);
  const pcrColor = pcrNum > 1.1 ? 'var(--put)' : pcrNum < 0.9 ? 'var(--call)' : 'var(--atm)';

  setText('ib-spot', spot ? `₹ ${fmt(spot, 2)}` : '—');
  setText('ib-expiry', expiry || '—');
  setText('ib-strikes', `${rows.length} strikes`);

  const ibPcr = $('ib-pcr');
  if (ibPcr) {
    ibPcr.textContent = pcr ? parseFloat(pcr).toFixed(3) : '—';
    ibPcr.style.color = pcrColor;
  }

  const b = $('strike-count-badge');
  if (b) { b.textContent = `${rows.length} strikes`; b.style.display = 'inline-block'; }
}

function hideInfoBar() {
  const bar = $('table-infobar');
  if (bar) bar.style.display = 'none';
  const b = $('strike-count-badge');
  if (b) b.style.display = 'none';
}

// Toggle % change
const pctTogglePill = $('pct-toggle-pill');
if (pctTogglePill) {
  pctTogglePill.addEventListener('click', () => {
    App.showPct = !App.showPct;
    const track = $('pct-toggle-track');
    if (track) track.classList.toggle('on', App.showPct);
    renderChainTable();
  });
}

// Toggle Greeks columns
const greeksTogglePill = $('greeks-toggle-pill');
if (greeksTogglePill) {
  greeksTogglePill.addEventListener('click', () => {
    App.showGreeks = !App.showGreeks;
    const track = $('greeks-toggle-track');
    if (track) track.classList.toggle('on', App.showGreeks);
    renderChainTable();
  });
}

// Formula precision select
const formulaPrecisionSelect = $('formula-precision-select');
if (formulaPrecisionSelect) {
  formulaPrecisionSelect.addEventListener('change', (e) => {
    App.formulaPrecision = parseInt(e.target.value) || 4;
    renderChainTable();
  });
}



// ── Greeks Dashboard ──────────────────────────────────────
function loadGreeksHistory() {
  const expiry = $('greeks-expiry-sel')?.value || App.greeksExpiry;
  const strike = $('greeks-strike-input')?.value || App.greeksStrike;
  const limit = $('greeks-limit')?.value || 100;

  if (!expiry || !strike) {
    toast('Select an expiry and strike price first.', 'warn'); return;
  }

  App.greeksExpiry = expiry;
  App.greeksStrike = strike;

  // show loading
  $('greeks-charts-area').innerHTML = `<div class="empty-state"><div class="loading-ring"></div><div class="empty-title">Loading Greeks history…</div></div>`;

  const headerInfo = $('greeks-current-info');
  const headerStrike = $('greeks-header-strike');
  if (headerInfo) headerInfo.style.display = 'block';
  if (headerStrike) headerStrike.textContent = `${strike}`;

  fetch(`/api/greeks/history?expiry=${expiry}&strike=${strike}&limit=${limit}`)
    .then(r => r.json())
    .then(res => {
      const data = res.data || [];
      renderGreeksCharts(data);
      renderGreeksChangeTable(data);
    })
    .catch(e => toast(`Greeks fetch error: ${e}`, 'err'));
}

function renderGreeksCharts(rows) {
  const area = $('greeks-charts-area');
  if (!rows.length) {
    area.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📈</div>
      <div class="empty-title">No history yet</div>
      <div class="empty-desc">Data accumulates as the option chain is fetched every 5 seconds.</div>
    </div>`;
    return;
  }

  const labels = rows.map(r => r.fetch_time.substring(11, 19));
  const CALL_C = '#10b981', PUT_C = '#f43f5e';

  const chartDefs = [
    { id: 'gc-ltp', title: 'LTP', cK: 'call_ltp', pK: 'put_ltp', dec: 2, desc: 'Last Traded Price' },
    { id: 'gc-delta', title: 'Delta Δ', cK: 'call_delta', pK: 'put_delta', dec: 4, desc: 'Price sensitivity per ₹1 spot move' },
    { id: 'gc-gamma', title: 'Gamma Γ', cK: 'call_gamma', pK: 'put_gamma', dec: 6, desc: 'Rate of Delta change' },
    { id: 'gc-theta', title: 'Theta Θ', cK: 'call_theta', pK: 'put_theta', dec: 2, desc: 'Daily time decay (₹)' },
    { id: 'gc-vega', title: 'Vega V', cK: 'call_vega', pK: 'put_vega', dec: 4, desc: 'Price change per 1% IV shift' },
    { id: 'gc-iv', title: 'IV %', cK: 'call_iv', pK: 'put_iv', dec: 2, desc: 'Implied Volatility' },
  ];

  area.innerHTML = `<div class="greeks-charts-grid">
    ${chartDefs.map(d => `
      <div class="card chart-box" data-idx="${chartDefs.indexOf(d)}">
        <div class="card-head" style="padding:10px 14px">
          <span class="card-title" style="font-size:0.75rem">
            <span class="ico">📉</span>${d.title}
            <span class="text-muted text-xs" style="font-weight:400">${d.desc}</span>
          </span>
          <div class="flex gap-2 text-xs">
            <span class="text-call font-bold">— Call</span>
            <span class="text-put font-bold">— Put</span>
          </div>
        </div>
        <div class="chart-canvas-wrap"><canvas id="${d.id}"></canvas></div>
      </div>`).join('')}
  </div>`;

  // Make each card clickable to open tabular view in modal
  area.querySelectorAll('.chart-box').forEach(el => {
    el.addEventListener('click', () => {
      const d = chartDefs[parseInt(el.dataset.idx, 10)];
      openGreeksModal(d, rows);
    });
  });

  // Destroy old
  Object.values(App.greeksCharts).forEach(ch => ch.destroy());
  App.greeksCharts = {};

  const chartOpts = (dec) => ({
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#12122a',
        borderColor: 'rgba(99,102,241,0.3)', borderWidth: 1,
        titleColor: '#e2e8f0', bodyColor: '#94a3b8',
        padding: 10,
        callbacks: {
          label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(dec) : '—'}`,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: '#475569', maxTicksLimit: 6, font: { size: 9 } },
        grid: { color: 'rgba(255,255,255,0.025)' },
      },
      y: {
        ticks: { color: '#475569', font: { size: 9 } },
        grid: { color: 'rgba(255,255,255,0.025)' },
      },
    },
  });

  chartDefs.forEach(d => {
    const ctx = document.getElementById(d.id)?.getContext('2d');
    if (!ctx) return;
    App.greeksCharts[d.id] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Call',
            data: rows.map(r => r[d.cK]),
            borderColor: CALL_C, backgroundColor: 'rgba(16,185,129,0.06)',
            tension: 0.35, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2, fill: true,
          },
          {
            label: 'Put',
            data: rows.map(r => r[d.pK]),
            borderColor: PUT_C, backgroundColor: 'rgba(244,63,94,0.06)',
            tension: 0.35, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2, fill: true,
          },
        ],
      },
      options: chartOpts(d.dec),
    });
  });
}

// ── Greeks Modal Tabular View ──────────────────────────────
function openGreeksModal(d, rows) {
  const modal = $('greeks-modal');
  if (!modal) return;

  const titleEl = $('gm-title');
  const subEl = $('gm-sub');
  if (titleEl) titleEl.textContent = `${d.title} Historical Data`;
  if (subEl) subEl.textContent = `Expiry: ${App.greeksExpiry} | Strike: ${App.greeksStrike}`;

  const tableWrap = $('gm-table-wrap');
  if (tableWrap) {
    let html = `<div class="oc-scroll" style="max-height: 400px; overflow-y: auto;"><table class="oc-table" style="min-width:100%">
      <thead>
        <tr class="col-row">
          <th class="ch-strike" style="text-align:left; width:220px">Time</th>
          <th class="ch-call">Call Value</th>
          <th class="ch-put">Put Value</th>
        </tr>
      </thead>
      <tbody>`;

    // Render newest rows first but keep track of their original index in 'rows'
    const reversed = [...rows].reverse();
    reversed.forEach((row, i) => {
      // Find original index in chronologically ordered 'rows' array
      const origIdx = rows.indexOf(row);
      const tc = i % 2 === 0 ? 'row-even' : '';
      const cv = parseFloat(row[d.cK]);
      const pv = parseFloat(row[d.pK]);
      html += `<tr class="${tc}" data-idx="${origIdx}">
        <td class="font-mono" style="text-align:left">${row.fetch_time}</td>
        <td class="text-call font-mono">${isNaN(cv) ? '—' : cv.toFixed(d.dec)}</td>
        <td class="text-put font-mono">${isNaN(pv) ? '—' : pv.toFixed(d.dec)}</td>
      </tr>`;
    });

    html += `</tbody></table></div>`;
    tableWrap.innerHTML = html;
  }

  // Destroy previous modal chart instance if it exists
  if (App.modalChart) {
    App.modalChart.destroy();
    App.modalChart = null;
  }

  // Draw chart inside modal (chronological order)
  const ctx = document.getElementById('gm-chart')?.getContext('2d');
  if (ctx) {
    const labels = rows.map(r => r.fetch_time.substring(11, 19));
    const CALL_C = '#10b981', PUT_C = '#f43f5e';

    App.modalChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Call',
            data: rows.map(r => r[d.cK]),
            borderColor: CALL_C, backgroundColor: 'rgba(16,185,129,0.04)',
            tension: 0.3, pointRadius: 0, pointHoverRadius: 6, borderWidth: 2, fill: true,
          },
          {
            label: 'Put',
            data: rows.map(r => r[d.pK]),
            borderColor: PUT_C, backgroundColor: 'rgba(244,63,94,0.04)',
            tension: 0.3, pointRadius: 0, pointHoverRadius: 6, borderWidth: 2, fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, labels: { color: '#94a3b8', boxWidth: 12, font: { size: 10 } } },
          tooltip: {
            backgroundColor: '#12122a',
            borderColor: 'rgba(99,102,241,0.3)', borderWidth: 1,
            titleColor: '#e2e8f0', bodyColor: '#94a3b8',
            padding: 10,
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(d.dec) : '—'}`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#475569', maxTicksLimit: 8, font: { size: 9 } },
            grid: { color: 'rgba(255,255,255,0.025)' },
          },
          y: {
            ticks: { color: '#475569', font: { size: 9 } },
            grid: { color: 'rgba(255,255,255,0.025)' },
          },
        },
        // ── Click on Graph → Highlight & Scroll Table ──
        onClick: (event, activeElements) => {
          if (!activeElements || activeElements.length === 0) return;
          const idx = activeElements[0].index;

          // Clear previous highlights
          const tbody = tableWrap.querySelector('tbody');
          tbody.querySelectorAll('tr').forEach(tr => tr.classList.remove('row-highlight'));

          // Highlight matching row
          const matchRow = tbody.querySelector(`tr[data-idx="${idx}"]`);
          if (matchRow) {
            matchRow.classList.add('row-highlight');
            matchRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        }
      }
    });
  }

  // ── Click on Table Row → Highlight Chart Point ──
  const rowsCollection = tableWrap.querySelectorAll('tbody tr[data-idx]');
  rowsCollection.forEach(rowEl => {
    rowEl.addEventListener('click', () => {
      // Clear previous highlights
      rowsCollection.forEach(r => r.classList.remove('row-highlight'));
      rowEl.classList.add('row-highlight');

      const idx = parseInt(rowEl.dataset.idx, 10);
      if (App.modalChart) {
        // Set chart active elements (both datasets)
        App.modalChart.setActiveElements([
          { datasetIndex: 0, index: idx },
          { datasetIndex: 1, index: idx }
        ]);
        // Set tooltip active element
        App.modalChart.tooltip.setActiveElements([
          { datasetIndex: 0, index: idx },
          { datasetIndex: 1, index: idx }
        ], {
          x: App.modalChart.scales.x.getPixelForValue(idx),
          y: App.modalChart.scales.y.getPixelForValue(rows[idx][d.cK])
        });
        App.modalChart.update();
      }
    });
  });

  modal.style.display = 'flex';
}

function closeGreeksModal(e) {
  const modal = $('greeks-modal');
  if (!modal) return;
  // If clicked, make sure it's the backdrop wrapper or close button click
  if (e && e.target !== modal && !e.target.classList.contains('gm-close')) return;

  // Destroy chart to release canvas memory
  if (App.modalChart) {
    App.modalChart.destroy();
    App.modalChart = null;
  }

  modal.style.display = 'none';
}

function renderGreeksChangeTable(rows) {
  const card = $('greeks-change-card');
  const wrapper = $('greeks-table-wrapper');
  if (!wrapper || !rows.length) { if (card) card.style.display = 'none'; return; }

  if (card) card.style.display = 'block';

  const rangeEl = $('greeks-range-label');
  if (rangeEl && rows.length >= 2) {
    const t1 = rows[0].fetch_time.substring(11, 19);
    const t2 = rows[rows.length - 1].fetch_time.substring(11, 19);
    rangeEl.textContent = `${t1} → ${t2}`;
  }

  const first = rows[0], last = rows[rows.length - 1];
  const greekDefs = [
    { k: 'call_ltp', label: 'Call LTP', dec: 2, side: 'call' },
    { k: 'call_iv', label: 'Call IV %', dec: 2, side: 'call' },
    { k: 'call_delta', label: 'Call Delta', dec: 4, side: 'call' },
    { k: 'call_gamma', label: 'Call Gamma', dec: 6, side: 'call' },
    { k: 'call_theta', label: 'Call Theta', dec: 2, side: 'call' },
    { k: 'call_vega', label: 'Call Vega', dec: 4, side: 'call' },
    { k: 'call_oi', label: 'Call OI', dec: 0, side: 'call' },
    { k: 'put_ltp', label: 'Put LTP', dec: 2, side: 'put' },
    { k: 'put_iv', label: 'Put IV %', dec: 2, side: 'put' },
    { k: 'put_delta', label: 'Put Delta', dec: 4, side: 'put' },
    { k: 'put_gamma', label: 'Put Gamma', dec: 6, side: 'put' },
    { k: 'put_theta', label: 'Put Theta', dec: 2, side: 'put' },
    { k: 'put_vega', label: 'Put Vega', dec: 4, side: 'put' },
    { k: 'put_oi', label: 'Put OI', dec: 0, side: 'put' },
    { k: 'spot_price', label: 'Spot', dec: 2, side: '' },
    { k: 'pcr', label: 'PCR', dec: 4, side: '' },
  ];

  let html = `<table class="gct">
    <thead><tr>
      <th style="text-align:left">Metric</th>
      <th>At Start</th>
      <th>Current</th>
      <th>Change</th>
      <th>% Change</th>
    </tr></thead>
    <tbody>`;

  greekDefs.forEach((gk, i) => {
    const f = parseFloat(first[gk.k]);
    const l = parseFloat(last[gk.k]);
    const chg = l - f;
    const pct = (f !== 0 && !isNaN(f)) ? (chg / Math.abs(f)) * 100 : null;
    const chgCls = chg > 0 ? 'chg-pos' : chg < 0 ? 'chg-neg' : '';
    const pctStr = pct != null
      ? `<span class="pct-badge ${pct >= 0 ? 'pos' : 'neg'}">${fmtPct(pct, 2)}</span>`
      : '—';
    const rowCls = gk.side === 'call' ? 'call-row' : gk.side === 'put' ? 'put-row' : '';

    html += `<tr class="${rowCls}" style="${i % 2 !== 0 ? 'background:var(--row-even)' : ''}">
      <td>${gk.label}</td>
      <td>${isNaN(f) ? '—' : f.toFixed(gk.dec)}</td>
      <td>${isNaN(l) ? '—' : l.toFixed(gk.dec)}</td>
      <td class="${chgCls}">${isNaN(chg) ? '—' : (chg >= 0 ? '+' : '') + chg.toFixed(gk.dec)}</td>
      <td>${pctStr}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  wrapper.innerHTML = html;
}

// ── Formula Builder ───────────────────────────────────────
function fetchAndRenderFormulas() {
  fetch('/api/formulas')
    .then(r => r.json())
    .then(res => {
      App.formulas = res.formulas || [];
      renderFormulaList();
    })
    .catch(() => { });
}

function renderFormulaList() {
  const list = $('formula-list');
  if (!list) return;

  if (!App.formulas.length) {
    list.innerHTML = `<div class="empty-state" style="padding:20px">
      <div class="empty-icon">🧮</div>
      <div class="empty-title">No formulas saved yet</div>
      <div class="empty-desc">Create one using the builder on the left. It'll show as a column in the Live Chain table.</div>
    </div>`;
    return;
  }

  list.innerHTML = App.formulas.map(f => `
    <div class="formula-card">
      <span class="f-dot" style="background:${f.color}"></span>
      <div style="flex:1;min-width:0">
        <div class="f-name">${f.name}</div>
        <div class="f-expr">${f.expression}</div>
        ${f.description ? `<div class="f-desc">${f.description}</div>` : ''}
      </div>
      <div class="f-actions">
        <button class="btn btn-ghost btn-sm" onclick="editFormula(${f.id})">✏️ Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteFormula(${f.id})" style="color:var(--put)">🗑️</button>
      </div>
    </div>
  `).join('');
}

function editFormula(id) {
  const f = App.formulas.find(x => x.id === id);
  if (!f) return;
  $('formula-id').value = f.id;
  $('formula-name-input').value = f.name;
  $('formula-expr-input').value = f.expression;
  $('formula-desc-input').value = f.description || '';
  $('formula-color-input').value = f.color || '#60a5fa';
  $('formula-form-title').innerHTML = '<span class="ico">✏️</span> Edit Formula';
  $('formula-form-title').closest('.card-head')?.scrollIntoView({ behavior: 'smooth' });
}

function deleteFormula(id) {
  if (!confirm('Delete this formula?')) return;
  fetch(`/api/formulas/${id}`, { method: 'DELETE' })
    .then(() => { toast('Formula deleted.', 'ok'); fetchAndRenderFormulas(); })
    .catch(e => toast(`Error: ${e}`, 'err'));
}

function clearFormulaForm() {
  $('formula-id').value = '';
  $('formula-name-input').value = '';
  $('formula-expr-input').value = '';
  $('formula-desc-input').value = '';
  $('formula-color-input').value = '#60a5fa';
  $('formula-form-title').innerHTML = '<span class="ico">➕</span> New Formula';
  $('formula-validation-msg').innerHTML = '';
}

function insertVar(v) {
  const ta = $('formula-expr-input');
  if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + v + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + v.length;
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

// Live validation
$('formula-expr-input')?.addEventListener('input', debounce(async function () {
  const expr = this.value.trim();
  const el = $('formula-validation-msg');
  if (!expr) { el.innerHTML = ''; return; }
  try {
    const res = await fetch('/api/formulas/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: expr }),
    });
    const data = await res.json();
    el.innerHTML = data.valid
      ? `<span class="validate-badge ok">✅ Valid expression</span>`
      : `<span class="validate-badge err">❌ ${data.error}</span>`;
  } catch { el.innerHTML = ''; }
}, 450));

$('formula-save-btn')?.addEventListener('click', async () => {
  const id = $('formula-id').value;
  const name = $('formula-name-input').value.trim();
  const expr = $('formula-expr-input').value.trim();
  const desc = $('formula-desc-input').value.trim();
  const color = $('formula-color-input').value;
  if (!name) { toast('Enter a formula name.', 'warn'); return; }
  if (!expr) { toast('Enter an expression.', 'warn'); return; }

  const payload = { name, expression: expr, description: desc, color };
  if (id) payload.id = parseInt(id);

  const res = await fetch('/api/formulas', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.error) { toast(`Error: ${data.error}`, 'err'); return; }
  toast('Formula saved!', 'ok');
  clearFormulaForm();
  fetchAndRenderFormulas();
});

// ── History ───────────────────────────────────────────────

// Convert datetime-local value (YYYY-MM-DDTHH:MM) to API format (YYYY-MM-DD HH:MM)
function dtLocalToApi(v) {
  return v ? v.replace('T', ' ') : '';
}

// Convert Date object to datetime-local input value (YYYY-MM-DDTHH:MM)
function toDatetimeLocal(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Set quick date-range presets into the From/To datetime-local inputs.
 *  @param {number|'today'|'all'} preset  Minutes back, or special keyword */
function setHistoryRange(preset) {
  const now = new Date();
  let from;

  if (preset === 'all') {
    $('history-from').value = '';
    $('history-to').value = toDatetimeLocal(now);
    return;
  }
  if (preset === 'today') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 15);
  } else {
    from = new Date(now.getTime() - preset * 60 * 1000);
  }
  $('history-from').value = toDatetimeLocal(from);
  $('history-to').value = toDatetimeLocal(now);

  // Highlight active chip
  document.querySelectorAll('.preset-chip').forEach(b => b.classList.remove('active'));
  event?.target?.classList?.add('active');
}

async function loadHistory() {
  const expiry = $('history-expiry-sel')?.value;
  const from = dtLocalToApi($('history-from')?.value);
  const to = dtLocalToApi($('history-to')?.value);
  const limit = $('history-limit')?.value || 500;

  if (!expiry) { toast('Select an expiry date.', 'warn'); return; }

  $('history-table-wrapper').innerHTML = `<div class="empty-state"><div class="loading-ring"></div><div class="empty-title">Loading…</div></div>`;

  let url = `/api/history?expiry=${expiry}&limit=${limit}`;
  if (from) url += `&from=${encodeURIComponent(from)}`;
  if (to) url += `&to=${encodeURIComponent(to)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    const rows = data.data || [];

    const cnt = $('history-count');
    if (cnt) { cnt.textContent = `${rows.length} rows`; cnt.style.display = 'inline-block'; }

    renderHistoryTable(rows, expiry);
  } catch (e) { toast(`History error: ${e}`, 'err'); }
}

function renderHistoryTable(rows, expiry) {
  // Store for export
  App.historyRows = rows;
  App.historyExpiry = expiry || $('history-expiry-sel')?.value || 'history';

  // Enable / disable export buttons
  const hasRows = rows.length > 0;
  const btnCsv = $('btn-export-csv');
  const btnXls = $('btn-export-excel');
  if (btnCsv) btnCsv.disabled = !hasRows;
  if (btnXls) btnXls.disabled = !hasRows;

  const wrapper = $('history-table-wrapper');
  if (!rows.length) {
    wrapper.innerHTML = `<div class="empty-state"><div class="empty-icon">📂</div><div class="empty-title">No data found</div><div class="empty-desc">Try a different expiry or date range.</div></div>`;
    return;
  }

  const cols = [
    { k: 'fetch_time', l: 'Time' },
    { k: 'strike_price', l: 'Strike' },
    { k: 'spot_price', l: 'Spot' },
    { k: 'call_ltp', l: 'Call LTP' },
    { k: 'call_oi', l: 'Call OI' },
    { k: 'call_iv', l: 'Call IV' },
    { k: 'call_delta', l: 'Call Δ' },
    { k: 'call_theta', l: 'Call Θ' },
    { k: 'call_vega', l: 'Call V' },
    { k: 'put_ltp', l: 'Put LTP' },
    { k: 'put_oi', l: 'Put OI' },
    { k: 'put_iv', l: 'Put IV' },
    { k: 'put_delta', l: 'Put Δ' },
    { k: 'put_theta', l: 'Put Θ' },
    { k: 'put_vega', l: 'Put V' },
    { k: 'pcr', l: 'PCR' },
    { k: 'is_atm', l: 'ATM' },
  ];

  let html = `<div class="oc-scroll"><table class="oc-table" style="min-width:1400px">
    <thead>
      <tr class="col-row">
        ${cols.map(c => `<th class="ch-call">${c.l}</th>`).join('')}
      </tr>
    </thead>
    <tbody>`;

  rows.slice(0, 2000).forEach((row, i) => {
    const cls = row.is_atm ? 'row-atm' : i % 2 === 0 ? 'row-even' : '';
    html += `<tr class="${cls}">`;
    cols.forEach(c => {
      const v = row[c.k];
      if (c.k === 'is_atm') html += `<td class="text-center">${v ? '★' : ''}</td>`;
      else if (c.k === 'fetch_time') html += `<td class="font-mono" style="font-size:0.65rem;white-space:nowrap">${v || '—'}</td>`;
      else {
        const n = parseFloat(v);
        html += `<td class="text-right">${isNaN(n) ? (v || '—') : n.toLocaleString('en-IN', { maximumFractionDigits: 4 })}</td>`;
      }
    });
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  wrapper.innerHTML = html;
}

// ── Export helpers ────────────────────────────────────────
const EXPORT_COLS = [
  'fetch_time', 'strike_price', 'spot_price',
  'call_ltp', 'call_oi', 'call_iv', 'call_delta', 'call_gamma', 'call_theta', 'call_vega',
  'put_ltp', 'put_oi', 'put_iv', 'put_delta', 'put_gamma', 'put_theta', 'put_vega',
  'pcr', 'is_atm',
];

function _rowsToDelimited(rows, sep) {
  const header = EXPORT_COLS.join(sep);
  const lines = rows.map(r =>
    EXPORT_COLS.map(k => {
      const v = r[k];
      if (v === null || v === undefined) return '';
      const s = String(v);
      // Quote if contains separator, quote, or newline
      return s.includes(sep) || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    }).join(sep)
  );
  return [header, ...lines].join('\n');
}

function _triggerDownload(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

function exportHistoryCSV() {
  if (!App.historyRows?.length) { toast('Load data first.', 'warn'); return; }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const csv = _rowsToDelimited(App.historyRows, ',');
  _triggerDownload('\uFEFF' + csv,   // BOM for Excel UTF-8 recognition
    `option_chain_${App.historyExpiry}_${ts}.csv`, 'text/csv;charset=utf-8');
  toast('CSV downloaded!', 'ok');
}

function exportHistoryExcel() {
  if (!App.historyRows?.length) { toast('Load data first.', 'warn'); return; }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const tsv = _rowsToDelimited(App.historyRows, '\t');
  _triggerDownload(tsv,
    `option_chain_${App.historyExpiry}_${ts}.xls`, 'application/vnd.ms-excel;charset=utf-8');
  toast('Excel file downloaded!', 'ok');
}

// ── Settings & Auth ───────────────────────────────────────
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();

    if ($('cfg-strikes')) { $('cfg-strikes').value = cfg.strikes_around_atm || 20; }
    if ($('cfg-strikes-val')) { $('cfg-strikes-val').textContent = cfg.strikes_around_atm || 20; }
    if ($('cfg-refresh')) { $('cfg-refresh').value = cfg.refresh_interval || 5; }
    if ($('cfg-client-id')) { $('cfg-client-id').value = cfg.client_id || ''; }
    if ($('cfg-redirect-uri')) { $('cfg-redirect-uri').value = cfg.redirect_uri || ''; }

    // Underlying dropdown
    const sel = $('cfg-underlying');
    if (sel && cfg.underlyings) {
      sel.innerHTML = Object.entries(cfg.underlyings)
        .map(([label, val]) => `<option value="${val}" ${val === cfg.underlying ? 'selected' : ''}>${label}</option>`)
        .join('');
    } else if (sel && cfg.underlying) {
      [...sel.options].forEach(o => { o.selected = o.value === cfg.underlying; });
    }

    syncTokenBadge(cfg.has_token);
  } catch (e) { console.warn('Config load error', e); }
}

async function openAuthUrl() {
  const res = await fetch('/api/auth/url');
  const data = await res.json();
  const section = $('auth-code-section');
  const note = $('auth-redirect-note');
  if (note) note.innerHTML = `After logging in you'll be redirected to:<br><code>${data.redirect_uri}</code><br>Copy the <code>?code=XXXXX</code> value and paste below:`;
  if (section) section.style.display = 'block';
  window.open(data.url, '_blank');
}

async function submitAuthCode() {
  const code = $('auth-code-input')?.value.trim();
  if (!code) { toast('Paste the authorization code.', 'warn'); return; }
  const res = await fetch('/api/auth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (data.error) { toast(`Auth error: ${data.error}`, 'err'); return; }
  toast(data.message || 'Authenticated!', 'ok');
  $('auth-code-input').value = '';
  $('auth-code-section').style.display = 'none';
  loadConfig();
}

async function submitManualToken() {
  const token = $('manual-token-input')?.value.trim();
  if (!token) { toast('Paste the access token.', 'warn'); return; }
  const res = await fetch('/api/auth/manual_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await res.json();
  if (data.error) { toast(`Error: ${data.error}`, 'err'); return; }
  toast('Token saved! Streaming will begin shortly.', 'ok');
  $('manual-token-input').value = '';
  loadConfig();
}

async function saveConfig() {
  // Apply and persist font size (local only — not sent to server)
  const fsVal = $('cfg-fontsize')?.value;
  if (fsVal) applyChainFontSize(fsVal);

  const payload = {
    underlying: $('cfg-underlying')?.value,
    strikes_around_atm: parseInt($('cfg-strikes')?.value || 20),
    refresh_interval: parseInt($('cfg-refresh')?.value || 5),
    client_id: $('cfg-client-id')?.value,
    redirect_uri: $('cfg-redirect-uri')?.value,
  };
  const secret = $('cfg-client-secret')?.value;
  if (secret) payload.client_secret = secret;

  const res = await fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  toast(data.success ? 'Configuration saved!' : 'Failed to save.', data.success ? 'ok' : 'err');
}

// ── Stream Control ────────────────────────────────────────
async function startStream() {
  await fetch('/api/streaming/start', { method: 'POST' });
  toast('Streaming started.', 'ok');
}
async function stopStream() {
  await fetch('/api/streaming/stop', { method: 'POST' });
  toast('Streaming paused.', 'info');
}

// ── Utilities ─────────────────────────────────────────────
function debounce(fn, ms) {
  let t;
  return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
}

// Range slider display
document.querySelectorAll('input[type="range"][data-display]').forEach(el => {
  el.addEventListener('input', () => {
    const t = $(el.dataset.display);
    if (t) t.textContent = el.value;
  });
});

// ── Bootstrap ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Restore sidebar collapse state from localStorage
  if (localStorage.getItem('upstox_sidebar_collapsed') === '1') {
    document.querySelector('.layout')?.classList.add('sidebar-collapsed');
  }

  // Immediately restore badge from last known state so page doesn't
  // flash "Connecting…" while the WebSocket handshake completes.
  if (App.streaming && App.tokenValid) {
    updateBadge('live');
  } else if (App.tokenValid) {
    updateBadge('paused');
  } else if (App.tokenValid === false && localStorage.getItem('upstox_token_valid') !== null) {
    updateBadge('auth');
  }
  updateStreamButtons();
  syncTokenBadge(App.tokenValid);

  navigate('live');
  loadConfig();
  fetchAndRenderFormulas();
  startVixPolling();

  // Nested scroll propagation for .oc-scroll to prevent scroll-lock
  const ocScroll = document.querySelector('.oc-scroll');
  const mainEl = document.querySelector('.main');
  if (ocScroll && mainEl) {
    ocScroll.addEventListener('wheel', (e) => {
      const { scrollTop, scrollHeight, clientHeight } = ocScroll;
      const delta = e.deltaY;
      if ((delta > 0 && scrollTop + clientHeight >= scrollHeight - 1) || 
          (delta < 0 && scrollTop <= 1)) {
        mainEl.scrollTop += delta;
      }
    }, { passive: true });
  }

  // Default date range for history (datetime-local format: YYYY-MM-DDTHH:MM)
  const now = new Date();
  const from = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  if ($('history-to')) $('history-to').value = toDatetimeLocal(now);
  if ($('history-from')) $('history-from').value = toDatetimeLocal(from);
});

// Expose globals for inline onclick handlers
Object.assign(window, {
  navigate, startStream, stopStream, toggleSidebar,
  openAuthUrl, submitAuthCode, submitManualToken, saveConfig,
  loadGreeksHistory, loadHistory,
  setHistoryRange, exportHistoryCSV, exportHistoryExcel,
  editFormula, deleteFormula, clearFormulaForm, insertVar,
  closeGreeksModal,
});

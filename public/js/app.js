import { TOKENS, CARD_COLORS, getTokenInfo, getCardGradient } from './icons.js';
import { playPaySuccessSound, playBankAlertSound, playErrorSound, triggerHaptic } from './audio_haptics.js';
import { attachHolographicCard, animateNumber } from './card_fx.js';
import { renderQrSvg, startQrScanner } from './qr.js';
import { isWebNfcSupported, readNfcPaymentTag, writeNfcPaymentTag } from './nfc.js';
import { COLOR_GROUPS, getClassicItalianDeckClient, saveDeckLocally, loadLocalDeck } from './classic_deck.js';

const SESSION_KEY = 'monopoly_pay_session_v1';

const state = {
  room: null,
  playerId: null,
  activeTab: 'wallet',
  propFilter: 'all',
  logFilter: 'all',
  bankerMode: 'personal', // 'personal' | 'bank'
  lastSeenLogId: null,
  sse: null,
  lanOrigin: window.location.origin,
  onboardingMode: 'join',
  selectedToken: 'cane',
  selectedColor: CARD_COLORS[0].id,
  editorDeck: null,
};

// Register PWA Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Use LAN IP for QR invites only when running locally on localhost/127.0.0.1
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
  fetch('/api/server-info')
    .then((r) => r.json())
    .then((info) => {
      if (info.lanIp && info.lanIp !== '127.0.0.1') {
        state.lanOrigin = `${window.location.protocol}//${info.lanIp}:${info.port}`;
      }
    })
    .catch(() => {});
}

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Errore di rete');
    err.code = data.code;
    err.extra = data.extra;
    throw err;
  }
  return data;
}

function showBanner(text) {
  const el = document.getElementById('global-banner');
  const txt = document.getElementById('global-banner-text');
  txt.textContent = text;
  el.classList.add('show');
  playBankAlertSound();
  clearTimeout(showBanner._timer);
  showBanner._timer = setTimeout(() => el.classList.remove('show'), 5200);
}

function showPaySuccess(title, sub = '') {
  const ov = document.getElementById('pay-success-overlay');
  document.getElementById('pay-success-title').textContent = title;
  document.getElementById('pay-success-sub').textContent = sub;
  ov.classList.remove('hidden');
  playPaySuccessSound();
  setTimeout(() => ov.classList.add('hidden'), 1450);
}

function handleActionError(err) {
  playErrorSound();
  if (err.code === 'INSUFFICIENT_FUNDS' && err.extra) {
    openDebtAssistantModal(err.extra, err.message);
    return;
  }
  alert(err.message);
}

function saveSession(roomCode, playerId) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, playerId }));
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch (_) {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function cur() {
  return state.room?.currency || '€';
}

function me() {
  return state.room?.players?.[state.playerId] || null;
}

function isBanker() {
  return state.room?.bankerId === state.playerId;
}

function connectSSE(roomCode) {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  const es = new EventSource(`/api/rooms/${roomCode}/stream`);
  es.onmessage = (ev) => {
    try {
      const room = JSON.parse(ev.data);
      applyRoomUpdate(room);
    } catch (_) {}
  };
  state.sse = es;
}

function applyRoomUpdate(room) {
  const prevVersion = state.room?.version || 0;
  state.room = room;

  if (room.auditLog && room.auditLog.length > 0) {
    const latest = room.auditLog[room.auditLog.length - 1];
    if (state.lastSeenLogId && latest.id !== state.lastSeenLogId && latest.globalBanner) {
      showBanner(latest.globalBanner);
    }
    state.lastSeenLogId = latest.id;
  }

  if (room.version !== prevVersion || prevVersion === 0) {
    renderApp();
  }
}

/* ================= ONBOARDING ================= */
function initOnboarding() {
  const params = new URLSearchParams(window.location.search);
  const urlRoom = params.get('room');
  if (urlRoom) {
    document.getElementById('inp-room-code').value = urlRoom.toUpperCase();
  }

  const saved = loadSession();
  if (saved && saved.roomCode && saved.playerId) {
    const box = document.getElementById('resume-session-box');
    box.classList.remove('hidden');
    document.getElementById('btn-resume-session').onclick = async () => {
      try {
        const res = await api(`/api/rooms/${saved.roomCode}`);
        if (res.room && res.room.players[saved.playerId]) {
          enterRoom(res.room, saved.playerId);
        } else {
          clearSession();
          box.classList.add('hidden');
        }
      } catch (_) {
        clearSession();
        box.classList.add('hidden');
      }
    };
  }

  const tokenPicker = document.getElementById('token-picker');
  tokenPicker.innerHTML = TOKENS.map(
    (t) => `<button type="button" class="token-option ${t.id === state.selectedToken ? 'selected' : ''}" data-token="${t.id}">
      <span class="big">${t.emoji}</span>${t.label}
    </button>`
  ).join('');
  tokenPicker.onclick = (e) => {
    const btn = e.target.closest('[data-token]');
    if (!btn) return;
    state.selectedToken = btn.dataset.token;
    tokenPicker.querySelectorAll('.token-option').forEach((el) => el.classList.toggle('selected', el === btn));
  };

  const colorPicker = document.getElementById('color-picker');
  colorPicker.innerHTML = CARD_COLORS.map(
    (c) => `<button type="button" class="color-dot ${c.id === state.selectedColor ? 'selected' : ''}" data-color="${c.id}" style="background: ${c.gradient}" title="${c.name}"></button>`
  ).join('');
  colorPicker.onclick = (e) => {
    const btn = e.target.closest('[data-color]');
    if (!btn) return;
    state.selectedColor = btn.dataset.color;
    colorPicker.querySelectorAll('.color-dot').forEach((el) => el.classList.toggle('selected', el === btn));
  };

  const tabJoin = document.getElementById('tab-mode-join');
  const tabCreate = document.getElementById('tab-mode-create');
  const setMode = (mode) => {
    state.onboardingMode = mode;
    tabJoin.classList.toggle('active', mode === 'join');
    tabCreate.classList.toggle('active', mode === 'create');
    document.getElementById('join-only-fields').classList.toggle('hidden', mode !== 'join');
    document.getElementById('create-only-fields').classList.toggle('hidden', mode !== 'create');
    document.getElementById('btn-onboarding-submit').textContent =
      mode === 'create' ? 'Crea Stanza & Diventa Banchiere' : 'Entra nella Stanza';
  };
  tabJoin.onclick = () => setMode('join');
  tabCreate.onclick = () => setMode('create');

  document.getElementById('onboarding-form').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('onboarding-error');
    errEl.textContent = '';
    const name = document.getElementById('inp-player-name').value.trim();

    try {
      if (state.onboardingMode === 'create') {
        const localDeck = loadLocalDeck();
        const res = await api('/api/rooms', 'POST', {
          bankerName: name,
          token: state.selectedToken,
          color: state.selectedColor,
          currency: document.getElementById('inp-currency').value,
          startingBalance: Number(document.getElementById('inp-start-bal').value || 1500),
          freeParkingEnabled: document.getElementById('inp-free-parking').checked,
          customDeck: localDeck || undefined,
        });
        enterRoom(res.room, res.playerId);
      } else {
        const code = document.getElementById('inp-room-code').value.trim().toUpperCase();
        if (!code) throw new Error('Inserisci il codice stanza.');
        const res = await api(`/api/rooms/${code}/join`, 'POST', {
          name,
          token: state.selectedToken,
          color: state.selectedColor,
        });
        enterRoom(res.room, res.playerId);
      }
    } catch (err) {
      errEl.textContent = err.message;
    }
  };
}

function enterRoom(room, playerId) {
  state.room = room;
  state.playerId = playerId;
  state.lastSeenLogId = room.auditLog?.[room.auditLog.length - 1]?.id || null;
  saveSession(room.code, playerId);

  document.getElementById('onboarding-view').classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');
  document.getElementById('room-code-label').textContent = room.code;

  connectSSE(room.code);
  renderApp();
}

/* ================= NAVIGATION & RENDER ================= */
function initNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.onclick = () => {
      state.activeTab = btn.dataset.tab;
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      document.getElementById(`tab-${state.activeTab}`).classList.remove('hidden');
      renderApp();
    };
  });

  document.getElementById('btn-room-badge').onclick = () => openInviteModal();
  document.getElementById('modal-backdrop').onclick = closeModal;
}

function renderApp() {
  if (!state.room || !me()) return;
  const player = me();
  document.getElementById('header-subtitle').textContent =
    isBanker() ? `Direttore di Banca • ${player.name}` : `Giocatore • ${player.name}`;

  if (state.activeTab === 'wallet') renderWalletTab();
  if (state.activeTab === 'properties') renderPropertiesTab();
  if (state.activeTab === 'bank') renderBankTab();
  if (state.activeTab === 'log') renderLogTab();
}

/* ================= TAB 1: WALLET ================= */
function renderWalletTab() {
  const container = document.getElementById('tab-wallet');
  const player = me();
  const token = getTokenInfo(player.token);
  const inBankMode = isBanker() && state.bankerMode === 'bank';

  const switchHtml = isBanker()
    ? `<div class="banker-switch-bar">
        <button class="banker-switch-btn ${!inBankMode ? 'active' : ''}" id="sw-personal" type="button">💳 Conto Personale</button>
        <button class="banker-switch-btn ${inBankMode ? 'active bank-mode' : ''}" id="sw-bank" type="button">🏦 Cassa Banca</button>
      </div>`
    : '';

  const cardBg = inBankMode
    ? 'linear-gradient(135deg, #FF9F0A 0%, #BF5AF2 55%, #1C1C2E 100%)'
    : getCardGradient(player.color);

  const cardHtml = `
    <div class="wallet-card-wrap">
      <div id="virtual-card" class="virtual-card" style="background: ${cardBg};">
        <div class="card-top">
          <div>
            <div class="card-brand">${inBankMode ? 'BANCA CENTRALE MONOPOLY' : 'MONOPOLY PAY'}</div>
            <div class="card-sub">${inBankMode ? 'Modalità Direttore di Banca' : `Stanza ${state.room.code}`}</div>
          </div>
          <div class="card-token-badge">${inBankMode ? '🏦 Cassaforte' : `${token.emoji} ${token.label}`}</div>
        </div>
        <div>
          <div class="card-balance-label">${inBankMode ? 'Fondi Banca' : 'Saldo Disponibile'}</div>
          <div id="animated-balance" class="card-balance-value">${inBankMode ? '∞ Illimitato' : ''}</div>
        </div>
        <div class="card-bottom">
          <div>
            <div class="card-holder">${inBankMode ? 'CASSA DELLA BANCA' : player.name.toUpperCase()}</div>
            <div class="card-sub">${player.isBankrupt ? '⚠️ IN BANCAROTTA' : '•••• •••• •••• ' + state.room.code.slice(-4)}</div>
          </div>
          <div style="font-size: 20px; opacity: 0.9;"> contactless ᯤ</div>
        </div>
      </div>
    </div>
  `;

  const actionsHtml = inBankMode
    ? `<div class="action-row">
        <button id="btn-bank-credit" class="btn btn-warning" type="button">💸 Accredita Giocatore</button>
        <button id="btn-bank-via" class="btn btn-success" type="button">🏁 Passaggio VIA (+200)</button>
      </div>`
    : `<div class="action-row">
        <button id="btn-pay-open" class="btn btn-primary" type="button" ${player.isBankrupt ? 'disabled' : ''}>⚡ Paga / Trasferisci</button>
        <button id="btn-receive-qr" class="btn btn-secondary" type="button">📲 Ricevi (QR / NFC)</button>
      </div>`;

  const freeParkingHtml = state.room.freeParkingEnabled
    ? `<div class="glass" style="margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <div style="font-size: 12px; color: var(--text-dim);">🅿️ Salvadanaio Parcheggio Gratuito</div>
          <div style="font-size: 22px; font-weight: 800; color: var(--amber);">${state.room.freeParkingPot.toLocaleString('it-IT')} ${cur()}</div>
        </div>
        ${isBanker() && state.room.freeParkingPot > 0 ? `<button id="btn-claim-fp" class="btn btn-warning btn-sm" type="button">Assegna</button>` : ''}
      </div>`
    : '';

  const inboxHtml = renderPendingInbox();

  const playersHtml = Object.values(state.room.players)
    .map((p) => {
      const tk = getTokenInfo(p.token);
      return `<div class="player-row ${p.isBankrupt ? 'bankrupt' : ''}">
        <div class="player-meta">
          <div class="player-avatar" style="background: ${getCardGradient(p.color)}">${tk.emoji}</div>
          <div>
            <div class="player-name">${p.name} ${p.id === state.playerId ? '(Tu)' : ''}</div>
            <div class="player-role">${p.isBanker ? '🏦 Banchiere' : 'Giocatore'}${p.isBankrupt ? ' • Bancarotta' : ''}</div>
          </div>
        </div>
        <div class="player-balance">${p.balance.toLocaleString('it-IT')} ${cur()}</div>
      </div>`;
    })
    .join('');

  container.innerHTML = `
    ${switchHtml}
    ${cardHtml}
    ${actionsHtml}
    ${freeParkingHtml}
    ${inboxHtml}
    <div class="section-head"><span class="section-title">Giocatori al Tavolo</span></div>
    <div class="player-list">${playersHtml}</div>
  `;

  attachHolographicCard(document.getElementById('virtual-card'));
  if (!inBankMode) {
    animateNumber(document.getElementById('animated-balance'), player.balance, cur());
  }

  if (isBanker()) {
    document.getElementById('sw-personal')?.addEventListener('click', () => {
      state.bankerMode = 'personal';
      renderWalletTab();
    });
    document.getElementById('sw-bank')?.addEventListener('click', () => {
      state.bankerMode = 'bank';
      renderWalletTab();
    });
  }

  document.getElementById('btn-pay-open')?.addEventListener('click', () => openPayModal());
  document.getElementById('btn-receive-qr')?.addEventListener('click', () => openReceiveModal());
  document.getElementById('btn-bank-credit')?.addEventListener('click', () => openBankTransferModal());
  document.getElementById('btn-bank-via')?.addEventListener('click', () => openQuickViaModal());
  document.getElementById('btn-claim-fp')?.addEventListener('click', () => openClaimFreeParkingModal());

  bindInboxActions();
}

function renderPendingInbox() {
  const reqs = state.room.pendingRequests || [];
  const relevant = reqs.filter((r) => {
    if (r.type === 'rent_charge') return r.fromPlayerId === state.playerId;
    if (r.type === 'trade_offer') return r.toPlayerId === state.playerId && r.status === 'pending_recipient';
    if (isBanker() && (r.type === 'build_request' || r.type === 'mortgage_request' || (r.type === 'trade_offer' && r.status === 'pending_banker'))) {
      return true;
    }
    return false;
  });

  if (relevant.length === 0) return '';

  const cards = relevant
    .map((r) => {
      if (r.type === 'rent_charge') {
        const owner = state.room.players[r.toPlayerId];
        return `<div class="req-card">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 4px;">💸 Richiesta Affitto: ${r.propertyName}</div>
          <div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">
            Da pagare a <b>${owner?.name}</b> • ${r.detail} • <b>${r.amount} ${cur()}</b>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-success btn-sm" style="flex:1" data-rent-pay="${r.id}">Apple Pay • ${r.amount} ${cur()}</button>
            <button class="btn btn-secondary btn-sm" data-rent-dismiss="${r.id}">Annulla</button>
          </div>
        </div>`;
      }
      if (r.type === 'trade_offer' && r.status === 'pending_recipient') {
        const from = state.room.players[r.fromPlayerId];
        return `<div class="req-card">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 4px;">🤝 Proposta di Scambio da ${from?.name}</div>
          <div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">
            Ti offre: ${formatTradeSide(r.offerProperties, r.offerCash)}<br/>
            Chiede: ${formatTradeSide(r.requestProperties, r.requestCash)}
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-success btn-sm" style="flex:1" data-trade-resp="${r.id}" data-acc="1">Accetta</button>
            <button class="btn btn-danger btn-sm" data-trade-resp="${r.id}" data-acc="0">Rifiuta</button>
          </div>
        </div>`;
      }
      if (r.type === 'build_request' && isBanker()) {
        const p = state.room.players[r.playerId];
        const verb = r.action === 'build' ? 'Costruire su' : 'Vendere edificio su';
        return `<div class="req-card" style="border-color: rgba(255,159,10,0.45); background: rgba(255,159,10,0.08);">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 4px;">🏦 Approvazione Edificio</div>
          <div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">
            <b>${p?.name}</b> chiede di ${verb} <b>${r.propertyName}</b> (${r.amount} ${cur()})
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-warning btn-sm" style="flex:1" data-build-app="${r.id}" data-acc="1">Approva</button>
            <button class="btn btn-secondary btn-sm" data-build-app="${r.id}" data-acc="0">Rifiuta</button>
          </div>
        </div>`;
      }
      if (r.type === 'mortgage_request' && isBanker()) {
        const p = state.room.players[r.playerId];
        const verb = r.action === 'mortgage' ? 'Ipotecare' : 'Disipotecare';
        return `<div class="req-card" style="border-color: rgba(255,159,10,0.45); background: rgba(255,159,10,0.08);">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 4px;">🏦 Approvazione Ipoteca</div>
          <div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">
            <b>${p?.name}</b> chiede di ${verb} <b>${r.propertyName}</b> (${r.amount} ${cur()})
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-warning btn-sm" style="flex:1" data-mort-app="${r.id}" data-acc="1">Approva</button>
            <button class="btn btn-secondary btn-sm" data-mort-app="${r.id}" data-acc="0">Rifiuta</button>
          </div>
        </div>`;
      }
      if (r.type === 'trade_offer' && r.status === 'pending_banker' && isBanker()) {
        const p1 = state.room.players[r.fromPlayerId];
        const p2 = state.room.players[r.toPlayerId];
        return `<div class="req-card" style="border-color: rgba(255,159,10,0.45); background: rgba(255,159,10,0.08);">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 4px;">🏦 Convalida Scambio</div>
          <div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px;">
            <b>${p1?.name}</b> ⇄ <b>${p2?.name}</b> (accettato da entrambi)
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-warning btn-sm" style="flex:1" data-trade-app="${r.id}" data-acc="1">Convalida Scambio</button>
            <button class="btn btn-secondary btn-sm" data-trade-app="${r.id}" data-acc="0">Annulla</button>
          </div>
        </div>`;
      }
      return '';
    })
    .join('');

  return `<div class="section-head"><span class="section-title">Notifiche &amp; Approvazioni</span></div>${cards}`;
}

function formatTradeSide(propIds, cash) {
  const names = (propIds || []).map((id) => state.room.properties.find((p) => p.id === id)?.name || id);
  if (cash > 0) names.push(`${cash} ${cur()}`);
  return names.length ? names.join(', ') : 'Nulla';
}

function bindInboxActions() {
  document.querySelectorAll('[data-rent-pay]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/api/rooms/${state.room.code}/rent/respond`, 'POST', {
          actorId: state.playerId,
          requestId: btn.dataset.rentPay,
          accept: true,
        });
        showPaySuccess('Affitto Pagato!');
      } catch (err) {
        handleActionError(err);
      }
    };
  });

  document.querySelectorAll('[data-rent-dismiss]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/api/rooms/${state.room.code}/rent/respond`, 'POST', {
          actorId: state.playerId,
          requestId: btn.dataset.rentDismiss,
          accept: false,
        });
      } catch (err) {
        handleActionError(err);
      }
    };
  });

  document.querySelectorAll('[data-trade-resp]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/api/rooms/${state.room.code}/trade/respond`, 'POST', {
          actorId: state.playerId,
          requestId: btn.dataset.tradeResp,
          accept: btn.dataset.acc === '1',
        });
        triggerHaptic([20]);
      } catch (err) {
        handleActionError(err);
      }
    };
  });

  document.querySelectorAll('[data-build-app]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/api/rooms/${state.room.code}/build/approve`, 'POST', {
          actorId: state.playerId,
          requestId: btn.dataset.buildApp,
          approve: btn.dataset.acc === '1',
        });
        triggerHaptic([20]);
      } catch (err) {
        handleActionError(err);
      }
    };
  });

  document.querySelectorAll('[data-mort-app]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/api/rooms/${state.room.code}/mortgage/approve`, 'POST', {
          actorId: state.playerId,
          requestId: btn.dataset.mortApp,
          approve: btn.dataset.acc === '1',
        });
        triggerHaptic([20]);
      } catch (err) {
        handleActionError(err);
      }
    };
  });

  document.querySelectorAll('[data-trade-app]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/api/rooms/${state.room.code}/trade/approve`, 'POST', {
          actorId: state.playerId,
          requestId: btn.dataset.tradeApp,
          approve: btn.dataset.acc === '1',
        });
        showPaySuccess('Scambio Convalidato!');
      } catch (err) {
        handleActionError(err);
      }
    };
  });
}

/* ================= TAB 2: PROPRIETÀ ================= */
function renderPropertiesTab() {
  const container = document.getElementById('tab-properties');
  const props = state.room.properties || [];

  const filtered = props.filter((p) => {
    if (state.propFilter === 'mine') return p.ownerId === state.playerId;
    if (state.propFilter === 'free') return !p.ownerId;
    if (state.propFilter === 'mortgaged') return p.mortgaged;
    return true;
  });

  const gridHtml = filtered
    .map((p) => {
      const cg = COLOR_GROUPS[p.colorGroup] || { hex: '#8E8E93', label: p.colorGroup };
      const owner = p.ownerId ? state.room.players[p.ownerId] : null;
      const housesHtml =
        p.houses === 5
          ? `<span class="hotel-dot">H</span>`
          : Array.from({ length: p.houses || 0 })
              .map(() => `<span class="house-dot"></span>`)
              .join('');

      return `<div class="prop-card ${p.mortgaged ? 'mortgaged' : ''}" data-prop-id="${p.id}">
        <div class="prop-color-bar" style="background: ${cg.hex};"></div>
        ${p.mortgaged ? `<div class="mortgage-stamp">IPOTECATA</div>` : ''}
        <div class="prop-body">
          <div class="prop-name">${p.name}</div>
          <div class="prop-owner">${owner ? `${getTokenInfo(owner.token).emoji} ${owner.name}` : '🏦 Libera'}</div>
          <div class="prop-footer">
            <span>${p.price} ${cur()}</span>
            <div class="houses-row">${housesHtml}</div>
          </div>
        </div>
      </div>`;
    })
    .join('');

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
      <div class="section-title">Contratti &amp; Immobili</div>
      <button id="btn-open-trade" class="btn btn-secondary btn-sm" type="button">🤝 Scambia</button>
    </div>
    <div class="filter-pills">
      <button class="pill-btn ${state.propFilter === 'all' ? 'active' : ''}" data-pf="all">Tutte (${props.length})</button>
      <button class="pill-btn ${state.propFilter === 'mine' ? 'active' : ''}" data-pf="mine">Le Mie</button>
      <button class="pill-btn ${state.propFilter === 'free' ? 'active' : ''}" data-pf="free">Libere</button>
      <button class="pill-btn ${state.propFilter === 'mortgaged' ? 'active' : ''}" data-pf="mortgaged">Ipotecate</button>
    </div>
    <div class="prop-grid">${gridHtml || '<p style="color: var(--text-dim); font-size: 13px;">Nessuna proprietà trovata.</p>'}</div>
  `;

  container.querySelectorAll('[data-pf]').forEach((b) => {
    b.onclick = () => {
      state.propFilter = b.dataset.pf;
      renderPropertiesTab();
    };
  });

  container.querySelectorAll('[data-prop-id]').forEach((card) => {
    card.onclick = () => openPropertyDetailModal(card.dataset.propId);
  });

  document.getElementById('btn-open-trade')?.addEventListener('click', () => openTradeModal());
}

/* ================= TAB 3: BANCA & SETUP ================= */
function renderBankTab() {
  const container = document.getElementById('tab-bank');
  const inviteUrl = `${state.lanOrigin}/?room=${state.room.code}`;
  const qrSvg = renderQrSvg(inviteUrl, 170);

  let bankerPanel = '';
  if (isBanker()) {
    bankerPanel = `
      <div class="glass" style="margin-bottom: 14px;">
        <div class="section-title" style="margin-bottom: 10px;">🏦 Operazioni Cassa della Banca</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px;">
          <button id="btn-b-via" class="btn btn-success btn-sm" type="button">🏁 Passaggio VIA</button>
          <button id="btn-b-tx" class="btn btn-warning btn-sm" type="button">💸 Accredita / Tassa</button>
        </div>
        <label style="display: flex; align-items: center; gap: 10px; font-size: 13px; cursor: pointer;">
          <input id="chk-fp-toggle" type="checkbox" ${state.room.freeParkingEnabled ? 'checked' : ''} style="width: 18px; height: 18px;" />
          <span>Salvadanaio Parcheggio Gratuito attivo</span>
        </label>
      </div>

      <div class="glass" style="margin-bottom: 14px;">
        <div class="section-title" style="margin-bottom: 6px;">🃏 Configurazione Mazzo Contratti</div>
        <p style="font-size: 12px; color: var(--text-dim); margin: 0 0 10px;">
          Modifica terreni, stazioni, società, prezzi e rendite o importa/esporta in JSON.
        </p>
        <button id="btn-open-deck-editor" class="btn btn-primary btn-sm btn-block" type="button">Apri Editor Mazzo (${state.room.properties.length} carte)</button>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="glass" style="text-align: center; margin-bottom: 14px;">
      <div class="section-title" style="margin-bottom: 4px;">Invita Giocatori nella Stanza</div>
      <div style="font-size: 28px; font-weight: 800; letter-spacing: 4px; color: var(--blue); margin: 6px 0;">${state.room.code}</div>
      <div class="qr-box">${qrSvg}</div>
      <div style="font-size: 11px; color: var(--text-dim); word-break: break-all; margin: 6px 0 10px;">${inviteUrl}</div>
      <button id="btn-copy-invite" class="btn btn-secondary btn-sm" type="button">Copia Link Invito</button>
    </div>

    ${bankerPanel}

    <div class="glass">
      <div class="section-title" style="margin-bottom: 8px;">⚙️ Sessione</div>
      <button id="btn-leave-room" class="btn btn-danger btn-sm btn-block" type="button">Esci dalla Stanza</button>
    </div>
  `;

  document.getElementById('btn-copy-invite').onclick = () => {
    navigator.clipboard?.writeText(inviteUrl);
    showBanner('📋 Link invito copiato negli appunti!');
  };

  document.getElementById('btn-leave-room').onclick = () => {
    if (confirm('Vuoi uscire dalla stanza su questo dispositivo?')) {
      clearSession();
      window.location.href = '/';
    }
  };

  if (isBanker()) {
    document.getElementById('btn-b-via').onclick = () => openQuickViaModal();
    document.getElementById('btn-b-tx').onclick = () => openBankTransferModal();
    document.getElementById('chk-fp-toggle').onchange = async (e) => {
      try {
        await api(`/api/rooms/${state.room.code}/settings`, 'POST', {
          actorId: state.playerId,
          freeParkingEnabled: e.target.checked,
        });
      } catch (err) {
        handleActionError(err);
      }
    };
    document.getElementById('btn-open-deck-editor').onclick = () => openDeckEditorModal();
  }
}

/* ================= TAB 4: REGISTRO LIVE ================= */
function renderLogTab() {
  const container = document.getElementById('tab-log');
  const logs = [...(state.room.auditLog || [])].reverse().filter((l) => {
    if (state.logFilter === 'bank') return l.isBankAction;
    if (state.logFilter === 'mine') return l.fromId === state.playerId || l.toId === state.playerId;
    return true;
  });

  const itemsHtml = logs
    .map((l) => {
      const time = new Date(l.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `<div class="log-item ${l.isBankAction ? 'bank-action' : ''}">
        <div class="log-top">
          <span>${l.fromName} → ${l.toName}</span>
          <span style="color: ${l.isBankAction ? 'var(--amber)' : 'var(--green)'};">${l.amount > 0 ? `${l.amount} ${cur()}` : ''}</span>
        </div>
        <div class="log-sub">
          <span>${l.reason}</span>
          <span>${time}</span>
        </div>
      </div>`;
    })
    .join('');

  container.innerHTML = `
    <div class="section-head" style="margin-top: 0;">
      <span class="section-title">Registro Pubblico Immutabile</span>
      <span style="font-size: 11px; color: var(--text-dim);">🔒 Solo lettura</span>
    </div>
    <div class="filter-pills">
      <button class="pill-btn ${state.logFilter === 'all' ? 'active' : ''}" data-lf="all">Tutte</button>
      <button class="pill-btn ${state.logFilter === 'bank' ? 'active' : ''}" data-lf="bank">Solo Banca</button>
      <button class="pill-btn ${state.logFilter === 'mine' ? 'active' : ''}" data-lf="mine">Le Mie</button>
    </div>
    <div>${itemsHtml || '<p style="color: var(--text-dim); font-size: 13px;">Nessuna transazione.</p>'}</div>
  `;

  container.querySelectorAll('[data-lf]').forEach((b) => {
    b.onclick = () => {
      state.logFilter = b.dataset.lf;
      renderLogTab();
    };
  });
}

/* ================= MODALS ================= */
function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function closeModal() {
  if (closeModal._stopScanner) {
    closeModal._stopScanner();
    closeModal._stopScanner = null;
  }
  if (closeModal._stopNfc) {
    closeModal._stopNfc();
    closeModal._stopNfc = null;
  }
  document.getElementById('modal-backdrop').classList.add('hidden');
}

function openInviteModal() {
  const inviteUrl = `${state.lanOrigin}/?room=${state.room.code}`;
  openModal(`
    <div style="text-align: center;">
      <div class="section-title">Stanza ${state.room.code}</div>
      <div class="qr-box">${renderQrSvg(inviteUrl, 190)}</div>
      <p style="font-size: 12px; color: var(--text-dim);">Fai inquadrare questo QR Code ai giocatori sullo stesso Wi-Fi.</p>
      <button class="btn btn-secondary btn-block" onclick="navigator.clipboard?.writeText('${inviteUrl}')">Copia Link</button>
    </div>
  `);
}

function openPayModal(preselectedTo = '') {
  const others = Object.values(state.room.players).filter((p) => p.id !== state.playerId && !p.isBankrupt);
  const options = [
    `<option value="BANK">🏦 LA BANCA</option>`,
    ...others.map((p) => `<option value="${p.id}" ${p.id === preselectedTo ? 'selected' : ''}>${getTokenInfo(p.token).emoji} ${p.name}</option>`),
  ].join('');

  openModal(`
    <div class="section-title" style="margin-bottom: 12px;">⚡ Paga / Trasferisci</div>
    <div style="display: flex; gap: 8px; margin-bottom: 12px;">
      <button id="btn-scan-qr-pay" class="btn btn-secondary btn-sm" style="flex:1" type="button">📷 Scansiona QR</button>
      <button id="btn-tap-nfc-pay" class="btn btn-secondary btn-sm" style="flex:1" type="button">📶 Tap NFC</button>
    </div>
    <video id="qr-video-preview" class="hidden" style="width:100%; border-radius: 14px; margin-bottom: 10px;"></video>
    <div id="pay-sensor-status" style="font-size: 12px; color: var(--amber); margin-bottom: 8px;"></div>

    <form id="form-pay">
      <div class="field">
        <label>Destinatario</label>
        <select id="pay-to" class="select">${options}</select>
      </div>
      <div class="field">
        <label>Importo (${cur()})</label>
        <input id="pay-amount" class="input" type="number" min="1" placeholder="Es. 150" required />
      </div>
      <div class="field">
        <label>Causale</label>
        <input id="pay-reason" class="input" placeholder="Es. Tassa, Prestito, Accordo..." value="Pagamento rapido" />
      </div>
      <label id="wrap-tax-fp" class="hidden" style="display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 12px;">
        <input id="pay-is-tax" type="checkbox" style="width: 18px; height: 18px;" />
        <span>È una tassa/multa (invia al Parcheggio Gratuito)</span>
      </label>
      <button type="submit" class="btn btn-primary btn-block">Conferma con Apple Pay</button>
    </form>
  `);

  const toSel = document.getElementById('pay-to');
  const taxWrap = document.getElementById('wrap-tax-fp');
  const syncTaxVisibility = () => {
    taxWrap.classList.toggle('hidden', !(toSel.value === 'BANK' && state.room.freeParkingEnabled));
  };
  toSel.onchange = syncTaxVisibility;
  syncTaxVisibility();

  document.getElementById('btn-scan-qr-pay').onclick = async () => {
    const vid = document.getElementById('qr-video-preview');
    const st = document.getElementById('pay-sensor-status');
    vid.classList.remove('hidden');
    closeModal._stopScanner = await startQrScanner(
      vid,
      (raw) => {
        vid.classList.add('hidden');
        try {
          const u = new URL(raw);
          const targetId = u.searchParams.get('to');
          if (targetId && state.room.players[targetId]) {
            toSel.value = targetId;
            syncTaxVisibility();
            st.textContent = `QR riconosciuto: ${state.room.players[targetId].name}`;
          }
        } catch (_) {
          st.textContent = 'QR non valido per Monopoly Pay.';
        }
      },
      (msg) => {
        vid.classList.add('hidden');
        st.textContent = msg;
      }
    );
  };

  document.getElementById('btn-tap-nfc-pay').onclick = async () => {
    const st = document.getElementById('pay-sensor-status');
    closeModal._stopNfc = await readNfcPaymentTag(
      (payload) => {
        try {
          const data = JSON.parse(payload);
          if (data.playerId && state.room.players[data.playerId]) {
            toSel.value = data.playerId;
            syncTaxVisibility();
            st.textContent = `NFC rilevato: ${state.room.players[data.playerId].name}`;
            triggerHaptic([20]);
          }
        } catch (_) {}
      },
      (msg) => {
        st.textContent = msg;
      }
    );
  };

  document.getElementById('form-pay').onsubmit = async (e) => {
    e.preventDefault();
    const amount = Number(document.getElementById('pay-amount').value);
    const toId = toSel.value;
    const reason = document.getElementById('pay-reason').value.trim();
    const isTaxOrFine = document.getElementById('pay-is-tax').checked;
    try {
      await api(`/api/rooms/${state.room.code}/transfer`, 'POST', {
        actorId: state.playerId,
        fromId: state.playerId,
        toId,
        amount,
        reason,
        isTaxOrFine,
      });
      closeModal();
      showPaySuccess('Pagamento Inviato', `${amount} ${cur()}`);
    } catch (err) {
      handleActionError(err);
    }
  };
}

function openReceiveModal() {
  const payUri = `${state.lanOrigin}/?room=${state.room.code}&to=${state.playerId}`;
  const nfcBtn = isWebNfcSupported()
    ? `<button id="btn-write-nfc" class="btn btn-secondary btn-block" style="margin-top: 8px;" type="button">📶 Scrivi su Tag NFC (Android)</button>`
    : `<p style="font-size: 11px; color: var(--text-dim); margin-top: 8px;">Web NFC attivo solo su Android Chrome; su iOS usa il QR Code qui sopra.</p>`;

  openModal(`
    <div style="text-align: center;">
      <div class="section-title">📲 Ricevi Pagamento</div>
      <div class="qr-box">${renderQrSvg(payUri, 190)}</div>
      <div style="font-size: 14px; font-weight: 700;">${me().name}</div>
      <div id="nfc-write-status" style="font-size: 12px; color: var(--amber); margin-top: 6px;"></div>
      ${nfcBtn}
    </div>
  `);

  document.getElementById('btn-write-nfc')?.addEventListener('click', () => {
    writeNfcPaymentTag(
      JSON.stringify({ room: state.room.code, playerId: state.playerId }),
      (msg) => (document.getElementById('nfc-write-status').textContent = msg)
    );
  });
}

function openBankTransferModal() {
  const players = Object.values(state.room.players).filter((p) => !p.isBankrupt);
  const opts = players.map((p) => `<option value="${p.id}">${getTokenInfo(p.token).emoji} ${p.name}</option>`).join('');

  openModal(`
    <div class="section-title" style="margin-bottom: 12px;">🏦 Cassa della Banca</div>
    <form id="form-bank-tx">
      <div class="field">
        <label>Operazione</label>
        <select id="b-dir" class="select">
          <option value="credit">Accredita da Banca a Giocatore (+)</option>
          <option value="debit">Addebita Tassa/Multa a Giocatore (-)</option>
        </select>
      </div>
      <div class="field">
        <label>Giocatore</label>
        <select id="b-player" class="select">${opts}</select>
      </div>
      <div class="field">
        <label>Importo (${cur()})</label>
        <input id="b-amount" class="input" type="number" min="1" required />
      </div>
      <div class="field">
        <label>Causale (visibile a tutto il tavolo)</label>
        <input id="b-reason" class="input" placeholder="Es. Imprevisti, Tassa di Lusso..." required />
      </div>
      <label id="b-fp-wrap" class="hidden" style="display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 12px;">
        <input id="b-is-tax" type="checkbox" checked style="width: 18px; height: 18px;" />
        <span>Versa nel Salvadanaio Parcheggio Gratuito</span>
      </label>
      <button type="submit" class="btn btn-warning btn-block">Esegui &amp; Notifica Tutti</button>
    </form>
  `);

  const dirSel = document.getElementById('b-dir');
  const fpWrap = document.getElementById('b-fp-wrap');
  const sync = () => fpWrap.classList.toggle('hidden', !(dirSel.value === 'debit' && state.room.freeParkingEnabled));
  dirSel.onchange = sync;
  sync();

  document.getElementById('form-bank-tx').onsubmit = async (e) => {
    e.preventDefault();
    const dir = dirSel.value;
    const pid = document.getElementById('b-player').value;
    const amount = Number(document.getElementById('b-amount').value);
    const reason = document.getElementById('b-reason').value.trim();
    const isTaxOrFine = document.getElementById('b-is-tax').checked;
    try {
      await api(`/api/rooms/${state.room.code}/transfer`, 'POST', {
        actorId: state.playerId,
        fromId: dir === 'credit' ? 'BANK' : pid,
        toId: dir === 'credit' ? pid : 'BANK',
        amount,
        reason,
        isTaxOrFine: dir === 'debit' && isTaxOrFine,
      });
      closeModal();
    } catch (err) {
      handleActionError(err);
    }
  };
}

function openQuickViaModal() {
  const players = Object.values(state.room.players).filter((p) => !p.isBankrupt);
  const opts = players.map((p) => `<option value="${p.id}">${getTokenInfo(p.token).emoji} ${p.name}</option>`).join('');
  openModal(`
    <div class="section-title" style="margin-bottom: 12px;">🏁 Passaggio dal VIA (+200 ${cur()})</div>
    <form id="form-via">
      <div class="field">
        <label>Giocatore</label>
        <select id="via-player" class="select">${opts}</select>
      </div>
      <button type="submit" class="btn btn-success btn-block">Accredita 200 ${cur()}</button>
    </form>
  `);
  document.getElementById('form-via').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/rooms/${state.room.code}/transfer`, 'POST', {
        actorId: state.playerId,
        fromId: 'BANK',
        toId: document.getElementById('via-player').value,
        amount: 200,
        reason: 'Passaggio dal VIA',
      });
      closeModal();
    } catch (err) {
      handleActionError(err);
    }
  };
}

function openClaimFreeParkingModal() {
  const players = Object.values(state.room.players).filter((p) => !p.isBankrupt);
  const opts = players.map((p) => `<option value="${p.id}">${getTokenInfo(p.token).emoji} ${p.name}</option>`).join('');
  openModal(`
    <div class="section-title" style="margin-bottom: 12px;">🅿️ Assegna Parcheggio Gratuito (${state.room.freeParkingPot} ${cur()})</div>
    <form id="form-fp-claim">
      <div class="field">
        <label>Vincitore</label>
        <select id="fp-player" class="select">${opts}</select>
      </div>
      <button type="submit" class="btn btn-warning btn-block">Assegna Salvadanaio</button>
    </form>
  `);
  document.getElementById('form-fp-claim').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/rooms/${state.room.code}/free-parking/claim`, 'POST', {
        actorId: state.playerId,
        toPlayerId: document.getElementById('fp-player').value,
      });
      closeModal();
    } catch (err) {
      handleActionError(err);
    }
  };
}

/* ================= PROPERTY DETAIL MODAL ================= */
function openPropertyDetailModal(propId) {
  const prop = state.room.properties.find((p) => p.id === propId);
  if (!prop) return;
  const cg = COLOR_GROUPS[prop.colorGroup] || { hex: '#8E8E93', label: prop.colorGroup };
  const owner = prop.ownerId ? state.room.players[prop.ownerId] : null;
  const isMine = prop.ownerId === state.playerId;

  let rentTableHtml = '';
  if (prop.type === 'street') {
    const r = prop.rents;
    rentTableHtml = `
      <div style="font-size: 12px; display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; background: rgba(255,255,255,0.04); padding: 10px 12px; border-radius: 12px; margin: 10px 0;">
        <span>Affitto base</span><b>${r.base} ${cur()}</b>
        <span>Serie completa</span><b>${r.monopoly} ${cur()}</b>
        <span>1 Casa</span><b>${r.house1} ${cur()}</b>
        <span>2 Case</span><b>${r.house2} ${cur()}</b>
        <span>3 Case</span><b>${r.house3} ${cur()}</b>
        <span>4 Case</span><b>${r.house4} ${cur()}</b>
        <span>Hotel</span><b>${r.hotel} ${cur()}</b>
        <span>Costo Casa/Hotel</span><b>${prop.houseCost} ${cur()}</b>
        <span>Ipoteca / Disipoteca</span><b>${prop.mortgageValue} / ${prop.unmortgageCost} ${cur()}</b>
      </div>`;
  } else if (prop.type === 'station') {
    const sr = prop.stationRents;
    rentTableHtml = `
      <div style="font-size: 12px; display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; background: rgba(255,255,255,0.04); padding: 10px 12px; border-radius: 12px; margin: 10px 0;">
        <span>1 Stazione</span><b>${sr.s1} ${cur()}</b>
        <span>2 Stazioni</span><b>${sr.s2} ${cur()}</b>
        <span>3 Stazioni</span><b>${sr.s3} ${cur()}</b>
        <span>4 Stazioni</span><b>${sr.s4} ${cur()}</b>
        <span>Ipoteca / Disipoteca</span><b>${prop.mortgageValue} / ${prop.unmortgageCost} ${cur()}</b>
      </div>`;
  } else {
    const m = prop.multipliers;
    rentTableHtml = `
      <div style="font-size: 12px; display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; background: rgba(255,255,255,0.04); padding: 10px 12px; border-radius: 12px; margin: 10px 0;">
        <span>1 Società</span><b>${m.u1}× Dadi</b>
        <span>2 Società</span><b>${m.u2}× Dadi</b>
        <span>Ipoteca / Disipoteca</span><b>${prop.mortgageValue} / ${prop.unmortgageCost} ${cur()}</b>
      </div>`;
  }

  let actionsHtml = '';
  if (!owner) {
    actionsHtml = `<button id="btn-buy-prop" class="btn btn-success btn-block" type="button">Acquista per ${prop.price} ${cur()}</button>`;
  } else if (!isMine) {
    actionsHtml = `
      ${prop.type === 'utility' ? `<div class="field"><label>Risultato Dadi (2-12)</label><input id="rent-dice" class="input" type="number" min="2" max="12" value="7" /></div>` : ''}
      <button id="btn-pay-rent-direct" class="btn btn-primary btn-block" type="button" ${prop.mortgaged ? 'disabled' : ''}>
        ${prop.mortgaged ? 'Proprietà Ipotecata (Affitto 0)' : `Richiedi / Paga Affitto a ${owner.name}`}
      </button>`;
  } else {
    // Proprietà del giocatore corrente
    const groupProps = state.room.properties.filter((x) => x.colorGroup === prop.colorGroup);
    const ownsGroup = groupProps.every((x) => x.ownerId === state.playerId);
    const anyMortgaged = groupProps.some((x) => x.mortgaged);
    const anyHouses = groupProps.some((x) => (x.houses || 0) > 0);
    const minH = Math.min(...groupProps.map((x) => x.houses || 0));
    const maxH = Math.max(...groupProps.map((x) => x.houses || 0));

    const canBuild = prop.type === 'street' && ownsGroup && !anyMortgaged && (prop.houses || 0) < 5 && (prop.houses || 0) <= minH;
    const canSell = prop.type === 'street' && (prop.houses || 0) > 0 && !anyMortgaged && (prop.houses || 0) >= maxH;
    const canMortgage = !prop.mortgaged && !(prop.type === 'street' && anyHouses);

    const debtors = Object.values(state.room.players)
      .filter((p) => p.id !== state.playerId && !p.isBankrupt)
      .map((p) => `<option value="${p.id}">${getTokenInfo(p.token).emoji} ${p.name}</option>`)
      .join('');

    actionsHtml = `
      ${debtors ? `<div class="glass" style="padding: 12px; margin-bottom: 10px;">
        <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px;">Riscuoti Affitto da un Giocatore</div>
        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
          <select id="rent-debtor" class="select" style="flex:1">${debtors}</select>
          ${prop.type === 'utility' ? `<input id="rent-dice" class="input" type="number" min="2" max="12" value="7" style="width: 74px;" title="Dadi" />` : ''}
        </div>
        <button id="btn-req-rent" class="btn btn-primary btn-sm btn-block" type="button" ${prop.mortgaged ? 'disabled' : ''}>Richiedi Affitto</button>
      </div>` : ''}

      ${prop.type === 'street' ? `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
        <button id="btn-build-house" class="btn btn-success btn-sm" type="button" ${canBuild ? '' : 'disabled'}>+ Costruisci (${prop.houseCost}${cur()})</button>
        <button id="btn-sell-house" class="btn btn-secondary btn-sm" type="button" ${canSell ? '' : 'disabled'}>- Vendi (+${Math.floor(prop.houseCost / 2)}${cur()})</button>
      </div>` : ''}

      ${!prop.mortgaged
        ? `<button id="btn-mortgage" class="btn btn-warning btn-sm btn-block" type="button" ${canMortgage ? '' : 'disabled'}>🔒 Ipoteca (+${prop.mortgageValue} ${cur()})</button>`
        : `<button id="btn-unmortgage" class="btn btn-success btn-sm btn-block" type="button">🔓 Disipoteca (-${prop.unmortgageCost} ${cur()})</button>`}
    `;
  }

  openModal(`
    <div style="border-radius: 14px; overflow: hidden; border: 1px solid var(--border); margin-bottom: 12px;">
      <div style="height: 16px; background: ${cg.hex};"></div>
      <div style="padding: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="font-size: 18px; font-weight: 800;">${prop.name}</div>
          <span style="font-size: 13px; color: var(--text-dim);">${prop.price} ${cur()}</span>
        </div>
        <div style="font-size: 12px; color: var(--text-dim); margin-top: 2px;">
          Proprietario: ${owner ? `${getTokenInfo(owner.token).emoji} ${owner.name}` : '🏦 Banca'} ${prop.mortgaged ? '• 🔒 IPOTECATA' : ''}
        </div>
      </div>
    </div>
    ${rentTableHtml}
    ${actionsHtml}
  `);

  document.getElementById('btn-buy-prop')?.addEventListener('click', async () => {
    try {
      await api(`/api/rooms/${state.room.code}/properties/buy`, 'POST', { actorId: state.playerId, propertyId: propId });
      closeModal();
      showPaySuccess('Proprietà Acquistata!', prop.name);
    } catch (err) {
      handleActionError(err);
    }
  });

  document.getElementById('btn-pay-rent-direct')?.addEventListener('click', async () => {
    const diceEl = document.getElementById('rent-dice');
    try {
      const reqRes = await api(`/api/rooms/${state.room.code}/rent/request`, 'POST', {
        actorId: state.playerId,
        propertyId: propId,
        debtorId: state.playerId,
        diceRoll: diceEl ? Number(diceEl.value) : null,
      });
      // Conferma immediata con Apple Pay
      await api(`/api/rooms/${state.room.code}/rent/respond`, 'POST', {
        actorId: state.playerId,
        requestId: reqRes.result.id,
        accept: true,
      });
      closeModal();
      showPaySuccess('Affitto Pagato!', `${reqRes.result.amount} ${cur()}`);
    } catch (err) {
      handleActionError(err);
    }
  });

  document.getElementById('btn-req-rent')?.addEventListener('click', async () => {
    const debtorId = document.getElementById('rent-debtor').value;
    const diceEl = document.getElementById('rent-dice');
    try {
      await api(`/api/rooms/${state.room.code}/rent/request`, 'POST', {
        actorId: state.playerId,
        propertyId: propId,
        debtorId,
        diceRoll: diceEl ? Number(diceEl.value) : null,
      });
      closeModal();
      showBanner('📩 Richiesta di affitto inviata al giocatore!');
    } catch (err) {
      handleActionError(err);
    }
  });

  document.getElementById('btn-build-house')?.addEventListener('click', async () => {
    try {
      await api(`/api/rooms/${state.room.code}/build/request`, 'POST', {
        actorId: state.playerId,
        propertyId: propId,
        action: 'build',
      });
      closeModal();
      showBanner('🏗️ Richiesta costruzione inviata al Banchiere!');
    } catch (err) {
      handleActionError(err);
    }
  });

  document.getElementById('btn-sell-house')?.addEventListener('click', async () => {
    try {
      await api(`/api/rooms/${state.room.code}/build/request`, 'POST', {
        actorId: state.playerId,
        propertyId: propId,
        action: 'sell',
      });
      closeModal();
      showBanner('🏚️ Richiesta vendita edificio inviata al Banchiere!');
    } catch (err) {
      handleActionError(err);
    }
  });

  document.getElementById('btn-mortgage')?.addEventListener('click', async () => {
    try {
      await api(`/api/rooms/${state.room.code}/mortgage/request`, 'POST', {
        actorId: state.playerId,
        propertyId: propId,
        action: 'mortgage',
      });
      closeModal();
      showBanner('🔒 Richiesta ipoteca inviata al Banchiere!');
    } catch (err) {
      handleActionError(err);
    }
  });

  document.getElementById('btn-unmortgage')?.addEventListener('click', async () => {
    try {
      await api(`/api/rooms/${state.room.code}/mortgage/request`, 'POST', {
        actorId: state.playerId,
        propertyId: propId,
        action: 'unmortgage',
      });
      closeModal();
      showBanner('🔓 Richiesta disipoteca inviata al Banchiere!');
    } catch (err) {
      handleActionError(err);
    }
  });
}

/* ================= TRADE MODAL ================= */
function openTradeModal() {
  const others = Object.values(state.room.players).filter((p) => p.id !== state.playerId && !p.isBankrupt);
  if (others.length === 0) {
    alert('Servono almeno 2 giocatori attivi per proporre uno scambio.');
    return;
  }
  const myProps = state.room.properties.filter((p) => p.ownerId === state.playerId);

  openModal(`
    <div class="section-title" style="margin-bottom: 12px;">🤝 Proponi Scambio</div>
    <form id="form-trade">
      <div class="field">
        <label>Con chi vuoi scambiare?</label>
        <select id="tr-partner" class="select">
          ${others.map((p) => `<option value="${p.id}">${getTokenInfo(p.token).emoji} ${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Le tue proprietà offerte</label>
        <div style="max-height: 110px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;">
          ${myProps.map((p) => `<label style="font-size: 13px;"><input type="checkbox" name="offerP" value="${p.id}" /> ${p.name}</label>`).join('') || '<span style="font-size:12px;color:var(--text-dim);">Nessuna proprietà</span>'}
        </div>
      </div>
      <div class="field">
        <label>Denaro offerto (${cur()})</label>
        <input id="tr-offer-cash" class="input" type="number" min="0" value="0" />
      </div>
      <div class="field">
        <label>Proprietà richieste alla controparte</label>
        <div id="tr-req-props" style="max-height: 110px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;"></div>
      </div>
      <div class="field">
        <label>Denaro richiesto (${cur()})</label>
        <input id="tr-req-cash" class="input" type="number" min="0" value="0" />
      </div>
      <button type="submit" class="btn btn-primary btn-block">Invia Proposta</button>
    </form>
  `);

  const partnerSel = document.getElementById('tr-partner');
  const reqBox = document.getElementById('tr-req-props');
  const renderPartnerProps = () => {
    const pid = partnerSel.value;
    const pProps = state.room.properties.filter((p) => p.ownerId === pid);
    reqBox.innerHTML =
      pProps.map((p) => `<label style="font-size: 13px;"><input type="checkbox" name="reqP" value="${p.id}" /> ${p.name}</label>`).join('') ||
      '<span style="font-size:12px;color:var(--text-dim);">Nessuna proprietà</span>';
  };
  partnerSel.onchange = renderPartnerProps;
  renderPartnerProps();

  document.getElementById('form-trade').onsubmit = async (e) => {
    e.preventDefault();
    const offerProperties = [...document.querySelectorAll('input[name="offerP"]:checked')].map((el) => el.value);
    const requestProperties = [...document.querySelectorAll('input[name="reqP"]:checked')].map((el) => el.value);
    try {
      await api(`/api/rooms/${state.room.code}/trade/create`, 'POST', {
        actorId: state.playerId,
        toPlayerId: partnerSel.value,
        offerProperties,
        offerCash: Number(document.getElementById('tr-offer-cash').value || 0),
        requestProperties,
        requestCash: Number(document.getElementById('tr-req-cash').value || 0),
      });
      closeModal();
      showBanner('🤝 Proposta di scambio inviata!');
    } catch (err) {
      handleActionError(err);
    }
  };
}

/* ================= DEBT ASSISTANT MODAL ================= */
function openDebtAssistantModal(extra, message) {
  const sug = extra.suggestions || { sellHouses: [], mortgageProperties: [] };
  const housesHtml = sug.sellHouses
    .map(
      (h) => `<div class="player-row" style="margin-bottom:6px;">
        <span style="font-size:13px;">🏠 Vendi casa su <b>${h.propertyName}</b></span>
        <button class="btn btn-secondary btn-sm" data-debt-sell="${h.propertyId}">+${h.refund} ${cur()}</button>
      </div>`
    )
    .join('');
  const mortHtml = sug.mortgageProperties
    .map(
      (m) => `<div class="player-row" style="margin-bottom:6px;">
        <span style="font-size:13px;">🔒 Ipoteca <b>${m.propertyName}</b></span>
        <button class="btn btn-warning btn-sm" data-debt-mort="${m.propertyId}">+${m.mortgageValue} ${cur()}</button>
      </div>`
    )
    .join('');

  openModal(`
    <div class="section-title" style="color: var(--red); margin-bottom: 6px;">⚠️ Assistente Gestione Debito</div>
    <p style="font-size: 13px; color: var(--text-dim); margin: 0 0 12px;">${message}<br/>Deficit da coprire: <b>${extra.deficit} ${cur()}</b></p>
    ${housesHtml || mortHtml ? `<div style="margin-bottom: 12px;">${housesHtml}${mortHtml}</div>` : '<p style="font-size:12px;color:var(--text-dim);">Nessun immobile liquidabile disponibile.</p>'}
    <button id="btn-declare-bankrupt" class="btn btn-danger btn-block" type="button">🏳️ Dichiara Bancarotta</button>
  `);

  document.querySelectorAll('[data-debt-sell]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/rooms/${state.room.code}/build/request`, 'POST', {
          actorId: state.playerId,
          propertyId: b.dataset.debtSell,
          action: 'sell',
        });
        closeModal();
        showBanner('🏚️ Richiesta vendita edificio inviata al Banchiere!');
      } catch (err) {
        alert(err.message);
      }
    };
  });

  document.querySelectorAll('[data-debt-mort]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/rooms/${state.room.code}/mortgage/request`, 'POST', {
          actorId: state.playerId,
          propertyId: b.dataset.debtMort,
          action: 'mortgage',
        });
        closeModal();
        showBanner('🔒 Richiesta ipoteca inviata al Banchiere!');
      } catch (err) {
        alert(err.message);
      }
    };
  });

  document.getElementById('btn-declare-bankrupt').onclick = async () => {
    if (!confirm('Sei sicuro di voler dichiarare BANCAROTTA? Tutti i tuoi beni saranno trasferiti.')) return;
    try {
      await api(`/api/rooms/${state.room.code}/bankruptcy`, 'POST', {
        actorId: state.playerId,
        creditorId: extra.creditorId || 'BANK',
      });
      closeModal();
    } catch (err) {
      alert(err.message);
    }
  };
}

/* ================= DECK EDITOR MODAL ================= */
function openDeckEditorModal() {
  state.editorDeck = JSON.parse(JSON.stringify(state.room.properties));

  const renderList = () => {
    const rows = state.editorDeck
      .map(
        (p, idx) => `<div class="player-row" style="margin-bottom: 6px;">
          <div>
            <div style="font-size: 13px; font-weight: 700;">${p.name}</div>
            <div style="font-size: 11px; color: var(--text-dim);">${p.type.toUpperCase()} • ${p.colorGroup} • ${p.price} ${cur()}</div>
          </div>
          <button class="btn btn-secondary btn-sm" data-edit-idx="${idx}" type="button">Modifica</button>
        </div>`
      )
      .join('');

    openModal(`
      <div class="section-title" style="margin-bottom: 10px;">🃏 Editor Mazzo Contratti</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px;">
        <button id="btn-deck-export" class="btn btn-secondary btn-sm" type="button">Esporta JSON</button>
        <button id="btn-deck-import" class="btn btn-secondary btn-sm" type="button">Importa JSON</button>
        <button id="btn-deck-reset" class="btn btn-secondary btn-sm" type="button">Preset Classico IT</button>
        <button id="btn-deck-save" class="btn btn-success btn-sm" type="button">Salva &amp; Applica</button>
      </div>
      <input id="inp-deck-file" type="file" accept="application/json" class="hidden" />
      <div style="max-height: 45dvh; overflow-y: auto;">${rows}</div>
    `);

    document.querySelectorAll('[data-edit-idx]').forEach((b) => {
      b.onclick = () => editSingleCard(Number(b.dataset.editIdx));
    });

    document.getElementById('btn-deck-export').onclick = () => {
      const blob = new Blob([JSON.stringify(state.editorDeck, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `monopoly-deck-${state.room.code}.json`;
      a.click();
    };

    document.getElementById('btn-deck-import').onclick = () => document.getElementById('inp-deck-file').click();
    document.getElementById('inp-deck-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (!Array.isArray(parsed)) throw new Error('JSON non valido');
        state.editorDeck = parsed;
        renderList();
      } catch (err) {
        alert(err.message);
      }
    };

    document.getElementById('btn-deck-reset').onclick = () => {
      state.editorDeck = getClassicItalianDeckClient();
      renderList();
    };

    document.getElementById('btn-deck-save').onclick = async () => {
      try {
        saveDeckLocally(state.editorDeck);
        await api(`/api/rooms/${state.room.code}/deck`, 'POST', {
          actorId: state.playerId,
          deck: state.editorDeck,
        });
        closeModal();
        showPaySuccess('Mazzo Aggiornato!');
      } catch (err) {
        handleActionError(err);
      }
    };
  };

  const editSingleCard = (idx) => {
    const p = state.editorDeck[idx];
    openModal(`
      <div class="section-title" style="margin-bottom: 10px;">Modifica: ${p.name}</div>
      <form id="form-edit-card">
        <div class="field"><label>Nome</label><input id="ec-name" class="input" value="${p.name}" required /></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div class="field"><label>Prezzo</label><input id="ec-price" class="input" type="number" value="${p.price}" required /></div>
          <div class="field"><label>Ipoteca</label><input id="ec-mort" class="input" type="number" value="${p.mortgageValue}" required /></div>
        </div>
        ${p.type === 'street' ? `
          <div class="field"><label>Costo Casa/Hotel</label><input id="ec-hcost" class="input" type="number" value="${p.houseCost}" required /></div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div class="field"><label>Affitto Base</label><input id="ec-r0" class="input" type="number" value="${p.rents.base}" /></div>
            <div class="field"><label>Serie Completa</label><input id="ec-rm" class="input" type="number" value="${p.rents.monopoly}" /></div>
            <div class="field"><label>1 Casa</label><input id="ec-r1" class="input" type="number" value="${p.rents.house1}" /></div>
            <div class="field"><label>2 Case</label><input id="ec-r2" class="input" type="number" value="${p.rents.house2}" /></div>
            <div class="field"><label>3 Case</label><input id="ec-r3" class="input" type="number" value="${p.rents.house3}" /></div>
            <div class="field"><label>4 Case</label><input id="ec-r4" class="input" type="number" value="${p.rents.house4}" /></div>
            <div class="field"><label>Hotel</label><input id="ec-rh" class="input" type="number" value="${p.rents.hotel}" /></div>
          </div>` : ''}
        <div style="display: flex; gap: 8px;">
          <button type="submit" class="btn btn-primary" style="flex:1">Salva Carta</button>
          <button id="ec-back" type="button" class="btn btn-secondary">Indietro</button>
        </div>
      </form>
    `);

    document.getElementById('ec-back').onclick = renderList;
    document.getElementById('form-edit-card').onsubmit = (e) => {
      e.preventDefault();
      p.name = document.getElementById('ec-name').value.trim();
      p.price = Number(document.getElementById('ec-price').value);
      p.mortgageValue = Number(document.getElementById('ec-mort').value);
      p.unmortgageCost = Math.round(p.mortgageValue * 1.1);
      if (p.type === 'street') {
        p.houseCost = Number(document.getElementById('ec-hcost').value);
        p.rents = {
          base: Number(document.getElementById('ec-r0').value),
          monopoly: Number(document.getElementById('ec-rm').value),
          house1: Number(document.getElementById('ec-r1').value),
          house2: Number(document.getElementById('ec-r2').value),
          house3: Number(document.getElementById('ec-r3').value),
          house4: Number(document.getElementById('ec-r4').value),
          hotel: Number(document.getElementById('ec-rh').value),
        };
      }
      renderList();
    };
  };

  renderList();
}

initOnboarding();
initNav();

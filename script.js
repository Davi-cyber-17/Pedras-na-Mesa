(() => {
'use strict';

/* =====================================================
   Utilidades
   ===================================================== */
const PREFIX = 'pedras-mesa-';
const AVATARS = ['😊', '😎', '🤠', '🦊'];
const BOT_NAMES = ['Bia', 'Zeca', 'Duda', 'Léo'];
// STUN + TURN públicos: ajudam PC (wi-fi) e celular (4G/5G) a se conectarem mesmo em redes diferentes
const PEER_OPTS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  }
};
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sameTile = (x, y) => !!x && !!y && x[0] === y[0] && x[1] === y[1];
const pips = t => t[0] + t[1];
const sumPips = hand => hand.reduce((s, t) => s + pips(t), 0);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function fullSet() {
  const s = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) s.push([i, j]);
  return s;
}
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 5; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}
function show(id) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}

/* =====================================================
   Estado global
   ===================================================== */
let mode = null;      // 'local' | 'host' | 'client'
let G = null;         // jogo (somente no anfitrião / local)
let peer = null;
let hostConn = null;
let lastView = null;
let selected = null;  // peça escolhida quando há 2 lados possíveis
let prevChain = [];
let netTimer = null;
let netState = 'ok';
let lastSeen = 0;
let wake = null;

function setNet(state) {
  netState = state;
  const c = $('#chipNet');
  if (!c) return;
  if (mode !== 'host' && mode !== 'client') { c.hidden = true; return; }
  c.hidden = false;
  c.className = 'chip net ' + state;
  c.lastElementChild.textContent = state === 'ok' ? 'Online' : 'Conexão instável';
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wake && lastView && lastView.phase !== 'lobby') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    }
  } catch (e) {}
}

function startNetTimer() {
  clearInterval(netTimer);
  netTimer = setInterval(() => {
    const now = Date.now();
    if (mode === 'host' && G) {
      G.players.forEach(p => { if (p.conn && p.conn.open) p.conn.send({ t: 'ping' }); });
      G.players.filter(p => p.conn && now - (p.seen || now) > 45000)
        .map(p => p.conn)
        .forEach(c => { onDisconnect(c); try { c.close(); } catch (e) {} });
      setNet(peer && !peer.disconnected ? 'ok' : 'warn');
    } else if (mode === 'client') {
      if (hostConn && hostConn.open) hostConn.send({ t: 'pong' });
      const gap = now - lastSeen;
      if (gap > 60000) exitRoom('Conexão perdida com o anfitrião.');
      else setNet(gap > 15000 ? 'warn' : 'ok');
    }
  }, 4000);
}

const nameInput = $('#playerName');
try { nameInput.value = localStorage.getItem('domino-name') || ''; } catch (e) {}
function myName() {
  const n = nameInput.value.trim().slice(0, 14) || 'Jogador';
  try { localStorage.setItem('domino-name', n); } catch (e) {}
  return n;
}

/* =====================================================
   MOTOR DO JOGO (roda no anfitrião ou no modo local)
   ===================================================== */
function newGame(code, target) {
  return {
    code, target, players: [], phase: 'lobby', chain: [], boneyard: [],
    turn: 0, passes: 0, round: 0, roundInfo: null, msg: '', mustPlay: null,
    timer: null, lastWinner: null
  };
}

function addPlayer(name, isBot, conn) {
  if (G.players.length >= 4) return false;
  G.players.push({ name, isBot, conn, hand: [], score: 0, seen: Date.now() });
  return true;
}

function nextBotName() {
  const used = G.players.map(p => p.name);
  return BOT_NAMES.find(n => !used.includes(n)) || 'Bot';
}

function startMatch() {
  G.players.forEach(p => { p.score = 0; });
  G.round = 0;
  G.lastWinner = null;
  startRound();
}

function startRound() {
  G.round++;
  const tiles = shuffle(fullSet());
  G.players.forEach(p => { p.hand = tiles.splice(0, 7); });
  G.boneyard = tiles;
  G.chain = [];
  G.passes = 0;
  G.roundInfo = null;
  G.phase = 'playing';
  G.mustPlay = null;

  if (G.lastWinner == null) {
    // maior carroça começa; se ninguém tiver, a maior peça
    let seat = 0, best = -1, bestTile = null;
    G.players.forEach((p, i) => p.hand.forEach(t => {
      if (t[0] === t[1] && t[0] > best) { best = t[0]; seat = i; bestTile = t; }
    }));
    if (best < 0) {
      let bs = -1;
      G.players.forEach((p, i) => p.hand.forEach(t => {
        if (pips(t) > bs) { bs = pips(t); seat = i; bestTile = t; }
      }));
    }
    G.turn = seat;
    G.mustPlay = bestTile;
  } else {
    G.turn = G.lastWinner;
  }
  G.msg = `${G.players[G.turn].name} começa a rodada`;
  sync();
}

function movesFor(seat) {
  const p = G.players[seat];
  const res = [];
  if (G.chain.length === 0) {
    p.hand.forEach(t => {
      if (!G.mustPlay || sameTile(t, G.mustPlay)) res.push({ tile: t, sides: ['C'] });
    });
    return res;
  }
  const L = G.chain[0].a;
  const R = G.chain[G.chain.length - 1].b;
  p.hand.forEach(t => {
    const s = [];
    if (t[0] === L || t[1] === L) s.push('L');
    if (t[0] === R || t[1] === R) s.push('R');
    if (s.length) res.push({ tile: t, sides: s });
  });
  return res;
}

function place(t, side) {
  const c = G.chain;
  if (side === 'C') {
    c.push({ a: t[0], b: t[1] });
  } else if (side === 'L') {
    const L = c[0].a;
    if (t[1] === L) c.unshift({ a: t[0], b: t[1] });
    else c.unshift({ a: t[1], b: t[0] });
  } else {
    const R = c[c.length - 1].b;
    if (t[0] === R) c.push({ a: t[0], b: t[1] });
    else c.push({ a: t[1], b: t[0] });
  }
}

function doPlay(seat, tile, side) {
  if (!G || G.phase !== 'playing' || G.turn !== seat || !Array.isArray(tile)) return;
  const mv = movesFor(seat).find(m => sameTile(m.tile, tile));
  if (!mv || !mv.sides.includes(side)) return;
  const p = G.players[seat];
  p.hand.splice(p.hand.findIndex(t => sameTile(t, tile)), 1);
  place(mv.tile, side);
  G.passes = 0;
  G.mustPlay = null;
  G.msg = `${p.name} jogou ${mv.tile[0]}-${mv.tile[1]}`;
  if (p.hand.length === 0) endRound(seat, 'domino');
  else G.turn = (G.turn + 1) % G.players.length;
  sync();
}

function doDraw(seat) {
  if (!G || G.phase !== 'playing' || G.turn !== seat) return;
  if (movesFor(seat).length > 0 || G.boneyard.length === 0) return;
  const p = G.players[seat];
  p.hand.push(G.boneyard.pop());
  G.msg = `${p.name} comprou uma peça`;
  sync();
}

function doPass(seat) {
  if (!G || G.phase !== 'playing' || G.turn !== seat) return;
  if (movesFor(seat).length > 0 || G.boneyard.length > 0) return;
  const p = G.players[seat];
  G.passes++;
  G.msg = `${p.name} passou a vez`;
  if (G.passes >= G.players.length) endRound(null, 'blocked');
  else G.turn = (G.turn + 1) % G.players.length;
  sync();
}

function endRound(winner, reason) {
  const totals = G.players.map(p => sumPips(p.hand));
  if (reason === 'blocked') {
    const min = Math.min(...totals);
    const ws = totals.map((t, i) => (t === min ? i : -1)).filter(i => i >= 0);
    winner = ws.length === 1 ? ws[0] : -1;
  }
  let points = 0;
  if (winner >= 0) {
    points = totals.reduce((s, t, i) => (i === winner ? s : s + t), 0);
    G.players[winner].score += points;
    G.lastWinner = winner;
  } else {
    G.lastWinner = null;
  }
  G.roundInfo = { winner, reason, points, hands: G.players.map(p => p.hand.map(t => t.slice())) };
  const won = winner >= 0 && G.players[winner].score >= G.target;
  G.phase = won ? 'matchEnd' : 'roundEnd';
  G.msg = winner >= 0 ? `${G.players[winner].name} fez ${points} pontos` : 'Rodada empatada';
}

function doNext() {
  if (!G) return;
  if (G.phase === 'roundEnd') startRound();
  else if (G.phase === 'matchEnd') startMatch();
}

/* ----- Bots ----- */
function botMove(seat) {
  if (!G || G.phase !== 'playing' || G.turn !== seat) return;
  const p = G.players[seat];
  const mv = movesFor(seat);
  if (mv.length === 0) {
    if (G.boneyard.length > 0) doDraw(seat);
    else doPass(seat);
    return;
  }
  let best = null, bestScore = -Infinity;
  mv.forEach(m => m.sides.forEach(side => {
    const t = m.tile;
    let exposed = t[1];
    if (side === 'L') exposed = t[0] === G.chain[0].a ? t[1] : t[0];
    if (side === 'R') exposed = t[0] === G.chain[G.chain.length - 1].b ? t[1] : t[0];
    const keep = p.hand.filter(h => !sameTile(h, t) && (h[0] === exposed || h[1] === exposed)).length;
    const score = pips(t) + (t[0] === t[1] ? 4 : 0) + keep * 1.5 + Math.random();
    if (score > bestScore) { bestScore = score; best = { tile: t, side }; }
  }));
  doPlay(seat, best.tile, best.side);
}

function schedule() {
  clearTimeout(G.timer);
  if (G.phase !== 'playing') return;
  const seat = G.turn;
  const p = G.players[seat];
  if (p.isBot) {
    G.timer = setTimeout(() => botMove(seat), 900 + Math.random() * 500);
  } else if (movesFor(seat).length === 0 && G.boneyard.length === 0) {
    G.timer = setTimeout(() => doPass(seat), 1400);
  }
}

/* ----- Visão de cada jogador (esconde as mãos dos outros) ----- */
function viewFor(seat) {
  const me = G.players[seat];
  const playing = G.phase === 'playing' && G.turn === seat;
  const moves = playing ? movesFor(seat) : [];
  return {
    phase: G.phase, code: G.code, target: G.target, round: G.round, mySeat: seat,
    players: G.players.map(p => ({ name: p.name, isBot: p.isBot, count: p.hand.length, score: p.score })),
    myHand: me.hand, chain: G.chain, boneyard: G.boneyard.length, turn: G.turn, msg: G.msg,
    moves,
    canDraw: playing && moves.length === 0 && G.boneyard.length > 0,
    noMove: playing && moves.length === 0 && G.boneyard.length === 0,
    mustPlayFirst: playing && G.chain.length === 0 && !!G.mustPlay,
    roundInfo: G.roundInfo
  };
}

function broadcast() {
  G.players.forEach((p, i) => {
    if (p.conn && p.conn.open) p.conn.send({ t: 'view', view: viewFor(i) });
  });
  render(viewFor(0));
}

function sync() {
  broadcast();
  schedule();
}

/* ----- Ações recebidas (do próprio anfitrião ou de clientes) ----- */
function handle(seat, m) {
  if (!G || !m) return;
  switch (m.t) {
    case 'play': return doPlay(seat, m.tile, m.side);
    case 'draw': return doDraw(seat);
    case 'next': return doNext();
    case 'sync': {
      const p = G.players[seat];
      if (p && p.conn && p.conn.open) p.conn.send({ t: 'view', view: viewFor(seat) });
      return;
    }
    case 'addBot':
      if (seat === 0 && G.phase === 'lobby' && addPlayer(nextBotName(), true, null)) sync();
      return;
    case 'removeBot':
      if (seat === 0 && G.phase === 'lobby') {
        const p = G.players[m.seat];
        if (p && p.isBot && m.seat !== 0) { G.players.splice(m.seat, 1); sync(); }
      }
      return;
    case 'setTarget':
      if (seat === 0 && G.phase === 'lobby' && [50, 100, 150].includes(m.v)) { G.target = m.v; sync(); }
      return;
    case 'start':
      if (seat === 0 && G.phase === 'lobby' && G.players.length >= 2) startMatch();
      return;
  }
}

function send(a) {
  if (mode === 'client') {
    if (hostConn && hostConn.open) hostConn.send(a);
  } else {
    handle(0, a);
  }
}

/* =====================================================
   ONLINE (salas via PeerJS / WebRTC)
   ===================================================== */
function setOnlineStatus(t) { $('#onlineStatus').textContent = t; }

function onConnection(conn) {
  conn.on('data', m => {
    if (!G || !m) return;
    if (m.t === 'join') {
      if (G.players.some(p => p.conn === conn)) return;
      if (G.phase !== 'lobby') {
        conn.send({ t: 'error', msg: 'A partida desta sala já começou.' });
        setTimeout(() => conn.close(), 400);
        return;
      }
      if (G.players.length >= 4) {
        conn.send({ t: 'error', msg: 'A sala está cheia.' });
        setTimeout(() => conn.close(), 400);
        return;
      }
      addPlayer(String(m.name || 'Jogador').slice(0, 14), false, conn);
      sync();
    } else {
      const i = G.players.findIndex(p => p.conn === conn);
      if (i < 0) return;
      G.players[i].seen = Date.now();
      if (m.t !== 'pong') handle(i, m);
    }
  });
  conn.on('close', () => onDisconnect(conn));
  conn.on('error', () => onDisconnect(conn));
}

function onDisconnect(conn) {
  if (!G) return;
  const i = G.players.findIndex(p => p.conn === conn);
  if (i < 0) return;
  if (G.phase === 'lobby') {
    G.players.splice(i, 1);
  } else {
    const p = G.players[i];
    G.msg = `${p.name} saiu. Um bot assumiu o lugar`;
    p.conn = null;
    p.isBot = true;
    p.name += ' (bot)';
  }
  sync();
}

function createRoom() {
  if (typeof Peer === 'undefined') return setOnlineStatus('Não foi possível carregar a biblioteca online. Verifique a internet.');
  setOnlineStatus('Criando sala…');
  let tries = 0;
  const attempt = () => {
    tries++;
    const code = genCode();
    const p = new Peer(PREFIX + code, PEER_OPTS);
    peer = p;
    p.on('open', () => {
      mode = 'host';
      G = newGame(code, 100);
      addPlayer(myName(), false, null);
      setOnlineStatus('');
      startNetTimer();
      sync();
    });
    p.on('connection', onConnection);
    p.on('disconnected', () => { if (!p.destroyed) p.reconnect(); });
    p.on('error', e => {
      if (e.type === 'unavailable-id' && tries < 6) { p.destroy(); attempt(); return; }
      if (!G) { setOnlineStatus('Erro de conexão: ' + e.type); return; }
      toast('Erro de rede: ' + e.type);
    });
  };
  attempt();
}

function joinRoom() {
  if (typeof Peer === 'undefined') return setOnlineStatus('Não foi possível carregar a biblioteca online. Verifique a internet.');
  const code = $('#roomCode').value.trim().toUpperCase();
  if (code.length < 4) return setOnlineStatus('Digite o código da sala.');
  setOnlineStatus('Conectando…');
  const p = new Peer(PEER_OPTS);
  peer = p;
  let gotData = false;
  const fail = msg => { clearTimeout(timer); cleanupPeer(); setOnlineStatus(msg); };
  const timer = setTimeout(() => { if (!gotData) fail('Não foi possível conectar. Confira o código e a internet.'); }, 12000);

  p.on('open', () => {
    const c = p.connect(PREFIX + code, { reliable: true, serialization: 'json' });
    c.on('open', () => {
      hostConn = c;
      mode = 'client';
      lastSeen = Date.now();
      startNetTimer();
      c.send({ t: 'join', name: myName() });
    });
    c.on('data', m => {
      if (!m) return;
      lastSeen = Date.now();
      if (m.t === 'ping') return;
      if (m.t === 'view') {
        gotData = true;
        clearTimeout(timer);
        setOnlineStatus('');
        render(m.view);
      } else if (m.t === 'error') {
        exitRoom(m.msg);
      }
    });
    c.on('close', () => {
      if (hostConn !== c) return;
      exitRoom('A sala foi encerrada.');
    });
  });
  p.on('error', e => {
    if (e.type === 'peer-unavailable') fail('Sala não encontrada. Confira o código.');
    else fail('Erro de conexão: ' + e.type);
  });
}

function cleanupPeer() {
  const c = hostConn;
  hostConn = null;
  if (c) { try { c.close(); } catch (e) {} }
  if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
}

function resetState() {
  clearInterval(netTimer);
  netTimer = null;
  if (G) { clearTimeout(G.timer); G = null; }
  cleanupPeer();
  mode = null; lastView = null; selected = null; prevChain = [];
}
function leaveToMenu() {
  resetState();
  show('screen-menu');
}
function exitRoom(msg) {
  resetState();
  show('screen-online');
  setOnlineStatus(msg || '');
}

/* =====================================================
   RENDERIZAÇÃO
   ===================================================== */
const PIPS = { 0: [], 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8] };
function pipCells(n, o) {
  const set = n === 6 ? (o === 'h' ? [0, 1, 2, 6, 7, 8] : [0, 2, 3, 5, 6, 8]) : PIPS[n];
  let s = '';
  for (let i = 0; i < 9; i++) s += set.includes(i) ? '<i class="p"></i>' : '<i></i>';
  return s;
}
function tileHTML(a, b, o, cls = '') {
  return `<div class="tile ${o} ${cls}" data-a="${a}" data-b="${b}"><div class="half n${a}">${pipCells(a, o)}</div><div class="half n${b}">${pipCells(b, o)}</div></div>`;
}
const avatarFor = (p, i) => (p.isBot ? '🤖' : AVATARS[i % 4]);

function render(v) {
  lastView = v;
  if (selected && !(v.moves || []).some(m => sameTile(m.tile, selected))) selected = null;
  if (v.phase === 'lobby') {
    renderLobby(v);
    show('screen-lobby');
  } else {
    show('screen-game');
    renderGame(v);
    setNet(netState);
    keepAwake();
  }
}

/* ----- Lobby ----- */
function renderLobby(v) {
  const isHost = v.mySeat === 0;
  $('#lobbyCode').textContent = v.code;
  let html = '';
  for (let i = 0; i < 4; i++) {
    const p = v.players[i];
    if (p) {
      const tag = i === 0 ? 'Anfitrião' : p.isBot ? 'Bot' : '';
      const you = i === v.mySeat ? ' (você)' : '';
      const rm = isHost && p.isBot ? `<button data-rm="${i}" aria-label="Remover bot">✕</button>` : '';
      html += `<div class="slot"><span class="av">${avatarFor(p, i)}</span><span class="nm">${esc(p.name)}${you}</span><span class="tag">${tag}</span>${rm}</div>`;
    } else {
      html += `<div class="slot empty"><span class="av">＋</span><span class="nm">Aguardando jogador…</span></div>`;
    }
  }
  $('#lobbySlots').innerHTML = html;
  $('#hostControls').hidden = !isHost;
  $('#guestNote').hidden = isHost;
  $('#btnAddBot').disabled = v.players.length >= 4;
  $('#btnStart').disabled = v.players.length < 2;
  $('#lobbyTarget').value = String(v.target);
}

/* ----- Jogo ----- */
function renderGame(v) {
  const n = v.players.length;
  const me = v.mySeat;
  const myTurn = v.phase === 'playing' && v.turn === me;

  $('#chipRound').textContent = 'Rodada ' + v.round;
  $('#chipTarget').textContent = 'Meta ' + v.target;
  $('#chipPile').textContent = 'Monte ' + v.boneyard;
  $('#chipRoom').textContent = v.code ? 'Sala ' + v.code : 'Contra o computador';
  $('#table').className = 'table n' + n;

  ['top', 'left', 'right'].forEach(k => { $('#seat-' + k).innerHTML = ''; });
  const posMap = n === 2 ? { 1: 'top' } : n === 3 ? { 1: 'left', 2: 'right' } : { 1: 'left', 2: 'top', 3: 'right' };
  for (let r = 1; r < n; r++) {
    const i = (me + r) % n;
    const p = v.players[i];
    const pos = posMap[r];
    const orient = pos === 'top' ? 'v' : 'h';
    let backs = '';
    for (let k = 0; k < p.count; k++) backs += `<span class="back ${orient}"></span>`;
    const active = v.phase === 'playing' && v.turn === i;
    $('#seat-' + pos).innerHTML =
      `<div class="pill ${active ? 'active' : ''}"><span class="pname">${esc(p.name)}</span><b class="score">${p.score}</b><span class="avatar">${avatarFor(p, i)}</span></div>` +
      `<div class="backs ${pos}">${backs}</div>`;
  }

  const mp = v.players[me];
  $('#mePill').className = 'pill me-pill' + (myTurn ? ' active' : '');
  $('#mePill').innerHTML = `<span class="pname">${esc(mp.name)}</span><b class="score">${mp.score}</b><span class="avatar">${avatarFor(mp, me)}</span>`;

  renderChain(v);
  renderHand(v, myTurn);

  let main = '';
  if (v.phase === 'playing') {
    if (myTurn) {
      if (v.canDraw) main = 'Sem jogada. Compre uma peça do monte.';
      else if (v.noMove) main = 'Sem jogada. Você passa a vez…';
      else if (v.mustPlayFirst) main = 'Você começa: jogue a peça destacada.';
      else main = selected ? 'Escolha o lado da mesa.' : 'Sua vez. Escolha uma peça.';
    } else {
      main = 'Vez de ' + v.players[v.turn].name + '…';
    }
  } else {
    main = 'Fim da rodada';
  }
  $('#statusText').textContent = main;
  $('#statusLog').textContent = v.msg || '';
  const draw = $('#btnDraw');
  draw.hidden = !v.canDraw;
  draw.textContent = `Comprar peça (${v.boneyard})`;

  renderModal(v);
}

function renderChain(v) {
  const el = $('#chain');
  const board = $('#board');
  const chain = v.chain;
  const mv = selected ? v.moves.find(m => sameTile(m.tile, selected)) : null;

  let newIdx = -1;
  if (chain.length === prevChain.length + 1) {
    if (prevChain.length === 0) newIdx = 0;
    else if (chain[1].a === prevChain[0].a && chain[1].b === prevChain[0].b) newIdx = 0;
    else newIdx = chain.length - 1;
  }
  prevChain = chain.map(c => ({ a: c.a, b: c.b }));

  let units = 0;
  chain.forEach(c => { units += c.a === c.b ? 1 : 2; });
  if (mv) units += 4;
  const boardW = board.clientWidth - 24;
  const boardH = board.clientHeight - 16;
  let u = Math.floor((boardW - (chain.length + 2) * 3) / Math.max(units, 8));
  u = Math.max(16, Math.min(56, u, Math.floor(boardH / 2.4)));
  el.style.setProperty('--u', u + 'px');

  if (chain.length === 0) {
    el.innerHTML = '<div class="empty-note">A mesa está vazia. Quem começa joga a primeira peça.</div>';
    return;
  }
  let html = '';
  if (mv && mv.sides.includes('L')) html += `<button class="dz" data-side="L" aria-label="Jogar na esquerda">◀ ${chain[0].a}</button>`;
  chain.forEach((c, i) => {
    html += tileHTML(c.a, c.b, c.a === c.b ? 'v' : 'h', i === newIdx ? 'new' : '');
  });
  if (mv && mv.sides.includes('R')) html += `<button class="dz" data-side="R" aria-label="Jogar na direita">${chain[chain.length - 1].b} ▶</button>`;
  el.innerHTML = html;

  if (newIdx >= 0 && chain.length > 6) {
    const t = el.querySelectorAll('.tile')[newIdx];
    if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
}

function renderHand(v, myTurn) {
  const el = $('#hand');
  const hand = v.myHand.slice().sort((x, y) => pips(y) - pips(x) || y[0] - x[0]);
  const avail = el.clientWidth - 16;
  let hu = Math.floor(avail / (Math.max(hand.length, 1) * 1.12));
  hu = Math.max(22, Math.min(66, hu, Math.floor(window.innerHeight * 0.095)));
  el.style.setProperty('--u', hu + 'px');
  el.classList.toggle('myturn', myTurn);
  el.innerHTML = hand.map(t => {
    const playable = myTurn && v.moves.some(m => sameTile(m.tile, t));
    const cls = 'mine ' + (playable ? 'playable' : 'dim') + (selected && sameTile(selected, t) ? ' sel' : '');
    return tileHTML(t[0], t[1], 'v', cls);
  }).join('');
}

function renderModal(v) {
  const m = $('#modal');
  if (v.phase !== 'roundEnd' && v.phase !== 'matchEnd') {
    m.hidden = true;
    m.innerHTML = '';
    return;
  }
  const r = v.roundInfo;
  const iWon = r.winner === v.mySeat;
  let title, sub;
  if (r.winner < 0) {
    title = 'Rodada empatada';
    sub = 'Jogo fechado com pontos iguais. Ninguém pontua.';
  } else {
    const w = v.players[r.winner];
    title = v.phase === 'matchEnd'
      ? (iWon ? 'Você venceu a partida!' : `${esc(w.name)} venceu a partida!`)
      : (iWon ? 'Você ganhou a rodada!' : `${esc(w.name)} ganhou a rodada`);
    sub = (r.reason === 'domino' ? 'Bateu: ficou sem peças.' : 'Jogo fechado: menos pontos na mão.') + ` +${r.points} pontos.`;
  }
  const rows = v.players.map((p, i) => {
    const hand = r.hands[i];
    const minis = hand.length ? hand.map(t => tileHTML(t[0], t[1], 'h')).join('') : '';
    return `<div class="mrow ${i === r.winner ? 'win' : ''}">` +
      `<span class="rn">${esc(p.name)}${i === v.mySeat ? ' (você)' : ''}<small>${hand.length ? sumPips(hand) + ' pontos na mão' : 'sem peças'}</small></span>` +
      `<b>${p.score}</b><div class="minis">${minis}</div></div>`;
  }).join('');
  const nextLabel = v.phase === 'matchEnd' ? 'Jogar de novo' : 'Próxima rodada';
  m.hidden = false;
  m.innerHTML = `<div class="mcard"><h2>${title}</h2><p class="sub">${sub}</p>${rows}` +
    `<div class="mbtns"><button class="btn primary" data-act="next">${nextLabel}</button>` +
    `<button class="btn" data-act="leave">Sair</button></div></div>`;
}

/* =====================================================
   EVENTOS
   ===================================================== */
$('#btnOnline').onclick = () => { show('screen-online'); setOnlineStatus(''); };
$('#btnLocal').onclick = () => show('screen-local');
$('#btnOnlineBack').onclick = () => { cleanupPeer(); show('screen-menu'); };
$('#btnLocalBack').onclick = () => show('screen-menu');
$('#btnCreate').onclick = createRoom;
$('#btnJoin').onclick = joinRoom;
$('#roomCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

$('#btnStartLocal').onclick = () => {
  const n = +document.querySelector('input[name=lp]:checked').value;
  const target = +$('#localTarget').value;
  mode = 'local';
  G = newGame('', target);
  addPlayer(myName(), false, null);
  for (let i = 1; i < n; i++) addPlayer(BOT_NAMES[i - 1], true, null);
  startMatch();
};

/* lobby */
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copiado!'); }
  catch (e) { window.prompt('Copie:', t); }
}
$('#btnCopyCode').onclick = () => lastView && copyText(lastView.code);
$('#btnCopyLink').onclick = () => {
  if (!lastView) return;
  const base = location.origin && location.origin !== 'null' ? location.origin + location.pathname : '';
  const url = base ? `${base}?sala=${lastView.code}` : '';
  if (url && navigator.share) {
    navigator.share({ title: 'Dominó', text: `Entre na minha sala de Dominó! Código: ${lastView.code}`, url }).catch(() => {});
  } else {
    copyText(url || lastView.code);
  }
};
$('#btnAddBot').onclick = () => send({ t: 'addBot' });
$('#btnStart').onclick = () => send({ t: 'start' });
$('#lobbyTarget').onchange = e => send({ t: 'setTarget', v: +e.target.value });
$('#btnLobbyLeave').onclick = leaveToMenu;
$('#lobbySlots').addEventListener('click', e => {
  const b = e.target.closest('[data-rm]');
  if (b) send({ t: 'removeBot', seat: +b.dataset.rm });
});

/* jogo */
$('#btnLeave').onclick = () => { if (confirm('Sair da partida?')) leaveToMenu(); };
$('#btnDraw').onclick = () => send({ t: 'draw' });

$('#hand').addEventListener('click', e => {
  const t = e.target.closest('.tile');
  const v = lastView;
  if (!t || !v || v.phase !== 'playing') return;
  if (v.turn !== v.mySeat) return toast('Aguarde a sua vez.');
  if (v.canDraw) return toast('Sem peça para jogar. Compre do monte.');
  const tile = [+t.dataset.a, +t.dataset.b];
  const mv = v.moves.find(m => sameTile(m.tile, tile));
  if (!mv) {
    t.classList.remove('shake');
    void t.offsetWidth;
    t.classList.add('shake');
    return;
  }
  if (mv.sides.length === 1) {
    selected = null;
    send({ t: 'play', tile: mv.tile, side: mv.sides[0] });
  } else {
    selected = sameTile(selected, tile) ? null : tile;
    renderGame(v);
  }
});

$('#chain').addEventListener('click', e => {
  const dz = e.target.closest('.dz');
  if (!dz || !selected) return;
  const tile = selected;
  selected = null;
  send({ t: 'play', tile, side: dz.dataset.side });
});

$('#modal').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'next') send({ t: 'next' });
  else leaveToMenu();
});

window.addEventListener('resize', () => {
  if (lastView && lastView.phase !== 'lobby' && $('#screen-game').classList.contains('active')) renderGame(lastView);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  if (mode === 'client') {
    if (hostConn && hostConn.open) hostConn.send({ t: 'sync' });
    else if (hostConn) exitRoom('Conexão perdida com o anfitrião.');
  }
});

/* link de convite: ?sala=CODIGO */
const invite = new URLSearchParams(location.search).get('sala');
if (invite) {
  $('#roomCode').value = invite.toUpperCase().slice(0, 5);
  show('screen-online');
}
})();

// Rumor Mill app: screens, host loop and client connection.

import { createGame, addPlayer, act, tick, viewFor, setConnected, cleanName, CONFIG } from './engine.js';
import { HostNet, ClientNet } from './net.js';

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const area = (k) => (k === 'rm-name' ? localStorage : sessionStorage);
const store = {
  get(k) {
    try {
      return JSON.parse(area(k).getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      area(k).setItem(k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
  del(k) {
    try {
      area(k).removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 24);
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

const ui = { mode: 'home', connectingText: '', status: 'connected', view: null, viewAt: 0, homeError: '', noRoom: 0, draftTo: null };
let session = store.get('rm-session');
let host = null;
let client = null;

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 3200);
}

// ---------- host ----------

function hostHandlers() {
  return {
    onHello: (msg) => (typeof msg.id === 'string' && msg.id.length <= 64 ? addPlayer(host.state, { id: msg.id, name: msg.name }) : { ok: false, error: 'Bad request.' }),
    onJoined: () => hostBroadcast(),
    onAction(pid, a) {
      const r = act(host.state, pid, a, Date.now());
      if (!r.ok) host.net.sendTo(pid, { t: 'err', error: r.error });
      hostBroadcast();
    },
    onReact() {},
    onDrop(pid) {
      setConnected(host.state, pid, false);
      hostBroadcast();
    },
  };
}

function hostBroadcast() {
  if (!host) return;
  const now = Date.now();
  host.lastSent = host.state.version;
  host.lastBeat = now;
  store.set('rm-state-' + host.state.code, host.state);
  host.net.broadcast((pid) => ({ t: 'view', view: viewFor(host.state, pid, now) }));
  setView(viewFor(host.state, session.id, now));
}

function startHostLoop() {
  if (location.hostname === 'localhost') window.__rmHost = host; // e2e test hook
  host.loop = setInterval(() => {
    const now = Date.now();
    tick(host.state, now);
    if (host.state.version !== host.lastSent || now - host.lastBeat > 2000) hostBroadcast();
  }, 250);
  hostBroadcast();
}

async function waitForPeer(ms = 10000) {
  const end = Date.now() + ms;
  while (!window.Peer && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return !!window.Peer;
}

async function openHostNet(state, retryForMs = 0) {
  const deadline = Date.now() + retryForMs;
  for (;;) {
    const net = new HostNet(state.code, hostHandlers());
    try {
      await net.open();
      return net;
    } catch (err) {
      if (err?.type === 'unavailable-id' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
}

const NO_LIB = 'The connection library did not load. Check your internet connection and reload.';
const netErr = (e) =>
  ['network', 'server-error', 'socket-error', 'socket-closed'].includes(e?.type)
    ? 'Could not reach the matchmaking server. Check your connection and try again.'
    : 'Something went wrong opening the connection. Try again.';

async function createRoom(name) {
  if (!(await waitForPeer())) return homeFail(NO_LIB);
  ui.mode = 'connecting';
  ui.connectingText = 'Lighting the lanterns…';
  render();
  const id = uid();
  for (let i = 0; i < 5; i++) {
    const state = createGame(newCode());
    addPlayer(state, { id, name });
    host = { state, net: null, loop: null, lastSent: 0, lastBeat: 0 };
    try {
      host.net = await openHostNet(state);
      session = { code: state.code, id, name, role: 'host' };
      store.set('rm-session', session);
      startHostLoop();
      history.replaceState(null, '', location.pathname + '?room=' + state.code);
      return;
    } catch (e) {
      host = null;
      if (e?.type === 'unavailable-id') continue;
      return homeFail(netErr(e));
    }
  }
  homeFail('Could not reserve a room code. Try again.');
}

async function resumeHost(saved) {
  if (!(await waitForPeer())) return homeFail(NO_LIB);
  ui.mode = 'connecting';
  ui.connectingText = `Reopening room ${saved.code}…`;
  render();
  saved.players.forEach((p) => (p.connected = p.id === session.id));
  host = { state: saved, net: null, loop: null, lastSent: 0, lastBeat: 0 };
  try {
    host.net = await openHostNet(saved, 45000);
    startHostLoop();
    toast('Room reopened. Everyone will reconnect automatically.');
  } catch {
    host = null;
    clearSession(saved.code);
    homeFail(`Room ${saved.code} could not be reopened. Start a new room.`);
  }
}

async function joinRoom(code, name) {
  if (!(await waitForPeer())) return homeFail(NO_LIB);
  const id = session && session.code === code ? session.id : uid();
  ui.mode = 'connecting';
  ui.connectingText = `Knocking on room ${code}…`;
  ui.noRoom = 0;
  render();
  client = new ClientNet(code, { id, name }, {
    onMessage(m) {
      if (m.t === 'welcome') {
        session = { code, id, name, role: 'client' };
        store.set('rm-session', session);
        history.replaceState(null, '', location.pathname + '?room=' + code);
      } else if (m.t === 'reject') {
        client.close();
        client = null;
        if (session?.code === code) clearSession(code);
        homeFail(m.error);
      } else if (m.t === 'view') setView(m.view);
      else if (m.t === 'err') toast(m.error);
    },
    onStatus(st) {
      if (st === 'no-room') {
        if (++ui.noRoom >= 3) {
          client.close();
          client = null;
          if (session?.code === code) clearSession(code);
          homeFail(`No room ${code} is open right now. Check the code with your host.`);
        }
        return;
      }
      if (st === 'closed') {
        client?.close();
        client = null;
        clearSession(code);
        return homeFail('The host closed the room.');
      }
      ui.status = st;
      renderStatus();
    },
  });
  client.start();
}

function doAct(a) {
  if (host) {
    const r = act(host.state, session.id, a, Date.now());
    if (!r.ok) toast(r.error);
    hostBroadcast();
  } else client?.act(a);
}

function clearSession(code) {
  store.del('rm-session');
  if (code) store.del('rm-state-' + code);
  session = null;
}

function leave() {
  if (host && !confirm('Leaving closes the room for everyone. Close it?')) return;
  if (host) {
    clearInterval(host.loop);
    host.net.close();
    clearSession(host.state.code);
    host = null;
  }
  if (client) {
    client.close();
    clearSession(session?.code);
    client = null;
  }
  ui.mode = 'home';
  ui.view = null;
  history.replaceState(null, '', location.pathname);
  render();
}

function homeFail(msg) {
  ui.mode = 'home';
  ui.homeError = msg;
  ui.view = null;
  render();
}

// ---------- view plumbing ----------

function setView(v) {
  const prev = ui.view;
  ui.view = v;
  ui.viewAt = performance.now();
  ui.mode = 'game';
  if (!prev || prev.version !== v.version || !$app.dataset.phase) render();
  else updateClock();
}

function remaining() {
  const v = ui.view;
  return v?.remainingMs ? Math.max(0, v.remainingMs - (performance.now() - ui.viewAt)) : 0;
}

function updateClock() {
  const ms = remaining();
  document.querySelectorAll('[data-secs]').forEach((el) => (el.textContent = Math.ceil(ms / 1000)));
  const t = ui.view?.totalMs || 0;
  document.querySelectorAll('[data-bar]').forEach((el) => (el.style.transform = `scaleX(${t ? Math.min(1, ms / t) : 0})`));
}
setInterval(updateClock, 200);

function renderStatus() {
  let bar = document.getElementById('netbar');
  if (!(client && ui.mode === 'game' && ui.status === 'reconnecting')) return bar?.remove();
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'netbar';
    bar.className = 'netbar';
    bar.textContent = 'Lost the host. Reconnecting…';
    document.body.appendChild(bar);
  }
}

const name = (id) => ui.view.players.find((p) => p.id === id)?.name ?? 'Someone';
const inviteLink = (code) => `${location.origin}${location.pathname}?join=${code}`;
const timer = (label) =>
  `<div class="timer"><div class="timer-row"><span>${esc(label)}</span><b><span data-secs>${Math.ceil(remaining() / 1000)}</span>s</b></div><div class="timer-track"><div class="timer-fill" data-bar></div></div></div>`;

// ---------- components ----------

function topbar() {
  const v = ui.view;
  const me = v.players.find((p) => p.id === v.you?.id);
  const inGame = v.phase !== 'lobby';
  return `<header class="topbar">
    <span class="tb-code">${esc(v.code)}</span>
    ${inGame && v.phase !== 'final' ? `<span class="tb-round">Round ${v.round} of ${v.maxRounds}</span>` : ''}
    <span class="tb-gap"></span>
    ${inGame && me && !me.spectator ? `<span class="tb-score">${me.score} pts</span>` : ''}
    <button class="chip" data-open="menu" aria-label="Menu">⋯</button>
  </header>`;
}

function roleCard() {
  const y = ui.view.you;
  if (!y?.role) return '';
  return y.role === 'gossip'
    ? `<section class="role role-gossip"><p class="role-label">You are the Gossip</p><p class="role-word">${esc(y.word)}</p><p class="role-help">Everyone else knows a different secret. Make the town believe <b>${esc(
        y.word
      )}</b> without getting caught.</p></section>`
    : `<section class="role"><p class="role-label">The town's secret</p><p class="role-word">${esc(y.word)}</p><p class="role-help">One of you is the Gossip and was told something else. Hint at the secret without saying it.</p></section>`;
}

function inbox() {
  const y = ui.view.you;
  if (!y || !y.inbox.length) return '';
  return `<section class="inbox"><h2 class="sec">Whispered to you</h2>${y.inbox
    .map((w) => `<div class="bubble bubble-private"><p>${esc(w.text)}</p><small>from ${esc(name(w.from))}, only you know that</small></div>`)
    .join('')}</section>`;
}

function people({ show = '' } = {}) {
  const v = ui.view;
  return `<section class="people"><h2 class="sec">Townsfolk</h2><ul>${v.players
    .filter((p) => !p.spectator)
    .map((p) => {
      const me = p.id === v.you?.id;
      const tag =
        show === 'whisper' ? (p.whispered ? 'Whispered' : '') : show === 'debate' ? (p.ready ? 'Ready' : '') : show === 'vote' ? (p.voted ? 'Voted' : '') : '';
      return `<li class="${me ? 'is-me' : ''}${p.connected ? '' : ' is-away'}"><span class="p-name">${esc(p.name)}${me ? ' <small>(you)</small>' : ''}${
        p.id === v.hostId ? ' <small>· host</small>' : ''
      }${p.connected ? '' : ' <small>· away</small>'}</span>${tag ? `<span class="tag">${tag}</span>` : ''}${
        v.phase !== 'lobby' ? `<span class="p-score">${p.score}</span>` : ''
      }${v.phase === 'lobby' && v.you?.isHost && !me ? `<button class="link" data-act="remove" data-id="${esc(p.id)}">Remove</button>` : ''}</li>`;
    })
    .join('')}</ul>${
    v.players.some((p) => p.spectator) ? `<p class="hint">Watching: ${v.players.filter((p) => p.spectator).map((p) => esc(p.name)).join(', ')}</p>` : ''
  }</section>`;
}

function howTo() {
  return `<section class="card howto"><h2 class="sec">How to play</h2><ol>
    <li><b>Get your word.</b> Everyone learns the town's secret, except the Gossip, who's told a rumor instead.</li>
    <li><b>Whisper.</b> Send one hint to one person. They see it came from you. Don't say the word.</li>
    <li><b>Hear the rumors.</b> Every whisper is read aloud to the whole town, with no names.</li>
    <li><b>Accuse.</b> Debate, then vote. Catch the Gossip and you score. If they escape, they score.</li>
  </ol><p class="hint-left">Caught Gossips get one last chance: guess the real secret to steal 3 points. Three rounds, a new Gossip each time.</p></section>`;
}

// ---------- screens ----------

function screenHome() {
  const params = new URLSearchParams(location.search);
  const joinCode = (params.get('join') || params.get('room') || '').toUpperCase().slice(0, 4);
  return `<section class="home">
    <div class="home-bubbles" aria-hidden="true"><span>psst…</span><span>did you hear?</span><span>it's about the…</span></div>
    <h1 class="title">Rumor<br/>Mill</h1>
    <p class="tagline">A whispering game for friends. Everyone knows the secret except the Gossip, who's spreading a rumor. Pass private hints, hear them all read aloud, and catch the liar.</p>
    <form class="card form" id="homeForm" autocomplete="off">
      <label class="field"><span>Your name</span><input id="name" maxlength="16" required placeholder="e.g. Edwin" value="${esc(store.get('rm-name') || '')}"/></label>
      ${ui.homeError ? `<p class="form-error" role="alert">${esc(ui.homeError)}</p>` : ''}
      <button type="submit" class="btn btn-main" data-intent="create" ${joinCode ? 'hidden' : ''}>Create a room</button>
      <div class="join"><label class="field field-code"><span>Room code</span><input id="code" maxlength="4" placeholder="ABCD" value="${esc(joinCode)}" autocapitalize="characters"/></label>
      <button type="submit" class="btn ${joinCode ? 'btn-main' : 'btn-line'}" data-intent="join">Join room</button></div>
      ${joinCode ? `<button type="submit" class="btn btn-ghost" data-intent="create">Create my own room instead</button>` : ''}
    </form>
    <p class="meta">3–8 players · 10 minutes · any phone or laptop · no login<br/><button class="link" data-open="howto">How to play</button></p>
  </section>`;
}

const screenConnecting = () => `<section class="center"><div class="spinner"></div><p>${esc(ui.connectingText)}</p><button class="btn btn-ghost" data-act="cancel">Cancel</button></section>`;

function screenLobby() {
  const v = ui.view;
  const n = v.players.filter((p) => !p.spectator && p.connected).length;
  const need = Math.max(0, CONFIG.minPlayers - n);
  return `${topbar()}<section>
    <div class="plate"><p class="plate-label">Room code</p><p class="plate-code">${esc(v.code)}</p>
    <p class="plate-hint">Friends open <b>${esc(location.host)}</b> and enter this code.</p>
    <button class="btn btn-line-dark btn-small" data-act="invite">Copy invite link</button></div>
    ${people()}
    ${
      v.you?.isHost
        ? `<button class="btn btn-main btn-wide" data-act="start" ${need ? 'disabled' : ''}>Start the gossip</button><p class="hint">${
            need ? `${need} more ${need > 1 ? 'people' : 'person'} needed. Share the code.` : `${n} townsfolk ready. Up to 8 can play.`
          }</p>`
        : `<p class="note">Waiting for ${esc(name(v.hostId))} to start.</p>`
    }
    ${v.you?.spectator ? '<p class="note">You joined mid-game and are watching. You’ll play next game.</p>' : ''}
    ${howTo()}</section>`;
}

function screenWhisper() {
  const v = ui.view;
  const y = v.you;
  let body = '';
  if (y?.spectator) body = '<p class="note">Everyone is whispering. You’re watching this game.</p>';
  else if (y.sent)
    body = `<div class="bubble bubble-sent"><p>${esc(y.sent.text)}</p><small>you whispered this to ${esc(name(y.sent.to))}</small></div><p class="hint">Waiting for the others.</p>`;
  else {
    const others = v.players.filter((p) => !p.spectator && p.id !== y.id);
    if (!others.some((p) => p.id === ui.draftTo)) ui.draftTo = null;
    body = `<form class="card whisper" id="whisperForm">
      <p class="field-label">Whisper to</p>
      <div class="pick">${others
        .map((p) => `<button type="button" class="pick-btn ${ui.draftTo === p.id ? 'is-on' : ''}" data-pick="${esc(p.id)}" aria-pressed="${ui.draftTo === p.id}">${esc(p.name)}</button>`)
        .join('')}</div>
      <label class="field"><span>Your hint (don't say the word)</span><input id="whisperText" maxlength="${CONFIG.maxWhisper}" placeholder="e.g. it smells amazing in the morning" value="${esc(
      ui.draftText || ''
    )}"/></label>
      <button type="submit" class="btn btn-main btn-wide" ${ui.draftTo ? '' : 'disabled'}>Send whisper</button>
    </form>`;
  }
  return `${topbar()}<section class="stage">
    <p class="kicker">Round ${v.round} · whisper</p><h2 class="h">Pass a secret hint</h2>
    ${roleCard()}${timer('Whispers close in')}${body}${inbox()}</section>${people({ show: 'whisper' })}`;
}

function revealed({ all = false } = {}) {
  const v = ui.view;
  const list = all ? v.revealed : v.revealed;
  return `<ol class="rumors">${list
    .map((r, i) => `<li class="bubble bubble-public${!all && i === list.length - 1 ? ' is-new' : ''}"><span class="num">${i + 1}</span><p>${esc(r.text)}</p></li>`)
    .join('')}</ol>`;
}

function screenReveal() {
  const v = ui.view;
  return `${topbar()}<section class="stage">
    <p class="kicker">Round ${v.round} · the rumor mill</p><h2 class="h">Whisper ${v.revealed.length} of ${v.revealTotal}</h2>
    <p class="sub">Read it out loud. No names, but someone in this room received each one.</p>
    ${revealed()}${roleCard()}${inbox()}</section>${people()}`;
}

function screenDebate() {
  const v = ui.view;
  const y = v.you;
  const humans = v.players.filter((p) => !p.spectator && p.connected);
  return `${topbar()}<section class="stage">
    <p class="kicker">Round ${v.round} · debate</p><h2 class="h">Who's the Gossip?</h2>
    <p class="sub">Which whisper doesn't fit? If you received it, say who sent it. They can't deny it.</p>
    ${timer('Vote opens in')}${revealed({ all: true })}
    ${y && !y.spectator ? `<button class="btn ${y.ready ? 'btn-line' : 'btn-main'} btn-wide" data-act="ready" ${y.ready ? 'disabled' : ''}>${y.ready ? 'Ready. Waiting for the others' : 'Ready to vote'}</button>` : ''}
    <p class="hint">${humans.filter((p) => p.ready).length} of ${humans.length} ready</p>
    ${roleCard()}${inbox()}</section>${people({ show: 'debate' })}`;
}

function screenVote() {
  const v = ui.view;
  const y = v.you;
  let body = '';
  if (y?.spectator) body = '<p class="note">The town is voting.</p>';
  else if (y.vote) body = `<p class="voted">You accused <b>${esc(name(y.vote))}</b>. Waiting for the town.</p>`;
  else
    body = `<div class="accuse">${v.players
      .filter((p) => !p.spectator && p.id !== y.id)
      .map((p) => `<button class="accuse-btn" data-act="vote" data-id="${esc(p.id)}">${esc(p.name)}</button>`)
      .join('')}</div>`;
  return `${topbar()}<section class="stage">
    <p class="kicker">Round ${v.round} · accuse</p><h2 class="h">Point at the Gossip</h2>
    <p class="sub">One accusation each, all at once. A tie means the Gossip slips away.</p>
    ${timer('Voting closes in')}${body}${revealed({ all: true })}</section>${people({ show: 'vote' })}`;
}

function screenGuess() {
  const v = ui.view;
  const y = v.you;
  const body = y?.options?.length
    ? `<p class="sub">You've been caught. Guess the town's real secret to steal 3 points.</p><div class="accuse">${y.options
        .map((w) => `<button class="accuse-btn" data-act="guess" data-word="${esc(w)}">${esc(w)}</button>`)
        .join('')}</div>`
    : `<p class="sub">The town caught someone. If it's the Gossip, they get one guess at the real secret.</p>`;
  return `${topbar()}<section class="stage"><p class="kicker">Round ${v.round} · caught?</p><h2 class="h">Last chance</h2>${timer('Guess in')}${body}</section>${people()}`;
}

function screenResult() {
  const v = ui.view;
  const r = v.lastResult;
  const gName = name(r.gossipId);
  const headline = r.caught ? `${esc(gName)} was the Gossip, and got caught` : `${esc(gName)} was the Gossip, and got away`;
  const agg = {};
  r.changes.forEach((c) => (agg[c.id] = agg[c.id] || { d: 0, why: [] }) && (agg[c.id].d += c.delta) && agg[c.id].why.push(c.why));
  return `${topbar()}<section class="stage">
    <p class="kicker">Round ${r.round} · the truth</p><h2 class="h">${headline}</h2>
    <div class="truth"><div><small>The secret</small><b>${esc(r.truth)}</b></div><div class="truth-rumor"><small>The rumor</small><b>${esc(r.rumor)}</b></div></div>
    ${r.caught ? `<p class="sub">${r.guess ? (r.guess === r.truth ? `${esc(gName)} guessed “${esc(r.guess)}” correctly and stole 3 points.` : `${esc(gName)} guessed “${esc(r.guess)}”. Wrong.`) : `${esc(gName)} didn't guess in time.`}</p>` : r.accused ? `<p class="sub">The town wrongly accused ${esc(name(r.accused))}.</p>` : '<p class="sub">The vote tied, so nobody was accused.</p>'}
    <h3 class="sec">Who whispered what</h3>
    <ul class="unmask">${r.whispers
      .map((w) => `<li class="${w.from === r.gossipId ? 'is-gossip' : ''}"><p>${esc(w.text)}</p><small>${esc(name(w.from))} → ${esc(name(w.to))}</small></li>`)
      .join('')}</ul>
    ${Object.keys(agg).length ? `<ul class="changes">${Object.entries(agg).map(([id, a]) => `<li><span>${esc(name(id))}</span><b>+${a.d}</b><small>${esc(a.why.join(', '))}</small></li>`).join('')}</ul>` : ''}
    ${timer(r.round >= v.maxRounds ? 'Final scores in' : 'Next round in')}</section>${people()}`;
}

function screenFinal() {
  const v = ui.view;
  const rows = v.finalScores || [];
  return `${topbar()}<section class="stage final">
    <p class="kicker">The rumor mill is closed</p><h2 class="h">${rows[0] ? `${esc(rows[0].name)} hears everything` : 'Game over'}</h2>
    <ol class="podium">${rows.map((r, i) => `<li style="--i:${i}"><span class="rank">${r.rank}</span><span>${esc(r.name)}</span><b>${r.score}</b></li>`).join('')}</ol>
    ${v.you?.isHost ? `<button class="btn btn-main btn-wide" data-act="playAgain">Play again in this room</button>` : `<p class="note">${esc(name(v.hostId))} can start a new game.</p>`}
  </section>`;
}

function openSheet(kind) {
  let body = '';
  if (kind === 'howto') body = howTo().replace('class="card howto"', 'class="howto"');
  if (kind === 'menu') {
    const v = ui.view;
    body = `<h2 class="sheet-title">Room ${esc(v?.code || '')}</h2>
      ${v ? `<button class="btn btn-line btn-wide" data-act="invite">Copy invite link</button>` : ''}
      <button class="btn btn-line btn-wide" data-open="howto">How to play</button>
      ${v ? `<button class="btn btn-danger btn-wide" data-act="leave">${host ? 'Close the room' : 'Leave the room'}</button>` : ''}
      ${host ? '<p class="hint-left">You’re hosting: the game runs on this device, so keep this tab open. If you refresh, the room reopens and everyone reconnects.</p>' : ''}`;
  }
  $sheet.innerHTML = `<div class="sheet-inner">${body}<button class="btn btn-ghost btn-wide" data-close>Close</button></div>`;
  if (!$sheet.open) $sheet.showModal();
}

function render() {
  if (ui.mode === 'home') {
    $app.innerHTML = screenHome();
    delete $app.dataset.phase;
    document.getElementById('homeForm').addEventListener('submit', onHomeSubmit);
    return;
  }
  if (ui.mode === 'connecting' || !ui.view) {
    $app.innerHTML = screenConnecting();
    return;
  }
  const v = ui.view;
  // Keep a half-typed whisper across re-renders.
  const t = document.getElementById('whisperText');
  if (t) ui.draftText = t.value;
  const focused = document.activeElement?.id === 'whisperText';
  const screens = { lobby: screenLobby, whisper: screenWhisper, reveal: screenReveal, debate: screenDebate, vote: screenVote, guess: screenGuess, result: screenResult, final: screenFinal };
  const prev = $app.dataset.phase;
  const y = window.scrollY;
  $app.innerHTML = (screens[v.phase] || screenLobby)();
  $app.dataset.phase = v.phase;
  if (prev === v.phase) window.scrollTo(0, y);
  else window.scrollTo(0, 0);
  if (v.phase !== 'whisper') ui.draftText = '';
  const nt = document.getElementById('whisperText');
  if (nt && focused) {
    nt.focus();
    nt.setSelectionRange(nt.value.length, nt.value.length);
  }
  document.getElementById('whisperForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = document.getElementById('whisperText').value;
    if (!text.trim()) return toast('Write a hint first.');
    doAct({ type: 'whisper', to: ui.draftTo, text });
  });
  updateClock();
  renderStatus();
}

let submitIntent = 'create';
function onHomeSubmit(e) {
  e.preventDefault();
  const intent = e.submitter?.dataset.intent || submitIntent;
  const n = cleanName(document.getElementById('name').value);
  if (!n) {
    ui.homeError = 'Enter your name first.';
    return render();
  }
  store.set('rm-name', n);
  ui.homeError = '';
  if (intent === 'join') {
    const code = document.getElementById('code').value.toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) {
      ui.homeError = 'Room codes are 4 letters.';
      return render();
    }
    joinRoom(code, n);
  } else createRoom(n);
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act],[data-open],[data-close],[data-pick],[data-intent]');
  if (!t || t.disabled) return;
  if (t.dataset.intent) submitIntent = t.dataset.intent;
  if (t.dataset.close !== undefined) return $sheet.close();
  if (t.dataset.open) return openSheet(t.dataset.open);
  if (t.dataset.pick) {
    ui.draftTo = t.dataset.pick;
    return render();
  }
  switch (t.dataset.act) {
    case 'start':
    case 'ready':
    case 'playAgain':
      return doAct({ type: t.dataset.act });
    case 'remove':
      return doAct({ type: 'remove', id: t.dataset.id });
    case 'vote':
      return doAct({ type: 'vote', target: t.dataset.id });
    case 'guess':
      return doAct({ type: 'guess', word: t.dataset.word });
    case 'invite': {
      const link = inviteLink(ui.view.code);
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        try {
          return await navigator.share({ title: 'Rumor Mill', text: 'Join my Rumor Mill room', url: link });
        } catch {
          /* fall through */
        }
      }
      try {
        await navigator.clipboard.writeText(link);
        toast('Invite link copied.');
      } catch {
        prompt('Copy this invite link:', link);
      }
      return;
    }
    case 'leave':
      $sheet.close();
      return leave();
    case 'cancel':
      client?.close();
      client = null;
      if (host) {
        clearInterval(host.loop);
        host = null;
      }
      return homeFail('');
    default:
  }
});

$sheet.addEventListener('click', (e) => e.target === $sheet && $sheet.close());
window.addEventListener('beforeunload', (e) => {
  if (host && ui.view && !['lobby', 'final'].includes(ui.view.phase)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function boot() {
  const p = new URLSearchParams(location.search);
  const urlRoom = (p.get('room') || '').toUpperCase();
  if (session && (!urlRoom || urlRoom === session.code)) {
    if (session.role === 'host') {
      const saved = store.get('rm-state-' + session.code);
      if (saved) return resumeHost(saved);
    } else return joinRoom(session.code, session.name);
  }
  render();
  if (p.get('join')) document.getElementById('name')?.focus();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

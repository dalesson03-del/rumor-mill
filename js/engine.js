// Rumor Mill engine. Pure state + functions. The host's browser runs it and
// sends each player only what they're allowed to see.

export const CONFIG = {
  minPlayers: 3,
  maxPlayers: 8,
  rounds: 3,
  whisperSeconds: 75,
  revealSeconds: 4,
  debateSeconds: 60,
  voteSeconds: 25,
  guessSeconds: 20,
  resultSeconds: 12,
  maxWhisper: 60,
};

// Each pair: the town's secret and a close-but-wrong rumor.
export const PAIRS = [
  ['Pizza', 'Burger'], ['Beach', 'Lake'], ['Cat', 'Fox'], ['Guitar', 'Violin'], ['Coffee', 'Tea'],
  ['Wedding', 'Graduation'], ['Library', 'Museum'], ['Snow', 'Rain'], ['Pirate', 'Cowboy'], ['Train', 'Airplane'],
  ['Dentist', 'Barber'], ['Volcano', 'Earthquake'], ['Wizard', 'Vampire'], ['Football', 'Basketball'], ['Honey', 'Syrup'],
  ['Moon', 'Sun'], ['Zoo', 'Farm'], ['Camera', 'Telescope'], ['Ghost', 'Zombie'], ['Bakery', 'Butcher'],
  ['Mango', 'Pineapple'], ['Castle', 'Prison'], ['Ninja', 'Spy'], ['Circus', 'Carnival'], ['Penguin', 'Owl'],
  ['Diamond', 'Gold'], ['Hospital', 'School'], ['Jungle', 'Desert'], ['Robot', 'Alien'], ['Golf', 'Tennis'],
];

function bump(s) {
  s.version += 1;
}
export function getPlayer(s, id) {
  return s.players.find((p) => p.id === id) || null;
}
const seated = (s) => s.players.filter((p) => !p.spectator);
const present = (s) => seated(s).filter((p) => p.connected);

export function cleanName(name) {
  return String(name || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

function shuffle(a, rng) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function setPhase(s, phase, now, seconds) {
  s.phase = phase;
  s.phaseStartedAt = now;
  s.phaseEndsAt = seconds ? now + seconds * 1000 : 0;
}

export function createGame(code) {
  return {
    code, version: 1, phase: 'lobby', hostId: null, players: [], round: 0, maxRounds: CONFIG.rounds,
    gossipId: null, lastGossipId: null, truth: null, rumor: null, options: [], usedPairs: [],
    whispers: {}, revealOrder: [], revealIndex: -1, ready: {}, votes: {}, guess: null,
    phaseStartedAt: 0, phaseEndsAt: 0, lastResult: null, finalScores: null,
  };
}

export function addPlayer(s, { id, name }) {
  const ex = getPlayer(s, id);
  if (ex) {
    ex.connected = true;
    bump(s);
    return { ok: true, player: ex, rejoined: true };
  }
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: 'Enter a name to join.' };
  const twin = s.players.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (twin) return { ok: false, error: `Someone here is already called ${twin.name}. Pick another name.` };
  const spectator = s.phase !== 'lobby' || seated(s).length >= CONFIG.maxPlayers;
  const player = { id, name: clean, connected: true, spectator, score: 0 };
  s.players.push(player);
  if (!s.hostId) s.hostId = id;
  bump(s);
  return { ok: true, player };
}

export function setConnected(s, id, c) {
  const p = getPlayer(s, id);
  if (!p || p.connected === c) return;
  p.connected = c;
  bump(s);
}

export function removePlayer(s, id) {
  if (s.phase !== 'lobby') return { ok: false, error: 'Players can only be removed in the lobby.' };
  if (id === s.hostId) return { ok: false, error: 'The host cannot be removed.' };
  s.players = s.players.filter((p) => p.id !== id);
  bump(s);
  return { ok: true };
}

export function startGame(s, now, rng = Math.random) {
  if (s.phase !== 'lobby') return { ok: false, error: 'The game has already started.' };
  s.players = s.players.filter((p) => p.connected);
  if (seated(s).length < CONFIG.minPlayers) return { ok: false, error: `You need at least ${CONFIG.minPlayers} players. Share the room code.` };
  s.players.forEach((p) => (p.score = 0));
  s.round = 0;
  s.usedPairs = [];
  s.lastGossipId = null;
  s.finalScores = null;
  nextRound(s, now, rng);
  return { ok: true };
}

function nextRound(s, now, rng) {
  s.round += 1;
  const crew = seated(s).filter((p) => p.connected);
  const pool = crew.length > 1 ? crew.filter((p) => p.id !== s.lastGossipId) : crew;
  s.gossipId = pool[Math.floor(rng() * pool.length)].id;
  s.lastGossipId = s.gossipId;
  const free = PAIRS.map((_, i) => i).filter((i) => !s.usedPairs.includes(i));
  const idx = free[Math.floor(rng() * free.length)];
  s.usedPairs.push(idx);
  const pair = rng() < 0.5 ? PAIRS[idx] : PAIRS[idx].slice().reverse();
  [s.truth, s.rumor] = pair;
  const others = shuffle(PAIRS.flat().filter((w) => !pair.includes(w)), rng).slice(0, 2);
  s.options = shuffle([s.truth, s.rumor, ...others], rng);
  s.whispers = {};
  s.revealOrder = [];
  s.revealIndex = -1;
  s.ready = {};
  s.votes = {};
  s.guess = null;
  s.lastResult = null;
  setPhase(s, 'whisper', now, CONFIG.whisperSeconds);
  bump(s);
}

export function whisper(s, pid, { to, text }, now) {
  if (s.phase !== 'whisper') return { ok: false, error: 'Whispering is closed.' };
  const p = getPlayer(s, pid);
  if (!p || p.spectator) return { ok: false, error: 'Only players can whisper.' };
  if (s.whispers[pid]) return { ok: false, error: 'You already whispered this round.' };
  const target = getPlayer(s, to);
  if (!target || target.spectator || to === pid) return { ok: false, error: 'Pick someone to whisper to.' };
  const clean = String(text || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, CONFIG.maxWhisper);
  if (!clean) return { ok: false, error: 'Write a whisper first.' };
  const word = pid === s.gossipId ? s.rumor : s.truth;
  if (clean.toLowerCase().includes(word.toLowerCase())) return { ok: false, error: `You can't say “${word}” outright. Hint at it.` };
  s.whispers[pid] = { to, text: clean, at: now };
  bump(s);
  if (present(s).every((x) => s.whispers[x.id])) beginReveal(s, now);
  return { ok: true };
}

function beginReveal(s, now) {
  s.revealOrder = Object.keys(s.whispers);
  s.revealOrder.sort((a, b) => (s.whispers[a].text < s.whispers[b].text ? -1 : 1)); // stable, sender-blind order
  s.revealIndex = 0;
  if (!s.revealOrder.length) return beginDebate(s, now);
  setPhase(s, 'reveal', now, CONFIG.revealSeconds);
  bump(s);
}

function beginDebate(s, now) {
  s.revealIndex = s.revealOrder.length - 1;
  s.ready = {};
  setPhase(s, 'debate', now, CONFIG.debateSeconds);
  bump(s);
}

export function markReady(s, pid, now) {
  if (s.phase !== 'debate') return { ok: false, error: 'Debate is not open.' };
  const p = getPlayer(s, pid);
  if (!p || p.spectator) return { ok: false, error: 'Only players can call the vote.' };
  s.ready[pid] = true;
  bump(s);
  if (present(s).every((x) => s.ready[x.id])) beginVote(s, now);
  return { ok: true };
}

function beginVote(s, now) {
  s.votes = {};
  setPhase(s, 'vote', now, CONFIG.voteSeconds);
  bump(s);
}

export function castVote(s, pid, target, now) {
  if (s.phase !== 'vote') return { ok: false, error: 'Voting is closed.' };
  const p = getPlayer(s, pid);
  if (!p || p.spectator) return { ok: false, error: 'Only players can vote.' };
  if (s.votes[pid]) return { ok: false, error: 'You already voted.' };
  const t = getPlayer(s, target);
  if (!t || t.spectator || target === pid) return { ok: false, error: 'Vote for someone else.' };
  s.votes[pid] = target;
  bump(s);
  if (present(s).every((x) => s.votes[x.id])) resolveVote(s, now);
  return { ok: true };
}

function tally(s) {
  const counts = {};
  Object.values(s.votes).forEach((t) => (counts[t] = (counts[t] || 0) + 1));
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter((k) => counts[k] === max);
  return { counts, accused: max > 0 && top.length === 1 ? top[0] : null };
}

function resolveVote(s, now) {
  const { accused } = tally(s);
  if (accused === s.gossipId) {
    setPhase(s, 'guess', now, CONFIG.guessSeconds);
    bump(s);
  } else finishRound(s, now);
}

export function makeGuess(s, pid, word, now) {
  if (s.phase !== 'guess') return { ok: false, error: 'No guess is open.' };
  if (pid !== s.gossipId) return { ok: false, error: 'Only the Gossip guesses.' };
  if (!s.options.includes(word) || word === s.rumor) return { ok: false, error: 'Pick one of the words.' };
  s.guess = word;
  finishRound(s, now);
  return { ok: true };
}

function finishRound(s, now) {
  const { counts, accused } = tally(s);
  const caught = accused === s.gossipId;
  const gossip = getPlayer(s, s.gossipId);
  const changes = [];
  const add = (p, d, why) => {
    if (!p || !d) return;
    p.score += d;
    changes.push({ id: p.id, delta: d, why });
  };
  if (caught) {
    Object.entries(s.votes).forEach(([v, t]) => t === s.gossipId && add(getPlayer(s, v), 2, 'Caught the Gossip'));
    if (s.guess === s.truth) add(gossip, 3, 'Guessed the real secret');
  } else add(gossip, 4, 'Got away with it');
  s.lastResult = {
    round: s.round, caught, accused, gossipId: s.gossipId, truth: s.truth, rumor: s.rumor, guess: s.guess,
    counts, changes,
    whispers: Object.entries(s.whispers).map(([from, w]) => ({ from, to: w.to, text: w.text })),
  };
  setPhase(s, 'result', now, CONFIG.resultSeconds);
  bump(s);
}

function finish(s, now) {
  const rows = seated(s).map((p) => ({ id: p.id, name: p.name, score: p.score })).sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => (r.rank = i && rows[i - 1].score === r.score ? rows[i - 1].rank : i + 1));
  s.finalScores = rows;
  setPhase(s, 'final', now, 0);
  bump(s);
}

export function playAgain(s, now) {
  if (s.phase !== 'final') return { ok: false, error: 'The game is still running.' };
  s.players = s.players.filter((p) => p.connected);
  let n = 0;
  s.players.forEach((p) => {
    p.spectator = n >= CONFIG.maxPlayers;
    if (!p.spectator) n++;
    p.score = 0;
  });
  Object.assign(s, { round: 0, gossipId: null, lastResult: null, finalScores: null });
  setPhase(s, 'lobby', now, 0);
  bump(s);
  return { ok: true };
}

export function tick(s, now, rng = Math.random) {
  const v = s.version;
  if (!s.phaseEndsAt || now < s.phaseEndsAt) return false;
  if (s.phase === 'whisper') beginReveal(s, now);
  else if (s.phase === 'reveal') {
    if (s.revealIndex < s.revealOrder.length - 1) {
      s.revealIndex += 1;
      setPhase(s, 'reveal', now, CONFIG.revealSeconds);
      bump(s);
    } else beginDebate(s, now);
  } else if (s.phase === 'debate') beginVote(s, now);
  else if (s.phase === 'vote') resolveVote(s, now);
  else if (s.phase === 'guess') finishRound(s, now);
  else if (s.phase === 'result') (s.round >= s.maxRounds ? finish(s, now) : nextRound(s, now, rng));
  return s.version !== v;
}

export function act(s, pid, a, now, rng = Math.random) {
  const host = pid === s.hostId;
  switch (a?.type) {
    case 'start':
      return host ? startGame(s, now, rng) : { ok: false, error: 'Only the host can start.' };
    case 'remove':
      return host ? removePlayer(s, a.id) : { ok: false, error: 'Only the host can remove players.' };
    case 'playAgain':
      return host ? playAgain(s, now) : { ok: false, error: 'Only the host can do that.' };
    case 'whisper':
      return whisper(s, pid, a, now);
    case 'ready':
      return markReady(s, pid, now);
    case 'vote':
      return castVote(s, pid, a.target, now);
    case 'guess':
      return makeGuess(s, pid, a.word, now);
    default:
      return { ok: false, error: 'Unknown action.' };
  }
}

export function viewFor(s, pid, now) {
  const me = getPlayer(s, pid);
  const inRound = ['whisper', 'reveal', 'debate', 'vote', 'guess'].includes(s.phase);
  const isGossip = pid === s.gossipId;
  const seatedMe = me && !me.spectator;
  const revealed = s.revealIndex >= 0 ? s.revealOrder.slice(0, s.revealIndex + 1).map((id) => ({ text: s.whispers[id].text })) : [];
  const inbox = Object.entries(s.whispers)
    .filter(([, w]) => w.to === pid)
    .map(([from, w]) => ({ from, text: w.text }));
  return {
    code: s.code, version: s.version, phase: s.phase, hostId: s.hostId, round: s.round, maxRounds: s.maxRounds,
    remainingMs: s.phaseEndsAt ? Math.max(0, s.phaseEndsAt - now) : 0,
    totalMs: s.phaseEndsAt ? s.phaseEndsAt - s.phaseStartedAt : 0,
    players: s.players.map((p) => ({
      id: p.id, name: p.name, connected: p.connected, spectator: p.spectator, score: p.score,
      whispered: !!s.whispers[p.id], ready: !!s.ready[p.id], voted: !!s.votes[p.id],
    })),
    revealed,
    revealTotal: s.revealOrder.length,
    lastResult: s.phase === 'result' || s.phase === 'final' ? s.lastResult : null,
    finalScores: s.phase === 'final' ? s.finalScores : null,
    you: me
      ? {
          id: pid, isHost: pid === s.hostId, spectator: me.spectator,
          role: inRound && seatedMe ? (isGossip ? 'gossip' : 'villager') : null,
          word: inRound && seatedMe ? (isGossip ? s.rumor : s.truth) : null,
          sent: s.whispers[pid] ? { to: s.whispers[pid].to, text: s.whispers[pid].text } : null,
          inbox: seatedMe ? inbox : [],
          ready: !!s.ready[pid],
          vote: s.votes[pid] || null,
          options: s.phase === 'guess' && isGossip ? s.options.filter((w) => w !== s.rumor) : [],
        }
      : null,
  };
}

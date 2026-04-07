/**
 * Astroyd.io - Game Server
 * Fixes: bots attack each other, accurate leaderboard (mass-based),
 *        top score persistence via IP (JSON file, no database needed),
 *        smoother physics (higher tick rate + better interpolation data)
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// ─── Constants ────────────────────────────────────────────────────────────────
const CONFIG = {
  WORLD_WIDTH: 4000,
  WORLD_HEIGHT: 4000,
  TICK_RATE: 30,
  MAX_STARS: 300,
  MAX_MASS: 10000,      // "r" stored on player is MASS, not pixels
  START_MASS: 18,
  STAR_RADIUS: 5,       // pixel radius of collectible stars (unchanged)
  STAR_VALUE: 2,        // mass gained per star
  SPEED_BASE: 180,      // px/s at minimum size
  SPEED_SCALE: 1,     // speed reduction per pixel-radius unit (applied to pixel r, not mass)
  CONSUME_RATIO: 1.1,
  MIN_BOTS: 5,
  MAX_BOTS: 10,
  BOT_NAMES: ['shadow','VOID','Nebula','crimson_fury','SolarFlare','lunar_echo','PHANTOM','voidwalker','StarDust','night_hawk','Eclipse','frostbite','BLAZEFURY','quantumLeap','astro_void','PixelGhost','stormbreaker','IRONCLAD','ember','DarkPulse','skyfall','cosmic_rift','Nova','HYPERION','drift','silent_echo','ArcLight','glitch','VOID_REIGN','emberfall','ShadowStrike','ice_queen','ZENITH','orbit','NovaFlare','midnight','StarForge','cryptic','blue_nova','RADIANT','GhostWalker','flare','VoidKnight','silver_shadow','ASTRAL','pulse','NightShift','core','echo_blade','LUMEN','drifter','blackhole','SolarWind','neon','FrostNova','gravity','storm','EMBERCORE','voidling','SkyBreaker','astro','PHOENIX','darkmatter','flareon','Quantum','steelheart','cosmos','redshift','ICEBOUND','shadowfax','NebulaCore','riftwalker','STATIC','nova_echo','stormlord','GLACIER','deepvoid','sunflare','ECHO','starlight','voidpulse','DarkStar','horizon','moonfall','SHADOWFANG','flux','NovaKnight','ghost','STARFALL','crypt','silverfang','blackstar','ASTROX','rift','NightFang','pulsefire','corex','zen','VOIDCORE'],
  BOT_CHASE_RANGE: 8,
  // Visual radius scale: pixel radius = RADIUS_BASE * log(mass / RADIUS_LOG_BASE)
  // At mass=18  → ~12px   At mass=500 → ~35px   At mass=10000 → ~65px
  RADIUS_BASE: 20,
  RADIUS_LOG_BASE: 5,
};

// Convert mass → pixel radius (used server-side for physics geometry)
// Client uses the same formula for rendering so they stay in sync.
function massToPixelRadius(mass) {
  return Math.max(8, CONFIG.RADIUS_BASE * Math.log(Math.max(1, mass) / CONFIG.RADIUS_LOG_BASE + 1));
}

// ─── Top-score persistence (flat JSON file, no database) ─────────────────────
// Stored as { "ip": topMass } — survives server restarts indefinitely.
const SCORES_FILE = path.join(__dirname, 'topscores.json');

function loadTopScores() {
  try {
    if (fs.existsSync(SCORES_FILE)) return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function saveTopScores(scores) {
  try { fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2)); } catch (_) {}
}

let topScores = loadTopScores();

function getTopScore(ip) { return topScores[ip] || 0; }

function updateTopScore(ip, mass) {
  const rounded = Math.round(mass);
  if (rounded > (topScores[ip] || 0)) {
    topScores[ip] = rounded;
    saveTopScores(topScores);
    return rounded;   // return new record value
  }
  return null;        // no new record
}

// ─── State ────────────────────────────────────────────────────────────────────
let players = {};
let stars = {};
let bots = {};
let idCounter = 1;

function genId() { return String(idCounter++); }
function rand(min, max) { return Math.random() * (max - min) + min; }

// ─── Star Management ──────────────────────────────────────────────────────────
function spawnStar() {
  const id = genId();
  stars[id] = {
    id,
    x: rand(50, CONFIG.WORLD_WIDTH - 50),
    y: rand(50, CONFIG.WORLD_HEIGHT - 50),
    r: CONFIG.STAR_RADIUS,
    hue: Math.floor(rand(30, 360)),
  };
  return stars[id];
}

function fillStars() {
  while (Object.keys(stars).length < CONFIG.MAX_STARS) spawnStar();
}

// ─── Player Management ────────────────────────────────────────────────────────
function createPlayer(id, name, isBot = false) {
  return {
    id,
    name: name || `Player${id}`,
    x: rand(200, CONFIG.WORLD_WIDTH - 200),
    y: rand(200, CONFIG.WORLD_HEIGHT - 200),
    r: CONFIG.START_MASS,   // r = mass (not pixels). Client converts via massToPixelRadius()
    vx: 0,
    vy: 0,
    score: 0,
    isBot,
    hue: Math.floor(rand(0, 360)),
    inputX: 0,
    inputY: 0,
  };
}

// ─── Bot AI ───────────────────────────────────────────────────────────────────
function createBot() {
  const id = genId();
  const name = CONFIG.BOT_NAMES[Math.floor(rand(0, CONFIG.BOT_NAMES.length))] + Math.floor(rand(10, 99));
  const player = createPlayer(id, name, true);
  bots[id] = { id, starTarget: null, chaseTarget: null, fleeTarget: null, updateTimer: 0 };
  players[id] = player;
  return player;
}

function removeBot(id) { delete bots[id]; delete players[id]; }

// ─── Physics Helpers ──────────────────────────────────────────────────────────
function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
function playerSpeed(mass) {
  const pr = massToPixelRadius(mass);
  return Math.max(40, CONFIG.SPEED_BASE - pr * CONFIG.SPEED_SCALE);
}

// ─── Bot AI Update ────────────────────────────────────────────────────────────
// FIX: Bots now scan ALL players (including other bots) for chase/flee decisions.
function updateBots(dt) {
  for (const [botId, bot] of Object.entries(bots)) {
    const p = players[botId];
    if (!p) continue;

    bot.updateTimer -= dt * 1000;
    if (bot.updateTimer <= 0) {
      bot.updateTimer = rand(250, 500);

      const FLEE_RANGE  = massToPixelRadius(p.r) * 7;
      const CHASE_RANGE = massToPixelRadius(p.r) * CONFIG.BOT_CHASE_RANGE;

      let fleeTarget = null,  fleeDist  = Infinity;
      let chaseTarget = null, chaseDist = Infinity;

      // Scan every player — human OR bot — for threat/prey
      for (const [pid, other] of Object.entries(players)) {
        if (pid === botId) continue;
        const d = dist(p, other);
        if (other.r >= p.r * CONFIG.CONSUME_RATIO && d < FLEE_RANGE) {
          if (d < fleeDist) { fleeDist = d; fleeTarget = pid; }
        } else if (p.r >= other.r * CONFIG.CONSUME_RATIO && d < CHASE_RANGE) {
          if (d < chaseDist) { chaseDist = d; chaseTarget = pid; }
        }
      }

      bot.fleeTarget  = fleeTarget;
      bot.chaseTarget = fleeTarget ? null : chaseTarget;

      if (!fleeTarget && !chaseTarget) {
        let bestStar = null, bestDist = Infinity;
        for (const [sid, star] of Object.entries(stars)) {
          const d = dist(p, star);
          if (d < bestDist) { bestDist = d; bestStar = sid; }
        }
        bot.starTarget = bestStar;
      } else {
        bot.starTarget = null;
      }
    }

    // Apply direction
    let dx = 0, dy = 0;
    if (bot.fleeTarget && players[bot.fleeTarget]) {
      const threat = players[bot.fleeTarget];
      dx = p.x - threat.x; dy = p.y - threat.y;
    } else if (bot.chaseTarget && players[bot.chaseTarget]) {
      const prey = players[bot.chaseTarget];
      dx = prey.x - p.x; dy = prey.y - p.y;
    } else if (bot.starTarget && stars[bot.starTarget]) {
      const star = stars[bot.starTarget];
      dx = star.x - p.x; dy = star.y - p.y;
    } else {
      p.inputX += rand(-0.4, 0.4);
      p.inputY += rand(-0.4, 0.4);
      const l = Math.sqrt(p.inputX ** 2 + p.inputY ** 2) || 1;
      p.inputX /= l; p.inputY /= l;
      continue;
    }
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    p.inputX = dx / len; p.inputY = dy / len;
  }
}

// ─── Physics Update ───────────────────────────────────────────────────────────
function updatePhysics(dt) {
  for (const p of Object.values(players)) {
    const speed = playerSpeed(p.r);   // p.r is mass; playerSpeed converts internally
    const pr = massToPixelRadius(p.r); // pixel radius for boundary checks
    const accel = Math.min(1, dt * 10);
    p.vx += (p.inputX * speed - p.vx) * accel;
    p.vy += (p.inputY * speed - p.vy) * accel;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Boundaries use pixel radius so players don't clip off-screen
    if (p.x < pr)                          { p.x = pr;                          p.vx =  Math.abs(p.vx) * 0.6; }
    if (p.x > CONFIG.WORLD_WIDTH  - pr)    { p.x = CONFIG.WORLD_WIDTH  - pr;    p.vx = -Math.abs(p.vx) * 0.6; }
    if (p.y < pr)                          { p.y = pr;                          p.vy =  Math.abs(p.vy) * 0.6; }
    if (p.y > CONFIG.WORLD_HEIGHT - pr)    { p.y = CONFIG.WORLD_HEIGHT - pr;    p.vy = -Math.abs(p.vy) * 0.6; }
  }
}

// ─── Collision Detection ──────────────────────────────────────────────────────
function checkCollisions() {
  const playerList = Object.values(players);
  const consumed = new Set();
  const starEvents = [], consumeEvents = [];

  // Star collection — use pixel radius for overlap.
  // Stars are rendered with a glow at 4x their radius, so we use a generous
  // pickup distance so collection feels responsive and matches what you see.
  const STAR_PICKUP_RADIUS = CONFIG.STAR_RADIUS * 5; // matches the visual glow size
  for (const p of playerList) {
    const pr = massToPixelRadius(p.r);
    for (const [sid, star] of Object.entries(stars)) {
      if (dist(p, star) < pr + STAR_PICKUP_RADIUS) {
        p.r = Math.min(CONFIG.MAX_MASS, p.r + CONFIG.STAR_VALUE);
        p.score++;
        delete stars[sid];
        starEvents.push({ starId: sid, playerId: p.id });
      }
    }
  }

  // Player-player collisions — use pixel radius for overlap, mass for consume ratio
  for (let i = 0; i < playerList.length; i++) {
    for (let j = i + 1; j < playerList.length; j++) {
      const a = playerList[i], b = playerList[j];
      if (consumed.has(a.id) || consumed.has(b.id)) continue;
      const pra = massToPixelRadius(a.r), prb = massToPixelRadius(b.r);
      // Overlap when distance < larger pixel radius
      if (dist(a, b) < Math.max(pra, prb)) {
        const bigger  = a.r >= b.r ? a : b;
        const smaller = a.r >= b.r ? b : a;
        if (bigger.r >= smaller.r * CONFIG.CONSUME_RATIO) {
          // Winner gains 30% of loser's mass
          bigger.r = Math.min(CONFIG.MAX_MASS, bigger.r + smaller.r * 1);
          bigger.score += 5;
          consumed.add(smaller.id);
          consumeEvents.push({ winnerId: bigger.id, loserId: smaller.id, loserName: smaller.name });
        }
      }
    }
  }

  for (const id of consumed) {
    if (players[id]) respawnPlayer(id);
  }

  fillStars();
  return { starEvents, consumeEvents };
}

function respawnPlayer(id) {
  const p = players[id];
  if (!p) return;
  p.x = rand(200, CONFIG.WORLD_WIDTH - 200);
  p.y = rand(200, CONFIG.WORLD_HEIGHT - 200);
  p.r = CONFIG.START_MASS;
  p.vx = 0; p.vy = 0;
}

// ─── Bot Population ───────────────────────────────────────────────────────────
function manageBots() {
  const humanCount = Object.values(players).filter(p => !p.isBot).length;
  const botCount   = Object.keys(bots).length;
  const desired    = Math.min(CONFIG.MAX_BOTS, Math.max(CONFIG.MIN_BOTS, CONFIG.MIN_BOTS - humanCount + 4));

  if (botCount < desired) {
    broadcast({ type: 'playerJoin', player: sanitizePlayer(createBot()) });
  } else if (botCount > desired + 2) {
    const botId = Object.keys(bots)[0];
    removeBot(botId);
    broadcast({ type: 'playerLeave', id: botId });
  }
}

// ─── WebSocket / HTTP Server ──────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const wsInfo = new WeakMap(); // ws -> { id, ip }

function sanitizePlayer(p) {
  return { id: p.id, name: p.name, x: p.x, y: p.y, r: p.r, score: p.score, hue: p.hue, isBot: p.isBot };
}

function broadcast(msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
  const id = genId();
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const player = createPlayer(id, null, false);
  players[id] = player;
  wsInfo.set(ws, { id, ip });

  sendTo(ws, {
    type: 'init',
    selfId: id,
    config: {
      WORLD_WIDTH: CONFIG.WORLD_WIDTH,
      WORLD_HEIGHT: CONFIG.WORLD_HEIGHT,
      // Client needs these to run the same massToPixelRadius formula
      RADIUS_BASE: CONFIG.RADIUS_BASE,
      RADIUS_LOG_BASE: CONFIG.RADIUS_LOG_BASE,
    },
    players: Object.values(players).map(sanitizePlayer),
    stars: Object.values(stars),
    topScore: getTopScore(ip),
  });

  broadcast({ type: 'playerJoin', player: sanitizePlayer(player) }, ws);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const p = players[id];
      if (!p) return;
      if (msg.type === 'input') {
        const len = Math.sqrt((msg.x || 0) ** 2 + (msg.y || 0) ** 2) || 0;
        p.inputX = len > 0 ? msg.x / len : 0;
        p.inputY = len > 0 ? msg.y / len : 0;
      } else if (msg.type === 'setName') {
        p.name = String(msg.name || '').trim().slice(0, 20) || `Player${id}`;
        broadcast({ type: 'playerUpdate', player: sanitizePlayer(p) });
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    const info = wsInfo.get(ws);
    if (!info) return;
    const p = players[info.id];
    if (p) updateTopScore(info.ip, p.r); // persist on disconnect
    delete players[info.id];
    broadcast({ type: 'playerLeave', id: info.id });
  });
});

// ─── Main Game Loop ───────────────────────────────────────────────────────────
let lastTick = Date.now();

function gameTick() {
  const now = Date.now();
  const dt  = Math.min((now - lastTick) / 1000, 0.05);
  lastTick  = now;

  updateBots(dt);
  updatePhysics(dt);
  const { starEvents, consumeEvents } = checkCollisions();

  // Check for new personal top-scores and piggyback into the tick
  const topScoreUpdates = {};
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const info = wsInfo.get(ws);
    if (!info) continue;
    const p = players[info.id];
    if (!p) continue;
    const newRecord = updateTopScore(info.ip, p.r);
    if (newRecord) topScoreUpdates[info.id] = newRecord;
  }

  broadcast({
    type: 'tick',
    players: Object.values(players).map(sanitizePlayer),
    stars: Object.values(stars),
    events: { stars: starEvents, consumed: consumeEvents },
    topScoreUpdates,
  });
}

fillStars();
for (let i = 0; i < CONFIG.MIN_BOTS; i++) createBot();
setInterval(gameTick, 1000 / CONFIG.TICK_RATE);
setInterval(manageBots, 3000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Astroyd.io running on http://localhost:${PORT}`));
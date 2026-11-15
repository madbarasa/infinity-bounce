/* global CONFIG */
'use strict';

// ==========================================
// 1. CONFIG
// ==========================================
const FALLBACK_CONFIG = {
    VERSION: '2.0.0', CANVAS_WIDTH: 800, CANVAS_HEIGHT: 600,
    PADDLE_WIDTH: 80, PADDLE_HEIGHT: 12, PADDLE_SPEED: 3.5,
    BALL_RADIUS: 8, BALL_SPEED: 7, BRICK_ROWS: 5, BRICK_COLS: 10,
    BRICK_WIDTH: 70, BRICK_HEIGHT: 20, BRICK_PADDING: 5,
    BRICK_OFFSET_TOP: 60, INITIAL_LIVES: 10, POWERUP_SIZE: 20,
    MAX_PLAYERS: 4, SERVER_TICK_MS: 8
};

const CFG = (typeof CONFIG === 'object' && CONFIG !== null) ? CONFIG : FALLBACK_CONFIG;
CFG.BRICK_OFFSET_LEFT = Number.isFinite(CFG.BRICK_OFFSET_LEFT)
    ? CFG.BRICK_OFFSET_LEFT
    : (CFG.CANVAS_WIDTH - (CFG.BRICK_COLS * CFG.BRICK_WIDTH + (CFG.BRICK_COLS - 1) * CFG.BRICK_PADDING)) / 2;

const COLORS = {
    players: ['#00f5d4', '#9b5de5', '#f15bb5', '#fee440'],
    ball: '#ffffff',
    bricks: ['#ef5350', '#ab47bc', '#42a5f5', '#26a69a', '#66bb6a'],
    powerups: { W: '#00f5d4', P: '#fee440', M: '#ffffff' }
};
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const HIGHSCORE_KEY = 'multi_breakout_highscore';
const PREFS_KEY = 'multi_breakout_prefs';
const NET_CONFIG = {
    PING_INTERVAL_MS: 1500,
    RTT_EMA_ALPHA: 0.2,
    RTT_MIN_MS: 20,
    RTT_MAX_MS: 220,
    LERP_MIN: 0.35,
    LERP_MAX: 0.75,
    RECONNECT_BASE_MS: 1000,
    RECONNECT_MAX_MS: 16000,
    INPUT_SEND_INTERVAL_MS: 33,
    EXTRAPOLATE_MAX_MS: 120
};

// ==========================================
// 2. GLOBAL STATE
// ==========================================
let ws = null;
let wsGeneration = 0;
let reconnectTimer = null;
let reconnectAttempt = 0;
let pingTimer = null;
let inputTimer = null;

let selfId = null;
let targetState = null;
let lastStateAt = 0;
let lerpFactor = 0.55;
let smoothedRttMs = null;
let lastSentInput = '';
let toastTimer = null;

const prefs = { sound: true, vibrate: true };

const gameState = {
    balls: [], bricks: [], players: [], powerups: [],
    lives: CFG.INITIAL_LIVES, status: 'waiting', score: 0
};

const keys = { left: false, right: false };
const mouse = { x: null };
const predicted = { active: false, x: null, sentX: null };
let audioCtx = null;

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const livesEl = document.getElementById('lives');
const highScoreEl = document.getElementById('high-score');
const playersEl = document.getElementById('players');
const menuEl = document.getElementById('game-menu');
const menuTitleEl = document.getElementById('menu-title');
const menuMessageEl = document.getElementById('menu-message');
const startBtn = document.getElementById('start-btn');
const pauseBtn = document.getElementById('pause-btn');
const restartBtn = document.getElementById('restart-btn');
const settingsBtn = document.getElementById('settings-btn');
const helpBtn = document.getElementById('help-btn');
const backBtn = document.getElementById('back-btn');
const closeBtn = document.getElementById('close-btn');
const panelEl = document.getElementById('panel');
const panelTitleEl = document.getElementById('panel-title');
const panelBodyEl = document.getElementById('panel-body');
const versionEl = document.getElementById('version');
const toastEl = document.getElementById('toast');

// ==========================================
// 3. UTILITIES
// ==========================================
function num(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeColor(value, fallback) {
    return typeof value === 'string' && COLOR_PATTERN.test(value) ? value : fallback;
}

function shortId(id) {
    return typeof id === 'string' ? id.slice(0, 4) : '----';
}

function readStore(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
}

function writeStore(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { return; }
}

function loadPrefs() {
    const raw = readStore(PREFS_KEY);
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            prefs.sound = parsed.sound !== false;
            prefs.vibrate = parsed.vibrate !== false;
        }
    } catch (e) { return; }
}

function savePrefs() { writeStore(PREFS_KEY, JSON.stringify(prefs)); }

function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2200);
}

function vibrate(pattern) {
    if (!prefs.vibrate || !navigator.vibrate) return;
    navigator.vibrate(pattern);
}

function playTone(kind) {
    if (!prefs.sound) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const gain = audioCtx.createGain();
    const osc = audioCtx.createOscillator();
    const setup = {
        brick: { type: 'square', from: 520, to: 760, duration: 0.08, volume: 0.05 },
        paddle: { type: 'sine', from: 300, to: 460, duration: 0.09, volume: 0.07 },
        powerup: { type: 'triangle', from: 640, to: 1080, duration: 0.18, volume: 0.08 },
        lose: { type: 'sawtooth', from: 260, to: 90, duration: 0.35, volume: 0.07 },
        win: { type: 'triangle', from: 520, to: 1200, duration: 0.5, volume: 0.08 }
    }[kind];
    if (!setup) return;
    osc.type = setup.type;
    osc.frequency.setValueAtTime(setup.from, now);
    osc.frequency.exponentialRampToValueAtTime(setup.to, now + setup.duration);
    gain.gain.setValueAtTime(setup.volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + setup.duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + setup.duration);
}

function buildBrickView(aliveList) {
    const list = Array.isArray(aliveList) ? aliveList : [];
    const bricks = [];
    for (let row = 0; row < CFG.BRICK_ROWS; row++) {
        for (let col = 0; col < CFG.BRICK_COLS; col++) {
            bricks.push({
                x: col * (CFG.BRICK_WIDTH + CFG.BRICK_PADDING) + CFG.BRICK_OFFSET_LEFT,
                y: row * (CFG.BRICK_HEIGHT + CFG.BRICK_PADDING) + CFG.BRICK_OFFSET_TOP,
                width: CFG.BRICK_WIDTH,
                height: CFG.BRICK_HEIGHT,
                color: COLORS.bricks[row % COLORS.bricks.length],
                alive: list[row * CFG.BRICK_COLS + col] !== false
            });
        }
    }
    return bricks;
}

function syncBricks(aliveList) {
    const list = Array.isArray(aliveList) ? aliveList : [];
    if (gameState.bricks.length !== CFG.BRICK_ROWS * CFG.BRICK_COLS) {
        gameState.bricks = buildBrickView(list);
        return;
    }
    gameState.bricks.forEach((b, i) => { b.alive = list[i] !== false; });
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// ==========================================
// 4. ASSETS
// ==========================================
function iconNode(name) {
    const img = document.createElement('img');
    img.src = `/icons/${name}.png`;
    img.alt = '';
    return img;
}

// ==========================================
// 5. EVENT HANDLERS
// ==========================================
document.addEventListener('keydown', (e) => {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = true;
    if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = true;
    if (e.code === 'ArrowLeft' || e.code === 'KeyA' || e.code === 'ArrowRight' || e.code === 'KeyD') {
        predicted.active = true;
        sendInput(true);
    }
    if (e.code === 'Space') { e.preventDefault(); sendCommand('pause'); }
});

document.addEventListener('keyup', (e) => {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = false;
    if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = false;
    if (e.code === 'ArrowLeft' || e.code === 'KeyA' || e.code === 'ArrowRight' || e.code === 'KeyD') sendInput(true);
});

function handleInputX(clientX) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    mouse.x = Math.max(0, Math.min(CFG.CANVAS_WIDTH, (clientX - rect.left) * (canvas.width / rect.width)));
    predicted.active = false;
    sendInput();
}

canvas.addEventListener('mousemove', (e) => handleInputX(e.clientX));
canvas.addEventListener('touchstart', (e) => { if (e.touches.length) handleInputX(e.touches[0].clientX); }, { passive: true });
canvas.addEventListener('touchmove', (e) => { if (e.touches.length) handleInputX(e.touches[0].clientX); }, { passive: true });

startBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        reconnectAttempt = 0;
        clearReconnect();
        connect();
        return;
    }
    if (gameState.status === 'paused') sendCommand('pause');
    else if (gameState.status === 'gameover' || gameState.status === 'win') sendCommand('restart');
    else sendCommand('start');
});

pauseBtn.addEventListener('click', () => sendCommand('pause'));
restartBtn.addEventListener('click', () => sendCommand('restart'));
settingsBtn.addEventListener('click', () => openPanel('settings'));
helpBtn.addEventListener('click', () => openPanel('help'));
backBtn.addEventListener('click', () => closePanel());
closeBtn.addEventListener('click', () => closePanel());

// ==========================================
// 6. CORE LOGIC
// ==========================================
function clearReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function stopPingLoop() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function scheduleReconnect() {
    clearReconnect();
    const delay = Math.min(NET_CONFIG.RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), NET_CONFIG.RECONNECT_MAX_MS);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function resetLocalState() {
    selfId = null;
    targetState = null;
    lastStateAt = 0;
    smoothedRttMs = null;
    lastSentInput = '';
    predicted.active = false;
    predicted.x = null;
    predicted.sentX = null;
    mouse.x = null;
    keys.left = false;
    keys.right = false;
    gameState.balls = [];
    gameState.players = [];
    gameState.powerups = [];
    gameState.score = 0;
    gameState.status = 'waiting';
    gameState.lives = CFG.INITIAL_LIVES;
    gameState.bricks = buildBrickView([]);
    updateUI();
}

function connect() {
    if (ws) {
        const old = ws;
        ws = null;
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        if (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING) old.close();
    }
    stopPingLoop();
    resetLocalState();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}`);
    const gen = ++wsGeneration;
    ws = socket;
    showMenu('多人打砖块', '正在连接服务器…', '连接中');

    socket.onopen = () => {
        if (gen !== wsGeneration) return;
        clearReconnect();
        reconnectAttempt = 0;
        socket.send(JSON.stringify({ type: 'join' }));
        startPingLoop();
    };

    socket.onmessage = (event) => {
        if (gen !== wsGeneration) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'welcome') {
            selfId = typeof msg.playerId === 'string' ? msg.playerId : null;
            return;
        }
        if (msg.type === 'fullState') {
            if (typeof msg.selfId === 'string') selfId = msg.selfId;
            if (msg.config && typeof msg.config === 'object') Object.assign(CFG, msg.config);
            applyFullState(msg);
            return;
        }
        if (msg.type === 'gameState') { applyGameState(msg); return; }
        if (msg.type === 'pong') {
            if (typeof msg.clientTs === 'number' && Number.isFinite(msg.clientTs)) {
                const rtt = Math.max(0, performance.now() - msg.clientTs);
                smoothedRttMs = smoothedRttMs === null
                    ? rtt
                    : smoothedRttMs * (1 - NET_CONFIG.RTT_EMA_ALPHA) + rtt * NET_CONFIG.RTT_EMA_ALPHA;
            }
            return;
        }
        if (msg.type === 'error') showToast(String(msg.message || '服务器返回错误'));
    };

    socket.onerror = () => { /* 由 onclose 统一处理重连 */ };

    socket.onclose = () => {
        if (gen !== wsGeneration) return;
        stopPingLoop();
        showMenu('连接断开', '正在尝试自动重连…', '重连');
        scheduleReconnect();
    };
}

function startPingLoop() {
    stopPingLoop();
    pingTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'ping', clientTs: performance.now() }));
    }, NET_CONFIG.PING_INTERVAL_MS);
}

function sendInput(force = false) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const inputState = { type: 'input', left: keys.left, right: keys.right, mouseX: mouse.x };
    const inputStr = JSON.stringify(inputState);
    if (force || inputStr !== lastSentInput) {
        ws.send(inputStr);
        lastSentInput = inputStr;
    }
}

function sendCommand(cmd) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'command', command: cmd }));
}

function applyFullState(msg) {
    syncBricks(msg.bricks);
    targetState = msg;
    lastStateAt = performance.now();
    gameState.players = sanitizePlayers(msg.players);
    gameState.balls = sanitizeBalls(msg.balls);
    gameState.powerups = sanitizePowerups(msg.powerups);
    gameState.lives = num(msg.lives, CFG.INITIAL_LIVES);
    gameState.score = num(msg.score, 0);
    gameState.status = typeof msg.status === 'string' ? msg.status : 'waiting';
    predicted.x = null;
    predicted.sentX = null;
    updateUI();
}

function sanitizePlayers(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, CFG.MAX_PLAYERS || 4).map((p) => ({
        id: typeof p.id === 'string' ? p.id : '',
        x: num(p.x, 0),
        y: num(p.y, CFG.CANVAS_HEIGHT - CFG.PADDLE_HEIGHT - 10),
        color: safeColor(p.color, COLORS.players[0]),
        score: num(p.score, 0),
        paddleWidth: num(p.paddleWidth, CFG.PADDLE_WIDTH)
    }));
}

function sanitizeBalls(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 16).map((b) => ({
        x: num(b.x, CFG.CANVAS_WIDTH / 2), y: num(b.y, CFG.CANVAS_HEIGHT / 2),
        dx: num(b.dx, 0), dy: num(b.dy, -CFG.BALL_SPEED)
    }));
}

function sanitizePowerups(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 24).map((pu) => ({
        x: num(pu.x, 0), y: num(pu.y, 0),
        width: num(pu.width, CFG.POWERUP_SIZE), height: num(pu.height, CFG.POWERUP_SIZE),
        type: ['W', 'P', 'M'].includes(pu.type) ? pu.type : 'P'
    }));
}

function applyGameState(msg) {
    const prevStatus = gameState.status;
    const prevLives = gameState.lives;
    const prevBricksAlive = gameState.bricks.reduce((n, b) => n + (b.alive ? 1 : 0), 0);
    const prevPlayers = gameState.players.length;
    const prevScore = gameState.score;

    targetState = msg;
    lastStateAt = performance.now();
    gameState.status = typeof msg.status === 'string' ? msg.status : 'waiting';
    gameState.lives = num(msg.lives, CFG.INITIAL_LIVES);
    gameState.score = num(msg.score, 0);
    if (Array.isArray(msg.bricks)) syncBricks(msg.bricks);
    if (Array.isArray(msg.players)) {
        const incoming = sanitizePlayers(msg.players);
        const byId = new Map(gameState.players.map(p => [p.id, p]));
        gameState.players = incoming.map((fresh) => {
            const old = byId.get(fresh.id);
            if (!old) return fresh;
            return Object.assign(old, { x: fresh.x, y: fresh.y, color: fresh.color, score: fresh.score, paddleWidth: fresh.paddleWidth });
        });
    }
    if (Array.isArray(msg.balls)) {
        const fresh = sanitizeBalls(msg.balls);
        if (fresh.length !== gameState.balls.length) gameState.balls = fresh;
        else gameState.balls.forEach((b, i) => { b.x = fresh[i].x; b.y = fresh[i].y; b.dx = fresh[i].dx; b.dy = fresh[i].dy; });
    }
    if (Array.isArray(msg.powerups)) gameState.powerups = sanitizePowerups(msg.powerups);

    const nextAlive = gameState.bricks.reduce((n, b) => n + (b.alive ? 1 : 0), 0);
    if (nextAlive < prevBricksAlive) { playTone('brick'); vibrate(18); }
    if (gameState.players.length > prevPlayers) playTone('powerup');
    if (gameState.lives < prevLives && prevStatus === 'playing' && gameState.status !== 'win') { playTone('lose'); vibrate([40, 30, 60]); }
    if (gameState.status === 'win' && prevStatus !== 'win') playTone('win');
    if (gameState.score > prevScore && nextAlive === prevBricksAlive) playTone('paddle');
    updateUI();
}

function updateAdaptiveLerpFactor() {
    if (smoothedRttMs === null) return;
    const clamped = Math.max(NET_CONFIG.RTT_MIN_MS, Math.min(NET_CONFIG.RTT_MAX_MS, smoothedRttMs));
    const t = (clamped - NET_CONFIG.RTT_MIN_MS) / (NET_CONFIG.RTT_MAX_MS - NET_CONFIG.RTT_MIN_MS);
    lerpFactor = NET_CONFIG.LERP_MAX - t * (NET_CONFIG.LERP_MAX - NET_CONFIG.LERP_MIN);
}

function updateUI() {
    scoreEl.textContent = String(gameState.score);
    livesEl.textContent = String(gameState.lives);

    const stored = readStore(HIGHSCORE_KEY);
    const prevBest = stored === null || stored === '' ? 0 : Number(stored);
    const best = Number.isFinite(prevBest) ? prevBest : 0;
    if (gameState.score > best) {
        highScoreEl.textContent = String(gameState.score);
        writeStore(HIGHSCORE_KEY, String(gameState.score));
    } else {
        highScoreEl.textContent = String(best);
    }

    playersEl.replaceChildren();
    for (const p of gameState.players) {
        const tag = el('div', 'player-tag' + (p.id === selfId ? ' self' : ''));
        tag.style.backgroundColor = p.color;
        tag.appendChild(el('span', 'p-id', shortId(p.id)));
        tag.appendChild(el('span', 'p-score', String(p.score)));
        if (p.id === selfId) tag.appendChild(el('span', 'you-tag', 'YOU'));
        playersEl.appendChild(tag);
    }

    const pauseLabel = gameState.status === 'paused' ? '继续' : '暂停';
    pauseBtn.title = pauseLabel;
    pauseBtn.setAttribute('aria-label', pauseLabel);
    pauseBtn.classList.toggle('active', gameState.status === 'paused');
    pauseBtn.replaceChildren(iconNode(gameState.status === 'paused' ? 'play' : 'pause'));

    if (gameState.status === 'waiting') showMenu('多人打砖块', '等待玩家加入…', '开始游戏');
    else if (gameState.status === 'gameover') showMenu('游戏结束', `最终得分: ${gameState.score}`, '再玩一次');
    else if (gameState.status === 'win') showMenu('恭喜通关！', `最终得分: ${gameState.score}`, '再玩一次');
    else if (gameState.status === 'paused') showMenu('已暂停', '点击继续游戏', '继续游戏');
    else hideMenu();
}

function showMenu(title, msg, btnText) {
    menuEl.classList.remove('hidden');
    menuTitleEl.textContent = title;
    menuMessageEl.textContent = msg;
    startBtn.textContent = btnText;
}

function hideMenu() { menuEl.classList.add('hidden'); }

function fillRoundRect(context, x, y, w, h, r) {
    context.beginPath();
    if (typeof context.roundRect === 'function') context.roundRect(x, y, w, h, r);
    else context.rect(x, y, w, h);
    context.fill();
}

function draw() {
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const brick of gameState.bricks) {
        if (!brick.alive) continue;
        ctx.fillStyle = brick.color;
        fillRoundRect(ctx, brick.x, brick.y, brick.width, brick.height, 4);
    }

    for (const player of gameState.players) {
        const width = num(player.paddleWidth, CFG.PADDLE_WIDTH);
        let drawX = player.x;
        if (player.id === selfId && predicted.active && predicted.x !== null) drawX = predicted.x;
        ctx.fillStyle = player.color;
        fillRoundRect(ctx, drawX, player.y, width, CFG.PADDLE_HEIGHT, 8);
        ctx.shadowBlur = 15;
        ctx.shadowColor = player.color;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.strokeRect(drawX, player.y, width, CFG.PADDLE_HEIGHT);
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(player.id === selfId ? 'YOU' : shortId(player.id), drawX + width / 2, player.y - 8);
    }

    for (const ball of gameState.balls) {
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, CFG.BALL_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.ball;
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#fff';
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    for (const pu of gameState.powerups) {
        ctx.fillStyle = COLORS.powerups[pu.type] || '#fff';
        ctx.shadowBlur = 15;
        ctx.shadowColor = ctx.fillStyle;
        fillRoundRect(ctx, pu.x, pu.y, pu.width, pu.height, 4);
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#000';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pu.type, pu.x + pu.width / 2, pu.y + pu.height / 2);
    }

    if (gameState.status === 'paused') {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 48px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('已暂停', canvas.width / 2, canvas.height / 2);
    }
}

function makeToggle(label, value, onChange) {
    const row = el('div', 'row');
    row.appendChild(el('span', 'row-label', label));
    const toggle = el('button', 'toggle');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(value));
    toggle.setAttribute('aria-label', label);
    toggle.addEventListener('click', () => {
        const next = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', String(next));
        onChange(next);
        openPanel('settings');
    });
    row.appendChild(toggle);
    return row;
}

function buildSettingsPanel() {
    panelTitleEl.textContent = '设置';
    const frag = document.createDocumentFragment();
    frag.appendChild(makeToggle('音效', prefs.sound, (v) => {
        prefs.sound = v; savePrefs();
        if (v) playTone('powerup');
    }));
    const soundRow = el('div', 'row');
    soundRow.appendChild(iconNode('sound'));
    soundRow.appendChild(el('span', 'row-label', '音效开关'));
    soundRow.appendChild(el('span', 'row-value', prefs.sound ? '开启' : '关闭'));
    frag.appendChild(soundRow);
    frag.appendChild(makeToggle('震动', prefs.vibrate, (v) => {
        prefs.vibrate = v; savePrefs();
        if (v) vibrate(30);
    }));
    const vibrateRow = el('div', 'row');
    vibrateRow.appendChild(iconNode('vibrate'));
    vibrateRow.appendChild(el('span', 'row-label', '震动反馈'));
    vibrateRow.appendChild(el('span', 'row-value', prefs.vibrate ? '开启' : '关闭'));
    frag.appendChild(vibrateRow);
    panelBodyEl.replaceChildren(frag);
    appendCreditsRow();
    appendVersionRow();
}

function appendVersionRow() {
    const row = el('div', 'row');
    row.appendChild(el('span', 'row-label', '版本'));
    row.appendChild(el('span', 'row-value', 'v' + CFG.VERSION));
    panelBodyEl.appendChild(row);
}


function appendCreditsRow() {
    const row = el('div', 'row');
    row.appendChild(iconNode('credits'));
    row.appendChild(el('span', 'row-label', '开发者名单'));
    const btn = el('button', 'icon-btn');
    btn.type = 'button';
    btn.title = '开发者名单';
    const arrow = iconNode('back');
    arrow.style.transform = 'rotate(180deg)';
    btn.appendChild(arrow);
    btn.onclick = () => openPanel('credits');
    row.appendChild(btn);
    panelBodyEl.appendChild(row);
}

function buildHelpPanel() {
    panelTitleEl.textContent = '帮助';
    const wrap = el('div', 'row');
    const text = el('div', 'help-text');
    text.appendChild(el('strong', null, '操作说明'));
    const ul = document.createElement('ul');
    const lines = ['← → 或 A D 键移动挡板', '鼠标或触摸在画布内移动也可控制挡板', '空格键或暂停按钮切换暂停', '开始游戏后邀请朋友打开同一页面地址加入同一房间', '击碎砖块得分，每 100 分奖励 1 条生命', 'W 加宽挡板、P 加分、M 分裂多球', '清空全部砖块即通关'];
    lines.forEach(line => ul.appendChild(el('li', null, line)));
    text.appendChild(ul);
    wrap.appendChild(text);
    panelBodyEl.replaceChildren(wrap);
}

function buildCreditsPanel() {
    panelTitleEl.textContent = '开发者名单';
    const wrap = el('div', 'row');
    const group = el('div', 'credits-group');
    group.appendChild(el('div', 'credits-title', '游戏设计'));
    group.appendChild(el('div', 'credits-line', 'madbarasa'));
    group.appendChild(el('div', 'credits-title', '程序实现'));
    group.appendChild(el('div', 'credits-line', 'Node.js 服务端权威模拟 · 原生 Canvas 渲染 · WebSocket 实时同步'));
    group.appendChild(el('div', 'credits-title', '引擎'));
    group.appendChild(el('div', 'credits-line', 'Urhox'));
    const badge = document.createElement('img');
    badge.className = 'badge-img';
    badge.src = '/icons/powered-by-dsh.png';
    badge.alt = 'powered by dsh';
    badge.width = 121;
    badge.height = 20;
    group.appendChild(badge);
    wrap.appendChild(group);
    panelBodyEl.replaceChildren(wrap);
}

function openPanel(mode) {
    if (mode === 'settings') buildSettingsPanel();
    else if (mode === 'help') buildHelpPanel();
    else buildCreditsPanel();
    panelEl.classList.remove('hidden');
    panelEl.setAttribute('aria-hidden', 'false');
    menuEl.classList.add('hidden');
    backBtn.focus();
}

function closePanel() {
    panelEl.classList.add('hidden');
    panelEl.setAttribute('aria-hidden', 'true');
    updateUI();
}

function interpolate() {
    if (!targetState) return;
    updateAdaptiveLerpFactor();
    const freshPlayers = sanitizePlayers(targetState.players);
    freshPlayers.forEach(target => {
        const p = gameState.players.find(lp => lp.id === target.id);
        if (!p) return;
        if (p.id === selfId && predicted.active) return;
        p.x += (target.x - p.x) * lerpFactor;
        p.y = target.y;
    });
    const freshBalls = sanitizeBalls(targetState.balls);
    if (freshBalls.length !== gameState.balls.length) {
        gameState.balls = freshBalls;
    } else {
        const elapsed = Math.min(performance.now() - lastStateAt, NET_CONFIG.EXTRAPOLATE_MAX_MS);
        const ticks = elapsed / (CFG.SERVER_TICK_MS || 8);
        gameState.balls.forEach((b, i) => {
            const t = freshBalls[i];
            b.x = t.x + t.dx * ticks;
            b.y = t.y + t.dy * ticks;
        });
    }
}

function loop() {
    if (gameState.status === 'playing') {
        interpolate();
        const me = gameState.players.find(p => p.id === selfId);
        if (predicted.active && me) {
            const width = num(me.paddleWidth, CFG.PADDLE_WIDTH);
            const serverPlayers = sanitizePlayers(targetState && targetState.players);
            const serverX = num((serverPlayers.find(p => p.id === selfId) || {}).x, me.x);
            if (predicted.x === null) predicted.x = serverX;
            if (predicted.sentX === null) predicted.sentX = predicted.x;
            const dir = (keys.left ? -1 : 0) + (keys.right ? 1 : 0);
            const step = CFG.PADDLE_SPEED * (1000 / (CFG.SERVER_TICK_MS || 8)) * (1 / 60);
            predicted.x = Math.max(0, Math.min(CFG.CANVAS_WIDTH - width, predicted.x + dir * step));
            if (Math.abs(predicted.x - serverX) > 120) predicted.x = serverX;
            me.x = predicted.x;
            if (Math.abs(predicted.x - predicted.sentX) > 6) {
                mouse.x = predicted.x + width / 2;
                sendInput(true);
                predicted.sentX = predicted.x;
            }
        }
    }
    draw();
    requestAnimationFrame(loop);
}

// ==========================================
// 7. INITIALIZATION
// ==========================================
window.addEventListener('load', () => {
    loadPrefs();
    versionEl.textContent = 'v' + CFG.VERSION;
    gameState.bricks = buildBrickView([]);
    updateUI();
    if (inputTimer) clearInterval(inputTimer);
    inputTimer = setInterval(sendInput, NET_CONFIG.INPUT_SEND_INTERVAL_MS);
    connect();
    requestAnimationFrame(loop);
});

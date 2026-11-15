'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const core = require('./game-core');
const CONFIG = core.CONFIG;

function resolvePort(raw) {
    if (raw === undefined || raw === null || raw === '') return CONFIG.DEFAULT_PORT;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`PORT 必须是 1-65535 的整数，收到: ${raw}`);
    }
    return n;
}

const PORT = resolvePort(process.env.PORT);

const STATIC_FILES = new Map([
    ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
    ['/game.js', { file: 'game.js', type: 'application/javascript; charset=utf-8' }],
    ['/config.js', { file: null, type: 'application/javascript; charset=utf-8' }],
    ['/bg.webp', { file: 'bg.webp', type: 'image/webp', cache: true, root: 'assets' }],
    ['/favicon.png', { file: 'icons/play.png', type: 'image/png', cache: true, root: 'assets' }]
]);

const ICON_PREFIX = '/icons/';
const ICON_NAMES = new Set([
    'settings', 'back', 'help', 'close', 'sound', 'vibrate',
    'credits', 'pause', 'play', 'restart', 'powered-by-dsh'
]);
const COMMON_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN' };

function sendHeaders(res, status, type, extra) {
    res.writeHead(status, Object.assign({}, COMMON_HEADERS, { 'Content-Type': type }, extra || {}));
}

function sendNotFound(res) {
    sendHeaders(res, 404, 'text/plain; charset=utf-8');
    res.end('Not found');
}

function serveFile(res, relPath, type, extra, root) {
    const abs = path.join(__dirname, root || 'public', relPath);
    fs.readFile(abs, (err, data) => {
        if (err) { sendNotFound(res); return; }
        sendHeaders(res, 200, type, extra);
        res.end(data);
    });
}

function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    let host;
    try { host = new URL(origin).host; } catch (e) { return false; }
    const expected = req.headers['x-forwarded-host'] || req.headers.host;
    if (host === expected) return true;
    const hostname = String(expected).split(':')[0];
    return new URL(origin).hostname === hostname;
}

const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendNotFound(res); return; }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/health') {
        const body = JSON.stringify({ status: 'ok', version: CONFIG.VERSION, players: game.players.length, uptime: process.uptime() });
        sendHeaders(res, 200, 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
    }

    if (pathname.startsWith(ICON_PREFIX)) {
        const file = pathname.slice(ICON_PREFIX.length);
        const name = file.endsWith('.png') ? file.slice(0, -4) : file;
        if (!ICON_NAMES.has(name) || !/^[a-z][a-z0-9-]*$/.test(name) || name.includes('..')) { sendNotFound(res); return; }
        const abs = path.join(__dirname, 'assets', 'icons', name + '.png');
        fs.readFile(abs, (err, data) => {
            if (err) { sendNotFound(res); return; }
            sendHeaders(res, 200, 'image/png', { 'Cache-Control': 'public, max-age=86400' });
            res.end(req.method === 'HEAD' ? undefined : data);
        });
        return;
    }

    const entry = STATIC_FILES.get(pathname);
    if (!entry) { sendNotFound(res); return; }
    const extra = entry.cache ? { 'Cache-Control': 'public, max-age=86400' } : { 'Cache-Control': 'no-cache' };
    if (entry.file === null) {
        const body = 'const CONFIG = ' + JSON.stringify(CONFIG) + ';';
        sendHeaders(res, 200, entry.type, extra);
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
    }
    serveFile(res, entry.file, entry.type, extra, entry.root);
});

server.on('error', (err) => {
    console.error('[HTTP]', err.message);
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') process.exitCode = 1;
});
server.on('clientError', (err, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

const wss = new WebSocket.Server({
    server,
    maxPayload: CONFIG.MAX_PAYLOAD,
    verifyClient: (info, done) => { done(sameOrigin(info.req)); }
});

wss.on('error', (err) => { console.error('[WSS]', err.message); });

const game = core.createGame();

function wsPlayer(ws) {
    if (!ws.playerId) return null;
    return game.players.find(p => p.id === ws.playerId) || null;
}

function safeSend(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return; }
    ws.send(payload);
}

function broadcastGameState() {
    if (!game.dirty) return;
    const message = JSON.stringify(core.serializeState(game));
    for (const c of wss.clients) safeSend(c, message);
    game.dirty = false;
}

function broadcastFullState() {
    for (const c of wss.clients) {
        if (c.readyState !== WebSocket.OPEN || !c.playerId) continue;
        safeSend(c, JSON.stringify(core.serializeFull(game, c.playerId)));
    }
    game.dirty = false;
}

function sendError(ws, message) {
    safeSend(ws, JSON.stringify({ type: 'error', message }));
}

function handleMessage(ws, raw) {
    if (!ws.messageBudget || Date.now() > ws.budgetResetAt) {
        ws.budgetResetAt = Date.now() + 1000;
        ws.messageBudget = CONFIG.MAX_MESSAGES_PER_SECOND;
    }
    ws.messageBudget--;
    if (ws.messageBudget < 0) { ws.terminate(); return; }

    let data;
    try { data = JSON.parse(raw); } catch (e) { sendError(ws, '消息格式错误'); return; }
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.type !== 'string') {
        sendError(ws, '消息格式错误');
        return;
    }

    if (data.type === 'join') {
        if (ws.playerId) { safeSend(ws, JSON.stringify(core.serializeFull(game, ws.playerId))); return; }
        if (game.players.length >= CONFIG.MAX_PLAYERS) { sendError(ws, '房间已满'); return; }
        const player = core.addPlayer(game, ws);
        if (!player) { sendError(ws, '无法加入'); return; }
        safeSend(ws, JSON.stringify(core.serializeFull(game, player.id)));
        broadcastGameState();
        return;
    }

    const player = wsPlayer(ws);
    if (!player) { sendError(ws, '请先加入房间'); return; }

    if (data.type === 'input') {
        const input = core.normalizeInput(data);
        if (!input) { sendError(ws, '输入参数错误'); return; }
        core.applyInput(game, player, input);
        return;
    }
    if (data.type === 'ping') {
        const clientTs = typeof data.clientTs === 'number' && Number.isFinite(data.clientTs) ? data.clientTs : null;
        safeSend(ws, JSON.stringify({ type: 'pong', clientTs, serverTs: Date.now() }));
        return;
    }
    if (data.type === 'command') {
        const command = core.normalizeCommand(data);
        if (!command) { sendError(ws, '指令无效'); return; }
        if (command === 'start') core.startGame(game);
        else if (command === 'pause') core.togglePause(game);
        else if (command === 'restart') { core.restartGame(game); core.startGame(game); broadcastFullState(); return; }
        broadcastGameState();
        return;
    }
    sendError(ws, '未知消息类型');
}

wss.on('connection', (ws) => {
    ws.playerId = null;
    ws.isAlive = true;
    ws.messageBudget = CONFIG.MAX_MESSAGES_PER_SECOND;
    ws.budgetResetAt = Date.now() + 1000;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* 单连接错误隔离，防止未处理 error 事件终止进程 */ });
    ws.on('message', (message) => { handleMessage(ws, message.toString()); });
    ws.on('close', () => {
        if (core.removePlayer(game, ws)) broadcastGameState();
    });
});

const heartbeat = setInterval(() => {
    for (const c of wss.clients) {
        if (!c.isAlive) { c.terminate(); continue; }
        c.isAlive = false;
        if (c.readyState === WebSocket.OPEN) c.ping();
    }
}, CONFIG.HEARTBEAT_INTERVAL_MS);
heartbeat.unref();

const simTimer = setInterval(() => { core.stepGame(game); }, CONFIG.SIMULATION_TICK_MS);
simTimer.unref();

const broadcastTimer = setInterval(broadcastGameState, CONFIG.BROADCAST_INTERVAL_MS);
broadcastTimer.unref();

process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    if (err && err.code === 'EADDRINUSE') process.exit(1);
});
process.on('unhandledRejection', (err) => { console.error('[unhandledRejection]', err); });

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT} (v${CONFIG.VERSION})`);
});

module.exports = { server, wss, game };

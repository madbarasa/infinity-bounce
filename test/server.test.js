'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
let PORT = 19000;

function nextPort() { return PORT++; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startServer(env) {
    const port = nextPort();
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(port) }, env || {}),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });
    return { child, port, getLog: () => log };
}

async function waitReady(inst, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (inst.getLog().includes('Server running')) return;
        if (inst.child.exitCode !== null) throw new Error(`服务提前退出: ${inst.getLog()}`);
        await sleep(30);
    }
    throw new Error(`服务启动超时: ${inst.getLog()}`);
}

function openSocket(port, options) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, options || {});
        const queue = [];
        ws.on('message', m => {
            try { queue.push(JSON.parse(m.toString())); } catch (e) { queue.push({ raw: m.toString() }); }
        });
        ws.on('open', () => resolve({ ws, queue }));
        ws.on('error', reject);
    });
}

function waitFor(client, predicate, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
            const found = client.queue.find(predicate);
            if (found) return resolve(found);
            if (Date.now() - start > timeoutMs) return resolve(null);
            setTimeout(tick, 8);
        };
        tick();
    });
}

function get(port, pathname, method = 'GET', headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function withServer(fn, env) {
    const inst = startServer(env);
    try {
        await waitReady(inst);
        return await fn(inst.port, inst);
    } finally {
        inst.child.kill('SIGKILL');
    }
}

test('PORT 非数字时进程快速失败并输出明确错误', async () => {
    const inst = startServer({ PORT: 'not_a_number' });
    await sleep(400);
    assert.equal(inst.child.exitCode, 1);
    assert.match(inst.getLog(), /PORT 必须是 1-65535 的整数/);
    inst.child.kill('SIGKILL');
});

test('PORT 越界值时进程快速失败', async () => {
    const inst = startServer({ PORT: '70000' });
    await sleep(400);
    assert.equal(inst.child.exitCode, 1);
    inst.child.kill('SIGKILL');
});

test('/health 返回 ok、版本与玩家数，POST 被拒绝', async () => {
    await withServer(async (port) => {
        const good = await get(port, '/health');
        assert.equal(good.status, 200);
        const body = JSON.parse(good.body);
        assert.equal(body.status, 'ok');
        assert.equal(body.version, '2.0.0');
        assert.equal(body.players, 0);
        const post = await get(port, '/health', 'POST');
        assert.equal(post.status, 404);
    });
});

test('静态资源带查询串可访问，含 charset、nosniff 与缓存头', async () => {
    await withServer(async (port) => {
        for (const [pathname, type] of [['/index.html?x=1', 'text/html'], ['/style.css?v=2', 'text/css'], ['/game.js?v=3', 'application/javascript'], ['/config.js?v=4', 'application/javascript']]) {
            const res = await get(port, pathname);
            assert.equal(res.status, 200, pathname);
            assert.match(res.headers['content-type'], new RegExp(type));
            assert.match(res.headers['content-type'], /charset=utf-8/);
            assert.equal(res.headers['x-content-type-options'], 'nosniff');
            assert.ok(res.headers['cache-control']);
        }
        const config = await get(port, '/config.js');
        assert.match(config.body, /"VERSION":"2.0.0"/);
        assert.match(config.body, /"BRICK_OFFSET_LEFT"/);
        const missing = await get(port, '/nope.css');
        assert.equal(missing.status, 404);
        assert.equal(missing.headers['content-type'], 'text/plain; charset=utf-8');
        const bg = await get(port, '/bg.webp');
        assert.equal(bg.status, 200);
        assert.equal(bg.headers['content-type'], 'image/webp');
        const icon = await get(port, '/icons/settings.png');
        assert.equal(icon.status, 200);
        assert.equal(icon.headers['content-type'], 'image/png');
        const badIcon = await get(port, '/icons/..%2fpackage.json');
        assert.equal(badIcon.status, 404);
    });
});

test('跨源 WebSocket 握手被拒绝，同源握手被接受', async () => {
    await withServer(async (port) => {
        await assert.rejects(
            () => openSocket(port, { headers: { Origin: 'https://evil.example.com' } }),
            /Unexpected server response: 401|socket hang up/
        );
        const okClient = await openSocket(port);
        okClient.ws.close();
    });
});

test('join 由服务端分配 id，客户端自带 playerId 被完全忽略', async () => {
    await withServer(async (port) => {
        const a = await openSocket(port);
        a.ws.send(JSON.stringify({ type: 'join', playerId: '<img src=x onerror=alert(1)>' }));
        const full = await waitFor(a, m => m.type === 'fullState');
        assert.ok(full);
        assert.match(full.selfId, /^p_/);
        assert.equal(full.players.length, 1);
        assert.match(full.players[0].id, /^p_/);
        assert.ok(!full.players[0].id.includes('img'));
        assert.equal(full.bricks.length, 50);
        assert.equal(full.config.VERSION, '2.0.0');
        a.ws.close();
    });
});

test('未加入连接不能发送 start/pause/restart/input/ping，全部返回 error', async () => {
    await withServer(async (port) => {
        const a = await openSocket(port);
        a.ws.send(JSON.stringify({ type: 'join' }));
        await waitFor(a, m => m.type === 'fullState');
        const b = await openSocket(port);
        for (const msg of [
            { type: 'command', command: 'start' },
            { type: 'command', command: 'pause' },
            { type: 'command', command: 'restart' },
            { type: 'input', left: true, right: false, mouseX: 100 },
            { type: 'ping', clientTs: 123 }
        ]) {
            a.queue.length = 0;
            b.ws.send(JSON.stringify(msg));
            const err = await waitFor(b, m => m.type === 'error');
            assert.ok(err, JSON.stringify(msg));
        }
        a.queue.length = 0;
        a.ws.send(JSON.stringify({ type: 'join' }));
        const state = await waitFor(a, m => m.type === 'fullState');
        assert.ok(state);
        assert.equal(state.status, 'waiting');
        a.ws.close(); b.ws.close();
    });
});

test('匿名连接无法冒充他人控制挡板', async () => {
    await withServer(async (port) => {
        const a = await openSocket(port);
        a.ws.send(JSON.stringify({ type: 'join' }));
        const full = await waitFor(a, m => m.type === 'fullState');
        const victimId = full.selfId;
        const b = await openSocket(port);
        a.queue.length = 0;
        b.ws.send(JSON.stringify({ type: 'input', playerId: victimId, left: false, right: false, mouseX: 300 }));
        const err = await waitFor(b, m => m.type === 'error');
        assert.ok(err);
        await sleep(200);
        const state = a.queue.filter(m => m.type === 'gameState').pop();
        if (state) assert.notEqual(state.players[0].x, 260);
        a.ws.close(); b.ws.close();
    });
});

test('畸形 mouseX 被拒绝，挡板与球坐标保持有限', async () => {
    await withServer(async (port) => {
        const a = await openSocket(port);
        a.ws.send(JSON.stringify({ type: 'join' }));
        await waitFor(a, m => m.type === 'fullState');
        a.ws.send(JSON.stringify({ type: 'command', command: 'start' }));
        await waitFor(a, m => m.type === 'gameState' && m.status === 'playing');
        for (const bad of ['evil', NaN, {}, [], null, 1e309]) {
            a.queue.length = 0;
            const payload = { type: 'input', left: false, right: false, mouseX: bad };
            if (bad === null) delete payload.mouseX;
            a.ws.send(JSON.stringify(payload));
            await sleep(40);
        }
        await sleep(300);
        const states = a.queue.filter(m => m.type === 'gameState');
        assert.ok(states.length > 0);
        for (const s of states) {
            assert.ok(Number.isFinite(s.players[0].x), `挡板 x: ${s.players[0].x}`);
            for (const ball of s.balls) {
                assert.ok(Number.isFinite(ball.x));
                assert.ok(Number.isFinite(ball.y));
            }
        }
        a.ws.close();
    });
});

test('未知 command 与非法类型返回 error 且不产生广播放大', async () => {
    await withServer(async (port) => {
        const a = await openSocket(port);
        a.ws.send(JSON.stringify({ type: 'join' }));
        await waitFor(a, m => m.type === 'fullState');
        a.queue.length = 0;
        a.ws.send(JSON.stringify({ type: 'command', command: '__nope__' }));
        const err = await waitFor(a, m => m.type === 'error');
        assert.ok(err);
        a.ws.send(JSON.stringify({ type: 'command', command: { a: 1 } }));
        const err2 = await waitFor(a, m => m.type === 'error');
        assert.ok(err2);
        a.ws.close();
    });
});

test('deeply nested playerId 不会终止进程', async () => {
    await withServer(async (port, inst) => {
        const a = await openSocket(port);
        let nested = '1';
        for (let i = 0; i < 300; i++) nested = '[' + nested + ']';
        a.ws.send('{"type":"join","playerId":' + nested + '}');
        await sleep(300);
        assert.equal(inst.child.exitCode, null);
        const full = await waitFor(a, m => m.type === 'fullState');
        assert.ok(full);
        assert.match(full.selfId, /^p_/);
        a.ws.close();
    });
});

test('restart 向所有已连接客户端广播完整状态与重建砖墙', async () => {
    await withServer(async (port) => {
        const a = await openSocket(port);
        a.ws.send(JSON.stringify({ type: 'join' }));
        await waitFor(a, m => m.type === 'fullState');
        a.ws.send(JSON.stringify({ type: 'command', command: 'start' }));
        await waitFor(a, m => m.type === 'gameState' && m.status === 'playing');
        a.queue.length = 0;
        a.ws.send(JSON.stringify({ type: 'command', command: 'restart' }));
        const full = await waitFor(a, m => m.type === 'fullState');
        assert.ok(full);
        assert.equal(full.bricks.filter(Boolean).length, 50);
        assert.equal(full.lives, 10);
        assert.equal(full.score, 0);
        assert.equal(full.status, 'playing');
        const b = await openSocket(port);
        b.ws.send(JSON.stringify({ type: 'join' }));
        const bFull = await waitFor(b, m => m.type === 'fullState');
        assert.equal(bFull.bricks.length, 50);
        a.ws.close(); b.ws.close();
    });
});

test('玩家加入与离开时全量状态含增删后的玩家列表', async () => {
    await withServer(async (port) => {
        const a = await openSocket(port);
        a.ws.send(JSON.stringify({ type: 'join' }));
        const aFull = await waitFor(a, m => m.type === 'fullState');
        const b = await openSocket(port);
        b.ws.send(JSON.stringify({ type: 'join' }));
        const withB = await waitFor(a, m => m.type === 'gameState' && m.players.length === 2);
        assert.ok(withB);
        b.ws.close();
        const afterLeave = await waitFor(a, m => m.type === 'gameState' && m.players.length === 1, 2000);
        assert.ok(afterLeave);
        assert.equal(afterLeave.players[0].id, aFull.selfId);
        a.ws.close();
    });
});

test('消息限流：超量消息后连接被终止且进程存活', async () => {
    await withServer(async (port, inst) => {
        const a = await openSocket(port);
        a.ws.send(JSON.stringify({ type: 'join' }));
        await waitFor(a, m => m.type === 'fullState');
        for (let i = 0; i < 200; i++) {
            a.ws.send(JSON.stringify({ type: 'ping', clientTs: i }));
        }
        await sleep(400);
        assert.equal(inst.child.exitCode, null);
        a.ws.close();
    });
});

test('畸形 WebSocket 帧不会终止进程', async () => {
    await withServer(async (port, inst) => {
        const net = require('node:net');
        const socket = net.connect(port, '127.0.0.1');
        await new Promise(r => socket.on('connect', r));
        const key = require('node:crypto').randomBytes(16).toString('base64');
        socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        await new Promise(r => socket.once('data', r));
        socket.write(Buffer.from([0xc1, 0x82, 0x00, 0x00, 0x00, 0x00, 0x41, 0x42]));
        await sleep(300);
        assert.equal(inst.child.exitCode, null);
        socket.destroy();
    });
});

test('ping 仅回显有限数值 clientTs，畸形值回 null', async () => {
    await withServer(async (port) => {
        const a = await openSocket(port);
        a.ws.send(JSON.stringify({ type: 'join' }));
        await waitFor(a, m => m.type === 'fullState');
        a.queue.length = 0;
        a.ws.send(JSON.stringify({ type: 'ping', clientTs: 1234 }));
        const pong = await waitFor(a, m => m.type === 'pong');
        assert.equal(pong.clientTs, 1234);
        assert.ok(Number.isFinite(pong.serverTs));
        a.queue.length = 0;
        a.ws.send(JSON.stringify({ type: 'ping', clientTs: { evil: [1, 2, 3] } }));
        const pong2 = await waitFor(a, m => m.type === 'pong');
        assert.equal(pong2.clientTs, null);
        a.ws.close();
    });
});

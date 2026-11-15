'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19777;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function openSocket() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        const queue = [];
        ws.on('message', m => { try { queue.push(JSON.parse(m.toString())); } catch (e) { /* 忽略 */ } });
        ws.on('open', () => resolve({ ws, queue }));
        ws.on('error', reject);
    });
}

function waitFor(client, predicate, timeoutMs = 4000) {
    return new Promise(resolve => {
        const start = Date.now();
        const tick = () => {
            const found = client.queue.find(predicate);
            if (found) return resolve(found);
            if (Date.now() - start > timeoutMs) return resolve(null);
            setTimeout(tick, 10);
        };
        tick();
    });
}

test('两名玩家完整对局：开始、球运动、击砖得分、暂停冻结、继续、重开', async () => {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(PORT) }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);
    const clients = [];
    try {
        const start = Date.now();
        while (!log.includes('Server running') && Date.now() - start < 3000) await sleep(30);
        assert.match(log, /Server running/);

        const a = await openSocket(); clients.push(a);
        const b = await openSocket(); clients.push(b);
        a.ws.send(JSON.stringify({ type: 'join' }));
        b.ws.send(JSON.stringify({ type: 'join' }));
        const aFull = await waitFor(a, m => m.type === 'fullState');
        await waitFor(b, m => m.type === 'fullState');
        assert.ok(aFull);
        const twoPlayers = await waitFor(a, m => m.type === 'gameState' && m.players.length === 2);
        assert.ok(twoPlayers);
        assert.equal(twoPlayers.players.length, 2);

        a.queue.length = 0;
        b.queue.length = 0;
        b.ws.send(JSON.stringify({ type: 'command', command: 'start' }));
        const playing = await waitFor(a, m => m.type === 'gameState' && m.status === 'playing');
        assert.ok(playing);
        assert.equal(playing.balls.length, 1);
        assert.equal(playing.bricks.filter(Boolean).length, 50);
        assert.equal(playing.lives, 10);

        await sleep(1200);
        const states = a.queue.filter(m => m.type === 'gameState');
        assert.ok(states.length >= 10, `广播帧数 ${states.length}`);
        assert.ok(states.length <= 55, `广播过频 ${states.length}`);
        const first = states[0];
        const last = states[states.length - 1];
        assert.notDeepEqual(
            { x: first.balls[0]?.x, y: first.balls[0]?.y },
            { x: last.balls[0]?.x, y: last.balls[0]?.y }
        );
        const destroyed = last.bricks.filter(v => v === false).length;
        assert.ok(destroyed >= 1, `击碎砖块数 ${destroyed}`);
        assert.ok(last.score >= 10, `得分 ${last.score}`);
        assert.equal(last.bricks.length, 50);

        a.queue.length = 0;
        b.ws.send(JSON.stringify({ type: 'command', command: 'pause' }));
        const paused = await waitFor(a, m => m.type === 'gameState' && m.status === 'paused');
        assert.ok(paused);
        await sleep(250);
        const pausedStates = a.queue.filter(m => m.type === 'gameState');
        assert.ok(pausedStates.length <= 12, `暂停期间广播 ${pausedStates.length}`);
        const frozenX = pausedStates[0]?.balls[0]?.x;
        const frozenY = pausedStates[0]?.balls[0]?.y;
        for (const s of pausedStates) {
            assert.equal(s.balls[0]?.x, frozenX);
            assert.equal(s.balls[0]?.y, frozenY);
        }

        a.queue.length = 0;
        b.ws.send(JSON.stringify({ type: 'command', command: 'pause' }));
        const resumed = await waitFor(a, m => m.type === 'gameState' && m.status === 'playing');
        assert.ok(resumed);

        a.queue.length = 0;
        a.ws.send(JSON.stringify({ type: 'command', command: 'restart' }));
        const restarted = await waitFor(a, m => m.type === 'fullState');
        assert.ok(restarted);
        assert.equal(restarted.bricks.filter(Boolean).length, 50);
        assert.equal(restarted.score, 0);
        assert.equal(restarted.lives, 10);
        assert.equal(restarted.status, 'playing');
        assert.equal(restarted.players.length, 2);
    } finally {
        for (const c of clients) c.ws.close();
        child.kill('SIGKILL');
    }
});

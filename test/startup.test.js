'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19999;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function spawnServer(env) {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(PORT) }, env || {}),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);
    return { child, getLog: () => log };
}

test('端口被占用时第二个实例以非零码退出并记录结构化错误', async () => {
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(PORT, '127.0.0.1', resolve));
    const inst = spawnServer();
    try {
        await sleep(700);
        assert.equal(inst.child.exitCode, 1, `日志: ${inst.getLog()}`);
        assert.match(inst.getLog(), /EADDRINUSE/);
        assert.match(inst.getLog(), /\[HTTP\]/);
    } finally {
        if (inst.child.exitCode === null) inst.child.kill('SIGKILL');
        await new Promise(resolve => blocker.close(resolve));
    }
});

test('PORT 为空字符串时回落到默认端口 8082', async () => {
    const inst = spawnServer({ PORT: '' });
    try {
        await sleep(500);
        assert.match(inst.getLog(), /http:\/\/localhost:8082/);
    } finally {
        inst.child.kill('SIGKILL');
    }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19666;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function get(pathname, method = 'GET', headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('首页引用的全部资源均可由 HTTP 服务返回 200 且类型正确', async () => {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(PORT) }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);
    try {
        const start = Date.now();
        while (!log.includes('Server running') && Date.now() - start < 3000) await sleep(30);
        assert.match(log, /Server running/);

        const html = await get('/');
        assert.equal(html.status, 200);
        const text = html.body.toString('utf8');
        const refs = [...text.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(m => m[1].split('?')[0]);
        assert.ok(refs.length >= 7, `引用数 ${refs.length}`);
        for (const ref of refs) {
            assert.ok(!ref.includes('..'), `引用含穿越: ${ref}`);
            const res = await get(ref);
            assert.equal(res.status, 200, `${ref} 返回 ${res.status}`);
            const expected = ref.endsWith('.png') ? 'image/png'
                : ref.endsWith('.css') ? 'text/css'
                    : ref.endsWith('.js') ? 'application/javascript' : null;
            if (expected) assert.match(res.headers['content-type'], new RegExp(expected));
        }

        const iconRefs = [...text.matchAll(/src="\/icons\/([a-z-]+)\.png"/g)].map(m => m[1]);
        assert.ok(iconRefs.includes('settings'));
        assert.ok(iconRefs.includes('help'));
        assert.ok(iconRefs.includes('back'));
        assert.ok(iconRefs.includes('close'));

        const css = (await get('/style.css')).body.toString('utf8');
        assert.match(css, /url\('\/bg\.webp'\)/);
        const bg = await get('/bg.webp');
        assert.equal(bg.status, 200);
        assert.equal(bg.headers['content-type'], 'image/webp');
        assert.ok(bg.body.length < 100000, `WebP 体积 ${bg.body.length}`);

        const client = (await get('/game.js')).body.toString('utf8');
        const dynamicIcons = [...client.matchAll(/iconNode\('([a-z-]+)'\)/g)].map(m => m[1]);
        dynamicIcons.push('powered-by-dsh');
        for (const name of new Set(dynamicIcons)) {
            assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'icons', name + '.png')), `缺少图标 ${name}`);
            const res = await get('/icons/' + name + '.png');
            assert.equal(res.status, 200, `/icons/${name}.png`);
        }

        const badge = await get('/icons/powered-by-dsh.png');
        assert.equal(badge.status, 200);
        assert.equal(badge.body.length, 1922);
    } finally {
        child.kill('SIGKILL');
    }
});

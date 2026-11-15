'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'game.js'), 'utf8');
const CORE = require('../game-core');

class StubElement {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.style = {};
        this.attributes = {};
        this.textContent = '';
        this.title = '';
        this.className = '';
        this.listeners = {};
        this.value = '';
        const self = this;
        this.classList = {
            add: () => {},
            remove: () => {},
            toggle: () => {},
            contains: () => false
        };
        this.width = 800;
        this.height = 600;
        this.onclick = null;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this.getContext = () => self._ctx;
        this._ctx = makeContext();
    }
    appendChild(child) {
        if (this.tagName === 'fragment' && child.tagName === 'fragment') {
            this.children.push(...child.children);
        } else {
            this.children.push(child);
        }
        return child;
    }
    replaceChildren(...nodes) {
        this.children = nodes.flatMap(n => (n && n.tagName === 'fragment' ? n.children : [n]));
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k]; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    focus() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
    dispatch(type, event) { (this.listeners[type] || []).forEach(fn => fn(event)); }
}

function makeContext() {
    const noop = () => {};
    return new Proxy({
        fillRect: noop, beginPath: noop, roundRect: noop, rect: noop, fill: noop,
        arc: noop, strokeRect: noop, fillText: noop, save: noop, restore: noop,
        measureText: () => ({ width: 10 })
    }, { get: (t, k) => (k in t ? t[k] : 0), set: (t, k, v) => { t[k] = v; return true; } });
}

function makeDom() {
    const ids = [
        'gameCanvas', 'score', 'lives', 'high-score', 'players', 'game-menu',
        'menu-title', 'menu-message', 'start-btn', 'pause-btn', 'restart-btn',
        'settings-btn', 'help-btn', 'back-btn', 'close-btn', 'panel',
        'panel-title', 'panel-body', 'version', 'toast'
    ];
    const nodes = {};
    for (const id of ids) nodes[id] = new StubElement('div');
    nodes.gameCanvas = new StubElement('canvas');
    const document = {
        getElementById: id => nodes[id] || null,
        createElement: tag => new StubElement(tag),
        createDocumentFragment: () => new StubElement('fragment'),
        addEventListener: (type, fn) => { (document._listeners[type] = document._listeners[type] || []).push(fn); },
        _listeners: {}
    };
    return { document, nodes };
}

const liveSockets = [];

class BrowserWebSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this._ws = new WebSocket(url);
        liveSockets.push(this);
        this._ws.on('open', () => { this.readyState = 1; if (this.onopen) this.onopen(); });
        this._ws.on('message', (m) => { if (this.onmessage) this.onmessage({ data: m.toString() }); });
        this._ws.on('close', () => { this.readyState = 3; if (this.onclose) this.onclose(); });
        this._ws.on('error', () => { if (this.onerror) this.onerror(); });
    }
    send(data) { this.sent.push(data); if (this._ws.readyState === WebSocket.OPEN) this._ws.send(data); }
    close() { this.onclose = null; this._ws.close(); }
}

BrowserWebSocket.OPEN = 1;

function closeAllSockets() {
    for (const s of liveSockets.splice(0)) s.close();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildSandbox(port) {
    const { document, nodes } = makeDom();
    const store = {};
    const rafQueue = [];
    const timers = [];
    let frameCount = 0;
    const sandbox = {
        CONFIG: CORE.CONFIG,
        document,
        window: {
            addEventListener: (type, fn) => { if (type === 'load') sandbox._onload = fn; },
            localStorage: {
                getItem: k => (k in store ? store[k] : null),
                setItem: (k, v) => { store[k] = v; }
            },
            location: { protocol: 'http:', host: `127.0.0.1:${port}` },
            AudioContext: undefined,
            webkitAudioContext: undefined
        },
        navigator: { vibrate: () => true },
        WebSocket: BrowserWebSocket,
        performance: { now: () => Date.now() },
        requestAnimationFrame: (fn) => { if (frameCount++ < 3) rafQueue.push(fn); return frameCount; },
        setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t; },
        clearInterval: (t) => clearInterval(t),
        setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; },
        clearTimeout: (t) => clearTimeout(t),
        console,
        Math, JSON, Date, Number, String, Array, Object, Map, Set, RegExp,
        isNaN, parseInt, parseFloat, Infinity, NaN
    };
    return {
        sandbox, nodes, store, rafQueue,
        drainFrames: () => { const q = rafQueue.splice(0); q.forEach(fn => fn(Date.now())); },
        cleanup: () => { timers.forEach(t => { clearTimeout(t); clearInterval(t); }); closeAllSockets(); }
    };
}

test('客户端脚本在最小 DOM 下加载、连服、渲染与开关面板均不抛异常', async () => {
    const port = 19555;
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(port) }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    let env = null;
    child.stdout.on('data', d => log += d);
    child.stderr.on('data', d => log += d);
    try {
        const start = Date.now();
        while (!log.includes('Server running') && Date.now() - start < 3000) await sleep(30);
        assert.match(log, /Server running/);

        env = buildSandbox(port);
        const context = vm.createContext(env.sandbox);
        assert.doesNotThrow(() => vm.runInContext(CLIENT, context, { filename: 'game.js' }));
        assert.equal(typeof env.sandbox._onload, 'function');
        assert.doesNotThrow(() => env.sandbox._onload());
        assert.equal(env.nodes.version.textContent, 'v2.0.0');

        await sleep(300);
        assert.doesNotThrow(() => env.drainFrames());
        assert.equal(env.nodes.score.textContent, '0');

        assert.doesNotThrow(() => env.nodes['settings-btn'].dispatch('click', {}));
        assert.equal(env.nodes['panel-title'].textContent, '设置');
        assert.ok(env.nodes['panel-body'].children.length >= 4);
        assert.doesNotThrow(() => env.nodes['help-btn'].dispatch('click', {}));
        assert.equal(env.nodes['panel-title'].textContent, '帮助');
        assert.doesNotThrow(() => env.nodes['back-btn'].dispatch('click', {}));
        assert.doesNotThrow(() => env.nodes['close-btn'].dispatch('click', {}));
    } finally {
        if (env) env.cleanup();
        child.kill('SIGKILL');
    }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../game-core');

function makeGame(playerCount) {
    const game = core.createGame();
    for (let i = 0; i < playerCount; i++) {
        const ws = { playerId: null };
        core.addPlayer(game, ws);
    }
    return game;
}

test('CONFIG 含全部共享常量且砖块左偏移计算正确', () => {
    assert.equal(core.CONFIG.VERSION, '2.0.0');
    assert.equal(core.CONFIG.INITIAL_LIVES, 10);
    assert.equal(core.CONFIG.BROADCAST_INTERVAL_MS, 33);
    assert.equal(core.CONFIG.SIMULATION_TICK_MS, 8);
    const expected = (800 - (10 * 70 + 9 * 5)) / 2;
    assert.equal(core.CONFIG.BRICK_OFFSET_LEFT, expected);
});

test('createGame 生成 50 块存活砖块与 10 条生命', () => {
    const game = core.createGame();
    assert.equal(game.bricks.length, 50);
    assert.ok(game.bricks.every(b => b.alive));
    assert.equal(game.lives, 10);
    assert.equal(game.status, 'waiting');
    assert.equal(game.players.length, 0);
});

test('服务端生成 playerId 且绑定到连接，重复 join 不新增玩家', () => {
    const game = core.createGame();
    const ws = { playerId: null };
    const player = core.addPlayer(game, ws);
    assert.match(player.id, /^p_/);
    assert.equal(ws.playerId, player.id);
    assert.equal(core.addPlayer(game, ws), null);
    assert.equal(game.players.length, 1);
});

test('玩家 id 唯一且颜色来自白名单', () => {
    const game = core.createGame();
    const ids = new Set();
    for (let i = 0; i < 4; i++) {
        const p = core.addPlayer(game, { playerId: null });
        ids.add(p.id);
        assert.ok(core.CONFIG.PLAYER_COLORS.includes(p.color));
    }
    assert.equal(ids.size, 4);
});

test('房间上限 4 人，第 5 个连接被拒绝', () => {
    const game = core.createGame();
    for (let i = 0; i < 4; i++) core.addPlayer(game, { playerId: null });
    const rejected = core.addPlayer(game, { playerId: null });
    assert.equal(rejected, null);
    assert.equal(game.players.length, 4);
});

test('挡板按人数均匀排布且不越界', () => {
    for (let n = 1; n <= 4; n++) {
        const game = makeGame(n);
        game.players.forEach((p) => {
            assert.ok(p.x >= 0);
            assert.ok(p.x + p.paddleWidth <= core.CONFIG.CANVAS_WIDTH);
        });
        for (let i = 1; i < n; i++) assert.ok(game.players[i].x > game.players[i - 1].x);
    }
});

test('normalizeInput 拒绝非有限 mouseX 与非法类型，接受合法值并裁剪', () => {
    assert.equal(core.normalizeInput({ left: false, right: false, mouseX: 'evil' }), null);
    assert.equal(core.normalizeInput({ left: false, right: false, mouseX: NaN }), null);
    assert.equal(core.normalizeInput({ left: false, right: false, mouseX: Infinity }), null);
    assert.equal(core.normalizeInput(null), null);
    assert.equal(core.normalizeInput([]), null);
    assert.equal(core.normalizeInput({ mouseX: {} }), null);
    const ok = core.normalizeInput({ left: true, right: false, mouseX: 99999 });
    assert.equal(ok.left, true);
    assert.equal(ok.right, false);
    assert.equal(ok.mouseX, 800);
    const truthy = core.normalizeInput({ left: 'yes', right: {}, mouseX: 100 });
    assert.equal(truthy.left, false);
    assert.equal(truthy.right, false);
});

test('normalizeCommand 仅接受白名单指令', () => {
    for (const c of ['start', 'pause', 'restart']) {
        assert.equal(core.normalizeCommand({ command: c }), c);
    }
    assert.equal(core.normalizeCommand({ command: '__nope__' }), null);
    assert.equal(core.normalizeCommand({ command: {} }), null);
    assert.equal(core.normalizeCommand({ command: [] }), null);
    assert.equal(core.normalizeCommand(null), null);
});

test('rectIntersect 对 NaN 一律返回 false', () => {
    const base = { left: 0, right: 10, top: 0, bottom: 10 };
    assert.equal(core.rectIntersect(base, { left: NaN, right: 5, top: 5, bottom: 6 }), false);
    assert.equal(core.rectIntersect({ left: NaN, right: 5, top: 0, bottom: 10 }, base), false);
    assert.equal(core.rectIntersect({ left: 1, right: 2, top: 1, bottom: 2 }, base), true);
    assert.equal(core.rectIntersect({ left: 20, right: 30, top: 20, bottom: 30 }, base), false);
});

test('畸形 mouseX 不会让挡板 x 变成 NaN', () => {
    const game = makeGame(1);
    const p = game.players[0];
    const ws = p.ws;
    core.startGame(game);
    const input = core.normalizeInput({ left: false, right: false, mouseX: 'evil' });
    assert.equal(input, null);
    for (let i = 0; i < 100; i++) core.stepGame(game);
    assert.ok(Number.isFinite(p.x));
    assert.ok(Number.isFinite(ws.playerId ? game.balls[0].x : 0));
});

test('applyInput 把 mouseX 裁剪到画布内并把 targetX 限制在可移动范围', () => {
    const game = makeGame(1);
    const p = game.players[0];
    core.applyInput(game, p, core.normalizeInput({ left: false, right: false, mouseX: 0 }));
    assert.equal(p.targetX, 0);
    core.applyInput(game, p, core.normalizeInput({ left: false, right: false, mouseX: 99999 }));
    assert.equal(p.targetX, 800 - core.CONFIG.PADDLE_WIDTH);
    core.applyInput(game, p, core.normalizeInput({ left: true, right: false, mouseX: 400 }));
    assert.equal(p.targetX, null);
});

test('start 仅在 waiting 且有玩家时生效，pause 在 playing/paused 间切换', () => {
    const empty = core.createGame();
    assert.equal(core.startGame(empty), false);
    assert.equal(empty.status, 'waiting');

    const game = makeGame(1);
    assert.equal(core.startGame(game), true);
    assert.equal(game.status, 'playing');
    assert.equal(game.balls.length, 1);
    assert.equal(core.startGame(game), false);
    assert.equal(core.togglePause(game), true);
    assert.equal(game.status, 'paused');
    assert.equal(core.togglePause(game), true);
    assert.equal(game.status, 'playing');
});

test('restart 重建全部砖块、分数、生命、道具并重置球', () => {
    const game = makeGame(2);
    core.startGame(game);
    game.bricks.forEach(b => { b.alive = false; });
    game.players[0].score = 500;
    game.powerups.push({ x: 10, y: 10, type: 'W', width: 20, height: 20 });
    game.lives = 2;
    game.balls = [];
    core.restartGame(game);
    assert.ok(game.bricks.every(b => b.alive));
    assert.equal(game.bricks.length, 50);
    assert.equal(game.players[0].score, 0);
    assert.equal(game.lives, 10);
    assert.equal(game.powerups.length, 0);
    assert.equal(game.balls.length, 0);
    assert.equal(game.status, 'waiting');
    assert.equal(game.players[0].paddleWidth, core.CONFIG.PADDLE_WIDTH);
    assert.equal(core.startGame(game), true);
    assert.equal(game.status, 'playing');
    assert.equal(game.balls.length, 1);
});

test('得分归属最后击中挡板的玩家，每 100 分奖励 1 条生命', () => {
    const game = makeGame(2);
    core.startGame(game);
    const scorer = game.players[1];
    game.lastPaddleHitPlayerId = scorer.id;
    const before = game.lives;
    for (let i = 0; i < 10; i++) core.awardScore(game, scorer, 10);
    assert.equal(scorer.score, 100);
    assert.equal(game.lives, before + 1);
    assert.equal(game.players[0].score, 0);
});

test('serializeState 全量下发砖块位、玩家列表、球速度与版本', () => {
    const game = makeGame(2);
    core.startGame(game);
    game.bricks[0].alive = false;
    const state = core.serializeState(game);
    assert.equal(state.type, 'gameState');
    assert.equal(state.bricks.length, 50);
    assert.equal(state.bricks[0], false);
    assert.equal(state.players.length, 2);
    assert.equal(state.balls.length, 1);
    assert.ok(Number.isFinite(state.balls[0].dx));
    assert.ok(Number.isFinite(state.balls[0].dy));
    assert.equal(state.version, '2.0.0');
    assert.equal(state.score, 0);
    assert.equal(typeof state.tick, 'number');
    assert.ok(JSON.stringify(state).length > 0);
});

test('serializeFull 带 selfId 与完整 CONFIG', () => {
    const game = makeGame(1);
    const full = core.serializeFull(game, game.players[0].id);
    assert.equal(full.type, 'fullState');
    assert.equal(full.selfId, game.players[0].id);
    assert.equal(full.config.CANVAS_WIDTH, 800);
    assert.equal(full.config.BRICK_OFFSET_LEFT, core.CONFIG.BRICK_OFFSET_LEFT);
    assert.equal(full.config.VERSION, '2.0.0');
});

test('serializeState 对非有限坐标与非法颜色做净化', () => {
    const game = makeGame(1);
    game.players[0].x = NaN;
    game.players[0].color = 'red" onerror="alert(1)';
    game.balls = [{ x: NaN, y: Infinity, dx: NaN, dy: NaN }];
    const state = core.serializeState(game);
    assert.equal(state.players[0].x, 0);
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(state.players[0].color));
    assert.equal(state.balls[0].x, 0);
    assert.equal(state.balls[0].y, 0);
    assert.ok(Number.isFinite(state.balls[0].dx));
});

test('removePlayer 清理空房间并重置最后击板者', () => {
    const game = core.createGame();
    const wsA = { playerId: null };
    const wsB = { playerId: null };
    core.addPlayer(game, wsA);
    core.addPlayer(game, wsB);
    core.startGame(game);
    game.lastPaddleHitPlayerId = game.players[1].id;
    assert.equal(core.removePlayer(game, wsB), true);
    assert.equal(game.players.length, 1);
    assert.equal(game.lastPaddleHitPlayerId, null);
    assert.equal(wsB.playerId, null);
    assert.equal(core.removePlayer(game, wsA), true);
    assert.equal(game.players.length, 0);
    assert.equal(game.balls.length, 0);
    assert.equal(game.powerups.length, 0);
    assert.equal(game.status, 'waiting');
});

test('stepGame 在 NaN 初始状态下把球坐标恢复为有限值', () => {
    const game = makeGame(1);
    core.startGame(game);
    game.balls[0].x = NaN;
    game.balls[0].y = NaN;
    game.balls[0].dx = NaN;
    game.balls[0].dy = NaN;
    for (let i = 0; i < 20; i++) core.stepGame(game);
    for (const b of game.balls) {
        assert.ok(Number.isFinite(b.x));
        assert.ok(Number.isFinite(b.y));
        assert.ok(Number.isFinite(b.dx));
        assert.ok(Number.isFinite(b.dy));
    }
});

test('M 道具分裂球但不超过 MAX_BALLS', () => {
    const game = makeGame(1);
    core.startGame(game);
    const p = game.players[0];
    const b = game.balls[0];
    for (let i = 0; i < 8; i++) {
        game.powerups.push({ x: p.x, y: p.y - 5, type: 'M', width: 20, height: 20 });
        core.stepGame(game);
    }
    assert.ok(game.balls.length >= 1);
    assert.ok(game.balls.length <= core.CONFIG.MAX_BALLS);
    assert.ok(game.balls.every(x => Number.isFinite(x.x) && Number.isFinite(x.y)));
    assert.ok(Number.isFinite(b.x));
});

test('W 道具加宽挡板并在持续时间后自动恢复', () => {
    const game = makeGame(1);
    core.startGame(game);
    const p = game.players[0];
    game.powerups.push({ x: p.x, y: p.y - 5, type: 'W', width: 20, height: 20 });
    core.stepGame(game);
    assert.equal(p.paddleWidth, core.CONFIG.PADDLE_WIDTH * 1.5);
    game.balls = [];
    game.powerups = [];
    assert.ok(p.widerUntil > game.tick);
    game.tick = p.widerUntil - 1;
    core.stepGame(game);
    assert.equal(p.paddleWidth, core.CONFIG.PADDLE_WIDTH);
    assert.equal(p.widerUntil, 0);
});

test('砖块全部销毁时进入 win，生命耗尽进入 gameover', () => {
    const game = makeGame(1);
    core.startGame(game);
    game.bricks.forEach(b => { b.alive = false; });
    core.stepGame(game);
    assert.equal(game.status, 'win');

    const g2 = makeGame(1);
    core.startGame(g2);
    g2.lives = 1;
    g2.balls = [{ x: 400, y: 700, dx: 0, dy: 7 }];
    core.stepGame(g2);
    assert.equal(g2.status, 'gameover');
    assert.equal(g2.lives, 0);
});

test('多球场景中每颗球按自身最后击板者归属得分', () => {
    const game = makeGame(2);
    core.startGame(game);
    const [p0, p1] = game.players;
    game.balls = [
        { x: 400, y: 100, dx: 0, dy: 7, lastHitter: p0.id },
        { x: 410, y: 100, dx: 0, dy: 7, lastHitter: p1.id }
    ];
    game.bricks.forEach(b => { b.alive = false; });
    game.bricks[0].alive = true;
    game.bricks[0].x = 392;
    game.bricks[0].y = 105;
    game.bricks[0].width = 16;
    game.bricks[0].height = 20;
    game.bricks[20].alive = true;
    game.bricks[20].x = 402;
    game.bricks[20].y = 105;
    game.bricks[20].width = 16;
    game.bricks[20].height = 20;
    game.balls[0].x = 400;
    game.balls[0].y = 100;
    game.balls[1].x = 410;
    game.balls[1].y = 100;
    core.stepGame(game);
    assert.equal(game.players[0].score + game.players[1].score, 20);
    assert.equal(game.players[0].score, 10);
    assert.equal(game.players[1].score, 10);
});

test('paddleHit 仅在球自上向下穿越挡板接触线时命中', () => {
    const p = { x: 300, y: 578, paddleWidth: 80 };
    const contact = p.y - core.CONFIG.BALL_RADIUS;
    assert.equal(core.paddleHit({ x: 340, y: contact + 1 }, contact - 2, p), true);
    assert.equal(core.paddleHit({ x: 340, y: contact - 2 }, contact - 5, p), false);
    assert.equal(core.paddleHit({ x: 100, y: contact + 1 }, contact - 2, p), false);
});

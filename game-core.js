'use strict';

const crypto = require('crypto');

// 服务端与客户端共享的唯一配置来源；/config.js 直接下发本对象
const CONFIG = {
    VERSION: '2.0.0',
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 600,
    PADDLE_WIDTH: 80,
    PADDLE_HEIGHT: 12,
    PADDLE_SPEED: 3.5,
    BALL_RADIUS: 8,
    BALL_SPEED: 7,
    BRICK_ROWS: 5,
    BRICK_COLS: 10,
    BRICK_WIDTH: 70,
    BRICK_HEIGHT: 20,
    BRICK_PADDING: 5,
    BRICK_OFFSET_TOP: 60,
    INITIAL_LIVES: 10,
    POINTS_PER_BRICK: 10,
    MAX_PLAYERS: 4,
    MAX_BALLS: 12,
    PLAYER_COLORS: ['#00f5d4', '#9b5de5', '#f15bb5', '#fee440'],
    POWERUP_SIZE: 20,
    POWERUP_SPEED: 2.5,
    POWERUP_PROBABILITY: 0.2,
    POWERUP_DURATION: 10000,
    BONUS_POINTS: 50,
    LIFE_REWARD_THRESHOLD: 100,
    SIMULATION_TICK_MS: 8,
    BROADCAST_INTERVAL_MS: 33,
    HEARTBEAT_INTERVAL_MS: 30000,
    MAX_PAYLOAD: 4096,
    MAX_MESSAGES_PER_SECOND: 90,
    DEFAULT_PORT: 8082
};

CONFIG.BRICK_OFFSET_LEFT = (CONFIG.CANVAS_WIDTH - (CONFIG.BRICK_COLS * CONFIG.BRICK_WIDTH + (CONFIG.BRICK_COLS - 1) * CONFIG.BRICK_PADDING)) / 2;

const BRICK_COLORS = ['#ef5350', '#ab47bc', '#42a5f5', '#26a69a', '#66bb6a'];
const POWERUP_TYPES = ['W', 'P', 'M'];
const COMMANDS = new Set(['start', 'pause', 'restart']);
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function finite(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function createPlayerId() {
    return 'p_' + crypto.randomBytes(9).toString('base64url');
}

function normalizeInput(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const left = data.left === true;
    const right = data.right === true;
    let mouseX = null;
    if (data.mouseX !== null && data.mouseX !== undefined) {
        if (typeof data.mouseX !== 'number' || !Number.isFinite(data.mouseX)) return null;
        mouseX = clamp(data.mouseX, 0, CONFIG.CANVAS_WIDTH);
    }
    return { left, right, mouseX };
}

function normalizeCommand(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (typeof data.command !== 'string' || !COMMANDS.has(data.command)) return null;
    return data.command;
}

function createGame() {
    const game = {
        status: 'waiting',
        balls: [],
        bricks: [],
        players: [],
        powerups: [],
        lives: CONFIG.INITIAL_LIVES,
        lastPaddleHitPlayerId: null,
        tick: 0,
        dirty: true
    };
    initBricks(game);
    return game;
}

function initBricks(game) {
    game.bricks = [];
    for (let row = 0; row < CONFIG.BRICK_ROWS; row++) {
        for (let col = 0; col < CONFIG.BRICK_COLS; col++) {
            game.bricks.push({
                x: col * (CONFIG.BRICK_WIDTH + CONFIG.BRICK_PADDING) + CONFIG.BRICK_OFFSET_LEFT,
                y: row * (CONFIG.BRICK_HEIGHT + CONFIG.BRICK_PADDING) + CONFIG.BRICK_OFFSET_TOP,
                width: CONFIG.BRICK_WIDTH,
                height: CONFIG.BRICK_HEIGHT,
                color: BRICK_COLORS[row % BRICK_COLORS.length],
                alive: true
            });
        }
    }
    game.dirty = true;
}

function playerPaddleWidth(p) {
    return finite(p.paddleWidth, CONFIG.PADDLE_WIDTH);
}

function getPaddlePositions(count) {
    const positions = [];
    if (count === 1) {
        positions.push((CONFIG.CANVAS_WIDTH - CONFIG.PADDLE_WIDTH) / 2);
    } else {
        const spacing = CONFIG.CANVAS_WIDTH / count;
        for (let i = 0; i < count; i++) {
            positions.push(spacing * i + (spacing - CONFIG.PADDLE_WIDTH) / 2);
        }
    }
    return positions;
}

function repositionAllPaddles(game) {
    if (game.players.length === 0) return;
    const positions = getPaddlePositions(game.players.length);
    game.players.forEach((p, i) => { p.x = positions[i]; p.targetX = null; });
}

function resetBall(game) {
    if (game.players.length === 0) {
        game.balls = [];
        game.lastPaddleHitPlayerId = null;
        return;
    }
    const p = game.players[Math.floor(Math.random() * game.players.length)];
    game.lastPaddleHitPlayerId = p.id;
    const angle = (Math.random() - 0.5) * Math.PI / 2;
    const x = finite(p.x, 0) + playerPaddleWidth(p) / 2;
    game.balls = [{
        x,
        y: p.y - CONFIG.BALL_RADIUS,
        dx: Math.sin(angle) * CONFIG.BALL_SPEED,
        dy: -CONFIG.BALL_SPEED,
        lastHitter: p.id
    }];
}

function addPlayer(game, ws) {
    if (ws.playerId || game.players.length >= CONFIG.MAX_PLAYERS) return null;
    const id = createPlayerId();
    ws.playerId = id;
    const player = {
        id,
        color: CONFIG.PLAYER_COLORS[game.players.length % CONFIG.PLAYER_COLORS.length],
        x: 0,
        targetX: null,
        y: CONFIG.CANVAS_HEIGHT - CONFIG.PADDLE_HEIGHT - 10,
        left: false,
        right: false,
        score: 0,
        lastLifeScore: 0,
        paddleWidth: CONFIG.PADDLE_WIDTH,
        widerUntil: 0,
        ws
    };
    game.players.push(player);
    repositionAllPaddles(game);
    game.dirty = true;
    return player;
}

function removePlayer(game, ws) {
    const idx = game.players.findIndex(p => p.ws === ws);
    if (idx === -1) return false;
    game.players.splice(idx, 1);
    ws.playerId = null;
    repositionAllPaddles(game);
    if (game.lastPaddleHitPlayerId && !game.players.some(p => p.id === game.lastPaddleHitPlayerId)) {
        game.lastPaddleHitPlayerId = null;
    }
    for (const ball of game.balls) {
        if (ball.lastHitter && !game.players.some(p => p.id === ball.lastHitter)) ball.lastHitter = null;
    }
    if (game.players.length === 0) {
        game.balls = [];
        game.powerups = [];
        if (game.status === 'playing' || game.status === 'paused') game.status = 'waiting';
    }
    game.dirty = true;
    return true;
}

function applyInput(game, player, input) {
    player.left = input.left;
    player.right = input.right;
    const width = playerPaddleWidth(player);
    if (input.mouseX === null || input.left || input.right) {
        player.targetX = null;
    } else {
        player.targetX = clamp(input.mouseX - width / 2, 0, CONFIG.CANVAS_WIDTH - width);
    }
    game.dirty = true;
}

function startGame(game) {
    if (game.status !== 'waiting' || game.players.length === 0) return false;
    game.status = 'playing';
    resetBall(game);
    game.dirty = true;
    return true;
}

function togglePause(game) {
    if (game.status === 'playing') game.status = 'paused';
    else if (game.status === 'paused') game.status = 'playing';
    else return false;
    game.dirty = true;
    return true;
}

function restartGame(game) {
    initBricks(game);
    game.lives = CONFIG.INITIAL_LIVES;
    game.lastPaddleHitPlayerId = null;
    game.powerups = [];
    game.balls = [];
    for (const p of game.players) {
        p.score = 0;
        p.lastLifeScore = 0;
        p.paddleWidth = CONFIG.PADDLE_WIDTH;
        p.widerUntil = 0;
        p.left = false;
        p.right = false;
        p.targetX = null;
    }
    repositionAllPaddles(game);
    game.status = 'waiting';
    game.balls = [];
    game.dirty = true;
    return true;
}

function rectIntersect(r1, r2) {
    const values = [r1.left, r1.right, r1.top, r1.bottom, r2.left, r2.right, r2.top, r2.bottom];
    if (values.some(v => !Number.isFinite(v))) return false;
    return !(r2.left > r1.right || r2.right < r1.left || r2.top > r1.bottom || r2.bottom < r1.top);
}

function paddleHit(ball, prevY, player) {
    const width = playerPaddleWidth(player);
    const left = ball.x - CONFIG.BALL_RADIUS;
    const right = ball.x + CONFIG.BALL_RADIUS;
    if (right < player.x || left > player.x + width) return false;
    const contactY = player.y - CONFIG.BALL_RADIUS;
    return prevY <= contactY && ball.y >= contactY;
}

function awardScore(game, player, points) {
    player.score += points;
    if (player.score - player.lastLifeScore >= CONFIG.LIFE_REWARD_THRESHOLD) {
        game.lives++;
        player.lastLifeScore += CONFIG.LIFE_REWARD_THRESHOLD;
    }
}

function spawnPowerup(game, brick) {
    game.powerups.push({
        x: brick.x + brick.width / 2 - CONFIG.POWERUP_SIZE / 2,
        y: brick.y + brick.height / 2,
        type: POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)],
        width: CONFIG.POWERUP_SIZE,
        height: CONFIG.POWERUP_SIZE
    });
}

function bounceOffBrick(ball, brick) {
    const overlapLeft = ball.x + CONFIG.BALL_RADIUS - brick.x;
    const overlapRight = brick.x + brick.width - (ball.x - CONFIG.BALL_RADIUS);
    const overlapTop = ball.y + CONFIG.BALL_RADIUS - brick.y;
    const overlapBottom = brick.y + brick.height - (ball.y - CONFIG.BALL_RADIUS);
    const minO = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);
    if (minO === overlapLeft) { ball.x = brick.x - CONFIG.BALL_RADIUS; ball.dx = -Math.abs(ball.dx); }
    else if (minO === overlapRight) { ball.x = brick.x + brick.width + CONFIG.BALL_RADIUS; ball.dx = Math.abs(ball.dx); }
    else if (minO === overlapTop) { ball.y = brick.y - CONFIG.BALL_RADIUS; ball.dy = -Math.abs(ball.dy); }
    else { ball.y = brick.y + brick.height + CONFIG.BALL_RADIUS; ball.dy = Math.abs(ball.dy); }
}

function stepGame(game) {
    if (game.status !== 'playing') return;
    if (game.players.length === 0) {
        game.status = 'waiting';
        game.dirty = true;
        return;
    }
    game.tick++;

    for (const p of game.players) {
        const width = playerPaddleWidth(p);
        if (p.left || p.right) {
            p.targetX = null;
            if (p.left) p.x -= CONFIG.PADDLE_SPEED;
            if (p.right) p.x += CONFIG.PADDLE_SPEED;
        } else if (p.targetX !== null) {
            p.x = finite(p.targetX, p.x);
        }
        p.x = clamp(finite(p.x, 0), 0, CONFIG.CANVAS_WIDTH - width);
        if (p.widerUntil && game.tick >= p.widerUntil) {
            p.paddleWidth = CONFIG.PADDLE_WIDTH;
            p.widerUntil = 0;
        }
    }

    for (let i = game.balls.length - 1; i >= 0; i--) {
        const ball = game.balls[i];
        const prevY = ball.y;
        ball.x = finite(ball.x, CONFIG.CANVAS_WIDTH / 2);
        ball.y = finite(ball.y, CONFIG.CANVAS_HEIGHT / 2);
        ball.dx = finite(ball.dx, CONFIG.BALL_SPEED);
        ball.dy = finite(ball.dy, -CONFIG.BALL_SPEED);
        ball.x += ball.dx;
        ball.y += ball.dy;

        if (ball.x - CONFIG.BALL_RADIUS < 0) { ball.x = CONFIG.BALL_RADIUS; ball.dx = Math.abs(ball.dx); }
        else if (ball.x + CONFIG.BALL_RADIUS > CONFIG.CANVAS_WIDTH) { ball.x = CONFIG.CANVAS_WIDTH - CONFIG.BALL_RADIUS; ball.dx = -Math.abs(ball.dx); }
        if (ball.y - CONFIG.BALL_RADIUS < 0) { ball.y = CONFIG.BALL_RADIUS; ball.dy = Math.abs(ball.dy); }

        let hitPaddle = false;
        if (ball.dy > 0) {
            for (const p of game.players) {
                if (!paddleHit(ball, prevY, p)) continue;
                const width = playerPaddleWidth(p);
                const hitPos = (ball.x - p.x) / width;
                const angle = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, hitPos * Math.PI - Math.PI / 2));
                const speed = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
                ball.dx = Math.sin(angle) * speed;
                ball.dy = -Math.cos(angle) * speed;
                ball.y = p.y - CONFIG.BALL_RADIUS;
                ball.lastHitter = p.id;
                game.lastPaddleHitPlayerId = p.id;
                hitPaddle = true;
                break;
            }
        }

        if (!hitPaddle) {
            const ballR = {
                left: ball.x - CONFIG.BALL_RADIUS, right: ball.x + CONFIG.BALL_RADIUS,
                top: ball.y - CONFIG.BALL_RADIUS, bottom: ball.y + CONFIG.BALL_RADIUS
            };
            for (const b of game.bricks) {
                if (!b.alive) continue;
                const br = { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height };
                if (!rectIntersect(ballR, br)) continue;
                b.alive = false;
                const hitterId = ball.lastHitter || game.lastPaddleHitPlayerId;
                const scorer = game.players.find(p => p.id === hitterId);
                if (scorer) awardScore(game, scorer, CONFIG.POINTS_PER_BRICK);
                if (Math.random() < CONFIG.POWERUP_PROBABILITY) spawnPowerup(game, b);
                bounceOffBrick(ball, b);
                break;
            }
        }

        ball.x = clamp(finite(ball.x, CONFIG.CANVAS_WIDTH / 2), CONFIG.BALL_RADIUS, CONFIG.CANVAS_WIDTH - CONFIG.BALL_RADIUS);
        if (ball.y - CONFIG.BALL_RADIUS > CONFIG.CANVAS_HEIGHT) {
            game.balls.splice(i, 1);
            if (game.balls.length === 0) {
                game.lives--;
                if (game.lives <= 0) {
                    game.lives = 0;
                    game.status = 'gameover';
                } else {
                    resetBall(game);
                }
            }
        }
    }

    for (let i = game.powerups.length - 1; i >= 0; i--) {
        const pu = game.powerups[i];
        pu.y += CONFIG.POWERUP_SPEED;
        for (const p of game.players) {
            const width = playerPaddleWidth(p);
            const pr = { left: p.x, right: p.x + width, top: p.y, bottom: p.y + CONFIG.PADDLE_HEIGHT };
            const pur = { left: pu.x, right: pu.x + pu.width, top: pu.y, bottom: pu.y + pu.height };
            if (!rectIntersect(pur, pr)) continue;
            if (pu.type === 'W') {
                p.paddleWidth = CONFIG.PADDLE_WIDTH * 1.5;
                p.widerUntil = game.tick + Math.ceil(CONFIG.POWERUP_DURATION / CONFIG.SIMULATION_TICK_MS);
            } else if (pu.type === 'P') {
                awardScore(game, p, CONFIG.BONUS_POINTS);
            } else if (pu.type === 'M' && game.balls.length > 0 && game.balls.length + 2 <= CONFIG.MAX_BALLS) {
                const b = game.balls[0];
                game.balls.push(
                    { x: b.x, y: b.y, dx: -b.dx, dy: b.dy, lastHitter: b.lastHitter || game.lastPaddleHitPlayerId },
                    { x: b.x, y: b.y, dx: b.dx * 0.5, dy: -Math.abs(b.dy), lastHitter: b.lastHitter || game.lastPaddleHitPlayerId }
                );
            }
            game.powerups.splice(i, 1);
            break;
        }
        if (game.powerups[i] === pu && pu.y > CONFIG.CANVAS_HEIGHT) game.powerups.splice(i, 1);
    }

    if (game.status === 'playing' && game.bricks.every(b => !b.alive)) game.status = 'win';
    game.dirty = true;
}

function playerView(p) {
    return {
        id: p.id,
        x: finite(p.x, 0),
        y: finite(p.y, CONFIG.CANVAS_HEIGHT - CONFIG.PADDLE_HEIGHT - 10),
        color: COLOR_PATTERN.test(p.color) ? p.color : CONFIG.PLAYER_COLORS[0],
        score: finite(p.score, 0),
        paddleWidth: playerPaddleWidth(p)
    };
}

function serializeState(game) {
    return {
        type: 'gameState',
        balls: game.balls.map(b => ({
            x: finite(b.x, 0), y: finite(b.y, 0),
            dx: finite(b.dx, 0), dy: finite(b.dy, -CONFIG.BALL_SPEED)
        })),
        bricks: game.bricks.map(b => b.alive),
        players: game.players.map(playerView),
        powerups: game.powerups.map(pu => ({
            x: finite(pu.x, 0), y: finite(pu.y, 0),
            width: CONFIG.POWERUP_SIZE, height: CONFIG.POWERUP_SIZE,
            type: POWERUP_TYPES.includes(pu.type) ? pu.type : 'P'
        })),
        lives: finite(game.lives, CONFIG.INITIAL_LIVES),
        status: game.status,
        score: game.players.reduce((sum, p) => sum + finite(p.score, 0), 0),
        tick: game.tick,
        version: CONFIG.VERSION,
        timestamp: Date.now()
    };
}

function serializeFull(game, selfId) {
    const state = serializeState(game);
    state.type = 'fullState';
    state.selfId = selfId;
    state.config = CONFIG;
    return state;
}

module.exports = {
    CONFIG, BRICK_COLORS, POWERUP_TYPES, COMMANDS,
    finite, clamp, createPlayerId, normalizeInput, normalizeCommand,
    createGame, initBricks, resetBall, getPaddlePositions, repositionAllPaddles,
    playerPaddleWidth, addPlayer, removePlayer, applyInput,
    startGame, togglePause, restartGame, rectIntersect, paddleHit,
    awardScore, stepGame, serializeState, serializeFull
};

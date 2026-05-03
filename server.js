const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8082;

// 创建 HTTP 服务器（用于托管静态文件）
const server = http.createServer((req, res) => {
    const fs = require('fs');
    const path = require('path');
    if (req.url === '/' || req.url === '/index.html') {
        const filePath = path.join(__dirname, 'public', 'index.html');
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(500); res.end('Error'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url === '/style.css') {
        const filePath = path.join(__dirname, 'public', 'style.css');
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(500); res.end('Error'); return; }
            res.writeHead(200, { 'Content-Type': 'text/css' });
            res.end(data);
        });
    } else if (req.url === '/game.js') {
        const filePath = path.join(__dirname, 'public', 'game.js');
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(500); res.end('Error'); return; }
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(data);
        });
    } else if (req.url === '/config.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end('const CONFIG = ' + JSON.stringify(CONFIG) + ';');
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

const wss = new WebSocket.Server({ server });

// 游戏配置
const CONFIG = {
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 600,
    PADDLE_WIDTH: 80,
    PADDLE_HEIGHT: 12,
    PADDLE_SPEED: 7,
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
    PLAYER_COLORS: ['#00f5d4', '#9b5de5', '#f15bb5', '#fee440'],
    // --- 道具系统配置 ---
    POWERUP_SIZE: 20,
    POWERUP_SPEED: 2.5,
    POWERUP_PROBABILITY: 0.2,
    POWERUP_DURATION: 10000, // 10秒
    BONUS_POINTS: 50,
    LIFE_REWARD_THRESHOLD: 100
};

CONFIG.BRICK_OFFSET_LEFT = (CONFIG.CANVAS_WIDTH - (CONFIG.BRICK_COLS * CONFIG.BRICK_WIDTH + (CONFIG.BRICK_COLS - 1) * CONFIG.BRICK_PADDING)) / 2;

// 游戏房间状态
let game = {
    status: 'waiting',
    balls: [],
    bricks: [],
    players: [],
    powerups: [],
    lives: CONFIG.INITIAL_LIVES,
    lastPaddleHitPlayerId: null,
    destroyedBrickIndices: [] // 用于存储本帧被销毁的砖块索引
};

function initBricks() {
    game.bricks = [];
    const colors = ['#ef5350', '#ab47bc', '#42a5f5', '#26a69a', '#66bb6a'];
    for (let row = 0; row < CONFIG.BRICK_ROWS; row++) {
        for (let col = 0; col < CONFIG.BRICK_COLS; col++) {
            const x = col * (CONFIG.BRICK_WIDTH + CONFIG.BRICK_PADDING) + CONFIG.BRICK_OFFSET_LEFT;
            const y = row * (CONFIG.BRICK_HEIGHT + CONFIG.BRICK_PADDING) + CONFIG.BRICK_OFFSET_TOP;
            game.bricks.push({
                x, y,
                width: CONFIG.BRICK_WIDTH,
                height: CONFIG.BRICK_HEIGHT,
                color: colors[row % colors.length],
                alive: true
            });
        }
    }
}

initBricks();

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'join') {
                if (game.players.some(p => p.ws === ws)) return;
                if (game.players.length >= CONFIG.MAX_PLAYERS) {
                    ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
                    return;
                }
                const playerColor = CONFIG.PLAYER_COLORS[game.players.length % CONFIG.PLAYER_COLORS.length];
                const player = {
                    id: data.playerId,
                    color: playerColor,
                    x: 0,
                    targetX: 0,
                    y: CONFIG.CANVAS_HEIGHT - CONFIG.PADDLE_HEIGHT - 10,
                    left: false,
                    right: false,
                    score: 0,
                    lastLifeScore: 0,
                    paddleWidth: CONFIG.PADDLE_WIDTH,
                    widerTimer: null,
                    ws
                };
                game.players.push(player);
                repositionAllPaddles();
                broadcastFullState(ws); // 新玩家加入时发送完整状态
                broadcastGameState();
            } else if (data.type === 'input') {
                const player = game.players.find(p => p.id === data.playerId);
                if (player) {
                    player.left = data.left;
                    player.right = data.right;
                    if (data.mouseX !== null && data.mouseX !== undefined) {
                        player.targetX = data.mouseX - playerPaddleWidth(player) / 2;
                    }
                }
            } else if (data.type === 'command') {
                if (data.command === 'start' && game.status === 'waiting' && game.players.length >= 1) {
                    game.status = 'playing';
                    resetBall();
                } else if (data.command === 'pause') {
                    if (game.status === 'playing') game.status = 'paused';
                    else if (game.status === 'paused') game.status = 'playing';
                } else if (data.command === 'restart') {
                    game.lives = CONFIG.INITIAL_LIVES;
                    initBricks();
                    game.players.forEach(p => {
                        p.score = 0;
                        p.lastLifeScore = 0;
                        p.paddleWidth = CONFIG.PADDLE_WIDTH;
                        if (p.widerTimer) clearTimeout(p.widerTimer);
                    });
                    game.status = 'waiting';
                    game.lastPaddleHitPlayerId = null;
                    game.powerups = [];
                    game.balls = [];
                    resetBall();
                }
                broadcastGameState();
            }
        } catch (e) { console.error(e); }
    });

    ws.on('close', () => {
        const idx = game.players.findIndex(p => p.ws === ws);
        if (idx !== -1) {
            const p = game.players[idx];
            if (p.widerTimer) clearTimeout(p.widerTimer);
            game.players.splice(idx, 1);
            repositionAllPaddles();
            broadcastGameState();
        }
    });
});

function repositionAllPaddles() {
    if (game.players.length === 0) return;
    const positions = getPaddlePositions(game.players.length);
    game.players.forEach((p, i) => { p.x = positions[i]; });
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

function playerPaddleWidth(p) { return p.paddleWidth || CONFIG.PADDLE_WIDTH; }

function resetBall() {
    if (game.players.length === 0) return;
    const p = game.players[Math.floor(Math.random() * game.players.length)];
    game.lastPaddleHitPlayerId = p.id;
    const angle = (Math.random() - 0.5) * Math.PI / 2;
    game.balls = [{
        x: p.x + playerPaddleWidth(p) / 2,
        y: p.y - CONFIG.BALL_RADIUS,
        dx: Math.sin(angle) * CONFIG.BALL_SPEED,
        dy: -CONFIG.BALL_SPEED
    }];
}

function rectIntersect(r1, r2) {
    return !(r2.left > r1.right || r2.right < r1.left || r2.top > r1.bottom || r2.bottom < r1.top);
}

function gameLoop() {
    if (game.status !== 'playing') {
        setTimeout(gameLoop, 16);
        return;
    }
    if (game.players.length === 0) {
        game.status = 'waiting';
        broadcastGameState();
        setTimeout(gameLoop, 16);
        return;
    }

    game.players.forEach(p => {
        if (p.left || p.right) {
            p.targetX = null;
            if (p.left) p.x -= CONFIG.PADDLE_SPEED;
            if (p.right) p.x += CONFIG.PADDLE_SPEED;
        } else if (p.targetX !== undefined && p.targetX !== null) {
            const diff = p.targetX - p.x;
            if (Math.abs(diff) > CONFIG.PADDLE_SPEED) {
                p.x += Math.sign(diff) * CONFIG.PADDLE_SPEED;
            } else {
                p.x = p.targetX;
            }
        }
        p.x = Math.max(0, Math.min(CONFIG.CANVAS_WIDTH - playerPaddleWidth(p), p.x));
    });

    for (let i = game.balls.length - 1; i >= 0; i--) {
        const ball = game.balls[i];
        ball.x += ball.dx;
        ball.y += ball.dy;

        if (ball.x - CONFIG.BALL_RADIUS < 0) { ball.x = CONFIG.BALL_RADIUS; ball.dx = Math.abs(ball.dx); }
        else if (ball.x + CONFIG.BALL_RADIUS > CONFIG.CANVAS_WIDTH) { ball.x = CONFIG.CANVAS_WIDTH - CONFIG.BALL_RADIUS; ball.dx = -Math.abs(ball.dx); }
        if (ball.y - CONFIG.BALL_RADIUS < 0) { ball.y = CONFIG.BALL_RADIUS; ball.dy = Math.abs(ball.dy); }

        let hitP = false;
        for (const p of game.players) {
            const pw = playerPaddleWidth(p);
            const pr = { left: p.x, right: p.x + pw, top: p.y, bottom: p.y + CONFIG.PADDLE_HEIGHT };
            const br = { left: ball.x - CONFIG.BALL_RADIUS, right: ball.x + CONFIG.BALL_RADIUS, top: ball.y - CONFIG.BALL_RADIUS, bottom: ball.y + CONFIG.BALL_RADIUS };
            if (rectIntersect(br, pr) && ball.dy > 0) {
                game.lastPaddleHitPlayerId = p.id;
                const hitPos = (ball.x - p.x) / pw;
                const angle = Math.max(-Math.PI/3, Math.min(Math.PI/3, hitPos * Math.PI - Math.PI/2));
                const speed = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
                ball.dx = Math.sin(angle) * speed;
                ball.dy = -Math.cos(angle) * speed;
                ball.y = p.y - CONFIG.BALL_RADIUS;
                hitP = true;
                break;
            }
        }

        if (!hitP) {
            for (let idx = 0; idx < game.bricks.length; idx++) {
                const b = game.bricks[idx];
                if (!b.alive) continue;
                const br = { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height };
                const ballR = { left: ball.x - CONFIG.BALL_RADIUS, right: ball.x + CONFIG.BALL_RADIUS, top: ball.y - CONFIG.BALL_RADIUS, bottom: ball.y + CONFIG.BALL_RADIUS };
                if (rectIntersect(ballR, br)) {
                    b.alive = false;
                    game.destroyedBrickIndices.push(idx); // 记录被销毁的索引
                    const s = game.players.find(p => p.id === game.lastPaddleHitPlayerId);
                    if (s) {
                        s.score += CONFIG.POINTS_PER_BRICK;
                        if (s.score - s.lastLifeScore >= CONFIG.LIFE_REWARD_THRESHOLD) {
                            game.lives++;
                            s.lastLifeScore += CONFIG.LIFE_REWARD_THRESHOLD;
                        }
                    }
                    if (Math.random() < CONFIG.POWERUP_PROBABILITY) {
                        const types = ['W', 'P', 'M'];
                        game.powerups.push({
                            x: b.x + b.width/2 - CONFIG.POWERUP_SIZE/2,
                            y: b.y + b.height/2,
                            type: types[Math.floor(Math.random() * types.length)],
                            width: CONFIG.POWERUP_SIZE, height: CONFIG.POWERUP_SIZE
                        });
                    }
                    const overlapLeft = ball.x + CONFIG.BALL_RADIUS - br.left;
                    const overlapRight = br.right - (ball.x - CONFIG.BALL_RADIUS);
                    const overlapTop = ball.y + CONFIG.BALL_RADIUS - br.top;
                    const overlapBottom = br.bottom - (ball.y - CONFIG.BALL_RADIUS);
                    const minO = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);
                    if (minO === overlapLeft) { ball.x = br.left - CONFIG.BALL_RADIUS; ball.dx = -Math.abs(ball.dx); }
                    else if (minO === overlapRight) { ball.x = br.right + CONFIG.BALL_RADIUS; ball.dx = Math.abs(ball.dx); }
                    else if (minO === overlapTop) { ball.y = br.top - CONFIG.BALL_RADIUS; ball.dy = -Math.abs(ball.dy); }
                    else if (minO === overlapBottom) { ball.y = br.bottom + CONFIG.BALL_RADIUS; ball.dy = Math.abs(ball.dy); }
                    break;
                }
            }
        }

        if (ball.y + CONFIG.BALL_RADIUS > CONFIG.CANVAS_HEIGHT) {
            game.balls.splice(i, 1);
            if (game.balls.length === 0) {
                game.lives--;
                if (game.lives <= 0) game.status = 'gameover';
                else resetBall();
            }
        }
    }

    for (let i = game.powerups.length - 1; i >= 0; i--) {
        const pu = game.powerups[i];
        pu.y += CONFIG.POWERUP_SPEED;
        for (const p of game.players) {
            const pw = playerPaddleWidth(p);
            const pr = { left: p.x, right: p.x + pw, top: p.y, bottom: p.y + CONFIG.PADDLE_HEIGHT };
            const pur = { left: pu.x, right: pu.x + pu.width, top: pu.y, bottom: pu.y + pu.height };
            if (rectIntersect(pur, pr)) {
                if (pu.type === 'W') {
                    p.paddleWidth = CONFIG.PADDLE_WIDTH * 1.5;
                    if (p.widerTimer) clearTimeout(p.widerTimer);
                    p.widerTimer = setTimeout(() => { p.paddleWidth = CONFIG.PADDLE_WIDTH; }, CONFIG.POWERUP_DURATION);
                } else if (pu.type === 'P') {
                    p.score += CONFIG.BONUS_POINTS;
                    if (p.score - p.lastLifeScore >= CONFIG.LIFE_REWARD_THRESHOLD) { game.lives++; p.lastLifeScore += CONFIG.LIFE_REWARD_THRESHOLD; }
                } else if (pu.type === 'M') {
                    if (game.balls.length > 0) {
                        const b = game.balls[0];
                        game.balls.push({ x: b.x, y: b.y, dx: -b.dx, dy: b.dy }, { x: b.x, y: b.y, dx: b.dx * 0.5, dy: -Math.abs(b.dy) });
                    }
                }
                game.powerups.splice(i, 1);
                break;
            }
        }
        if (pu && pu.y > CONFIG.CANVAS_HEIGHT) game.powerups.splice(i, 1);
    }
    if (game.bricks.every(b => !b.alive)) game.status = 'win';
    broadcastGameState();
    setTimeout(gameLoop, 16);
}

function broadcastGameState() {
    const state = {
        type: 'gameState',
        balls: game.balls,
        powerups: game.powerups,
        players: game.players.map(p => ({
            id: p.id, x: p.x, y: p.y, color: p.color, score: p.score, paddleWidth: p.paddleWidth
        })),
        lives: game.lives,
        status: game.status,
        timestamp: Date.now()
    };
    
    // 如果有砖块被销毁，发送增量更新
    if (game.destroyedBrickIndices.length > 0) {
        state.destroyedBricks = [...game.destroyedBrickIndices];
        game.destroyedBrickIndices = []; // 清空缓存
    }

    const message = JSON.stringify(state);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(message); });
}

function broadcastFullState(ws) {
    const state = {
        type: 'fullState',
        balls: game.balls,
        bricks: game.bricks.map(b => b.alive), // 仅发送生存状态位
        players: game.players.map(p => ({
            id: p.id, x: p.x, y: p.y, color: p.color, score: p.score, paddleWidth: p.paddleWidth
        })),
        lives: game.lives,
        status: game.status,
        config: {
            BRICK_ROWS: CONFIG.BRICK_ROWS,
            BRICK_COLS: CONFIG.BRICK_COLS
        }
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(state));
}

gameLoop();
server.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });
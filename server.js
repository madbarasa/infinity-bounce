const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8082;

// 创建 HTTP 服务器（用于托管静态文件）
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        const fs = require('fs');
        const path = require('path');
        const filePath = path.join(__dirname, 'public', 'index.html');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url === '/style.css') {
        const fs = require('fs');
        const path = require('path');
        const filePath = path.join(__dirname, 'public', 'style.css');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading style.css');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/css' });
            res.end(data);
        });
    } else if (req.url === '/game.js') {
        const fs = require('fs');
        const path = require('path');
        const filePath = path.join(__dirname, 'public', 'game.js');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading game.js');
                return;
            }
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
    POWERUP_SIZE: 20,
    POWERUP_SPEED: 2.5,
    POWERUP_PROBABILITY: 0.2,
    POWERUP_DURATION: 10000,
    BONUS_POINTS: 50
};

CONFIG.BRICK_OFFSET_LEFT =
    (CONFIG.CANVAS_WIDTH -
        (CONFIG.BRICK_COLS * CONFIG.BRICK_WIDTH +
            (CONFIG.BRICK_COLS - 1) * CONFIG.BRICK_PADDING)) /
    2;

// 游戏房间状态
let game = {
    status: 'waiting', // waiting, playing, paused, gameover, win
    balls: [],
    bricks: [],
    players: [],
    powerups: [],
    lives: CONFIG.INITIAL_LIVES,
    /** 最后一次被球击中的挡板所属玩家，用于砖块得分归属 */
    lastPaddleHitPlayerId: null
};

// 初始化砖块
function initBricks() {
    game.bricks = [];
    for (let row = 0; row < CONFIG.BRICK_ROWS; row++) {
        for (let col = 0; col < CONFIG.BRICK_COLS; col++) {
            const x = col * (CONFIG.BRICK_WIDTH + CONFIG.BRICK_PADDING) + CONFIG.BRICK_OFFSET_LEFT;
            const y = row * (CONFIG.BRICK_HEIGHT + CONFIG.BRICK_PADDING) + CONFIG.BRICK_OFFSET_TOP;
            const colors = ['#ef5350', '#ab47bc', '#42a5f5', '#26a69a', '#66bb6a'];
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

function playerPaddleWidth(p) {
    return p.paddleWidth || CONFIG.PADDLE_WIDTH;
}

// 玩家连接
wss.on('connection', (ws) => {
    console.log('New connection');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'join') {
                if (game.players.some(p => p.ws === ws)) {
                    return;
                }
                if (game.players.length >= CONFIG.MAX_PLAYERS) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: '房间已满'
                    }));
                    return;
                }

                const player = {
                    id: data.playerId,
                    color: data.color,
                    x: 0,
                    targetX: null,
                    y: CONFIG.CANVAS_HEIGHT - CONFIG.PADDLE_HEIGHT - 10,
                    left: false,
                    right: false,
                    score: 0,
                    paddleWidth: CONFIG.PADDLE_WIDTH,
                    widerTimer: null,
                    ws
                };
                game.players.push(player);
                repositionAllPaddles();

                console.log(`Player ${data.playerId} joined. Total: ${game.players.length}`);

                broadcastGameState();
            }
            else if (data.type === 'input') {
                const player = game.players.find(p => p.id === data.playerId);
                if (player) {
                    player.left = data.left;
                    player.right = data.right;
                    if (data.mouseX !== null && data.mouseX !== undefined) {
                        const pw = playerPaddleWidth(player);
                        player.targetX = data.mouseX - pw / 2;
                        player.targetX = Math.max(0, Math.min(CONFIG.CANVAS_WIDTH - pw, player.targetX));
                    }
                }
            }
            else if (data.type === 'command') {
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
                        p.paddleWidth = CONFIG.PADDLE_WIDTH;
                        if (p.widerTimer) {
                            clearTimeout(p.widerTimer);
                            p.widerTimer = null;
                        }
                    });
                    game.status = 'waiting';
                    game.lastPaddleHitPlayerId = null;
                    game.powerups = [];
                    game.balls = [];
                    resetBall();
                }
                broadcastGameState();
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });

    ws.on('close', () => {
        const playerIndex = game.players.findIndex(p => p.ws === ws);
        if (playerIndex !== -1) {
            const p = game.players[playerIndex];
            if (p.widerTimer) clearTimeout(p.widerTimer);
            game.players.splice(playerIndex, 1);
            repositionAllPaddles();
            console.log('Player disconnected');
            broadcastGameState();
        }
    });
});

function repositionAllPaddles() {
    if (game.players.length === 0) return;
    const positions = getPaddlePositions(game.players.length);
    game.players.forEach((p, i) => {
        p.x = positions[i];
        p.targetX = positions[i];
    });
}

// 获取挡板位置（根据玩家数量）
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

// 重置球（单球开局）
function resetBall() {
    if (game.players.length === 0) return;
    const randomPlayer = game.players[Math.floor(Math.random() * game.players.length)];
    game.lastPaddleHitPlayerId = randomPlayer.id;
    const angle = (Math.random() - 0.5) * Math.PI / 2;
    const pw = playerPaddleWidth(randomPlayer);
    game.balls = [{
        x: randomPlayer.x + pw / 2,
        y: randomPlayer.y - CONFIG.BALL_RADIUS,
        dx: Math.sin(angle) * CONFIG.BALL_SPEED,
        dy: -Math.cos(angle) * CONFIG.BALL_SPEED
    }];
}

function rectIntersect(r1, r2) {
    return !(r2.left > r1.right || r2.right < r1.left || r2.top > r1.bottom || r2.bottom < r1.top);
}

// 游戏循环
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

    game.players.forEach(player => {
        if (player.left || player.right) {
            player.targetX = null;
            if (player.left) player.x -= CONFIG.PADDLE_SPEED;
            if (player.right) player.x += CONFIG.PADDLE_SPEED;
        } else if (player.targetX !== undefined && player.targetX !== null) {
            const diff = player.targetX - player.x;
            if (Math.abs(diff) > CONFIG.PADDLE_SPEED) {
                player.x += Math.sign(diff) * CONFIG.PADDLE_SPEED;
            } else {
                player.x = player.targetX;
            }
        }
        const pw = playerPaddleWidth(player);
        player.x = Math.max(0, Math.min(CONFIG.CANVAS_WIDTH - pw, player.x));
    });

    for (let i = game.balls.length - 1; i >= 0; i--) {
        const ball = game.balls[i];
        ball.x += ball.dx;
        ball.y += ball.dy;

        if (ball.x - CONFIG.BALL_RADIUS < 0) {
            ball.x = CONFIG.BALL_RADIUS;
            ball.dx = Math.abs(ball.dx);
        } else if (ball.x + CONFIG.BALL_RADIUS > CONFIG.CANVAS_WIDTH) {
            ball.x = CONFIG.CANVAS_WIDTH - CONFIG.BALL_RADIUS;
            ball.dx = -Math.abs(ball.dx);
        }
        if (ball.y - CONFIG.BALL_RADIUS < 0) {
            ball.y = CONFIG.BALL_RADIUS;
            ball.dy = Math.abs(ball.dy);
        }

        let hitPaddle = false;
        for (const player of game.players) {
            const pw = playerPaddleWidth(player);
            const paddleRect = {
                left: player.x,
                right: player.x + pw,
                top: player.y,
                bottom: player.y + CONFIG.PADDLE_HEIGHT
            };
            const ballRect = {
                left: ball.x - CONFIG.BALL_RADIUS,
                right: ball.x + CONFIG.BALL_RADIUS,
                top: ball.y - CONFIG.BALL_RADIUS,
                bottom: ball.y + CONFIG.BALL_RADIUS
            };
            if (rectIntersect(ballRect, paddleRect) && ball.dy > 0) {
                game.lastPaddleHitPlayerId = player.id;
                const hitPos = (ball.x - player.x) / pw;
                const angle = hitPos * Math.PI - Math.PI / 2;
                const maxAngle = Math.PI / 3;
                const clampedAngle = Math.max(-maxAngle, Math.min(maxAngle, angle));
                const speed = Math.sqrt(ball.dx * ball.dx + ball.dy * ball.dy);
                ball.dx = Math.sin(clampedAngle) * speed;
                ball.dy = -Math.cos(clampedAngle) * speed;
                ball.y = player.y - CONFIG.BALL_RADIUS;
                hitPaddle = true;
                break;
            }
        }

        if (!hitPaddle) {
            for (const brick of game.bricks) {
                if (!brick.alive) continue;
                const brickRect = { left: brick.x, right: brick.x + brick.width, top: brick.y, bottom: brick.y + brick.height };
                const ballRect = { left: ball.x - CONFIG.BALL_RADIUS, right: ball.x + CONFIG.BALL_RADIUS, top: ball.y - CONFIG.BALL_RADIUS, bottom: ball.y + CONFIG.BALL_RADIUS };
                if (rectIntersect(ballRect, brickRect)) {
                    brick.alive = false;
                    const scorer = game.players.find(p => p.id === game.lastPaddleHitPlayerId);
                    if (scorer) scorer.score += CONFIG.POINTS_PER_BRICK;

                    if (Math.random() < CONFIG.POWERUP_PROBABILITY) {
                        const types = ['W', 'P', 'M'];
                        game.powerups.push({
                            x: brick.x + brick.width / 2 - CONFIG.POWERUP_SIZE / 2,
                            y: brick.y + brick.height / 2,
                            type: types[Math.floor(Math.random() * types.length)],
                            width: CONFIG.POWERUP_SIZE,
                            height: CONFIG.POWERUP_SIZE
                        });
                    }

                    const overlapLeft = ball.x + CONFIG.BALL_RADIUS - brickRect.left;
                    const overlapRight = brickRect.right - (ball.x - CONFIG.BALL_RADIUS);
                    const overlapTop = ball.y + CONFIG.BALL_RADIUS - brickRect.top;
                    const overlapBottom = brickRect.bottom - (ball.y - CONFIG.BALL_RADIUS);
                    const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

                    if (minOverlap === overlapLeft) {
                        ball.x = brickRect.left - CONFIG.BALL_RADIUS;
                        ball.dx = -Math.abs(ball.dx);
                    } else if (minOverlap === overlapRight) {
                        ball.x = brickRect.right + CONFIG.BALL_RADIUS;
                        ball.dx = Math.abs(ball.dx);
                    } else if (minOverlap === overlapTop) {
                        ball.y = brickRect.top - CONFIG.BALL_RADIUS;
                        ball.dy = -Math.abs(ball.dy);
                    } else if (minOverlap === overlapBottom) {
                        ball.y = brickRect.bottom + CONFIG.BALL_RADIUS;
                        ball.dy = Math.abs(ball.dy);
                    }
                    break;
                }
            }
        }

        if (ball.y + CONFIG.BALL_RADIUS > CONFIG.CANVAS_HEIGHT) {
            game.balls.splice(i, 1);
            if (game.balls.length === 0) {
                game.lives--;
                if (game.lives <= 0) {
                    game.status = 'gameover';
                } else {
                    resetBall();
                }
            }
        }
    }

    for (let i = game.powerups.length - 1; i >= 0; i--) {
        const pu = game.powerups[i];
        pu.y += CONFIG.POWERUP_SPEED;
        let collected = false;
        for (const p of game.players) {
            const pw = playerPaddleWidth(p);
            const pr = { left: p.x, right: p.x + pw, top: p.y, bottom: p.y + CONFIG.PADDLE_HEIGHT };
            const pur = { left: pu.x, right: pu.x + pu.width, top: pu.y, bottom: pu.y + pu.height };
            if (rectIntersect(pur, pr)) {
                if (pu.type === 'W') {
                    p.paddleWidth = CONFIG.PADDLE_WIDTH * 1.5;
                    if (p.widerTimer) clearTimeout(p.widerTimer);
                    p.widerTimer = setTimeout(() => {
                        p.paddleWidth = CONFIG.PADDLE_WIDTH;
                        p.widerTimer = null;
                    }, CONFIG.POWERUP_DURATION);
                } else if (pu.type === 'P') {
                    p.score += CONFIG.BONUS_POINTS;
                } else if (pu.type === 'M') {
                    if (game.balls.length > 0) {
                        const b = game.balls[0];
                        game.balls.push(
                            { x: b.x, y: b.y, dx: -b.dx, dy: b.dy },
                            { x: b.x, y: b.y, dx: b.dx * 0.5, dy: -Math.abs(b.dy) }
                        );
                    }
                }
                collected = true;
                break;
            }
        }
        if (collected) {
            game.powerups.splice(i, 1);
        } else if (pu.y > CONFIG.CANVAS_HEIGHT) {
            game.powerups.splice(i, 1);
        }
    }

    if (game.bricks.every(b => !b.alive)) {
        game.status = 'win';
    }

    broadcastGameState();
    setTimeout(gameLoop, 16);
}

function broadcastGameState() {
    const state = {
        type: 'gameState',
        balls: game.balls,
        powerups: game.powerups,
        bricks: game.bricks,
        players: game.players.map(p => ({
            id: p.id,
            x: p.x,
            y: p.y,
            color: p.color,
            score: p.score,
            paddleWidth: p.paddleWidth
        })),
        lives: game.lives,
        status: game.status
    };
    const message = JSON.stringify(state);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

gameLoop();

server.listen(PORT, () => {
    console.log(`Multi-breakout server running on http://localhost:${PORT}`);
});

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
    INITIAL_LIVES: 3,
    POINTS_PER_BRICK: 10,
    MAX_PLAYERS: 4
};

CONFIG.BRICK_OFFSET_LEFT =
    (CONFIG.CANVAS_WIDTH -
        (CONFIG.BRICK_COLS * CONFIG.BRICK_WIDTH +
            (CONFIG.BRICK_COLS - 1) * CONFIG.BRICK_PADDING)) /
    2;

// 游戏房间状态
let game = {
    status: 'waiting', // waiting, playing, paused, gameover, win
    ball: {
        x: CONFIG.CANVAS_WIDTH / 2,
        y: CONFIG.CANVAS_HEIGHT - 100,
        dx: CONFIG.BALL_SPEED,
        dy: -CONFIG.BALL_SPEED
    },
    bricks: [],
    players: [],
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

// 玩家连接
wss.on('connection', (ws) => {
    console.log('New connection');
    
    // 为新玩家分配位置
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
                    y: CONFIG.CANVAS_HEIGHT - CONFIG.PADDLE_HEIGHT - 10,
                    left: false,
                    right: false,
                    score: 0,
                    ws
                };
                game.players.push(player);
                repositionAllPaddles();

                console.log(`Player ${data.playerId} joined. Total: ${game.players.length}`);

                broadcastGameState();
            }
            else if (data.type === 'input') {
                // 更新玩家输入
                const player = game.players.find(p => p.id === data.playerId);
                if (player) {
                    player.left = data.left;
                    player.right = data.right;
                    if (data.mouseX !== null && data.mouseX !== undefined) {
                        player.x = data.mouseX - CONFIG.PADDLE_WIDTH / 2;
                        player.x = Math.max(0, Math.min(CONFIG.CANVAS_WIDTH - CONFIG.PADDLE_WIDTH, player.x));
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
                    });
                    game.status = 'waiting';
                    game.lastPaddleHitPlayerId = null;
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

// 重置球
function resetBall() {
    if (game.players.length === 0) return;
    const randomPlayer = game.players[Math.floor(Math.random() * game.players.length)];
    game.lastPaddleHitPlayerId = randomPlayer.id;
    game.ball = {
        x: randomPlayer.x + CONFIG.PADDLE_WIDTH / 2,
        y: randomPlayer.y - CONFIG.BALL_RADIUS,
        dx: CONFIG.BALL_SPEED * (Math.random() > 0.5 ? 1 : -1),
        dy: -CONFIG.BALL_SPEED
    };
}

// 碰撞检测
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

    // 更新玩家挡板位置
    game.players.forEach(player => {
        if (player.left) player.x -= CONFIG.PADDLE_SPEED;
        if (player.right) player.x += CONFIG.PADDLE_SPEED;
        player.x = Math.max(0, Math.min(CONFIG.CANVAS_WIDTH - CONFIG.PADDLE_WIDTH, player.x));
    });
    
    // 更新球
    game.ball.x += game.ball.dx;
    game.ball.y += game.ball.dy;
    
    // 墙壁碰撞
    if (game.ball.x - CONFIG.BALL_RADIUS < 0 || game.ball.x + CONFIG.BALL_RADIUS > CONFIG.CANVAS_WIDTH) {
        game.ball.dx *= -1;
    }
    if (game.ball.y - CONFIG.BALL_RADIUS < 0) {
        game.ball.dy *= -1;
    }
    
    // 挡板碰撞
    for (const player of game.players) {
        const paddleRect = {
            left: player.x,
            right: player.x + CONFIG.PADDLE_WIDTH,
            top: player.y,
            bottom: player.y + CONFIG.PADDLE_HEIGHT
        };
        const ballRect = {
            left: game.ball.x - CONFIG.BALL_RADIUS,
            right: game.ball.x + CONFIG.BALL_RADIUS,
            top: game.ball.y - CONFIG.BALL_RADIUS,
            bottom: game.ball.y + CONFIG.BALL_RADIUS
        };
        if (rectIntersect(ballRect, paddleRect)) {
            game.lastPaddleHitPlayerId = player.id;
            const hitPos = (game.ball.x - player.x) / CONFIG.PADDLE_WIDTH;
            const angle = hitPos * Math.PI - Math.PI / 2;
            const speed = Math.sqrt(game.ball.dx * game.ball.dx + game.ball.dy * game.ball.dy);
            game.ball.dx = Math.sin(angle) * speed;
            game.ball.dy = -Math.abs(Math.cos(angle) * speed);
            game.ball.y = player.y - CONFIG.BALL_RADIUS;
        }
    }
    
    // 砖块碰撞
    for (const brick of game.bricks) {
        if (!brick.alive) continue;
        const brickRect = { left: brick.x, right: brick.x + brick.width, top: brick.y, bottom: brick.y + brick.height };
        const ballRect = { left: game.ball.x - CONFIG.BALL_RADIUS, right: game.ball.x + CONFIG.BALL_RADIUS, top: game.ball.y - CONFIG.BALL_RADIUS, bottom: game.ball.y + CONFIG.BALL_RADIUS };
        if (rectIntersect(ballRect, brickRect)) {
            brick.alive = false;
            const scorer = game.players.find(p => p.id === game.lastPaddleHitPlayerId);
            if (scorer) scorer.score += CONFIG.POINTS_PER_BRICK;
            
            // 反弹
            const ballCenterX = game.ball.x;
            const ballCenterY = game.ball.y;
            const brickCenterX = brick.x + brick.width / 2;
            const brickCenterY = brick.y + brick.height / 2;
            const dx = ballCenterX - brickCenterX;
            const dy = ballCenterY - brickCenterY;
            if (Math.abs(dx) > Math.abs(dy)) game.ball.dx *= -1;
            else game.ball.dy *= -1;
            break;
        }
    }
    
    // 底部检测
    if (game.ball.y + CONFIG.BALL_RADIUS > CONFIG.CANVAS_HEIGHT) {
        game.lives--;
        if (game.lives <= 0) {
            game.status = 'gameover';
        } else {
            resetBall();
        }
    }
    
    // 胜利检测
    if (game.bricks.every(b => !b.alive)) {
        game.status = 'win';
    }
    
    broadcastGameState();
    setTimeout(gameLoop, 16); // ~60fps
}

// 广播游戏状态
function broadcastGameState() {
    const state = {
        type: 'gameState',
        ball: game.ball,
        bricks: game.bricks,
        players: game.players.map(p => ({
            id: p.id,
            x: p.x,
            y: p.y,
            color: p.color,
            score: p.score
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

// 启动游戏循环
gameLoop();

server.listen(PORT, () => {
    console.log(`Multi-breakout server running on http://localhost:${PORT}`);
});
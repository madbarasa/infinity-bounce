// 多人协作打砖块 - 游戏客户端
// 支持 1-4 名玩家

// ==========================================
// 1. CONFIG (配置分区)
// ==========================================
const COLORS = {
    players: ['#00f5d4', '#9b5de5', '#f15bb5', '#fee440'], // Cyan, Purple, Pink, Yellow
    ball: '#ffffff',
    bricks: ['#f15bb5', '#9b5de5', '#00f5d4', '#fee440', '#ffffff'],
    powerups: {
        W: '#00f5d4', // Wider - Cyan
        P: '#fee440', // Points - Yellow
        M: '#ffffff'  // Multi-ball - White
    }
};

const HIGHSCORE_KEY = 'multi_breakout_highscore';

// ==========================================
// 2. GLOBAL STATE (全局状态分区)
// ==========================================
let ws;
let wsGeneration = 0;
let reconnectTimer = null;
let reconnectAttempt = 0;

let playerId = null;
let myColor = null;
let myLocalX = null;

let gameState = {
    balls: [],
    bricks: [],
    players: [],
    powerups: [],
    lives: 10,
    status: 'waiting'
};

// 状态插值缓冲
let targetState = null;
let lerpFactor = 0.25; // 插值系数，值越小越平滑但延迟越高

const keys = { left: false, right: false };
const mouse = { x: null };

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const livesEl = document.getElementById('lives');
const highScoreEl = document.getElementById('high-score');
const playersEl = document.getElementById('players');
const menuEl = document.getElementById('game-menu');
const startBtn = document.getElementById('start-btn');
const pauseBtn = document.getElementById('pause-btn');
const restartBtn = document.getElementById('restart-btn');

// ==========================================
// 3. UTILITIES (工具函数分区)
// ==========================================
function generatePlayerId() {
    return 'player_' + Math.random().toString(36).substr(2, 9);
}

function clearReconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function scheduleReconnect() {
    clearReconnect();
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 16000);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

/** 旧浏览器无 roundRect 时使用直角矩形 */
function fillRoundRect(context, x, y, w, h, r) {
    context.beginPath();
    if (typeof context.roundRect === 'function') {
        context.roundRect(x, y, w, h, r);
    } else {
        context.rect(x, y, w, h);
    }
    context.fill();
}

function handleInputX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    mouse.x = (clientX - rect.left) * scaleX;
    
    // 移除立即发送，交由 60fps 的定时器统一发送，防止由于高刷鼠标导致的性能爆炸
}

// ==========================================
// 4. ASSETS (资源配置分区)
// ==========================================
// 目前由 CSS 和代码绘制，预留分区

// ==========================================
// 5. EVENT HANDLERS (事件处理分区)
// ==========================================
document.addEventListener('keydown', (e) => {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = true;
    if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = true;
    if (e.code === 'Space') {
        e.preventDefault();
        sendCommand('pause');
    }
});

document.addEventListener('keyup', (e) => {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') keys.left = false;
    if (e.code === 'ArrowRight' || e.code === 'KeyD') keys.right = false;
});

canvas.addEventListener('mousemove', (e) => {
    handleInputX(e.clientX);
});

// 移动端触摸支持
canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length > 0) {
        handleInputX(e.touches[0].clientX);
    }
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length > 0) {
        handleInputX(e.touches[0].clientX);
    }
}, { passive: true });

startBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        reconnectAttempt = 0;
        clearReconnect();
        connect();
        return;
    }
    if (gameState.status === 'paused') {
        sendCommand('pause');
    } else if (gameState.status === 'gameover' || gameState.status === 'win') {
        sendCommand('restart');
    } else {
        sendCommand('start');
    }
});

pauseBtn.addEventListener('click', () => {
    sendCommand('pause');
});

restartBtn.addEventListener('click', () => {
    sendCommand('restart');
});

// ==========================================
// 6. CORE LOGIC (核心逻辑分区)
// ==========================================
function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const socket = new WebSocket(`${protocol}//${host}`);
    const gen = ++wsGeneration;
    ws = socket;

    socket.onopen = () => {
        if (gen !== wsGeneration) return;
        clearReconnect();
        reconnectAttempt = 0;
        console.log('Connected to server');
        playerId = generatePlayerId();
        // 颜色现在由服务器统一分配

        socket.send(
            JSON.stringify({
                type: 'join',
                playerId: playerId
            })
        );
    };

    socket.onmessage = (event) => {
        if (gen !== wsGeneration) return;
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            console.warn('Invalid WebSocket message', e);
            return;
        }
        if (msg.type === 'gameState') {
            targetState = msg;
            
            // 处理增量砖块销毁
            if (msg.destroyedBricks && gameState.bricks.length > 0) {
                msg.destroyedBricks.forEach(idx => {
                    if (gameState.bricks[idx]) gameState.bricks[idx].alive = false;
                });
            }
            
            updateUI();
            // 不再直接调用 draw()，由 requestAnimationFrame 驱动
        } else if (msg.type === 'fullState') {
            // 初始化砖块状态
            const colors = ['#f15bb5', '#9b5de5', '#00f5d4', '#fee440', '#ffffff'];
            const brickRows = msg.config.BRICK_ROWS;
            const brickCols = msg.config.BRICK_COLS;
            const brickWidth = 70;
            const brickHeight = 20;
            const brickPadding = 5;
            const offsetTop = 60;
            const offsetLeft = (800 - (brickCols * brickWidth + (brickCols - 1) * brickPadding)) / 2;

            gameState.bricks = [];
            for (let row = 0; row < brickRows; row++) {
                for (let col = 0; col < brickCols; col++) {
                    gameState.bricks.push({
                        x: col * (brickWidth + brickPadding) + offsetLeft,
                        y: row * (brickHeight + brickPadding) + offsetTop,
                        width: brickWidth,
                        height: brickHeight,
                        color: colors[row % colors.length],
                        alive: msg.bricks[row * brickCols + col]
                    });
                }
            }
            gameState.players = msg.players;
            gameState.lives = msg.lives;
            gameState.status = msg.status;
            targetState = JSON.parse(JSON.stringify(gameState));
        } else if (msg.type === 'playerId') {
            playerId = msg.playerId;
        } else if (msg.type === 'error') {
            alert(msg.message);
        }
    };

    socket.onclose = () => {
        if (gen !== wsGeneration) return;
        console.log('Disconnected');
        showMenu('连接断开', '正在尝试自动重连…', '重连');
        scheduleReconnect();
    };
}

let lastSentInput = '';
function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !playerId) return;
    const inputState = {
        type: 'input',
        playerId: playerId,
        left: keys.left,
        right: keys.right,
        mouseX: mouse.x
    };
    const inputStr = JSON.stringify(inputState);
    if (inputStr !== lastSentInput) {
        ws.send(inputStr);
        lastSentInput = inputStr;
    }
}
setInterval(sendInput, 33); 

function updateUI() {
    const total = gameState.players.reduce((sum, p) => sum + (p.score || 0), 0);
    scoreEl.textContent = String(total);
    livesEl.textContent = gameState.lives;

    playersEl.innerHTML = gameState.players
        .map(
            (p) => `
        <div class="player-tag" style="background:${p.color}; border: ${p.id === playerId ? '2px solid #fff' : 'none'}">
            <span class="p-id">${p.id.substr(0, 4)}</span>
            <span class="p-score">${p.score || 0}</span>
            ${p.id === playerId ? '<span class="you-tag">YOU</span>' : ''}
        </div>
    `
        )
        .join('');

    const stored = localStorage.getItem(HIGHSCORE_KEY);
    const prevBest = stored === null || stored === '' ? 0 : Number(stored);
    highScoreEl.textContent = String(Number.isFinite(prevBest) ? prevBest : 0);
    if (total > prevBest) {
        highScoreEl.textContent = String(total);
        localStorage.setItem(HIGHSCORE_KEY, String(total));
    }

    pauseBtn.textContent = gameState.status === 'paused' ? '继续' : '暂停';

    if (gameState.status === 'waiting') {
        showMenu('多人打砖块', '等待玩家加入…', '开始游戏');
    } else if (gameState.status === 'gameover') {
        showMenu('游戏结束', `最终得分: ${scoreEl.textContent}`, '再玩一次');
    } else if (gameState.status === 'win') {
        showMenu('恭喜通关！', `最终得分: ${scoreEl.textContent}`, '再玩一次');
    } else if (gameState.status === 'paused') {
        showMenu('已暂停', '点击继续游戏', '继续游戏');
    } else {
        hideMenu();
    }
}

function draw() {
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const brick of gameState.bricks) {
        if (!brick.alive) continue;
        ctx.fillStyle = brick.color;
        fillRoundRect(ctx, brick.x, brick.y, brick.width, brick.height, 4);
    }

    for (const player of gameState.players) {
        ctx.fillStyle = player.color;
        const pWidth = player.paddleWidth || CONFIG.PADDLE_WIDTH;
        
        let drawX = player.x;
        // 只有键盘操作时使用本地预测，鼠标操作由于同步极快，直接使用服务端坐标更准
        if (player.id === playerId && (keys.left || keys.right) && myLocalX !== null) {
            drawX = myLocalX;
        }
        
        fillRoundRect(ctx, drawX, player.y, pWidth, CONFIG.PADDLE_HEIGHT, 8);

        // 挡板发光效果
        ctx.shadowBlur = 15;
        ctx.shadowColor = player.color;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.strokeRect(drawX, player.y, pWidth, CONFIG.PADDLE_HEIGHT);
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(
            player.id === playerId ? "YOU" : player.id.substr(0, 4),
            drawX + pWidth / 2,
            player.y - 8
        );
    }

    // 渲染球 (数组)
    if (gameState.balls) {
        gameState.balls.forEach(ball => {
            ctx.beginPath();
            ctx.arc(ball.x, ball.y, CONFIG.BALL_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = COLORS.ball;
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#fff';
            ctx.fill();
            ctx.shadowBlur = 0;
        });
    }

    // 渲染道具
    if (gameState.powerups) {
        gameState.powerups.forEach(pu => {
            ctx.fillStyle = COLORS.powerups[pu.type] || '#fff';
            ctx.shadowBlur = 15;
            ctx.shadowColor = ctx.fillStyle;
            
            // 绘制一个带字母的圆角矩形道具
            fillRoundRect(ctx, pu.x, pu.y, pu.width, pu.height, 4);
            
            ctx.fillStyle = '#000';
            ctx.font = 'bold 14px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(pu.type, pu.x + pu.width / 2, pu.y + pu.height / 2);
            ctx.shadowBlur = 0;
        });
    }

    if (gameState.status === 'paused') {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 48px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('已暂停', canvas.width / 2, canvas.height / 2);
    }
}

function showMenu(title, msg, btnText) {
    menuEl.classList.remove('hidden');
    document.getElementById('menu-title').textContent = title;
    document.getElementById('menu-message').textContent = msg;
    startBtn.textContent = btnText;
}

function hideMenu() {
    menuEl.classList.add('hidden');
}

function sendCommand(cmd) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'command', command: cmd }));
}

// ==========================================
// 7. INITIALIZATION (初始化分区)
// ==========================================
window.addEventListener('load', () => {
    connect();

    function interpolate() {
        if (!targetState) return;

        // 状态平滑过渡
        gameState.status = targetState.status;
        gameState.lives = targetState.lives;

        // 插值处理玩家位置
        targetState.players.forEach(targetP => {
            let p = gameState.players.find(lp => lp.id === targetP.id);
            if (!p) {
                gameState.players.push({ ...targetP });
            } else {
                // 如果是本地玩家，使用特殊处理（Reconciliation）
                if (targetP.id === playerId) {
                    // 仅当偏差过大时纠偏
                    if (Math.abs(p.x - targetP.x) > 100) p.x = targetP.x;
                } else {
                    p.x += (targetP.x - p.x) * lerpFactor;
                }
                p.score = targetP.score;
                p.paddleWidth = targetP.paddleWidth;
            }
        });

        // 插值处理球位置
        if (targetState.balls.length !== gameState.balls.length) {
            gameState.balls = JSON.parse(JSON.stringify(targetState.balls));
        } else {
            gameState.balls.forEach((ball, i) => {
                const targetBall = targetState.balls[i];
                ball.x += (targetBall.x - ball.x) * lerpFactor;
                ball.y += (targetBall.y - ball.y) * lerpFactor;
            });
        }

        // 道具直接更新（通常数量少，且位置不连续）
        gameState.powerups = targetState.powerups;
    }

    function loop() {
        if (playerId && gameState.status === 'playing') {
            interpolate(); // 执行平滑插值

            const myPlayer = gameState.players.find(p => p.id === playerId);
            if (myPlayer && myLocalX === null) {
                myLocalX = myPlayer.x;
            }
            if (myLocalX !== null) {
                if (keys.left) myLocalX -= CONFIG.PADDLE_SPEED;
                if (keys.right) myLocalX += CONFIG.PADDLE_SPEED;
                const pWidth = (myPlayer || {}).paddleWidth || CONFIG.PADDLE_WIDTH;
                myLocalX = Math.max(0, Math.min(CONFIG.CANVAS_WIDTH - pWidth, myLocalX));
                
                // 本地渲染直接使用预测值，无视服务端返回的旧值
                if (myPlayer) myPlayer.x = myLocalX;
            }
        }
        draw();
        requestAnimationFrame(loop);
    }
    loop();
});

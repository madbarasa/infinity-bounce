import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const checks = [];

function ok(name) { checks.push(name); }
function fail(name, detail) { errors.push(`${name}: ${detail}`); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

function checkFile(rel) {
    if (!exists(rel)) { fail(rel, '文件缺失'); return null; }
    ok(rel);
    return read(rel);
}

function checkJson(rel) {
    const text = checkFile(rel);
    if (text === null) return null;
    try { return JSON.parse(text); } catch (e) { fail(rel, `JSON 解析失败: ${e.message}`); return null; }
}

function checkJsSyntax(rel) {
    if (!exists(rel)) { fail(rel, '文件缺失'); return; }
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' }); ok(`${rel} 语法`); }
    catch (e) { fail(rel, `语法错误: ${e.message}`); }
}

const pkg = checkJson('package.json');
const lock = checkJson('package-lock.json');
if (lock && lock.packages && lock.packages['node_modules/ws']) {
    const ws = lock.packages['node_modules/ws'];
    if (!/^8\.2[1-9]\./.test(ws.version) && !/^8\.[3-9]/.test(ws.version)) {
        fail('package-lock.json', `ws ${ws.version} 存在已知高危漏洞，需 >=8.21.0`);
    } else ok(`ws ${ws.version} 无已知高危漏洞`);
}
const badge = '[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)';

if (pkg && lock) {
    if (pkg.version !== lock.version) fail('版本', `package.json ${pkg.version} 与 lock ${lock.version} 不一致`);
    else if (lock.packages && lock.packages[''] && lock.packages[''].version !== pkg.version) fail('版本', `lock packages[""].version 不一致`);
    else ok('版本一致');
    if (pkg.version !== '2.0.0') fail('版本', `应为 2.0.0，实际 ${pkg.version}`);
    if (!pkg.scripts || pkg.scripts.test !== 'node --test test/*.test.js') fail('package.json', 'test 脚本必须指向 node:test 套件');
    else ok('test 脚本');
    if (!pkg.scripts || pkg.scripts.validate !== 'node tools/validate.mjs') fail('package.json', 'validate 脚本缺失');
    else ok('validate 脚本');
    if (!pkg.scripts || pkg.scripts.start !== 'node server.js') fail('package.json', 'start 脚本缺失');
    else ok('start 脚本');
}

const readme = checkFile('README.md');
if (readme !== null) {
    if (!readme.includes('| 版本 | 2.0.0 |')) fail('README.md', '版本表格未同步');
    else ok('README 版本');
    if (!readme.includes(badge)) fail('README.md', '官方徽章缺失');
    else ok('README 徽章');
    if ((readme.match(/powered_by-dsh/g) || []).length !== 1) fail('README.md', '徽章出现次数异常');
    else ok('README 徽章唯一');
    if (readme.includes('1.1.2')) fail('README.md', '残留旧版本号');
    else ok('README 无旧版本');
    if (!readme.includes('npm run validate') || !readme.includes('npm test')) fail('README.md', '缺少校验与测试说明');
    else ok('README 校验说明');
}

const design = checkFile('docs/策划文档.md');
if (design !== null) {
    if (!design.includes('**文档版本：** 2.0.0')) fail('策划文档', '主版本未同步');
    else ok('策划文档版本');
    if (!design.includes('**对应程序版本：** 2.0.0')) fail('策划文档', '对应程序版本未同步');
    else ok('策划文档对应版本');
    if (!design.includes(badge)) fail('策划文档', '官方徽章缺失');
    else ok('策划文档徽章');
    if ((design.match(/powered_by-dsh/g) || []).length !== 1) fail('策划文档', '徽章出现次数异常');
    else ok('策划文档徽章唯一');
    if (!design.includes('### 2.0.0')) fail('策划文档', '缺少 2.0.0 更新日志');
    else ok('策划文档更新日志');
    if (!design.includes('初始 10')) fail('策划文档', '生命规则未同步');
    else ok('策划文档生命规则');
    if (!design.includes('v3.0')) fail('策划文档', '未来规划标题未改为 v3.0');
    else ok('策划文档未来规划');
    if (/### 7\.4 待实现功能（v2\.0）/.test(design)) fail('策划文档', '残留 v2.0 规划标题');
    else ok('策划文档无 v2.0 规划残留');
}

const render = checkFile('render.yaml');
if (render !== null) {
    if (!render.includes('buildCommand: npm ci')) fail('render.yaml', 'buildCommand 未改为 npm ci');
    else ok('render buildCommand');
    if (!render.includes('healthCheckPath: /health')) fail('render.yaml', 'healthCheckPath 缺失');
    else ok('render healthCheckPath');
}

const settings = checkJson('.codebuddy/settings.json');
if (settings) {
    const all = JSON.stringify(settings);
    if (all.includes('弑君者')) fail('.codebuddy/settings.json', '残留其他项目规范');
    else ok('settings 无残留项目名');
    if (all.includes('自动') && all.includes('升级版本')) fail('.codebuddy/settings.json', '残留自动 bump 要求');
    else ok('settings 无自动 bump');
    if (!all.includes('$TOOL_INPUT')) fail('.codebuddy/settings.json', '$TOOL_INPUT 占位符缺失');
    else ok('settings 占位符');
}

const html = checkFile('public/index.html');
if (html !== null) {
    for (const id of ['score', 'lives', 'high-score', 'players', 'gameCanvas', 'game-menu', 'start-btn', 'pause-btn', 'restart-btn', 'settings-btn', 'help-btn', 'back-btn', 'close-btn', 'panel', 'panel-title', 'panel-body', 'version', 'toast', 'menu-title', 'menu-message']) {
        if (!html.includes(`id="${id}"`)) fail('index.html', `缺少 #${id}`);
    }
    ok('index.html 关键节点');
    if (html.includes('config.js') && html.includes('game.js')) ok('index.html 脚本引用');
    else fail('index.html', '脚本引用缺失');
    const scriptTags = html.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
    const inline = scriptTags.filter(t => !/\bsrc=/.test(t));
    if (inline.length > 0) fail('index.html', '存在内联脚本');
    else ok('index.html 无内联脚本');
    if (!html.includes('/icons/settings.png')) fail('index.html', '设置图标缺失');
    else ok('index.html 图标引用');
}

const css = checkFile('public/style.css');
if (css !== null) {
    if (!css.includes("url('/bg.webp')")) fail('style.css', '背景图缺失');
    else ok('style.css 背景图');
    if (!css.includes('clamp(')) fail('style.css', '缺少 clamp()');
    else ok('style.css clamp()');
    if (!css.includes('--color-primary:')) fail('style.css', '缺少 CSS 变量');
    else ok('style.css CSS 变量');
}

const client = checkFile('public/game.js');
if (client !== null) {
    if (client.includes('innerHTML')) fail('game.js', '存在 innerHTML 拼接');
    else ok('game.js 无 innerHTML');
    if (!client.includes('replaceChildren')) fail('game.js', '未使用安全 DOM');
    else ok('game.js 安全 DOM');
    if (!client.includes('buildSettingsPanel') || !client.includes('buildCreditsPanel')) fail('game.js', '设置或开发者名单面板缺失');
    else ok('game.js 面板');
    if (!client.includes('playTone') || !client.includes('vibrate')) fail('game.js', '音效或震动缺失');
    else ok('game.js 音效与震动');
    if (!client.includes('old.onopen = old.onmessage')) fail('game.js', '重连未清理旧连接回调');
    else ok('game.js 重连清理');
    if (!client.includes('syncBricks')) fail('game.js', '砖块全量对账缺失');
    else ok('game.js 砖块对账');
    if (!client.includes('Object.assign(CFG, msg.config)')) fail('game.js', '未读取服务端 CONFIG');
    else ok('game.js CONFIG 同步');
    if (/const\s+brickWidth\s*=\s*70/.test(client)) fail('game.js', '砖块几何硬编码');
    else ok('game.js 无硬编码几何');
}

const core = checkFile('game-core.js');
if (core !== null) {
    if (!core.includes('randomBytes')) fail('game-core.js', 'playerId 未由服务端生成');
    else ok('game-core.js 服务端生成 id');
    if (!core.includes('Number.isFinite')) fail('game-core.js', '缺少有限数值校验');
    else ok('game-core.js 有限数值校验');
    if (!core.includes('COMMANDS')) fail('game-core.js', '指令白名单缺失');
    else ok('game-core.js 指令白名单');
    if (!core.includes('rectIntersect')) fail('game-core.js', '碰撞检测缺失');
    else ok('game-core.js 碰撞检测');
}

const server = checkFile('server.js');
if (server !== null) {
    if (!server.includes('maxPayload')) fail('server.js', 'maxPayload 缺失');
    else ok('server.js maxPayload');
    if (!server.includes('verifyClient')) fail('server.js', 'Origin 校验缺失');
    else ok('server.js Origin 校验');
    if (!server.includes("wss.on('error'")) fail('server.js', 'wss error 监听缺失');
    else ok('server.js wss error');
    if (!server.includes("ws.on('error'")) fail('server.js', '单连接 error 监听缺失');
    else ok('server.js 连接 error');
    if (!server.includes('c.ping()')) fail('server.js', '心跳缺失');
    else ok('server.js 心跳');
    if (!server.includes('bufferedAmount')) fail('server.js', '发送背压检查缺失');
    else ok('server.js 背压检查');
    if (!server.includes('broadcastFullState()')) fail('server.js', 'restart 全量广播缺失');
    else ok('server.js restart 全量广播');
    if (!server.includes('/health')) fail('server.js', 'health 端点缺失');
    else ok('server.js health 端点');
    if (!server.includes('resolvePort')) fail('server.js', 'PORT 校验缺失');
    else ok('server.js PORT 校验');
    if (!server.includes('require(\'./game-core\')')) fail('server.js', '未引用纯逻辑层');
    else ok('server.js 纯逻辑层');
}

checkJsSyntax('server.js');
checkJsSyntax('game-core.js');
checkJsSyntax('public/game.js');
if (checkFile('tools/gen-assets.py') !== null) ok('tools/gen-assets.py 存在');

for (const icon of ['settings', 'back', 'help', 'close', 'sound', 'vibrate', 'credits', 'pause', 'play', 'restart', 'powered-by-dsh']) {
    checkFile(`assets/icons/${icon}.png`);
}
checkFile('assets/bg.webp');

const testFiles = fs.existsSync(path.join(ROOT, 'test'))
    ? fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js'))
    : [];
if (testFiles.length === 0) fail('test/', '测试文件缺失');
else ok(`test/ 共 ${testFiles.length} 个测试文件`);

if (errors.length > 0) {
    console.error(`validate 失败，共 ${errors.length} 项：`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
}
console.log(`validate 通过，共 ${checks.length} 项检查。`);

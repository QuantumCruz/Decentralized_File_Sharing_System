'use strict';

// FileShare v1.0.0: independent, packaged Windows production launcher.
// Keeps legacy FileShare, FileShare Preview, and development data untouched.

const { app, BrowserWindow, session, shell, dialog } = require('electron');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

if (!app.isPackaged || process.platform !== 'win32') {
    throw new Error('FileShare stable launcher requires a packaged Windows application.');
}
if (!process.env.LOCALAPPDATA) {
    throw new Error('LOCALAPPDATA is required.');
}

const PORTS = Object.freeze({
    owner: 35300,
    public: 35302,
    ipfs_api: 35301,
    ipfs_gateway: 38081,
    ipfs_swarm: 34001,
    tor_control: 39351,
    tor_socks: 39350
});
const ownerURL = `http://127.0.0.1:${PORTS.owner}`;
const publicURL = `http://127.0.0.1:${PORTS.public}`;
const ipfsAPI = `http://127.0.0.1:${PORTS.ipfs_api}/api/v0`;
const dataRoot = path.join(process.env.LOCALAPPDATA, 'QuantumCruz', 'FileShare');
const resources = process.resourcesPath;
const dirs = Object.freeze({
    parent: path.dirname(dataRoot),
    root: dataRoot,
    electron: path.join(dataRoot, 'electron'),
    state: path.join(dataRoot, 'state'),
    temp: path.join(dataRoot, 'temporary'),
    logs: path.join(dataRoot, 'logs'),
    ipfs: path.join(dataRoot, 'ipfs'),
    tor: path.join(dataRoot, 'tor'),
    torData: path.join(dataRoot, 'tor', 'data'),
    hiddenService: path.join(dataRoot, 'tor', 'hidden-service')
});
const paths = Object.freeze({
    backend: path.join(resources, 'backend', 'stable_server.exe'),
    ipfs: path.join(resources, 'binaries', 'ipfs.exe'),
    tor: path.join(resources, 'binaries', 'tor.exe'),
    cloudflared: path.join(resources, 'binaries', 'cloudflared.exe'),
    web: path.join(resources, 'server', 'build'),
    icon: path.join(resources, 'assets', 'icon.ico'),
    torrc: path.join(dirs.tor, 'torrc')
});

const token = crypto.randomBytes(32).toString('hex');
const children = new Map();
let window = null;
let logStream = null;
let stopping = false;
let tunnelURL = null;
let cloudflareOutput = '';

app.setName('FileShare');
fs.mkdirSync(dirs.parent, { recursive: true });
fs.mkdirSync(dirs.electron, { recursive: true });
app.setPath('userData', dirs.electron);
const primary = app.requestSingleInstanceLock();
if (!primary) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (window && !window.isDestroyed()) {
            if (window.isMinimized()) window.restore();
            window.focus();
        }
    });
}

function log(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    if (logStream && !logStream.destroyed) logStream.write(line);
    else process.stderr.write(line);
}

function ensureDirectories() {
    for (const [name, dir] of Object.entries(dirs)) {
        if (fs.existsSync(dir) && fs.realpathSync(dir) !== dir) {
            throw new Error(`Redirected FileShare storage location: ${name}`);
        }
        fs.mkdirSync(dir, { recursive: true });
    }
}

function checkResources() {
    for (const [name, file] of Object.entries(paths)) {
        if (name === 'torrc' || name === 'web') continue;
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            throw new Error(`Required FileShare component is missing: ${name}`);
        }
    }
    if (!fs.existsSync(path.join(paths.web, 'index.html'))) {
        throw new Error('Bundled FileShare frontend is missing.');
    }
}

function baseEnvironment() {
    const env = { ...process.env };
    for (const name of [
        'CLEARNET_URL', 'FILESHARE_ADMIN_TOKEN', 'FILESHARE_DEV_PROFILE',
        'FILESHARE_MODE', 'FILESHARE_PREVIEW_ROOT', 'FILESHARE_DATA_ROOT',
        'FILESHARE_DB_PATH', 'FILESHARE_TEMP_DIR', 'FILESHARE_IPFS_API'
    ]) delete env[name];
    Object.assign(env, {
        IPFS_PATH: dirs.ipfs,
        TMP: dirs.temp,
        TEMP: dirs.temp,
        TMPDIR: dirs.temp
    });
    return env;
}

function command(exe, args, env) {
    return execFileSync(exe, args, {
        cwd: dirs.root, env, windowsHide: true,
        timeout: 60000, encoding: 'utf8'
    });
}

function configureIpfs(env) {
    const configFile = path.join(dirs.ipfs, 'config');
    const expected = {
        API: `/ip4/127.0.0.1/tcp/${PORTS.ipfs_api}`,
        Gateway: `/ip4/127.0.0.1/tcp/${PORTS.ipfs_gateway}`,
        Swarm: [
            `/ip4/0.0.0.0/tcp/${PORTS.ipfs_swarm}`,
            `/ip4/0.0.0.0/udp/${PORTS.ipfs_swarm}/quic`
        ]
    };
    if (!fs.existsSync(configFile)) {
        log('Initializing dedicated FileShare IPFS repository');
        command(paths.ipfs, ['init'], env);
        command(paths.ipfs, ['config', 'Addresses.API', expected.API], env);
        command(paths.ipfs, ['config', 'Addresses.Gateway', expected.Gateway], env);
        command(paths.ipfs, [
            'config', '--json', 'Addresses.Swarm', JSON.stringify(expected.Swarm)
        ], env);
    }
    const actual = JSON.parse(command(paths.ipfs, ['config', 'show'], env));
    if (actual.Addresses?.API !== expected.API ||
        actual.Addresses?.Gateway !== expected.Gateway ||
        JSON.stringify(actual.Addresses?.Swarm) !== JSON.stringify(expected.Swarm)) {
        throw new Error('FileShare IPFS settings do not match the dedicated stable ports.');
    }
}

function configureTor() {
    const content = [
        `DataDirectory "${dirs.torData.replace(/\\/g, '/')}"`,
        'CookieAuthentication 1',
        `ControlPort 127.0.0.1:${PORTS.tor_control}`,
        `SocksPort 127.0.0.1:${PORTS.tor_socks}`,
        'Log notice stdout',
        ''
    ].join('\n');
    if (!fs.existsSync(paths.torrc)) {
        fs.writeFileSync(paths.torrc, content, { encoding: 'utf8', flag: 'wx' });
    } else if (fs.readFileSync(paths.torrc, 'utf8').replace(/\r\n/g, '\n') !== content) {
        throw new Error('Unexpected FileShare Tor configuration; existing data was preserved.');
    }
}

function start(name, executable, args, env) {
    const child = spawn(executable, args, {
        cwd: dirs.root, env, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    children.set(name, child);
    for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', chunk => {
            const output = String(chunk);
            log(`${name} ${stream}: ${output.trimEnd()}`);
            if (name === 'cloudflared') {
                cloudflareOutput = (cloudflareOutput + output).slice(-16384);
                const match = cloudflareOutput.match(
                    /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i
                );
                if (match) tunnelURL = match[0];
            }
        });
    }
    child.on('error', err => log(`${name} process error: ${err.message}`));
    child.on('exit', (code, signal) => log(`${name} exited: ${code}, ${signal}`));
    return child;
}

function alive(child) {
    return Boolean(child && child.pid && child.exitCode === null &&
        child.signalCode === null && !child.killed);
}

function stopAll() {
    if (stopping) return;
    stopping = true;
    for (const [name, child] of children) {
        if (!alive(child)) continue;
        try {
            execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true, timeout: 7000
            });
        } catch (err) {
            log(`Could not stop ${name}: ${err.message}`);
        }
    }
    if (logStream) {
        const stream = logStream;
        logStream = null;
        stream.end();
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(name, processName, condition, timeout) {
    const deadline = Date.now() + timeout;
    while (!stopping && Date.now() < deadline) {
        if (!alive(children.get(processName))) {
            throw new Error(`${processName} exited before ${name} was ready`);
        }
        if (await condition()) return;
        await sleep(350);
    }
    throw new Error(`Timed out waiting for ${name}`);
}

function requestReady(port, resource, headers = {}) {
    return new Promise(resolve => {
        const req = http.request({
            hostname: '127.0.0.1', port, path: resource,
            method: resource.startsWith('/api/v0/') ? 'POST' : 'GET',
            headers, timeout: 1800
        }, response => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

async function onionHostname() {
    const nameFile = path.join(dirs.hiddenService, 'hostname');
    if (!fs.existsSync(nameFile)) return null;
    const name = fs.readFileSync(nameFile, 'utf8').trim().toLowerCase();
    if (!/^[a-z2-7]{56}\.onion$/.test(name)) {
        throw new Error('Invalid FileShare Onion hostname');
    }
    return name.slice(0, -6);
}

async function waitForOnion() {
    let result = null;
    await waitFor('Tor Onion address', 'tor', async () => {
        result = await onionHostname();
        return Boolean(result);
    }, 90000);
    return result;
}

async function getTunnel() {
    const deadline = Date.now() + 17000;
    while (!stopping && Date.now() < deadline) {
        if (tunnelURL) return tunnelURL;
        if (!alive(children.get('cloudflared'))) break;
        await sleep(350);
    }
    log('HTTPS tunnel unavailable; Onion sharing remains available');
    return null;
}

function backendEnvironment(base, onion, clearnet) {
    return {
        ...base,
        FILESHARE_MODE: 'stable',
        FILESHARE_DATA_ROOT: dirs.root,
        FILESHARE_DB_PATH: path.join(dirs.state, 'metadata.db'),
        FILESHARE_TEMP_DIR: dirs.temp,
        FILESHARE_BUILD_DIR: paths.web,
        FILESHARE_IPFS_API: ipfsAPI,
        FILESHARE_OWNER_HOST: '127.0.0.1',
        FILESHARE_PUBLIC_HOST: '127.0.0.1',
        FILESHARE_OWNER_PORT: String(PORTS.owner),
        FILESHARE_PUBLIC_PORT: String(PORTS.public),
        FILESHARE_TOR_CONTROL_PORT: String(PORTS.tor_control),
        FILESHARE_ADMIN_TOKEN: token,
        FILESHARE_ONION_HOST: onion,
        CLEARNET_URL: clearnet || ''
    };
}

function createWindow() {
    const ownerSession = session.fromPartition('fileshare-stable-owner');
    ownerSession.webRequest.onBeforeSendHeaders({
        urls: [`${ownerURL}/*`, `ws://127.0.0.1:${PORTS.owner}/*`]
    }, (details, callback) => {
        details.requestHeaders['X-FileShare-Auth'] = token;
        callback({ requestHeaders: details.requestHeaders });
    });
    window = new BrowserWindow({
        width: 1200, height: 820, minWidth: 760, minHeight: 550,
        title: 'FileShare', icon: paths.icon, show: false,
        autoHideMenuBar: true, backgroundColor: '#0b0f2b',
        webPreferences: {
            partition: 'fileshare-stable-owner', nodeIntegration: false,
            contextIsolation: true, sandbox: true, webSecurity: true
        }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const target = new URL(url);
            if (target.protocol === 'https:' || target.protocol === 'http:') {
                shell.openExternal(url).catch(err => log(`External link: ${err.message}`));
            }
        } catch (_) { /* Refuse invalid URLs. */ }
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
        if (url !== ownerURL && !url.startsWith(`${ownerURL}/`)) {
            event.preventDefault();
        }
    });
}

async function launch() {
    const startedAt = Date.now();
    ensureDirectories();
    logStream = fs.createWriteStream(path.join(dirs.logs, 'fileshare.log'), {
        flags: 'a'
    });
    log('FileShare v1.0.0 starting');
    checkResources();
    const env = baseEnvironment();
    configureIpfs(env);
    configureTor();
    createWindow();

    start('ipfs', paths.ipfs, ['daemon'], env);
    start('tor', paths.tor, [
        '-f', paths.torrc,
        '--HiddenServiceDir', dirs.hiddenService,
        '--HiddenServicePort', `80 127.0.0.1:${PORTS.public}`
    ], env);
    start('cloudflared', paths.cloudflared, ['tunnel', '--url', publicURL], env);

    const [onion, https] = await Promise.all([
        (async () => {
            await waitFor('IPFS API', 'ipfs', () => requestReady(
                PORTS.ipfs_api, '/api/v0/version'
            ), 60000);
            return waitForOnion();
        })(),
        getTunnel()
    ]);

    start('backend', paths.backend, [], backendEnvironment(env, onion, https));
    await waitFor('owner backend', 'backend', () => requestReady(
        PORTS.owner, '/history', { 'X-FileShare-Auth': token }
    ), 30000);
    await window.loadURL(ownerURL);
    window.show();
    log(`FileShare ready in ${((Date.now() - startedAt) / 1000).toFixed(2)} seconds`);
}

if (primary) {
    app.whenReady().then(() => launch().catch(error => {
        log(`Startup failed: ${error.stack || error.message}`);
        stopAll();
        dialog.showErrorBox('FileShare could not start',
            `${error.message}\n\nYour original FileShare and Preview installations were not changed.`);
        app.quit();
    }));
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopAll);
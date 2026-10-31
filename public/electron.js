'use strict';

// FileShare isolated development launcher.
// The installed production application is not modified.

const {
    app,
    BrowserWindow,
    session,
    shell
} = require('electron');

const {
    spawn,
    execFileSync
} = require('child_process');

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const {
    loadDevelopmentRuntime
} = require('./dev_runtime');


const root = path.resolve(__dirname, '..');
const profile = loadDevelopmentRuntime(root);
const binDir = path.join(root, 'binaries');

const adminToken = crypto
    .randomBytes(32)
    .toString('hex');

const processes = new Map();

const devData = path.join(
    profile.workspace,
    'electron-user-data'
);

fs.mkdirSync(devData, {
    recursive: true
});

app.setName('FileShare Development');
app.setPath('userData', devData);

let logFile = null;
let splash = null;
let mainWindow = null;
let stopping = false;
let tunnelURL = null;
let startupStartedAt = null;


function log(message) {
    const line = (
        `[${new Date().toISOString()}] ${message}\n`
    );

    if (logFile && !logFile.destroyed) {
        logFile.write(line);
    } else {
        process.stderr.write(line);
    }
}


function runCommand(binary, args, env) {
    return execFileSync(binary, args, {
        cwd: profile.workspace,
        env,
        windowsHide: true,
        timeout: 60000,
        encoding: 'utf8'
    });
}


function ipfsEnvironment() {
    return {
        ...process.env,
        IPFS_PATH: profile.ipfs_repo,
        TMP: profile.temporary,
        TEMP: profile.temporary,
        TMPDIR: profile.temporary
    };
}


function ensureIpfsConfiguration(binary) {
    const env = ipfsEnvironment();

    const configPath = path.join(
        profile.ipfs_repo,
        'config'
    );

    // Compatible with bundled go-ipfs 0.7.0.
    const expected = {
        API: (
            `/ip4/127.0.0.1/tcp/` +
            profile.ports.ipfs_api
        ),

        Gateway: (
            `/ip4/127.0.0.1/tcp/` +
            profile.ports.ipfs_gateway
        ),

        Swarm: [
            `/ip4/0.0.0.0/tcp/${profile.ports.ipfs_swarm}`,
            `/ip4/0.0.0.0/udp/${profile.ports.ipfs_swarm}/quic`
        ]
    };

    // Configuration created by the first
    // development launcher, before the IPFS fix.
    const previousSwarm = [
        `/ip4/0.0.0.0/tcp/${profile.ports.ipfs_swarm}`,
        `/ip4/0.0.0.0/udp/${profile.ports.ipfs_swarm}/quic-v1`
    ];

    if (!fs.existsSync(configPath)) {
        log(
            'Initializing development-only IPFS repository'
        );

        runCommand(
            binary,
            ['init'],
            env
        );

        runCommand(
            binary,
            [
                'config',
                'Addresses.API',
                expected.API
            ],
            env
        );

        runCommand(
            binary,
            [
                'config',
                'Addresses.Gateway',
                expected.Gateway
            ],
            env
        );

        runCommand(
            binary,
            [
                'config',
                '--json',
                'Addresses.Swarm',
                JSON.stringify(expected.Swarm)
            ],
            env
        );
    }

    const config = JSON.parse(
        runCommand(
            binary,
            ['config', 'show'],
            env
        )
    );

    const oldLayoutMatches = (
        config.Addresses?.API === expected.API &&
        config.Addresses?.Gateway === expected.Gateway &&
        JSON.stringify(config.Addresses?.Swarm) ===
            JSON.stringify(previousSwarm)
    );

    if (oldLayoutMatches) {
        log(
            'Updating development IPFS Swarm ' +
            'from /quic-v1 to /quic'
        );

        runCommand(
            binary,
            [
                'config',
                '--json',
                'Addresses.Swarm',
                JSON.stringify(expected.Swarm)
            ],
            env
        );
    }

    const verified = JSON.parse(
        runCommand(
            binary,
            ['config', 'show'],
            env
        )
    );

    if (
        verified.Addresses?.API !== expected.API ||
        verified.Addresses?.Gateway !== expected.Gateway ||
        JSON.stringify(verified.Addresses?.Swarm) !==
            JSON.stringify(expected.Swarm)
    ) {
        throw new Error(
            'Development IPFS configuration is unexpected. ' +
            'Refusing to start.'
        );
    }

    return env;
}


function captureTunnelURL(message) {
    const match = message.match(
        /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i
    );

    if (match) {
        tunnelURL = match[0];
    }
}


function start(
    name,
    binary,
    args,
    env,
    workingDirectory = profile.workspace
) {
    const proc = spawn(
        binary,
        args,
        {
            cwd: workingDirectory,
            env,
            windowsHide: true,
            stdio: [
                'ignore',
                'pipe',
                'pipe'
            ]
        }
    );

    processes.set(name, proc);

    for (const channel of ['stdout', 'stderr']) {
        proc[channel].on('data', bytes => {
            const message = String(bytes);

            log(
                `${name} ${channel}: ${message.trimEnd()}`
            );

            if (name === 'cloudflared') {
                captureTunnelURL(message);
            }
        });
    }

    proc.on('error', error => {
        log(
            `${name} error: ${error.message}`
        );
    });

    proc.on('exit', (code, signal) => {
        log(
            `${name} exited (${code}, ${signal})`
        );
    });

    return proc;
}


function alive(proc) {
    return Boolean(
        proc &&
        proc.pid &&
        proc.exitCode === null &&
        !proc.killed
    );
}


function stopAll() {
    if (stopping) {
        return;
    }

    stopping = true;

    for (const [name, proc] of processes) {
        if (!alive(proc)) {
            continue;
        }

        try {
            if (process.platform === 'win32') {
                execFileSync(
                    'taskkill',
                    [
                        '/PID',
                        String(proc.pid),
                        '/T',
                        '/F'
                    ],
                    {
                        windowsHide: true,
                        timeout: 7000
                    }
                );
            } else {
                proc.kill('SIGTERM');
            }
        } catch (error) {
            log(
                `Unable to stop development ${name}: ` +
                error.message
            );
        }
    }

    if (logFile) {
        const stream = logFile;
        logFile = null;
        stream.end();
    }
}


function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}


async function awaitUntil(
    name,
    check,
    timeoutMs,
    processName
) {
    const stopAt = Date.now() + timeoutMs;

    while (
        Date.now() < stopAt &&
        !stopping
    ) {
        const proc = processes.get(
            processName
        );

        if (proc && !alive(proc)) {
            throw new Error(
                `${processName} terminated while waiting for ${name}`
            );
        }

        const result = await check();

        if (result) {
            return result;
        }

        await sleep(350);
    }

    throw new Error(
        `Timed out waiting for ${name}`
    );
}


function ipfsReady() {
    return new Promise(resolve => {
        const request = http.request(
            {
                hostname: '127.0.0.1',
                port: profile.ports.ipfs_api,
                path: '/api/v0/version',
                method: 'POST',
                timeout: 1500
            },
            response => {
                response.resume();

                resolve(
                    response.statusCode === 200
                );
            }
        );

        request.on('error', () => {
            resolve(false);
        });

        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });

        request.end();
    });
}


async function waitTunnel() {
    if (!processes.has('cloudflared')) {
        return null;
    }

    const deadline = Date.now() + 20000;

    while (Date.now() < deadline) {
        if (tunnelURL) {
            return tunnelURL;
        }

        if (!alive(processes.get('cloudflared'))) {
            break;
        }

        await sleep(350);
    }

    log(
        'Cloudflare tunnel unavailable; Tor remains required'
    );

    return null;
}


function buildBackendEnvironment(
    ipfsEnv,
    onion,
    cloudflare
) {
    const env = {
        ...ipfsEnv
    };

    delete env.CLEARNET_URL;

    Object.assign(env, {
        FILESHARE_MODE: 'development',

        FILESHARE_DEV_PROFILE: path.join(
            profile.workspace,
            'runtime.json'
        ),

        FILESHARE_DB_PATH: profile.database,

        FILESHARE_TEMP_DIR: profile.temporary,

        FILESHARE_IPFS_API: profile.ipfsAPI,

        FILESHARE_OWNER_HOST: '127.0.0.1',

        FILESHARE_PUBLIC_HOST: '127.0.0.1',

        FILESHARE_OWNER_PORT: String(
            profile.ports.owner
        ),

        FILESHARE_PUBLIC_PORT: String(
            profile.ports.public
        ),

        FILESHARE_TOR_CONTROL_PORT: String(
            profile.ports.tor_control
        ),

        FILESHARE_ADMIN_TOKEN: adminToken,

        FILESHARE_ONION_HOST: onion,

        CLEARNET_URL: cloudflare || ''
    });

    return env;
}


function ownerReady() {
    return new Promise(resolve => {
        const request = http.request(
            {
                hostname: '127.0.0.1',
                port: profile.ports.owner,
                path: '/history',
                method: 'GET',

                headers: {
                    'X-FileShare-Auth': adminToken
                },

                timeout: 1500
            },
            response => {
                response.resume();

                resolve(
                    response.statusCode === 200
                );
            }
        );

        request.on('error', () => {
            resolve(false);
        });

        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });

        request.end();
    });
}


function createWindows() {
    const ownerSession = session.fromPartition(
        'fileshare-development-owner'
    );

    ownerSession.webRequest.onBeforeSendHeaders(
        {
            urls: [
                `${profile.ownerURL}/*`,
                `ws://127.0.0.1:${profile.ports.owner}/*`
            ]
        },
        (details, callback) => {
            details.requestHeaders[
                'X-FileShare-Auth'
            ] = adminToken;

            callback({
                requestHeaders: details.requestHeaders
            });
        }
    );

    const preferences = {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
    };

    splash = new BrowserWindow({
        width: 450,
        height: 250,
        frame: false,
        resizable: false,
        backgroundColor: '#0b0f2b',
        webPreferences: preferences
    });

    const splashFile = path.join(
        root,
        'server',
        'build',
        'splash.html'
    );

    if (fs.existsSync(splashFile)) {
        splash.loadFile(splashFile);
    } else {
        splash.loadURL(
            'data:text/html,' +
            '<body style="background:%230b0f2b;' +
            'color:white;font:20px sans-serif;padding:32px">' +
            'Starting FileShare Development...</body>'
        );
    }

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'FileShare Development',
        show: false,
        autoHideMenuBar: true,

        webPreferences: {
            ...preferences,
            partition: 'fileshare-development-owner'
        }
    });

    mainWindow.webContents.setWindowOpenHandler(
        ({ url }) => {
            try {
                const target = new URL(url);

                if (
                    target.protocol === 'https:' ||
                    target.protocol === 'http:'
                ) {
                    shell.openExternal(url).catch(error => {
                        log(
                            `External link: ${error.message}`
                        );
                    });
                }
            } catch (_) {
                // Ignore invalid links.
            }

            return {
                action: 'deny'
            };
        }
    );

    mainWindow.webContents.on(
        'will-navigate',
        (event, url) => {
            if (
                !(
                    url === profile.ownerURL ||
                    url.startsWith(
                        `${profile.ownerURL}/`
                    )
                )
            ) {
                event.preventDefault();
            }
        }
    );
}


async function initialize() {
    startupStartedAt = Date.now();

    log(
        'Validating isolated development executables'
    );

    const binaries = {
        ipfs: path.join(
            binDir,
            'ipfs.exe'
        ),

        tor: path.join(
            binDir,
            'tor.exe'
        ),

        cloudflared: path.join(
            binDir,
            'cloudflared.exe'
        )
    };

    for (const name of ['ipfs', 'tor']) {
        if (!fs.existsSync(binaries[name])) {
            throw new Error(
                `Missing development binary: ${binaries[name]}`
            );
        }
    }

    const ipfsEnv = ensureIpfsConfiguration(
        binaries.ipfs
    );

    createWindows();

    start(
        'ipfs',
        binaries.ipfs,
        ['daemon'],
        ipfsEnv
    );

    const hiddenServiceDir = path.join(
        profile.workspace,
        'tor',
        'hidden-service'
    );

    fs.mkdirSync(hiddenServiceDir, {
        recursive: true
    });

    start(
        'tor',
        binaries.tor,
        [
            '-f',
            profile.torrc,

            '--HiddenServiceDir',
            hiddenServiceDir,

            '--HiddenServicePort',
            `80 127.0.0.1:${profile.ports.public}`
        ],
        ipfsEnv
    );

    if (fs.existsSync(binaries.cloudflared)) {
        start(
            'cloudflared',
            binaries.cloudflared,
            [
                'tunnel',
                '--url',
                profile.publicURL
            ],
            ipfsEnv
        );
    }

    const ipfsWait = awaitUntil(
        'development IPFS API',
        ipfsReady,
        60000,
        'ipfs'
    );

    const onionWait = awaitUntil(
        'development Onion service',
        async () => {
            const hostnameFile = path.join(
                hiddenServiceDir,
                'hostname'
            );

            if (!fs.existsSync(hostnameFile)) {
                return null;
            }

            const hostname = fs.readFileSync(
                hostnameFile,
                'utf8'
            ).trim().toLowerCase();

            if (
                !/^[a-z2-7]{56}\.onion$/.test(hostname)
            ) {
                throw new Error(
                    'Invalid Tor development hostname'
                );
            }

            return hostname.slice(0, -6);
        },
        90000,
        'tor'
    );

    const [
        ipfsOK,
        onion,
        cloudflare
    ] = await Promise.all([
        ipfsWait,
        onionWait,
        waitTunnel()
    ]);

    if (!ipfsOK) {
        throw new Error(
            'Development IPFS is unavailable'
        );
    }

    log(
        'Development IPFS and Tor are ready'
    );

    // Important:
    // Python runs from the source project root,
    // so "server.dev_server" resolves without
    // a manually configured PYTHONPATH.
    //
    // Its data paths still point exclusively
    // into the isolated development workspace.
    start(
        'backend',
        process.env.FILESHARE_DEV_PYTHON || 'python',
        [
            '-u',
            '-m',
            'server.dev_server'
        ],
        buildBackendEnvironment(
            ipfsEnv,
            onion,
            cloudflare
        ),
        root
    );

    await awaitUntil(
        'authenticated owner backend',
        ownerReady,
        30000,
        'backend'
    );

    await mainWindow.loadURL(
        profile.ownerURL
    );

    if (
        splash &&
        !splash.isDestroyed()
    ) {
        splash.close();
    }

    mainWindow.show();

    const duration = (
        (Date.now() - startupStartedAt) / 1000
    ).toFixed(2);

    log(
        'Development FileShare launched on isolated endpoints'
    );

    log(
        `Total development startup: ${duration} seconds`
    );
}


app.whenReady().then(() => {
    logFile = fs.createWriteStream(
        path.join(
            profile.logs,
            'electron-dev.log'
        ),
        {
            flags: 'a'
        }
    );

    initialize().catch(error => {
        log(
            `Development startup failed: ${error.stack || error.message}`
        );

        stopAll();

        const failure = new BrowserWindow({
            width: 540,
            height: 260,
            autoHideMenuBar: true,

            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true
            }
        });

        const message = encodeURIComponent(
            'FileShare Development did not start.\n' +
            error.message +
            '\nYour installed FileShare has not been modified.'
        );

        failure.loadURL(
            `data:text/plain;charset=utf-8,${message}`
        );

        if (
            splash &&
            !splash.isDestroyed()
        ) {
            splash.close();
        }

        if (
            mainWindow &&
            !mainWindow.isDestroyed()
        ) {
            mainWindow.hide();
        }
    });
});


app.on('window-all-closed', () => {
    stopAll();
    app.quit();
});

app.on('before-quit', stopAll);
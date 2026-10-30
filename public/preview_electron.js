'use strict';

// Standalone, packaged-only FileShare Preview launcher.
// This deliberately does not import the Stage 1 development profile.
// It never reads or writes the installed FileShare's application data.

const {
    app,
    BrowserWindow,
    session,
    shell,
    dialog
} = require('electron');

const {
    spawn,
    execFileSync
} = require('child_process');

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

if (!app.isPackaged) {
    throw new Error(
        'FileShare Preview must run from its packaged executable.'
    );
}

if (!process.env.LOCALAPPDATA) {
    throw new Error(
        'Windows LOCALAPPDATA is required for FileShare Preview.'
    );
}

const PORTS = Object.freeze({
    owner: 25300,
    public: 25302,
    ipfs_api: 25301,
    ipfs_gateway: 28081,
    ipfs_swarm: 24001,
    tor_control: 29351,
    tor_socks: 29350
});

const ownerURL = `http://127.0.0.1:${PORTS.owner}`;
const publicURL = `http://127.0.0.1:${PORTS.public}`;
const ipfsAPI = `http://127.0.0.1:${PORTS.ipfs_api}/api/v0`;

const resources = process.resourcesPath;

const previewRoot = path.join(
    process.env.LOCALAPPDATA,
    'FileSharePreviewRC'
);

const dirs = Object.freeze({
    root: previewRoot,
    electron: path.join(previewRoot, 'electron'),
    ipfs: path.join(previewRoot, 'ipfs'),
    tor: path.join(previewRoot, 'tor'),
    torData: path.join(
        previewRoot,
        'tor',
        'data'
    ),
    hiddenService: path.join(
        previewRoot,
        'tor',
        'hidden-service'
    ),
    temp: path.join(
        previewRoot,
        'temporary'
    ),
    logs: path.join(
        previewRoot,
        'logs'
    ),
    state: path.join(
        previewRoot,
        'state'
    )
});

const paths = Object.freeze({
    ipfs: path.join(
        resources,
        'binaries',
        'ipfs.exe'
    ),
    tor: path.join(
        resources,
        'binaries',
        'tor.exe'
    ),
    cloudflared: path.join(
        resources,
        'binaries',
        'cloudflared.exe'
    ),
    backend: path.join(
        resources,
        'backend',
        'preview_server.exe'
    ),
    web: path.join(
        resources,
        'server',
        'build'
    ),
    torrc: path.join(
        dirs.tor,
        'torrc'
    )
});

const token = crypto
    .randomBytes(32)
    .toString('hex');

const processes = new Map();

let logStream = null;
let window = null;
let stopping = false;
let tunnelURL = null;
let startedAt = 0;

app.setName('FileShare Preview');

fs.mkdirSync(
    dirs.electron,
    {
        recursive: true
    }
);

app.setPath(
    'userData',
    dirs.electron
);

const hasLock = app.requestSingleInstanceLock();

if (!hasLock) {
    app.quit();

} else {
    app.on(
        'second-instance',
        () => {
            if (
                window &&
                !window.isDestroyed()
            ) {
                if (window.isMinimized()) {
                    window.restore();
                }

                window.focus();
            }
        }
    );
}


function log(message) {
    const line = (
        `[${new Date().toISOString()}] ${message}\n`
    );

    if (
        logStream &&
        !logStream.destroyed
    ) {
        logStream.write(line);
    } else {
        process.stderr.write(line);
    }
}


function ensureSafeDirectories() {
    for (const name of Object.keys(dirs)) {
        const directory = dirs[name];

        if (
            fs.existsSync(directory) &&
            fs.lstatSync(directory).isSymbolicLink()
        ) {
            throw new Error(
                `Refusing redirected preview directory: ${name}`
            );
        }

        fs.mkdirSync(
            directory,
            {
                recursive: true
            }
        );
    }
}


function ipfsEnvironment() {
    const env = {
        ...process.env
    };

    delete env.CLEARNET_URL;
    delete env.FILESHARE_ADMIN_TOKEN;
    delete env.FILESHARE_DEV_PROFILE;

    Object.assign(env, {
        IPFS_PATH: dirs.ipfs,
        TMP: dirs.temp,
        TEMP: dirs.temp,
        TMPDIR: dirs.temp
    });

    return env;
}


function runCommand(
    executable,
    args,
    env
) {
    return execFileSync(
        executable,
        args,
        {
            cwd: dirs.root,
            env,
            windowsHide: true,
            timeout: 60000,
            encoding: 'utf8'
        }
    );
}


function configureIpfs(env) {
    const configFile = path.join(
        dirs.ipfs,
        'config'
    );

    const expected = {
        API: (
            `/ip4/127.0.0.1/tcp/${PORTS.ipfs_api}`
        ),

        Gateway: (
            `/ip4/127.0.0.1/tcp/${PORTS.ipfs_gateway}`
        ),

        Swarm: [
            `/ip4/0.0.0.0/tcp/${PORTS.ipfs_swarm}`,
            `/ip4/0.0.0.0/udp/${PORTS.ipfs_swarm}/quic`
        ]
    };

    if (!fs.existsSync(configFile)) {
        log(
            'Initializing isolated FileShare Preview IPFS repository'
        );

        runCommand(
            paths.ipfs,
            ['init'],
            env
        );

        runCommand(
            paths.ipfs,
            [
                'config',
                'Addresses.API',
                expected.API
            ],
            env
        );

        runCommand(
            paths.ipfs,
            [
                'config',
                'Addresses.Gateway',
                expected.Gateway
            ],
            env
        );

        runCommand(
            paths.ipfs,
            [
                'config',
                '--json',
                'Addresses.Swarm',
                JSON.stringify(expected.Swarm)
            ],
            env
        );
    }

    const actual = JSON.parse(
        runCommand(
            paths.ipfs,
            [
                'config',
                'show'
            ],
            env
        )
    );

    if (
        actual.Addresses?.API !== expected.API ||
        actual.Addresses?.Gateway !== expected.Gateway ||
        JSON.stringify(
            actual.Addresses?.Swarm
        ) !== JSON.stringify(
            expected.Swarm
        )
    ) {
        throw new Error(
            'Preview IPFS ports do not match the isolated configuration.'
        );
    }
}


function configureTor() {
    const lines = [
        `DataDirectory "${dirs.torData.replace(/\\/g, '/')}"`,
        'CookieAuthentication 1',
        `ControlPort 127.0.0.1:${PORTS.tor_control}`,
        `SocksPort 127.0.0.1:${PORTS.tor_socks}`,
        'Log notice stdout',
        ''
    ];

    const config = lines.join('\n');

    if (fs.existsSync(paths.torrc)) {
        if (
            fs.readFileSync(
                paths.torrc,
                'utf8'
            ).replace(
                /\r\n/g,
                '\n'
            ) !== config
        ) {
            throw new Error(
                'Unexpected Tor configuration in the preview profile.'
            );
        }

    } else {
        fs.writeFileSync(
            paths.torrc,
            config,
            {
                encoding: 'utf8',
                flag: 'wx'
            }
        );
    }
}


function start(
    name,
    executable,
    args,
    env
) {
    const child = spawn(
        executable,
        args,
        {
            cwd: dirs.root,
            env,
            windowsHide: true,
            stdio: [
                'ignore',
                'pipe',
                'pipe'
            ]
        }
    );

    processes.set(
        name,
        child
    );

    for (
        const channel of [
            'stdout',
            'stderr'
        ]
    ) {
        child[channel].on(
            'data',
            data => {
                const output = String(data);

                log(
                    `${name} ${channel}: ${output.trimEnd()}`
                );

                if (name === 'cloudflared') {
                    const match = output.match(
                        /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i
                    );

                    if (match) {
                        tunnelURL = match[0];
                    }
                }
            }
        );
    }

    child.on(
        'error',
        err => log(
            `${name} error: ${err.message}`
        )
    );

    child.on(
        'exit',
        (code, signal) => log(
            `${name} exited: ${code}, ${signal}`
        )
    );

    return child;
}


function alive(child) {
    return Boolean(
        child &&
        child.pid &&
        child.exitCode === null &&
        !child.killed
    );
}


function stopAll() {
    if (stopping) {
        return;
    }

    stopping = true;

    for (
        const [
            name,
            child
        ] of processes
    ) {
        if (!alive(child)) {
            continue;
        }

        try {
            execFileSync(
                'taskkill',
                [
                    '/PID',
                    String(child.pid),
                    '/T',
                    '/F'
                ],
                {
                    windowsHide: true,
                    timeout: 7000
                }
            );

        } catch (err) {
            log(
                `Unable to stop preview ${name}: ${err.message}`
            );
        }
    }

    if (logStream) {
        const stream = logStream;
        logStream = null;
        stream.end();
    }
}


function sleep(ms) {
    return new Promise(
        resolve => setTimeout(
            resolve,
            ms
        )
    );
}


async function waitFor(
    name,
    processName,
    fn,
    maximum
) {
    const deadline = Date.now() + maximum;

    while (
        !stopping &&
        Date.now() < deadline
    ) {
        if (
            !alive(
                processes.get(
                    processName
                )
            )
        ) {
            throw new Error(
                `${processName} stopped before ${name} was ready`
            );
        }

        const value = await fn();

        if (value) {
            return value;
        }

        await sleep(350);
    }

    throw new Error(
        `Timed out waiting for ${name}`
    );
}


function requestReady(
    port,
    requestPath,
    headers = {}
) {
    return new Promise(resolve => {
        const request = http.request(
            {
                hostname: '127.0.0.1',
                port,
                method: (
                    requestPath.startsWith('/api/v0/')
                        ? 'POST'
                        : 'GET'
                ),
                path: requestPath,
                headers,
                timeout: 1800
            },
            response => {
                response.resume();

                resolve(
                    response.statusCode === 200
                );
            }
        );

        request.on(
            'error',
            () => resolve(false)
        );

        request.on(
            'timeout',
            () => {
                request.destroy();
                resolve(false);
            }
        );

        request.end();
    });
}


async function getOnionHostname() {
    const file = path.join(
        dirs.hiddenService,
        'hostname'
    );

    if (!fs.existsSync(file)) {
        return null;
    }

    const hostname = fs.readFileSync(
        file,
        'utf8'
    ).trim().toLowerCase();

    if (
        !/^[a-z2-7]{56}\.onion$/.test(
            hostname
        )
    ) {
        throw new Error(
            'Invalid preview Onion hostname'
        );
    }

    return hostname.slice(
        0,
        -6
    );
}


async function getTunnel() {
    if (
        !processes.has('cloudflared')
    ) {
        return null;
    }

    const deadline = Date.now() + 17000;

    while (
        !stopping &&
        Date.now() < deadline
    ) {
        if (tunnelURL) {
            return tunnelURL;
        }

        if (
            !alive(
                processes.get(
                    'cloudflared'
                )
            )
        ) {
            break;
        }

        await sleep(350);
    }

    log(
        'HTTPS tunnel unavailable; Onion sharing remains available'
    );

    return null;
}


function backendEnvironment(
    env,
    onion,
    clearnet
) {
    return {
        ...env,

        FILESHARE_MODE: 'preview',

        FILESHARE_PREVIEW_ROOT: dirs.root,

        FILESHARE_DB_PATH: path.join(
            dirs.state,
            'metadata.db'
        ),

        FILESHARE_TEMP_DIR: dirs.temp,

        FILESHARE_BUILD_DIR: paths.web,

        FILESHARE_IPFS_API: ipfsAPI,

        FILESHARE_OWNER_HOST: '127.0.0.1',

        FILESHARE_PUBLIC_HOST: '127.0.0.1',

        FILESHARE_OWNER_PORT: String(
            PORTS.owner
        ),

        FILESHARE_PUBLIC_PORT: String(
            PORTS.public
        ),

        FILESHARE_TOR_CONTROL_PORT: String(
            PORTS.tor_control
        ),

        FILESHARE_ADMIN_TOKEN: token,

        FILESHARE_ONION_HOST: onion,

        CLEARNET_URL: clearnet || ''
    };
}


function makeWindow() {
    const ownerSession = session.fromPartition(
        'fileshare-preview-owner'
    );

    ownerSession.webRequest.onBeforeSendHeaders(
        {
            urls: [
                `${ownerURL}/*`,
                `ws://127.0.0.1:${PORTS.owner}/*`
            ]
        },
        (details, callback) => {
            details.requestHeaders[
                'X-FileShare-Auth'
            ] = token;

            callback({
                requestHeaders: details.requestHeaders
            });
        }
    );

    window = new BrowserWindow({
        width: 1200,
        height: 820,
        minWidth: 760,
        minHeight: 550,
        title: 'FileShare Preview',
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#0b0f2b',

        webPreferences: {
            partition: 'fileshare-preview-owner',
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
        }
    });

    window.webContents.setWindowOpenHandler(
        ({ url }) => {
            try {
                const u = new URL(url);

                if (
                    u.protocol === 'https:' ||
                    u.protocol === 'http:'
                ) {
                    shell.openExternal(
                        url
                    ).catch(
                        err => log(
                            `External link: ${err.message}`
                        )
                    );
                }

            } catch (_) {
                // Ignore invalid links.
            }

            return {
                action: 'deny'
            };
        }
    );

    window.webContents.on(
        'will-navigate',
        (event, target) => {
            if (
                !(
                    target === ownerURL ||
                    target.startsWith(
                        `${ownerURL}/`
                    )
                )
            ) {
                event.preventDefault();
            }
        }
    );
}


async function launch() {
    startedAt = Date.now();

    ensureSafeDirectories();

    logStream = fs.createWriteStream(
        path.join(
            dirs.logs,
            'preview.log'
        ),
        {
            flags: 'a'
        }
    );

    log(
        'FileShare Preview starting'
    );

    for (
        const key of [
            'ipfs',
            'tor',
            'backend'
        ]
    ) {
        if (
            !fs.statSync(
                paths[key],
                {
                    throwIfNoEntry: false
                }
            )?.isFile()
        ) {
            throw new Error(
                `Packaged preview component missing: ${key}`
            );
        }
    }

    if (
        !fs.existsSync(
            path.join(
                paths.web,
                'index.html'
            )
        )
    ) {
        throw new Error(
            'Packaged React frontend missing'
        );
    }

    const env = ipfsEnvironment();

    configureIpfs(env);
    configureTor();
    makeWindow();

    start(
        'ipfs',
        paths.ipfs,
        ['daemon'],
        env
    );

    start(
        'tor',
        paths.tor,
        [
            '-f',
            paths.torrc,

            '--HiddenServiceDir',
            dirs.hiddenService,

            '--HiddenServicePort',
            `80 127.0.0.1:${PORTS.public}`
        ],
        env
    );

    if (
        fs.existsSync(
            paths.cloudflared
        )
    ) {
        start(
            'cloudflared',
            paths.cloudflared,
            [
                'tunnel',
                '--url',
                publicURL
            ],
            env
        );
    }

    const [
        ipfsReady,
        onion,
        cloudflare
    ] = await Promise.all([
        waitFor(
            'isolated IPFS',
            'ipfs',
            () => requestReady(
                PORTS.ipfs_api,
                '/api/v0/version'
            ),
            60000
        ),

        waitFor(
            'Onion address',
            'tor',
            getOnionHostname,
            90000
        ),

        getTunnel()
    ]);

    if (!ipfsReady) {
        throw new Error(
            'Preview IPFS failed to initialize'
        );
    }

    start(
        'backend',
        paths.backend,
        [],
        backendEnvironment(
            env,
            onion,
            cloudflare
        )
    );

    await waitFor(
        'owner backend',
        'backend',
        () => requestReady(
            PORTS.owner,
            '/history',
            {
                'X-FileShare-Auth': token
            }
        ),
        30000
    );

    await window.loadURL(
        ownerURL
    );

    window.show();

    log(
        `FileShare Preview ready in ${
            (
                (Date.now() - startedAt) / 1000
            ).toFixed(2)
        } seconds`
    );
}


if (hasLock) {
    app.whenReady().then(
        () => launch().catch(
            err => {
                const message = (
                    err.stack ||
                    err.message
                );

                log(
                    `Preview startup failed: ${message}`
                );

                stopAll();

                dialog.showErrorBox(
                    'FileShare Preview could not start',
                    (
                        `${err.message}\n\n` +
                        'Your installed FileShare has not been modified.'
                    )
                );

                app.quit();
            }
        )
    );
}


app.on(
    'window-all-closed',
    () => app.quit()
);

app.on(
    'before-quit',
    stopAll
);
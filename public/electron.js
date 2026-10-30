const { app, BrowserWindow, net } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

let backend, tor, ipfs, cloudflared;
let splash, mainWindow;

function killProcess(proc, name) {
    if (proc && !proc.killed) {
        try {
            if (process.platform === 'win32') {
                execSync(`taskkill /PID ${proc.pid} /T /F`);
            } else {
                proc.kill('SIGTERM');
            }
            console.log(`${name} terminated.`);
        } catch (err) {
            console.error(`Failed to kill ${name}:`, err);
        }
    }
}

function killAllProcesses() {
    killProcess(backend, 'backend');
    killProcess(tor, 'tor');
    killProcess(ipfs, 'ipfs');
    killProcess(cloudflared, 'cloudflared');
}

function createWindows() {
    splash = new BrowserWindow({
        width: 400,
        height: 250,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        center: true,
        backgroundColor: '#0b0f2b'
    });
    splash.loadFile(path.join(process.resourcesPath, 'server', 'build', 'splash.html'));

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "FileShare",
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadURL('http://localhost:5000');
}

function showNoInternetScreen() {
    const offlineWin = new BrowserWindow({
        width: 500,
        height: 300,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        center: true,
        backgroundColor: '#111'
    });
    offlineWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <html style="margin:0;height:100%;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;font-family:sans-serif">
          <div style="text-align:center">
            <h2>🚫 No Internet Connection</h2>
            <p>Please connect to the internet and restart.</p>
          </div>
        </html>
    `)}`);
}

app.whenReady().then(() => {
    if (!net.isOnline()) {
        showNoInternetScreen();
        return;
    }

    const binDir = path.join(process.resourcesPath, 'binaries');
    const serverDir = path.join(process.resourcesPath, 'server');
    const logPath = path.join(app.getPath('userData'), 'backend.log');

    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    let ipfsReady = false;
    let cloudflaredUrl = undefined;
    let backendStarted = false;

    const tryStartBackend = () => {
        if (backendStarted || !ipfsReady || cloudflaredUrl === undefined) return;
        backendStarted = true;
        startBackend(cloudflaredUrl);
    };

    const startBackend = (clearnetUrl) => {
        backend = spawn(path.join(binDir, 'backend.exe'), [], {
            cwd: serverDir,
            env: { ...process.env, CLEARNET_URL: clearnetUrl || '' }
        });
        backend.stdout.on('data', data => logStream.write(`BACKEND STDOUT: ${data}\n`));
        backend.stderr.on('data', data => {
            const log = data.toString();
            logStream.write(`BACKEND STDERR: ${log}`);
            if (log.includes('Tor hidden service started:') && splash) {
                splash.close();
                splash = null;
                mainWindow.show();
            }
        });
    };

    // Start Tor
    tor = spawn(path.join(binDir, 'tor.exe'), ['-f', path.join(binDir, 'torrc')], { cwd: binDir });
    tor.stdout.on('data', data => logStream.write(`TOR STDOUT: ${data}\n`));
    tor.stderr.on('data', data => logStream.write(`TOR STDERR: ${data}\n`));

    // Start IPFS
    const ipfsPath = path.join(binDir, 'ipfs.exe');
    const ipfsConfigPath = path.join(process.env.USERPROFILE || process.env.HOME, '.ipfs', 'config');

    const startIpfs = () => {
        ipfs = spawn(ipfsPath, ['daemon'], { cwd: binDir });
        ipfs.stdout.on('data', data => {
            const log = data.toString();
            logStream.write(`IPFS STDOUT: ${log}`);
            if (!ipfsReady && log.includes('API server listening on')) {
                ipfsReady = true;
                logStream.write('IPFS is ready, checking if backend can start\n');
                tryStartBackend();
            }
        });
        ipfs.stderr.on('data', data => logStream.write(`IPFS STDERR: ${data}\n`));
    };

    if (!fs.existsSync(ipfsConfigPath)) {
        const initProc = spawn(ipfsPath, ['init'], { cwd: binDir });
        initProc.stdout.on('data', data => logStream.write(`IPFS INIT: ${data}\n`));
        initProc.stderr.on('data', data => logStream.write(`IPFS INIT ERROR: ${data}\n`));
        initProc.on('exit', startIpfs);
    } else {
        startIpfs();
    }

    // Start cloudflared
    const cloudflaredPath = path.join(binDir, 'cloudflared.exe');
    if (fs.existsSync(cloudflaredPath)) {
        cloudflared = spawn(cloudflaredPath, ['tunnel', '--url', 'http://localhost:5000'], { cwd: binDir });

        let cloudflaredDone = false;

        cloudflared.stderr.on('data', data => {
            const line = data.toString();
            logStream.write(`CLOUDFLARED: ${line}`);
            if (!cloudflaredDone) {
                for (const part of line.split(/\s+/)) {
                    if (part.startsWith('https://') && part.includes('trycloudflare.com')) {
                        cloudflaredUrl = part.trim();
                        cloudflaredDone = true;
                        logStream.write(`Cloudflared URL found: ${cloudflaredUrl}\n`);
                        tryStartBackend();
                        break;
                    }
                }
            }
        });

        // Fallback: if cloudflared takes too long, start without clearnet
        setTimeout(() => {
            if (!cloudflaredDone) {
                cloudflaredUrl = null;
                cloudflaredDone = true;
                logStream.write('Cloudflared timed out, starting backend without clearnet\n');
                tryStartBackend();
            }
        }, 30000);
    } else {
        // No cloudflared — mark as done immediately
        cloudflaredUrl = null;
        tryStartBackend();
    }

    createWindows();
});

app.on('window-all-closed', () => {
    killAllProcesses();
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', killAllProcesses);
app.on('will-quit', killAllProcesses);
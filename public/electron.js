const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

// Processes
let backend, tor, ipfs;
let splash, mainWindow;

// Kill helpers
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
}

// Check connectivity
const isOnline = async () => {
    return new Promise((resolve) => {
        require('dns').lookup('cloudflare.com', (err) => {
            resolve(!err);
        });
    });
};

// Splash and main windows
function createWindows() {
    // Splash screen
    splash = new BrowserWindow({
        width: 400,
        height: 250,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        center: true,
        backgroundColor: '#0b0f2b'
    });
    splash.loadFile(path.join(process.resourcesPath, 'build', 'splash.html'));

    // Main app window
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
    mainWindow.loadFile(path.join(process.resourcesPath, 'build', 'index.html'));
}

// Offline screen
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
          <div><h2>🚫 No Internet Connection</h2><p>Please connect to the internet and restart.</p></div>
        </html>
    `)}`);
}

// App startup
app.whenReady().then(async () => {
    const online = await isOnline();
    if (!online) {
        showNoInternetScreen();
        return;
    }

    const binDir = path.join(process.resourcesPath, 'binaries');
    const logPath = path.join(app.getPath('userData'), 'backend.log');
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });

    // Start backend
    backend = spawn(path.join(binDir, 'backend.exe'), [], { cwd: binDir });
    backend.stdout.on('data', data => logStream.write(`BACKEND STDOUT: ${data}\n`));
    backend.stderr.on('data', data => logStream.write(`BACKEND STDERR: ${data}\n`));

    // Start Tor
    tor = spawn(path.join(binDir, 'tor.exe'), ['-f', path.join(binDir, 'torrc')], { cwd: binDir });
    tor.stdout.on('data', data => logStream.write(`TOR STDOUT: ${data}\n`));
    tor.stderr.on('data', data => logStream.write(`TOR STDERR: ${data}\n`));

    // Start IPFS
    const ipfsPath = path.join(binDir, 'ipfs.exe');
    const ipfsConfigPath = path.join(process.env.USERPROFILE || process.env.HOME, '.ipfs', 'config');

    if (!fs.existsSync(ipfsConfigPath)) {
        const initProc = spawn(ipfsPath, ['init'], { cwd: binDir });
        initProc.stdout.on('data', data => logStream.write(`IPFS INIT: ${data}\n`));
        initProc.stderr.on('data', data => logStream.write(`IPFS INIT ERROR: ${data}\n`));
        initProc.on('exit', () => {
            ipfs = spawn(ipfsPath, ['daemon'], { cwd: binDir });
            ipfs.stdout.on('data', data => logStream.write(`IPFS STDOUT: ${data}\n`));
            ipfs.stderr.on('data', data => logStream.write(`IPFS STDERR: ${data}\n`));
        });
    } else {
        ipfs = spawn(ipfsPath, ['daemon'], { cwd: binDir });
        ipfs.stdout.on('data', data => logStream.write(`IPFS STDOUT: ${data}\n`));
        ipfs.stderr.on('data', data => logStream.write(`IPFS STDERR: ${data}\n`));
    }

    createWindows();

    // Show main window when backend is ready
    backend.stderr.on('data', data => {
        const log = data.toString();
        logStream.write(`BACKEND STDERR: ${log}`);
        if (log.includes('Tor hidden service started:') && splash) {
            splash.close();
            mainWindow.show();
        }
    });
});

// Cleanup
app.on('window-all-closed', () => {
    killAllProcesses();
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', killAllProcesses);
app.on('will-quit', killAllProcesses);

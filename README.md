# FileShare

**Secure file sharing, made simple.**

FileShare is a Windows desktop application that lets you share files with other devices through private download links. It combines encrypted IPFS storage, Tor Onion Services, optional HTTPS sharing, and a simple desktop interface.

The application was developed by QuantumCruz.

## Download

**Latest Windows release:**

https://github.com/QuantumCruz/Decentralized_File_Sharing_System/releases

Download the latest stable `FileShare-Setup-*-x64.exe` installer from the GitHub Releases page.

The installer bundles the desktop application and its required runtime components. Users do not need to install Python, Node.js, or IPFS separately.

## Features

- **Encrypted storage:** Files are encrypted with AES-256-GCM before being added to IPFS.
- **HTTPS sharing:** Generate a temporary browser-accessible download link using a Cloudflare Quick Tunnel.
- **Tor sharing:** Generate an Onion Service link for recipients using Tor Browser.
- **Download limits:** Choose how many download attempts a link permits.
- **Automatic expiry:** Shares expire 24 hours after creation.
- **Link revocation:** Stop sharing a file before its expiry.
- **Multiple-file sharing:** Bundle several files into a ZIP archive.
- **QR codes:** Open sharing links conveniently from other devices.
- **Upload progress:** Track file processing and upload status.
- **Sharing history:** Review previous shares and their status.
- **Standalone Windows application:** No separate Python or Node.js installation is required.

## How to use FileShare

1. Install and launch FileShare on your Windows computer.
2. Select or drag files into the application.
3. Choose a download limit.
4. Click **Create sharing link**.
5. Copy the HTTPS or Tor link and send it to your recipient.
6. The recipient opens the link and downloads the file.

Recipients do not need FileShare installed.

For Tor links, recipients need a browser capable of accessing Onion Services, such as Tor Browser.

**Important:** Keep FileShare running while recipients download. The hosting computer must remain available.

## How FileShare works

FileShare uses several components:

| Component | Purpose |
|---|---|
| Electron | Windows desktop application |
| React | User interface |
| Python and aiohttp | Local HTTP services and file-transfer operations |
| IPFS | Storage and retrieval of encrypted file content |
| Tor | Onion Service hosting |
| Cloudflare Quick Tunnels | Temporary public HTTPS access |
| SQLite | Local share metadata and download controls |
| WebSockets | Upload progress notifications |

The application maintains separate local HTTP listeners for its owner dashboard and public download interface.

Management operations require a session authentication token.

Public visitors are served only the download-facing functionality.

### Encryption and trust

Before publishing a file to IPFS, FileShare encrypts the file content using AES-256-GCM.

The local application retains the information needed to decrypt the shared content.

When a recipient downloads a file, the host application retrieves the encrypted object, verifies its integrity, decrypts it, and delivers the resulting file through the selected transport.

This design protects stored IPFS content, but it should **not** be described as recipient-side end-to-end encryption. The host application performs decryption, and HTTPS transfers use Cloudflare as a third-party network service.

## Security and access controls

FileShare implements:

- Separate owner and public APIs
- Authentication for management operations
- Authenticated AES-GCM decryption before plaintext delivery
- Atomic enforcement of download limits
- Revocation of active shares
- Local application-data isolation
- Validation of runtime configuration

Interrupted downloads may count toward the configured download limit.

Automated tests cover encryption failure handling, API isolation, download limits, revocation, and runtime configuration.

These controls reduce risk but do not constitute a complete independent security audit.

## Storage and application data

The stable Windows version stores its application data under:

```text
%LOCALAPPDATA%\QuantumCruz\FileShare
```

This includes share metadata, local IPFS repository data, Tor service data, and application logs.

The development and Preview versions use separate storage locations.

The stable application does not automatically import data from older installations.

Uninstalling the application may leave user data behind, depending on the installation and uninstall process.

## Known limitations

- Windows x64 is the primary supported desktop platform.
- The hosting computer must remain running and connected for remote downloads.
- Cloudflare Quick Tunnels are temporary, best-effort services. They do not provide guaranteed uptime or permanent URLs.
- Tor transfers may experience higher latency and lower throughput.
- The application currently has no automatic-update mechanism.
- The Windows installer is not code-signed, so Windows SmartScreen may display an unrecognized-publisher warning.
- Some bundled dependency versions are intentionally retained for compatibility. Dependency modernization remains future maintenance work.

The current version preserves the tested go-ipfs 0.7.0 integration. The age of this dependency and the Electron version should be considered when assessing security and compatibility.

## Development

### Requirements

For development and local builds:

- Windows
- Python 3.11 or compatible Python environment
- Node.js and npm
- Python packages `aiohttp`, `cryptography`, and `pyinstaller`
- The bundled IPFS, Tor, and cloudflared executables

Clone the repository:

```powershell
git clone https://github.com/QuantumCruz/Decentralized_File_Sharing_System.git
cd Decentralized_File_Sharing_System
```

Install dependencies:

```powershell
npm ci
python -m pip install aiohttp cryptography pyinstaller
```

The `binaries/` directory is excluded from Git and must be populated with compatible executable dependencies when building from source.

### Run automated tests

```powershell
python -m unittest discover -s tests -v
```

### Development environment

The development launcher uses its own isolated runtime profile.

```powershell
python scripts/prepare_dev_profile.py prepare
npm run electron
```

### Build the stable Windows installer

```powershell
npm run package
```

The build performs Python tests, generates the Python backend executable, compiles the React frontend, and packages the Windows installer.

Generated output:

```text
dist-stable/FileShare-Setup-1.0.0-x64.exe
```

The stable build must run from the `main` or `release/v1.0.0` branch.

## Testing

FileShare v1.0.0 completed 38 automated tests during release preparation.

Additional manual testing covered:

- Application startup and closure
- File upload and link generation
- Cross-device downloads
- Revocation and download controls
- Windows installer operation
- Public and owner API access separation

The automated tests and manual verification do not guarantee compatibility with every Windows environment or network configuration.

## Contributing

Bug reports and improvement suggestions are welcome through GitHub Issues.

Source contributions should be tested without modifying existing user data.

## License

MIT License. See [LICENSE](LICENSE).

Copyright © QuantumCruz.

Bundled third-party components are subject to their respective licenses.
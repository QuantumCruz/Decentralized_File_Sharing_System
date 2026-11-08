
# FileShare

**Secure file sharing, made simple.**

FileShare is a Windows desktop application for sharing files through temporary download links.

It combines AES-256-GCM encrypted IPFS storage, Tor Onion Services, optional Cloudflare HTTPS sharing, and a desktop interface designed to make file transfers straightforward.

Built by [QuantumCruz](https://github.com/QuantumCruz).

[![FileShare Tests](https://github.com/QuantumCruz/Decentralized_File_Sharing_System/actions/workflows/tests.yml/badge.svg)](https://github.com/QuantumCruz/Decentralized_File_Sharing_System/actions/workflows/tests.yml)

## Download

**Latest stable release: v1.0.2**

https://github.com/QuantumCruz/Decentralized_File_Sharing_System/releases/latest

Download `FileShare-Setup-1.0.2-x64.exe` and run the Windows installer.

The installer bundles the application and its required runtime components. End users do not need to install Python, Node.js, or IPFS separately.

**Supported platform:** Windows x64.

**Installer notice:** The current installer is unsigned. Windows SmartScreen may display an unrecognized-publisher warning.

## Features

- **Encrypted IPFS storage:** Encrypt files using AES-256-GCM before adding them to IPFS.
- **HTTPS sharing:** Generate temporary browser-accessible links using Cloudflare Quick Tunnels.
- **Tor Onion Services:** Share files through `.onion` links accessible using Tor Browser.
- **Download limits:** Configure the number of permitted download attempts.
- **24-hour expiry:** Shares automatically expire after 24 hours.
- **Revocation:** Disable a sharing link before it expires.
- **Multiple-file sharing:** Package several files into one downloadable ZIP archive.
- **QR codes:** Access sharing links conveniently from another device.
- **Upload progress:** View progress while FileShare processes files.
- **Sharing history:** Review previously created shares and their status.
- **Standalone installation:** Use the packaged Windows application without installing development tools.

## Getting started

1. Install and launch FileShare.
2. Select or drag the files you want to share.
3. Configure the download limit.
4. Create a sharing link.
5. Copy the HTTPS or Tor link.
6. Send the link to your recipient.

Recipients can download files using a browser without installing FileShare.

Tor links require a browser that supports Onion Services, such as Tor Browser.

**Important:** Your computer must remain running, connected to the internet, and hosting FileShare while recipients download shared files.

FileShare is a self-hosted sharing application, not a continuously available cloud storage service.

## How it works

FileShare uses the following components:

| Component | Role |
|---|---|
| Electron | Desktop application |
| React | User interface |
| Python and aiohttp | Backend services and file transfers |
| IPFS | Encrypted content storage and retrieval |
| Tor | Onion Service hosting |
| Cloudflare Quick Tunnels | Temporary public HTTPS access |
| SQLite | Share metadata and download controls |
| WebSockets | Upload progress notifications |

The application separates the owner-facing management interface from its public download service.

Management operations require session authentication. Public recipients access the download-facing functionality rather than the owner dashboard.

### File encryption

FileShare encrypts content using AES-256-GCM before storing it in IPFS.

The local hosting application retains the information required to decrypt shared content.

When a recipient downloads a file, the host retrieves the encrypted content, checks its authentication tag, decrypts it, and delivers the plaintext through the selected sharing transport.

This provides authenticated encryption for content stored in IPFS.

**It is not recipient-side end-to-end encryption.** Decryption occurs on the hosting computer before the recipient receives the file.

### HTTPS versus Tor

FileShare supports two distinct approaches to remote access.

**HTTPS sharing**

- Uses Cloudflare Quick Tunnels to expose the download service through a temporary public HTTPS URL.
- Recipients can use a normal web browser.
- Cloudflare is a third-party intermediary in the connection.
- The application should not be described as providing complete intermediary-free privacy through this mode.
- Tunnel availability and URL persistence are not guaranteed.

**Tor sharing**

- Exposes the download service through a Tor Onion Service.
- Recipients can connect using Tor Browser.
- Does not require a Cloudflare HTTPS tunnel for Onion Service access.
- Uses Tor's Onion Service architecture instead of a conventional public HTTPS endpoint.
- Performance depends on the network and Tor circuit conditions.

Neither mode makes the application invulnerable to compromise, traffic analysis, malicious recipients, or vulnerabilities in the host computer.

## Security and access controls

FileShare implements:

- AES-256-GCM authenticated encryption for stored file content
- Authentication for owner-management operations
- Separation between owner and public endpoints
- Download-limit enforcement
- Link revocation
- Expiration of shared links
- Validation of runtime configuration
- Isolation of development, preview, and stable application profiles

Interrupted downloads may count toward the configured download limit.

Automated tests cover important backend behaviors, including corrupted ciphertext rejection, authentication, endpoint isolation, download controls, and runtime profile validation.

These protections are useful security controls, **not a substitute for an independent security audit**.

Do not use FileShare as the sole protection for highly sensitive information without conducting an appropriate security assessment.

## Storage and application data

The stable Windows application stores its data under:

```text
%LOCALAPPDATA%\QuantumCruz\FileShare
```

Application data can include share metadata, local IPFS repository information, Tor service data, and logs.

Development and preview environments use separate runtime locations to reduce accidental interference with the installed stable application.

The stable application does not automatically import older application data.

Uninstalling the program may leave application data behind.

## Limitations

- Windows x64 is the currently supported desktop platform.
- The hosting computer must remain online and running FileShare.
- Cloudflare Quick Tunnels are temporary, best-effort services.
- Tor connections may exhibit higher latency or lower throughput, depending on network conditions.
- Downloads are served through the host; FileShare is not recipient-side end-to-end encrypted.
- The application has no built-in automatic-update mechanism.
- The Windows installer is unsigned.
- Some bundled dependencies are older and require future compatibility and security review.

### IPFS dependency compatibility

The current stable build uses **go-ipfs 0.7.0**, preserved from the tested release configuration.

The Windows build script explicitly checks for this version before packaging the installer.

A newer Kubo release has not yet been validated against FileShare's complete workflow. Compatibility should be established in an isolated development branch before replacing the existing binary.

The compatibility assessment should cover:

- Adding encrypted content
- Retrieving content
- Removing pins
- Backend API interactions
- Repository initialization and configuration
- Packaged Windows behavior

The current dependency should not be described as incompatible with modern Kubo versions until that has actually been demonstrated through testing.

The older IPFS and Electron versions remain maintenance and security considerations.

## Development

### Requirements

For local development and Windows builds:

- Windows
- Python 3.11
- Node.js and npm
- Python packages including `aiohttp`, `cryptography`, and `pyinstaller`
- Compatible IPFS, Tor, and cloudflared executables

Clone the repository:

```powershell
git clone https://github.com/QuantumCruz/Decentralized_File_Sharing_System.git
cd Decentralized_File_Sharing_System
```

Install application dependencies:

```powershell
npm ci
python -m pip install aiohttp cryptography pyinstaller
```

The `binaries/` directory is excluded from Git. Local installer builds require compatible runtime executables at the paths expected by the build script.

### Automated tests

Run:

```powershell
python -m unittest discover -s tests -v
```

The repository currently has 38 Python automated tests.

GitHub Actions also runs these tests on Windows for pushes and pull requests.

### Isolated development environment

Prepare the development runtime:

```powershell
python scripts/prepare_dev_profile.py prepare
```

Launch the Electron development application:

```powershell
npm run electron
```

The development profile uses dedicated runtime paths and ports to avoid interfering with the stable installation.

### Build the Windows installer

Run:

```powershell
npm run package
```

The stable build script:

1. Validates the Git branch and application version.
2. Verifies required runtime executables and assets.
3. Runs Python tests.
4. Builds the Python backend.
5. Compiles the React frontend.
6. Packages the Windows installer.
7. Verifies packaged components and executable hashes.

For v1.0.2, the expected output is:

```text
dist-stable/FileShare-Setup-1.0.2-x64.exe
```

The current build script accepts the `main` branch and the historical `release/v1.0.0` branch name.

It checks the declared application version in `package.json` and `package-lock.json`; the historical branch name does not determine the installer version.

The stable build also verifies the expected Tor 0.4.9.15 and go-ipfs 0.7.0 binaries.

## Testing and release status

**Latest stable version:** v1.0.2

**Automated Python tests:** 38 passing in GitHub Actions.

Manual release verification has included:

- Desktop startup and closure
- File selection and sharing-link creation
- Cross-device downloads
- Revocation and download-limit behavior
- Public and owner API separation
- Windows installer operation
- HTTPS and Tor access checks

Automated and manual testing do not guarantee successful operation on every network, Windows installation, or security configuration.

### Release verification

Published installer artifacts and associated SHA-256 files are available through GitHub Releases:

https://github.com/QuantumCruz/Decentralized_File_Sharing_System/releases

Verify downloads against their published hashes when checking installer integrity.

## Future improvements

Potential maintenance work includes:

- Evaluating current Kubo/IPFS releases
- Reviewing outdated desktop dependencies
- Improving automated build and installer verification
- Additional clean-machine testing
- Code-signing the Windows installer
- Expanding security and network-condition testing

These are prospective improvements, not claims about functionality already implemented.

## Contributing

Issues and improvement suggestions are welcome.

https://github.com/QuantumCruz/Decentralized_File_Sharing_System/issues

Contributions should preserve existing user data and the separation between development and stable runtime environments.

## License

FileShare is licensed under the [MIT License](LICENSE).

Copyright © 2025 QuantumCruz.

Bundled third-party dependencies retain their respective licenses.

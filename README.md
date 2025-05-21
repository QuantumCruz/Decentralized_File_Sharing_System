Decentralized File Sharing System
A privacy-first, peer-to-peer file sharing desktop application that leverages Tor, IPFS, and WebSockets to securely distribute files with optional expiry, max download limits, and QR code access — all without any central server.

Features:

Tor Onion Services — Share files anonymously and securely over the Tor network.

IPFS Integration — Store and retrieve files through the InterPlanetary File System.

Max Downloads & Expiry — Limit access and auto-expire shared files.

WebSocket Upload Feedback — Live upload progress with persistent WebSocket status.

Electron Desktop App — Fully offline-capable .exe with no install required.

Local-Only Execution — All processing and control remains on the user’s machine.

QR Code Generation — Instant sharing via QR for Onion links.

Folder Structure:

/frontend → React interface

/backend → Python aiohttp server

/resources/binaries → node.exe, Tor, IPFS, etc.

Usage Instructions:

Clone this repository:
git clone https://github.com/QuantumCruz/Decentralized_File_Sharing_System.git

Install dependencies:

Python: aiohttp, stem

Node.js: used internally for webtorrent-hybrid

Run the desktop app:

Use the prebuilt .exe or start with Electron for development

Git Ignore Notes:
This project excludes:

resources/binaries/ — external dependencies like node.exe, webtorrent-hybrid, Tor, etc.

dist/ — packaged Electron output

.exe and .asar files — large build artifacts

License:
MIT © 2025 QuantumCruz

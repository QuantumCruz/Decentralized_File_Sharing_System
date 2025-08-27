This project implements a privacy-first, peer-to-peer file sharing system that integrates Tor Onion Services, IPFS (InterPlanetary File System), and WebSockets within a fully offline-capable Electron desktop application. The system was designed to address the challenges of centralized file sharing — surveillance risks, server costs, and single points of failure — by distributing responsibility entirely to user machines.

Core contributions:

Secure anonymity: Files are shared directly via Tor Onion Services, preventing IP leakage and ensuring sender/receiver privacy.

Decentralized persistence: Files are stored and retrieved through IPFS, avoiding reliance on centralized hosting.

Controlled sharing: Features such as maximum download limits and time-based expiry give users granular control over access.

User experience: WebSockets provide real-time upload progress feedback; QR code generation simplifies Onion link sharing.

Results / Evaluation

Verified successful file transfers across multiple nodes on the Tor network.

Implemented expiry and max-download policies, with automated revocation of access once thresholds were met.

Confirmed full offline execution: the system runs without external servers beyond bundled dependencies.

Delivered a working .exe desktop application with no installation required.

Limitations & Future Work

Current implementation is desktop-only; future iterations could explore mobile integration.

File transfer speeds remain limited by Tor and IPFS performance; benchmarking at scale is an area for improvement.

Integration with additional peer-discovery mechanisms could improve resilience.

Future research directions include privacy-preserving audit logs, scalability benchmarking, and distributed access control policies.

This project demonstrates the application of distributed systems, privacy engineering, and secure software design — reflecting readiness for graduate-level research in Computer Science.

Features

Tor Onion Services — Anonymous, secure file sharing.

IPFS Integration — Decentralized file storage and retrieval.

Max Downloads & Expiry — Auto-expire shared links.

WebSocket Upload Feedback — Real-time transfer updates.

Electron Desktop App — Fully offline-capable .exe.

Local-Only Execution — No external servers required.

QR Code Generation — Instant sharing of Onion links.

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

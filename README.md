<p align="center">
  <img src="web/public/logo.png" width="140" alt="WebSpeak3 logo">
</p>

<h1 align="center">WebSpeak3</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="Dockerfile"><img src="https://img.shields.io/badge/docker-build%20passing-2496ED?logo=docker&logoColor=white" alt="Docker Build"></a>
  <a href="gateway/package.json"><img src="https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white" alt="Node Version"></a>
  <a href="connector/Cargo.toml"><img src="https://img.shields.io/badge/rust-2021-000000?logo=rust&logoColor=white" alt="Rust Version"></a>
  <a href="https://github.com/Moepchi/webspeak3/releases"><img src="https://img.shields.io/github/v/release/Moepchi/webspeak3?include_prereleases&label=release" alt="Latest Release"></a>
  <img src="https://img.shields.io/badge/status-public%20beta-f0b429" alt="Project Status">
</p>

<p align="center">
  <b>A modern, self-hosted browser client for TeamSpeak 3 servers — no install, just open a tab.</b>
</p>

<p align="center">
  <a href="https://webspeak3.de">🌐 Website</a> ·
  <a href="https://client.webspeak3.de">💬 Open Client</a> ·
  <a href="https://demo.webspeak3.de">🕹️ Live Demo</a> ·
  <a href="#-quick-start">🚀 Quick Start</a> ·
  <a href="#-installation">📖 Installation</a> ·
  <a href="ROADMAP.md">🗺️ Roadmap</a> ·
  <a href="https://github.com/Moepchi/webspeak3/issues">🐛 Report Bug</a>
</p>

> The [live demo](https://demo.webspeak3.de) runs entirely in your browser with simulated data — no real TeamSpeak server involved. It's there to show the UI, not the real connection.

---

## 📸 Preview

<table>
  <tr>
    <th>Desktop</th>
    <th>Mobile</th>
  </tr>
  <tr>
    <td width="72%"><img src="https://raw.githubusercontent.com/Moepchi/webspeak3-landing/main/public/screenshots/webspeak_current.png" width="100%" alt="WebSpeak3 desktop client connected to a TeamSpeak server"></td>
    <td width="28%" align="center"><img src="https://raw.githubusercontent.com/Moepchi/webspeak3-landing/main/public/screenshots/webspeak_mobile.png" width="260" alt="WebSpeak3 mobile client connected to a TeamSpeak server"></td>
  </tr>
</table>

## 🚀 Quick Start

Run the ready-made container and open **http://localhost:8080**:

```bash
docker run -d --name webspeak3 --restart unless-stopped -p 8080:8080 moepchi/webspeak3:latest
```

Enter the address and port of **any reachable TeamSpeak 3 or TeamSpeak 6
server** in the connection dialog. The TeamSpeak server does not need to be
installed on the same machine, modified, or operated by you.

> Voice requires a secure context. Microphone access works on `localhost`; for
> access from other devices, place WebSpeak3 behind an HTTPS reverse proxy.

## ✨ Features

|  |  |
|---|---|
| 🔌 **Real TeamSpeak protocol** | Connects to actual TS3/TS6 servers over a WebSocket gateway — the server stays exactly as-is |
| 🎙️ **Low-latency voice** | Opus-encoded voice with voice activation ("Sprachaktivierung") and adjustable sensitivity |
| 🤫 **Whisper** | Target your voice at specific channels or clients instead of your whole current channel |
| 🔊 **Custom audio output picker** | Route playback to any output device — works even in browsers without `AudioContext.setSinkId` |
| 💬 **Full text chat** | Channel, server-wide, and private (1:1) chat, each in its own tab — Shift+Enter for a newline |
| 🌳 **Live channel/client tree** | Correct ordering, status icons (channel commander, away, muted, deafened), country flags, click to switch channels |
| 🖱️ **Right-click context menu** | Private chat, poke, copy name, and whisper-target toggle straight from a client's row |
| 📜 **Server log** | Join/leave/switch, channel-group, and channel/server-change events shown inline, like the native client |
| 🔔 **Custom sound notifications** | Per-event sounds (connect, poke, messages, ...) with volume control and `.ts3soundpack` import |
| 🪪 **Persistent identity** | Keeps the same client UID across sessions instead of generating a new one every connect |
| 👉 **Poke & away status** | Poke clients with an optional message; set yourself away with presets or a custom status |
| ⭐ **Favorites & reconnect** | Remembers your last server/nickname; switch servers without leaving your tab |
| 📱 **Mobile-friendly layout** | Responsive single-column layout for narrow screens, not just a shrunk desktop UI |
| 🌍 **Localized UI** | Interface available in German and English, detected automatically or switchable in Options |
| 🌗 **Dark / light theme** | Clean, modern UI that adapts to your preference |
| 🔁 **Seamless reconnect** | Switch connections mid-session — old state tears down cleanly, no leaks or duplicates |

## 🧱 Tech Stack

<p>
  <img src="https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white" alt="Docker">
</p>

<details>
<summary><b>🏗️ Architecture details</b></summary>

<br>

Browsers can't send raw UDP, which is what TeamSpeak's native protocol runs
over, so a pure client-side implementation isn't possible — a server-side
gateway is required that speaks the real TS protocol on one side and
WebSocket to the browser on the other.

```
Browser (web/)  <--WebSocket-->  Gateway (gateway/)  <--stdin/stdout JSON-->  Rust connector (connector/)  <--TS3/TS6 protocol-->  TeamSpeak Server
```

- **`web/`** — Vite + React frontend. TS3-lookalike UI: channel tree, chat
  tabs, voice controls.
- **`gateway/`** — Node.js/TypeScript WebSocket server. Spawns the Rust
  connector per browser connection and relays newline-delimited JSON events
  between it and the browser.
- **`connector/`** — Rust binary wrapping [`tsclientlib`](https://github.com/ReSpeak/tsclientlib)
  (vendored as a git submodule in `tsclientlib/`), the actual TS3/TS6
  protocol implementation. Handles connecting, channel/client state, chat,
  and Opus-encoded voice.

</details>

## 🌐 Browser Support

| Browser | Status | Notes |
|---|---|---|
| Chrome / Edge / Chromium | ✅ Primary target | Recommended for the most complete audio and device support |
| Firefox | ✅ Supported | Core client and voice functionality are supported |
| Safari | 🧪 Experimental | Audio and microphone behavior still needs broader real-device testing |
| Mobile Chromium | ✅ Supported | Responsive client with microphone support over HTTPS |
| Mobile Safari | 🧪 Experimental | UI is responsive; audio behavior remains under active validation |

WebSpeak3 is a public beta. See the [beta roadmap](ROADMAP.md) for the current
scope, known limitations, and the next milestones.

## 🚀 Installation

### 🐳 Docker (recommended)

Clone the repo (the Rust connector depends on a git submodule, so pull it in too):

```bash
git clone --recurse-submodules https://github.com/Moepchi/webspeak3.git
cd webspeak3
```

This is what ships in [`docker-compose.yml`](docker-compose.yml):

```yaml
services:
  webspeak3:
    build: .
    image: moepchi/webspeak3:latest
    container_name: webspeak3
    restart: unless-stopped
    environment:
      - PORT=8080
```

Port publishing is left out on purpose — set it in a local, gitignored `docker-compose.override.yml` so it doesn't clash with whatever else is already using a port on your host:

```yaml
services:
  webspeak3:
    ports:
      - "8080:8080"
```

Then `docker compose up -d` and open `http://localhost:8080` (or whatever host port you chose).

Prefer to skip the build entirely? A prebuilt image is published on [Docker Hub](https://hub.docker.com/r/moepchi/webspeak3):

```bash
docker run -d -p 8080:8080 --name webspeak3 moepchi/webspeak3:latest
```

<details>
<summary><b>🛠️ Manual installation (without Docker)</b></summary>

<br>

**Prerequisites**

- **Node.js** 20+ and npm
- **Rust** (stable toolchain) — [rustup.rs](https://rustup.rs)
- **CMake** and a C/C++ toolchain — needed to build the Opus codec library (`audiopus_sys`) used for voice. On Windows, the Visual Studio "Desktop development with C++" workload covers this; on Linux, install `cmake` and `build-essential` (or equivalent); on macOS, `cmake` via Homebrew plus Xcode command line tools.
- **git**

**1. Clone the repository**

The Rust connector depends on the `tsclientlib` crate, vendored as a git submodule — make sure to pull it in too:

```bash
git clone --recurse-submodules https://github.com/Moepchi/webspeak3.git
cd webspeak3
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

**2. Build the Rust connector**

```bash
cd connector
cargo build
```

> **Note:** if the build fails with a CMake error like `Compatibility with CMake < 3.5 has been removed`, it's because the vendored Opus source uses an old `cmake_minimum_required`. Work around it with:
>
> ```bash
> CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo build
> ```
> (On Windows PowerShell: `$env:CMAKE_POLICY_VERSION_MINIMUM = "3.5"; cargo build`)

This produces `connector/target/debug/ts-connector` (or `ts-connector.exe` on Windows), which the gateway spawns automatically — no manual step needed after this.

**3. Install and start the gateway**

```bash
cd gateway
npm install
npm run dev
```

This starts the WebSocket gateway on `ws://localhost:8080`.

**4. Install and start the web frontend**

In a separate terminal:

```bash
cd web
npm install
npm run dev
```

Vite will print a local dev URL (typically `http://localhost:5173`) — open it in a browser.

**5. Connect**

In the web UI, enter the address of a TeamSpeak server and a nickname, then click **Connect**. Voice requires microphone permission when you enable the mic button; the output-device picker (if your browser supports it) requires no extra permission.

**Rebuilding after changes**

- Frontend and gateway changes hot-reload automatically (`npm run dev` in both cases).
- Connector changes require a rebuild (`cargo build` in `connector/`) and a reconnect from the browser — if the old `ts-connector` binary is still running (an active browser connection), disconnect first or the build will fail to overwrite the binary.

</details>

## Credits

The vast majority of this project's code was written by [Claude Code](https://claude.com/claude-code) (Anthropic's Claude), working iteratively with the repo owner one feature at a time.

---

### Legal / Disclaimer

**WebSpeak3** is an independent, open-source, self-hosted project and is
**not** affiliated with, associated with, authorized by, endorsed by, or in
any way officially connected with TeamSpeak Systems GmbH.

"TeamSpeak", "TS3", and related logos or names are registered trademarks of
TeamSpeak Systems GmbH. All product and company names are trademarks™ or
registered® trademarks of their respective holders. Use of them does not
imply any affiliation with or endorsement by them.

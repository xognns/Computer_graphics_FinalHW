# Residual Light

Three.js 기반 컴퓨터그래픽스 최종 과제 게임입니다. DDGI 기반 indirect lighting을 게임플레이에 연결해 Lumen AI와 사물 가시성에 반영하는 것을 핵심 목표로 잡고 개발했습니다.

## Run

```bash
npm install
npm run dev
```

The dev server listens on all network interfaces, so another device on the same
Wi-Fi/LAN can open the game with:

```text
http://<this-computer-ip>:5173/
```

You can also run the explicit host script:

```bash
npm run dev:host
```

On Windows/WSL, use the Windows host IPv4 address from `ipconfig` on the other
device. If the page does not open, allow Node.js through Windows Defender
Firewall for private networks.

## Build

```bash
npm run build
```

## Preview Production Build

```bash
npm run preview
```

For testing the production build from another device:

```bash
npm run preview:host
```

Then open:

```text
http://<this-computer-ip>:4173/
```

## Visual Verification with VS Code Live Server

Live Server should serve the production build in `dist/`, not the source root.

```bash
npm run build
```

Then use VS Code Live Server's **Go Live** command. This workspace includes `.vscode/settings.json`, so Live Server opens `dist/` on port `5500`.

Expected URL:

```text
http://127.0.0.1:5500/
```

## Deploy

The project is a static Vite app. It can be deployed to Vercel or GitHub Pages after pushing the repository.

- Vercel: import the Git repository and use the default Vite settings.
- GitHub Pages: build with `npm run build` and publish the `dist/` directory.

## Current Controls

- `WASD`: Move
- `E`: Repair generator / use extraction console
- `Q`: Throw neon ball
- `Mouse`: Aim flashlight direction
- `Left click`: Toggle flashlight
- `P`: Toggle DDGI probe markers
- `R`: Toggle direct/indirect ray debug while playing
- `B`: Toggle bright map debug
- `R`: Restart after victory or failure

Touch devices show on-screen movement and action buttons automatically.

## Goal

Repair 6 generators, avoid Lumen by manipulating direct and indirect light, and report power restoration at the final console.

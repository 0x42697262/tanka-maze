# Tanka Maze

A real-time multiplayer tank battle in an open, randomized arena, built with
TypeScript and WebSockets. Each round generates a fresh layout of thin walls
(drawn as lines) for cover. Players create or join lobbies, then duel in a
server-authoritative arena where bullets ricochet off walls.

The server is intentionally stateless beyond live sessions — it exists only for
**lobby management** and **real-time multiplayer syncing**. Nothing is persisted.

## Features

- **Lobby system** — create a lobby (name, max players, kills-to-win), browse the
  live listing, and join open rooms. Listings update in real time.
- **Server-authoritative simulation** — a 30 Hz fixed-timestep loop owns all
  movement, bullet physics, collisions, and scoring, so clients can't cheat by
  manipulating local state.
- **Tank-style controls** — W/S (or ↑/↓) drive forward/reverse along the tank's
  heading, A/D (or ←/→) steer, and the turret aims independently at the mouse
  cursor. Click or space to fire.
- **Bouncing bullets** with limited ricochets, per-tank fire cooldown, and a
  bullet cap.
- **Smooth rendering** via snapshot interpolation (~100 ms buffer) on the client.
- **First to N kills wins**, then everyone returns to the lobby for a rematch.

## Project layout

```
src/
  shared/      # wire protocol + tuning constants (used by both sides)
    protocol.ts
    constants.ts
  server/      # Node WebSocket server (authoritative)
    index.ts   # HTTP static serving + WS hub
    lobby.ts   # room + game loop
    game.ts    # tank/bullet simulation
    maze.ts    # randomized open-arena wall generator (braided maze)
  client/      # Vite + canvas browser client
    index.html
    main.ts    # screens, networking glue, render loop
    net.ts     # WebSocket wrapper w/ auto-reconnect
    input.ts   # keyboard + mouse
    render.ts  # canvas renderer w/ interpolation
```

## Running

Install dependencies:

```bash
npm install
```

### Development (hot reload)

Runs the WebSocket server on `:8080` and the Vite dev server on `:5173`:

```bash
npm run dev
```

Open <http://localhost:5173>. To play multiplayer, open it in several tabs or on
other machines on your network. (The dev client connects to the server on
`ws://<host>:8080`.)

### Production (single port)

Build the client and compile the server, then serve everything from one port:

```bash
npm run build
npm start            # serves client + WebSocket on http://localhost:8080
```

Set `PORT` to change the port: `PORT=3000 npm start`.

### Deploying (Render.com)

The app is a single Node web service — it builds the client and serves both the
static files and the WebSocket from one port. It is **not** localhost-bound: the
client connects to the same origin (`wss://…` over HTTPS) and the server listens
on `process.env.PORT`.

A [`render.yaml`](./render.yaml) blueprint is included. To deploy:

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, select the repo (it reads `render.yaml`).

Or configure a **Web Service** manually with:

- **Build command:** `npm install --include=dev && npm run build`
- **Start command:** `npm start`

> `--include=dev` matters: Render sets `NODE_ENV=production`, which would
> otherwise skip `vite`/`typescript` (dev dependencies needed to build). Render
> injects `PORT` and terminates TLS, so WebSockets work over `wss://`
> automatically — no extra config.

### Type checking

```bash
npm run typecheck
```

## Controls

| Action          | Keys                        |
| --------------- | --------------------------- |
| Drive forward   | `W` / `↑`                   |
| Reverse         | `S` / `↓`                   |
| Steer left/right | `A` `D` / `←` `→`          |
| Aim turret      | Mouse cursor                |
| Fire            | Left click / `Space`        |

The tank's body points where it's heading; the cannon turret rotates
independently to track your mouse, so you can drive one way while shooting
another.

## How syncing works

1. Clients send `input` intents (movement booleans + aim angle + fire) at ~30 Hz.
2. The server advances the authoritative simulation and broadcasts a `snapshot`
   of all tanks and bullets each tick.
3. Clients buffer snapshots and render ~100 ms in the past, interpolating between
   the two surrounding snapshots for smooth motion.

No prediction is done on the client, which keeps state perfectly consistent at
the cost of a small, fixed input latency — a good trade for a LAN/casual game.

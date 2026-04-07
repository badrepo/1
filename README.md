# 🚀 Astroyd.io

Real-time multiplayer asteroid browser game built with Node.js + WebSockets + HTML5 Canvas.

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000
```

## Architecture

```
astroyd/
├── server.js          # Game server (Node.js + ws)
│   ├── CONFIG         # All tunable constants
│   ├── Star system    # Spawn / collect / refill
│   ├── Player mgmt    # Create / respawn / physics
│   ├── Bot AI         # Target stars, flee threats
│   ├── Collision      # Star collect + player consume
│   └── WS server      # Broadcast tick deltas
│
└── public/index.html  # Full client (single file)
    ├── Canvas render  # Background, stars, players, particles
    ├── Prediction     # Client-side movement prediction
    ├── Interpolation  # Smooth remote player movement
    ├── HUD            # Mass, leaderboard, minimap, killfeed
    └── Input          # Mouse steering, keyboard boost
```

## Controls
- **Mouse** — steer your asteroid
- **W / ↑** — boost speed
- Collect ★ stars to grow
- Absorb smaller asteroids (must be 1.1× their size)

## Tuning (server.js CONFIG)
| Key | Default | Effect |
|-----|---------|--------|
| TICK_RATE | 20 | Server updates/sec |
| MAX_STARS | 300 | Star density |
| MIN_BOTS / MAX_BOTS | 5 / 10 | Bot count range |
| CONSUME_RATIO | 1.1 | Size advantage to eat |
| SPEED_BASE | 180 | Max movement speed |

# CachyTile

A Wayland-first dynamic tiling KWin script for KDE Plasma 6, built for CachyOS.

Fills the gap left by Bismuth (archived) with a clean, modern, Plasma 6-native codebase.

---

## Features

- **4 layouts**: master-stack, columns, monocle, spotlight — switchable per virtual desktop
- **Configurable gaps**: inner and outer, live-adjustable
- **Smart float detection**: dialogs, splash screens, non-resizable windows auto-float
- **Per-app float rules**: define window classes that always float
- **Keyboard-driven**: i3-style shortcuts for focus, swap, layout cycle, float toggle
- **Per-desktop layout pinning** (Model B): pin a layout to a desktop in config; Meta+T overrides for the session only
- **KCM settings panel**: proper UI in System Settings, no config file editing needed
- **Plasma 6 + Wayland native**: uses KWin 6 scripting API throughout

---

## Install

### From source
```bash
git clone THE-PROJECT-URL
cd cachy-tile
make install
make reload
```

Then enable in **System Settings → Window Management → KWin Scripts → CachyTile**.

### As .kwinscript (KDE Store / manual)
```bash
make package
# Import cachy-tile.kwinscript via System Settings → KWin Scripts → Import
```

---

## Default Shortcuts

| Shortcut       | Action                          |
|----------------|---------------------------------|
| Meta + T       | Cycle layout                    |
| Meta + Return  | Swap focused window with master |
| Meta + J       | Focus next window               |
| Meta + K       | Focus previous window           |
| Meta + Shift + J | Move focused window down in tile order |
| Meta + Shift + K | Move focused window up in tile order   |
| Meta + Left    | Send focused window to previous desktop |
| Meta + Right   | Send focused window to next desktop     |
| Meta + F       | Toggle float for focused window |
| Meta + L       | Increase master width (master-stack) |
| Meta + H       | Decrease master width (master-stack) |

Shortcuts can be rebound in **System Settings → Shortcuts → KWin Scripts**.

> **⚠️ Meta+T conflicts with KDE's built-in "Toggle Tiles Editor".**
> KWin ships with **Meta+T** bound to its tile-editor overlay, so out of the box it will fire instead of (or alongside) CachyTile's *Cycle layout*. To free it up:
> **System Settings → Keyboard → Shortcuts**, search **`Toggle Tiles Editor`**, click its **Meta+T** chip and clear it, then **Apply**.

> **⚠️ Meta+Left / Meta+Right are KDE's default "Quick Tile Left/Right".**
> Send-to-desktop uses these. If you still have KDE's quick-tiling on those keys, clear it: **System Settings → Keyboard → Shortcuts**, search **`Quick Tile`**, and clear the **Meta+Left/Right** chips. (Most tiling-script users have already disabled KDE quick-tiling.) *Why arrows and not Meta+Shift+1–9? KWin can't fire script shortcuts on the shifted number row under Wayland, and plain Meta+1–9 is taken by the task manager.*

---

## Layouts

### master-stack
Left master pane, right stack column. 1 window fills the screen. Default 50/50 split.

### columns
Equal-width vertical columns. Great for wide monitors.

### monocle
All windows fullscreen, stacked. Cycle focus with Meta+J/K.

### spotlight
Master fills the entire screen. Stack windows sit in the corners, clockwise from bottom-right: BR → TR → TL → BL. More than 4 stack windows overflow into a second layer, scaled down by 70%, sitting behind the first. Corner size is configurable (default 28% of screen dimensions).

---

## Project Structure

```
cachy-tile/
├── contents/
│   ├── code/
│   │   └── main.js       ← Tiling engine + KWin signal wiring
│   ├── config/
│   │   └── main.xml      ← KConfigXT schema (config keys + defaults)
│   └── ui/
│       └── config.ui     ← Settings panel (KCM, Qt Designer)
├── package/
│   └── metadata.json     ← KWin plugin manifest
├── Makefile
└── README.md
```

---

## Roadmap

- [x] Master width ratio adjustment (Meta+H / Meta+L) (v0.1)
- [x] Spotlight layout (v0.2)
- [x] Per-desktop layout pinning — Model B (v0.2)
- [x] Minimized windows drop out of the layout; the rest reflow
- [x] Move window in tile order (Meta+Shift+J / Meta+Shift+K) (v0.3)
- [x] Send window to previous/next desktop (Meta+Left / Meta+Right) (v0.3)
- [ ] Session persistence — layout + ratio per desktop *(not yet working: the target KWin build has no script write-config API)*
- [ ] Spiral / Fibonacci layout
- [ ] Scratchpad (hidden floating layer)
- [ ] Multi-monitor awareness (independent layout per screen)
- [ ] Plasma widget for layout indicator in taskbar

---

## Contributing

Built by PSEUDOSTAGE for CachyOS and Plasma 6 power users. Not affiliated with CachyOS. PRs welcome.
Tested against KDE Plasma 6.4+ on Wayland.

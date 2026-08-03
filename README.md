<p align="center">
  <img src="imgs/plasmaflow-text-banner.svg" alt="PlasmaFlow" width="640">
</p>

<p align="center">
  A Wayland-first dynamic tiling KWin script for KDE Plasma 6.4+.<br>
  Fills the gap left by Bismuth (archived) with a clean, modern, Plasma 6-native codebase.
</p>

---

## Features

- **6 layouts**: spiral (Fibonacci, the default), master-stack, columns, monocle, spotlight, quadrant (2×2 grid) — switchable per virtual desktop
- **Configurable gaps**: inner and outer, live-adjustable
- **Borderless tiling** (optional): strip title bars and borders from tiled windows for a clean i3-style look
- **Smart float detection**: dialogs, splash screens, non-resizable windows auto-float
- **Per-app float rules**: define window classes that always float
- **Keyboard-driven**: i3-style shortcuts for focus, swap, layout cycle, float toggle
- **Per-desktop layout pinning** (Model B): pin a layout to a desktop in config; Meta+T overrides for the session only
- **Session persistence**: each desktop's layout and master width are remembered across logout/login
- **KCM settings panel**: proper UI in System Settings, no config file editing needed
- **Plasma 6 + Wayland native**: uses KWin 6 scripting API throughout

---

## Requirements

- **KDE Plasma 6.4+ on Wayland.** Developed and tested against 6.4+; earlier 6.x releases expose different KWin scripting APIs and may fail to load.
- **A running `plasmashell`.** Session persistence and the on-screen ratio/layout feedback are driven through plasmashell's scripting/OSD D-Bus interfaces. Both are best-effort: if plasmashell isn't running (or a future Plasma changes those interfaces), they silently no-op — tiling itself is unaffected.
- X11 may work but is not a supported target.

---

## Install

### From source
```bash
git clone https://github.com/PSEUDOSTAGE/PlasmaFlow.git
cd PlasmaFlow
make install
make reload
```

Then enable in **System Settings → Window Management → KWin Scripts → PlasmaFlow**.

### As .kwinscript (KDE Store / manual)
```bash
make package
# Import plasma-flow.kwinscript via System Settings → KWin Scripts → Import
```

---

## Default Shortcuts

| Shortcut       | Action                          |
|----------------|---------------------------------|
| Meta + T       | Cycle layout (only the layouts enabled in settings) |
| Meta + Shift + T | Cycle layout including disabled ones          |
| Meta + M       | Mirror the layout horizontally  |
| Meta + G       | Swap focused window with master |
| Meta + K       | Focus next window               |
| Meta + J       | Focus previous window           |
| Meta + Ctrl + K | Move focused window down in tile order |
| Meta + Ctrl + J | Move focused window up in tile order   |
| Meta + Left    | Send focused window to previous desktop |
| Meta + Right   | Send focused window to next desktop     |
| Meta + Ctrl + Space | Park focused window in the scratchpad |
| Meta + Space   | Summon / dismiss the scratchpad |
| Meta + F       | Toggle float (also ejects a summoned scratchpad window into tiling) |
| Meta + L       | Grow the focused window (master-stack/columns/spiral, quadrant diagonally, monocle slot) or corner size (spotlight) |
| Meta + H       | Shrink the focused window (master-stack/columns/spiral, quadrant diagonally, monocle slot) or corner size (spotlight) |

Shortcuts can be rebound in **System Settings → Shortcuts → KWin Scripts**.

> **⚠️ Meta+T conflicts with KDE's built-in "Toggle Tiles Editor".**
> KWin ships with **Meta+T** bound to its tile-editor overlay, so out of the box it will fire instead of (or alongside) PlasmaFlow's *Cycle layout*. To free it up:
> **System Settings → Keyboard → Shortcuts**, search **`Toggle Tiles Editor`**, click its **Meta+T** chip and clear it, then **Apply**.

> **⚠️ Meta+Left / Meta+Right are KDE's default "Quick Tile Left/Right".**
> Send-to-desktop uses these. If you still have KDE's quick-tiling on those keys, clear it: **System Settings → Keyboard → Shortcuts**, search **`Quick Tile`**, and clear the **Meta+Left/Right** chips. (Most tiling-script users have already disabled KDE quick-tiling.) *Why arrows and not Meta+Shift+1–9? KWin can't fire script shortcuts on the shifted number row under Wayland, and plain Meta+1–9 is taken by the task manager.*

> **ℹ️ Scratchpad uses Meta+Space (toggle) and Meta+Ctrl+Space (park).**
> These avoid the grave/tilde key, whose shifted keysym can't fire a script shortcut under Wayland. If **Meta+Space** is bound to something else on your system (e.g. a custom KRunner or keyboard-layout-switch binding), clear it in **System Settings → Keyboard → Shortcuts**.

> **⚠️ Meta+L is KDE's default "Lock Screen" shortcut.**
> PlasmaFlow uses it to *grow the focused window* (master-stack / columns / spiral / quadrant / monocle) or *corner size* (spotlight), so out of the box pressing it will lock the screen instead. To free it up: **System Settings → Keyboard → Shortcuts**, search **`Lock Screen`** (the *Screen Locking* action), click its **Meta+L** chip and clear it, then **Apply** — re-bind locking to another key first if you still want a lock shortcut.

---

## Layouts

### spiral *(default)*
Fibonacci spiral: the area is split recursively, alternating vertical/horizontal cuts and spiralling clockwise inward (left → top → right → bottom → …), with the last window filling the centre. **Meta+H/L** grow/shrink the **focused** window along its own cut — e.g. the top window grows downward, the right window grows leftward. The final (centre) window resizes via the cut it borders.

### master-stack
Left master pane, right stack column. 1 window fills the screen. Default 50/50 split. **Meta+H/L** resize the **focused** window: the master's width when it's focused, or a stack window's height (relative to its neighbours) when a stack window is focused.

### columns
Equal-width vertical columns. Great for wide monitors. **Meta+H/L** grow/shrink the **focused** column's width.

### monocle
All windows share one slot, stacked; only the focused one shows. Cycle focus with Meta+J/K. **Meta+H/L** shrink/grow that shared slot and re-centre it, so the focused window pulls toward screen centre with wallpaper margin around it (default is full-screen — nothing changes until you press Meta+H). The scale is per-desktop and remembered across logout.

### spotlight
Master fills the entire screen, kept behind the corner windows so it never covers them when focused. Stack windows sit in the corners, clockwise from bottom-right: BR → TR → TL → BL. More than 4 stack windows overflow into a second layer, scaled down by 70%, sitting behind the first. Corner size is configurable (default 38% of screen dimensions) and can be adjusted on the fly with **Meta+H/L**.

### quadrant
A 2×2 grid. Windows fill the quadrants in the order **TL → TR → BR → BL**: one window is fullscreen, two split the screen left/right, three fill three quadrants with the **bottom-left left empty**, and four take one quadrant each.

**Meta+H/L** grow/shrink the **focused** window *diagonally* — it expands from its own corner toward the centre, keeping its proportions, while the other windows adjust to make room (the diagonally-opposite window shrinks to match). Because the whole grid pivots on a single point, growing a *different* window first pulls the grid back to even (shrinking whichever window is currently largest), and only then starts to enlarge the focused one — so you can always get back to an even grid by growing the small window.

Opening a **5th** window (or more) doesn't disturb the grid: the extra windows **float and cascade in the centre**, ready to move where you like or pull into another layout with **Meta+F**.

### Trimming the cycle

If you only use some of these, untick the rest under **Configure → Layouts in the Meta+T Cycle** and **Meta+T** will skip them. Nothing becomes unreachable: **Meta+Shift+T** cycles through *every* layout regardless, and the default layout, per-desktop pins and remembered session layouts all still work with a layout you've unticked (the OSD marks it `(disabled)` so it's clear why Meta+T won't return to it). Unticking every layout leaves them all in the cycle rather than breaking the key.

---

## Appearance

This option lives in **System Settings → KWin Scripts → PlasmaFlow → Configure** and defaults to **off**. Config isn't read live — after changing it, reload the script (disable/enable it in the KCM, or `make reload`).

### Borderless tiling
**Remove window borders when tiled** strips the title bar and borders from every tiled window for a clean, chrome-free i3/Sway look. Decorations are automatically restored when a window leaves the layout — float it (**Meta+F**) or park it in the scratchpad and the title bar comes back. Windows that draw their own decorations (client-side, e.g. some GTK apps) are unaffected.

> **Telling the active window apart.** With title bars gone, the focused-colour title bar is no longer your active-window cue. The cleanest fix is KWin's built-in **Dim Inactive** effect (**System Settings → Desktop Effects → Dim Inactive**): inactive windows dim and the focused one stays full-brightness. It has a strength slider and pairs perfectly with borderless tiling. (A drawn outline/glow isn't possible from a KWin *script* — that needs a compositor effect.)

---

## Scratchpad

A hidden layer for windows you want out of the way but a keystroke away. It holds **any number** of windows.

- **Park** a window: focus it and press **Meta + Ctrl + Space**. It leaves the layout (the rest reflow) and hides — kept exactly at its current size and position.
- **Summon / dismiss**: **Meta + Space** brings every parked window to your current desktop (floating, each in place); press again to hide them. Move or resize a summoned window however you like — it keeps that size and position the next time you summon it, even as you park more windows.
- **Send back to tiling**: summon the scratchpad, focus a window, and press **Meta + F** — it drops into the current desktop's layout and leaves the scratchpad.

**Tip — move a window to any desktop, even non-adjacent ones:** park it, switch to whatever desktop you want (no matter how far), summon with **Meta + Space**, then **Meta + F** to tile it there. Meta+Left/Right only move to *neighbouring* desktops, so the scratchpad is the quickest way to send a window somewhere far.

---

## Project Structure

```
PlasmaFlow/
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
- [x] Move window in tile order (Meta+Ctrl+J / Meta+Ctrl+K) (v0.3)
- [x] Send window to previous/next desktop (Meta+Left / Meta+Right) (v0.3)
- [x] Session persistence — layout + ratio per desktop, remembered across logout/login (v0.3)
- [x] Spiral / Fibonacci layout — now the default (v0.3)
- [x] Scratchpad (multi-window hidden floating layer; doubles as send-to-any-desktop) (v0.3)
- [x] Borderless tiling — optional no-decoration mode (pairs with KWin's Dim Inactive effect)
- [x] Quadrant layout — 2×2 grid with diagonal focus-relative resizing; overflow windows float and cascade
- [ ] Multi-monitor awareness (independent layout per screen)
- [ ] Plasma widget for layout indicator in taskbar

---

## Contributing

Built by PSEUDOSTAGE for KDE Plasma 6 power users. PRs welcome.
Tested against KDE Plasma 6.4+ on Wayland.

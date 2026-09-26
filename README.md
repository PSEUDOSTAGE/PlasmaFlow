<p align="center">
  <img src="imgs/plasmaflow-text-banner.svg" alt="PlasmaFlow" width="640">
</p>

<p align="center">
  A keyboard-driven, Wayland-first dynamic tiling script for KDE Plasma 6.4+.
</p>

---

PlasmaFlow is a KWin script, not a separate window manager. It runs inside KWin, installs with no compilation, and is configured from System Settings. It picks up where Bismuth (archived) left off, with a codebase written for the Plasma 6 scripting API from the start.

## Features

- **Six layouts:** spiral (the default), master-stack, columns, monocle, spotlight and quadrant. Each virtual desktop has its own layout.
- **Focus-relative resizing:** Meta+H/L grow or shrink the *focused* window, not just the master.
- **Mirroring:** Meta+M flips the current desktop's layout left↔right.
- **Scratchpad:** a hidden layer of floating windows you can summon onto any desktop.
- **Smart floating:** dialogs, modal prompts, splash screens and fixed-size windows float automatically. You can also list apps that should always float.
- **Per-desktop pinning:** give desktop 2 columns and desktop 3 spotlight, for example.
- **Session persistence:** each desktop's layout and sizes are remembered across logout.
- **Borderless tiling (optional):** strips title bars from tiled windows.
- **Native settings panel** under System Settings → KWin Scripts, with no config files to edit.

## Requirements

- **KDE Plasma 6.4 or newer, on Wayland.** Earlier 6.x releases expose different scripting APIs and may fail to load the script. X11 may work but isn't supported.
- **A running `plasmashell`.** On-screen feedback and session persistence go through plasmashell's D-Bus interfaces. Without it, both quietly do nothing and tiling works as normal.

## Install

### From the KDE Store (recommended)

1. Open **System Settings → Window Management → KWin Scripts**.
2. Click **Get New…**, search for **PlasmaFlow** and install it.
3. Tick **PlasmaFlow** in the list and click **Apply**.

Updates arrive the same way, through **Get New…**.

### From source

```bash
git clone https://github.com/PSEUDOSTAGE/PlasmaFlow.git
cd PlasmaFlow
make install
make reload
```

Then enable it in **System Settings → Window Management → KWin Scripts → PlasmaFlow**.

To update, `git pull` and run the same two `make` commands. To remove it, run `make uninstall`.

## Shortcuts

| Shortcut | Action |
|---|---|
| Meta + T | Cycle layout (enabled layouts only) |
| Meta + Shift + T | Cycle through every layout |
| Meta + M | Mirror the layout horizontally |
| Meta + J / K | Focus previous / next window |
| Meta + Ctrl + J / K | Move focused window up / down in tile order |
| Meta + G | Swap focused window with master |
| Meta + H / L | Shrink / grow the focused window |
| Meta + F | Toggle float |
| Meta + Left / Right | Send window to previous / next desktop |
| Meta + Ctrl + Space | Park focused window in the scratchpad |
| Meta + Space | Summon / dismiss the scratchpad |

To rebind any of these, go to **System Settings → Keyboard → Shortcuts → KWin**.

### Conflicts with KDE defaults

Some of these keys are already taken by KDE out of the box. Clear the KDE binding in **System Settings → Keyboard → Shortcuts** (search for the action name, clear its chip, then Apply):

| Key | KDE default action | Notes |
|---|---|---|
| Meta + T | Toggle Tiles Editor | |
| Meta + L | Lock Screen | Bind locking to another key first if you still want it |
| Meta + Left / Right | Quick Tile Window to the Left / Right | Most tiling users have already disabled this |
| Meta + Space | *(none by default)* | Only an issue if you've bound it yourself, e.g. to KRunner or layout switching |

<details>
<summary>Why these keys?</summary>

Under Wayland, KWin scripts can't receive shortcuts on shifted symbol keys. That rules out Meta+Shift+1–9 and Meta+Shift+\`. Plain Meta+1–9 already belongs to the task manager. So desktop moves use the arrow keys, and the scratchpad uses Space.
</details>

## Layouts

**spiral** *(default)* is a Fibonacci spiral. The screen is split repeatedly, turning clockwise, and the last window fills the centre. Meta+H/L move the focused window's own split.

**master-stack** puts one master on the left and a stack on the right. With the master focused, Meta+H/L set its width. With a stack window focused, they set that window's height.

**columns** gives every window an equal-width column. Meta+H/L widen or narrow the focused column.

**monocle** shows one window at a time, and Meta+J/K cycle through them. Meta+H shrinks the shared slot toward the centre of the screen, leaving a margin of wallpaper around it. Meta+L grows it back to full screen.

**spotlight** gives the master the full screen, with the other windows in the corners (bottom-right, top-right, top-left, bottom-left). Past four, extra windows go into a smaller second layer. Meta+H/L resize the corners.

**quadrant** is a 2×2 grid, filled top-left, top-right, bottom-right, bottom-left. Meta+H/L grow the focused window diagonally from its corner. If another window is currently the largest, the grid first evens out, then the focused window grows. A 5th window and beyond float in a cascade in the centre.

To drop layouts you don't use from Meta+T, untick them in the settings. Meta+Shift+T still reaches every layout. A pinned or remembered layout still works even if it's unticked.

## Scratchpad

A hidden stash for windows you want out of the way but only a keystroke away.

- **Park:** Meta+Ctrl+Space removes the focused window from the layout and hides it.
- **Summon / dismiss:** Meta+Space brings every parked window to the current desktop, floating. Press it again to hide them. Each window keeps whatever size and position you give it.
- **Return to tiling:** focus a summoned window and press Meta+F.

**Tip:** the scratchpad is also the quickest way to move a window to a desktop that isn't next to the current one. Park it, switch desktops, summon it, then press Meta+F.

## Configuration

Settings live in **System Settings → Window Management → KWin Scripts → PlasmaFlow → Configure**. Changes take effect after the script reloads: disable and re-enable it there, or run `make reload`.

| Setting | Default | |
|---|---|---|
| Inner / outer gap | 8 px / 8 px | |
| Default layout | spiral | |
| Layouts in the Meta+T cycle | all | |
| Default master width | 0.5 | Also the first split in spiral |
| Resize step | 0.05 | Per Meta+H/L press |
| Spotlight corner size | 0.38 | Fraction of the screen |
| Always-float window classes | steam, plasmashell, krunner, yakuake, spectacle, kruler, plasma-desktop | Matches class or title |
| Per-desktop pinned layouts | *(none)* | e.g. `1=master-stack,2=columns,3=spotlight` |
| Float new windows by default | off | |
| Remember layout per desktop | on | |
| Remove window borders when tiled | off | See below |

Pinned layouts apply when a desktop is first opened. Meta+T overrides the pin, and the override is remembered.

**Borderless tiling** hides title bars and borders on tiled windows. They come back as soon as a window floats or goes into the scratchpad. Apps that draw their own title bars (some GTK apps) aren't affected. Without title bars it can be hard to spot the active window, so pair this with KWin's **Dim Inactive** effect (System Settings → Desktop Effects).

## Roadmap

- [ ] Multi-monitor support: an independent, tested layout per screen
- [ ] A panel widget that shows and cycles the current layout
- [ ] Per-app rules, e.g. always open as master
- [ ] KDE Store release

## Contributing

Issues and PRs are welcome. Everything lives in `contents/code/main.js`. Test changes with `make install && make reload`. If the script fails to load, `journalctl --user -b | grep plasma-flow` shows the error.

## License

[GPL-3.0](LICENSE)

## Credits

Built by PSEUDOSTAGE, with [Claude](https://claude.ai) (Anthropic) as a development collaborator throughout.

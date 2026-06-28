/**
 * CachyTile - main.js  (v0.2)
 * Entry point. Wires KWin workspace signals to the tiling engine.
 *
 * KWin scripting runs in a JS engine inside KWin itself.
 * `workspace` and `options` are globally available.
 */

"use strict";

// ─── Config ────────────────────────────────────────────────────────────────

// Known layout names, in the same order as the config combo box / Enum choices.
const LAYOUT_NAMES = ["master-stack", "columns", "monocle", "spotlight"];

// Tolerate a defaultLayout that comes back as a numeric index (e.g. "0" from an
// older combo-box binding) by mapping it to the layout name; pass names through.
function normalizeLayoutName(value) {
    if (LAYOUT_NAMES.indexOf(value) !== -1) return value;
    const i = parseInt(value, 10);
    if (!isNaN(i) && i >= 0 && i < LAYOUT_NAMES.length) return LAYOUT_NAMES[i];
    return "master-stack";
}

// Model B: parse "1=master-stack,2=columns" into { "1": "master-stack", ... }.
function parseDesktopLayouts(raw) {
    const map = {};
    if (raw) raw.split(",").forEach(entry => {
        const [idx, layout] = entry.trim().split("=");
        if (idx && layout) map[idx.trim()] = layout.trim();
    });
    return map;
}

// Read all config values from KConfig. Called at load and again whenever KWin
// is reconfigured (so changes from the settings dialog apply without a reload).
function loadConfig() {
    return {
        gap:                  readConfig("gap", 8),
        outerGap:             readConfig("outerGap", 8),
        defaultLayout:        normalizeLayoutName(readConfig("defaultLayout", "master-stack")),
        defaultMasterRatio:   readConfig("defaultMasterRatio", 0.5),
        masterRatioStep:      readConfig("masterRatioStep", 0.05),
        spotlightCornerRatio: readConfig("spotlightCornerRatio", 0.28),
        floatOnStart:         readConfig("floatOnStart", false),
        // NOTE: animationsEnabled is not implemented yet. KWin animates
        // frameGeometry changes itself and a script can't easily suppress that,
        // so this value is read but unused — a settings-panel placeholder.
        animationsEnabled:    readConfig("animationsEnabled", true),
        persistSession:       readConfig("persistSession", true),
        floatClasses:         readConfig("floatClasses",
            "steam,plasmashell,krunner,yakuake,spectacle,kruler,plasma-desktop"
        ).split(",").map(s => s.trim().toLowerCase()),
        // Meta+T overrides the pinned layout for the session only.
        desktopLayouts:       parseDesktopLayouts(readConfig("desktopLayouts", "")),
    };
}

// Read once at load. KWin gives workspace scripts no config-change signal and
// caches their config until the script is reloaded, so settings changes only
// take effect after a reload (KCM disable/enable, or `make reload`).
// See CLAUDE.md "Config system".
const CONFIG = loadConfig();

// ─── Layout engine import (KWin scripts use plain JS, no ES modules) ────────
// Layouts are defined inline below. In a real package these would be
// separate files loaded via Qt.include().

// ─── State ─────────────────────────────────────────────────────────────────

/**
 * layoutState: maps "screenIndex:desktopId" → { layout, windows[] }
 * Windows are stored in tiling order (index 0 = master).
 */
const layoutState = {};

// ─── Session persistence ────────────────────────────────────────────────────

/**
 * Persist layout + masterRatio for a desktop key.
 * Uses a flat key like "persist:0:desktop-uuid" → "master-stack|0.6".
 *
 * NOTE: KWin.writeConfig/readConfig are NOT available in this KWin build — the
 * scripting API only exposes a *read* path (the global readConfig() used for
 * CONFIG). Until we wire a real write-back mechanism, persistence degrades to a
 * no-op rather than crashing the engine. See restoreState() for the read guard.
 * TODO(v0.3): implement persistence via a supported API (callDBus / a helper).
 */
function persistState(key, state) {
    if (!CONFIG.persistSession) return;
    if (typeof KWin.writeConfig !== "function") return;
    const value = `${state.layout}|${state.masterRatio}`;
    KWin.writeConfig("persist:" + key, value);
}

/**
 * Restore a previously saved layout+ratio for a desktop key, if it exists.
 * Returns { layout, masterRatio } or null. No-ops if the write API is absent
 * (nothing could have been saved) — see persistState().
 */
function restoreState(key) {
    if (!CONFIG.persistSession) return null;
    if (typeof KWin.readConfig !== "function") return null;
    const raw = KWin.readConfig("persist:" + key, "");
    if (!raw) return null;
    const parts = raw.split("|");
    if (parts.length !== 2) return null;
    const layout = parts[0];
    const ratio  = parseFloat(parts[1]);
    // Unknown layout names are tolerated here; tile() falls back to master-stack.
    if (isNaN(ratio)) return null;
    return { layout, masterRatio: ratio };
}

/**
 * Resolve the pinned layout for a desktop index (Model B).
 * Returns the configured layout name, or null if not pinned.
 * desktopIndex is 1-based to match KWin desktop numbering.
 */
function pinnedLayout(desktopIndex) {
    return CONFIG.desktopLayouts[String(desktopIndex)] || null;
}

function stateKey(screenIndex, desktopId) {
    return `${screenIndex}:${desktopId}`;
}

function getState(window) {
    const screen   = window.screen;
    const desktops = window.desktops;
    if (!desktops || desktops.length === 0) return null;
    const key = stateKey(screen, desktops[0].id);
    if (!layoutState[key]) {
        const saved  = restoreState(key);
        const pinned = pinnedLayout(desktops[0].number);

        // Priority: pinned (Model B) > saved session > global default
        // If pinned exists, it always wins layout (but saved ratio still applies).
        const layout = pinned || (saved && saved.layout) || CONFIG.defaultLayout;
        const masterRatio = (saved && saved.masterRatio) || CONFIG.defaultMasterRatio;

        layoutState[key] = {
            layout,
            masterRatio,
            pinnedLayout: pinned || null,   // track so cycleLayout can mark it overridden
            windows:      [],
        };
    }
    return layoutState[key];
}

// ─── Float detection ────────────────────────────────────────────────────────

function shouldFloat(window) {
    if (window.dialog || window.utility || window.splash) return true;
    if (window.fullScreen)                                 return true;
    if (!window.resizeable)                                return true;

    const cls = (window.resourceClass || "").toLowerCase();
    const name = (window.caption || "").toLowerCase();

    return CONFIG.floatClasses.some(fc => cls.includes(fc) || name.includes(fc));
}

// ─── Layouts ────────────────────────────────────────────────────────────────

/**
 * Each layout is a function(windows, area, config) → void
 * It sets window.frameGeometry directly.
 *
 * `area`    = { x, y, width, height }  (usable screen area minus panels)
 * `windows` = ordered array of KWin Window objects
 */

// KWin's script engine does not expose the `Qt` global, so rect() is
// unavailable. frameGeometry accepts a plain {x, y, width, height} object —
// build all geometry through this helper so there's a single place to adjust.
function rect(x, y, width, height) {
    return { x: x, y: y, width: width, height: height };
}

const layouts = {

    /**
     * master-stack: left master, right stack column.
     * With 1 window: fills screen. With 2+: split by cfg.masterRatio (default 0.5).
     */
    "master-stack": function(windows, area, cfg) {
        if (windows.length === 0) return;

        const g     = cfg.gap;
        const og    = cfg.outerGap;
        const ratio = cfg.masterRatio;

        if (windows.length === 1) {
            windows[0].frameGeometry = rect(
                area.x + og,
                area.y + og,
                area.width  - og * 2,
                area.height - og * 2
            );
            return;
        }

        const usableWidth = area.width - og * 2 - g;
        const masterWidth = Math.floor(usableWidth * ratio);
        const stackWidth  = usableWidth - masterWidth;
        const stackCount  = windows.length - 1;
        const stackH      = Math.floor((area.height - og * 2 - g * (stackCount - 1)) / stackCount);

        // Master
        windows[0].frameGeometry = rect(
            area.x + og,
            area.y + og,
            masterWidth,
            area.height - og * 2
        );

        // Stack
        for (let i = 1; i < windows.length; i++) {
            const y = area.y + og + (i - 1) * (stackH + g);
            windows[i].frameGeometry = rect(
                area.x + og + masterWidth + g,
                y,
                stackWidth,
                stackH
            );
        }
    },

    /**
     * columns: equal-width vertical columns.
     */
    "columns": function(windows, area, cfg) {
        if (windows.length === 0) return;

        const g   = cfg.gap;
        const og  = cfg.outerGap;
        const n   = windows.length;
        const colW = Math.floor((area.width - og * 2 - g * (n - 1)) / n);

        for (let i = 0; i < n; i++) {
            windows[i].frameGeometry = rect(
                area.x + og + i * (colW + g),
                area.y + og,
                colW,
                area.height - og * 2
            );
        }
    },

    /**
     * monocle: all windows stacked fullscreen, focus switches between them.
     */
    "monocle": function(windows, area, cfg) {
        const og = cfg.outerGap;
        for (const win of windows) {
            win.frameGeometry = rect(
                area.x + og,
                area.y + og,
                area.width  - og * 2,
                area.height - og * 2
            );
        }
    },

    /**
     * spotlight: master fills the full screen, stack windows occupy corners.
     * Corner order (clockwise from bottom-right): BR, TR, TL, BL.
     * If more than 4 stack windows, a second layer of smaller corners sits
     * behind the first layer (scaled down by 0.7), and so on for further layers.
     */
    "spotlight": function(windows, area, cfg) {
        if (windows.length === 0) return;

        const og   = cfg.outerGap;
        const g    = cfg.gap;
        const cr   = cfg.spotlightCornerRatio;  // corner size as fraction of screen

        // Master always fills the entire usable area
        windows[0].frameGeometry = rect(
            area.x + og,
            area.y + og,
            area.width  - og * 2,
            area.height - og * 2
        );

        if (windows.length === 1) return;

        const stack = windows.slice(1);

        // Corner anchor positions (clockwise from BR): index 0-3
        // Each is { xFn, yFn } where xFn/yFn take (cw, ch) and return top-left x,y
        const corners = [
            // BR
            (cw, ch) => ({ x: area.x + area.width  - og - cw,
                           y: area.y + area.height - og - ch }),
            // TR
            (cw, ch) => ({ x: area.x + area.width  - og - cw,
                           y: area.y + og }),
            // TL
            (cw, ch) => ({ x: area.x + og,
                           y: area.y + og }),
            // BL
            (cw, ch) => ({ x: area.x + og,
                           y: area.y + area.height - og - ch }),
        ];

        const LAYER_SCALE = 0.7;   // each overflow layer shrinks by this factor
        const MAX_LAYERS  = 4;     // hard cap to avoid invisible windows

        for (let i = 0; i < stack.length; i++) {
            const slot   = i % 4;
            const layer  = Math.floor(i / 4);
            if (layer >= MAX_LAYERS) break;

            const scale  = Math.pow(LAYER_SCALE, layer);
            const cw     = Math.floor((area.width  - og * 2) * cr * scale);
            const ch     = Math.floor((area.height - og * 2) * cr * scale);

            // Offset each successive layer inward by gap so edges don't perfectly align
            const inset  = layer * g;
            const pos    = corners[slot](cw, ch);

            // Clamp into the usable area — paranoia for tiny screens
            const x = Math.max(area.x + og, Math.min(pos.x + inset, area.x + area.width  - og - cw));
            const y = Math.max(area.y + og, Math.min(pos.y + inset, area.y + area.height - og - ch));

            stack[i].frameGeometry = rect(x, y, cw, ch);
        }
    },

};

// ─── Tile trigger ───────────────────────────────────────────────────────────

function tile(window) {
    const state = getState(window);
    if (!state) return;

    // clientArea(option, window) is the most version-stable overload in Plasma 6:
    // it resolves the correct screen + desktop from the window itself.
    const area = workspace.clientArea(KWin.PlacementArea, window);

    // Minimized windows keep their slot in the tile order (so un-minimizing
    // restores their place) but must not occupy layout space — the remaining
    // windows reflow to fill it. Filtering also promotes the next window to
    // master when the master is minimized.
    const visible = state.windows.filter((w) => !w.minimized);

    // Merge per-state masterRatio into the config passed to the layout
    const layoutCfg = Object.assign({}, CONFIG, { masterRatio: state.masterRatio });
    const layoutFn  = layouts[state.layout] || layouts["master-stack"];
    layoutFn(visible, area, layoutCfg);
}

function retileScreen(screenIndex, desktop) {
    const key   = stateKey(screenIndex, desktop.id);
    const state = layoutState[key];
    if (!state || state.windows.length === 0) return;

    // Use first window as a proxy to get the area
    const proxy = state.windows[0];
    tile(proxy);
}

// ─── Window lifecycle ────────────────────────────────────────────────────────

function addWindow(window) {
    if (shouldFloat(window)) return;

    const state = getState(window);
    if (!state) return;

    if (!state.windows.includes(window)) {
        state.windows.push(window);
    }

    tile(window);
}

function removeWindow(window) {
    for (const key of Object.keys(layoutState)) {
        const state = layoutState[key];
        const idx   = state.windows.indexOf(window);
        if (idx !== -1) {
            state.windows.splice(idx, 1);
            // Retile remaining windows on this screen/desktop
            if (state.windows.length > 0) {
                tile(state.windows[0]);
            }
            break;
        }
    }
}

// ─── Keyboard shortcuts ─────────────────────────────────────────────────────

function cycleLayout(window) {
    const state = getState(window);
    if (!state) return;

    const keys = Object.keys(layouts);
    const idx  = keys.indexOf(state.layout);
    state.layout = keys[(idx + 1) % keys.length];

    tile(window);
    persistState(
        stateKey(window.screen, window.desktops[0].id),
        state
    );
    // Mark as session-overridden if it differs from pinned layout
    const overridden = state.pinnedLayout && state.layout !== state.pinnedLayout
        ? ` (pinned: ${state.pinnedLayout})` : "";
    osd.show(`CachyTile: ${state.layout}${overridden}`);
}

function swapWithMaster(window) {
    const state = getState(window);
    if (!state || state.windows.length < 2) return;

    const idx = state.windows.indexOf(window);
    if (idx <= 0) return;

    // Swap with master (index 0)
    [state.windows[0], state.windows[idx]] = [state.windows[idx], state.windows[0]];
    tile(window);
}

// Move focus to the next/previous window in tile order, walking past minimized
// windows so focus only ever lands on a currently visible one. `dir` is +1
// (next) or -1 (prev). No-op if there's no other visible window to move to —
// notably, we never activate a minimized window (which would un-minimize it).
function focusInDirection(window, dir) {
    const state = getState(window);
    if (!state) return;

    const n = state.windows.length;
    const start = state.windows.indexOf(window);
    if (start === -1) return;

    for (let step = 1; step < n; step++) {
        const i = ((start + dir * step) % n + n) % n;
        const candidate = state.windows[i];
        if (!candidate.minimized) {
            workspace.activeWindow = candidate;
            return;
        }
    }
}

function focusNext(window) { focusInDirection(window, 1); }
function focusPrev(window) { focusInDirection(window, -1); }

// Move the focused window one slot along the tile order, swapping it with its
// nearest visible (non-minimized) neighbour in that direction, then retile.
// `dir` is +1 (toward the end / "down") or -1 (toward the start / "up").
// Does not wrap: moving past either end is a no-op. The window keeps focus.
function moveInDirection(window, dir) {
    const state = getState(window);
    if (!state || state.windows.length < 2) return;

    const from = state.windows.indexOf(window);
    if (from === -1) return;

    for (let i = from + dir; i >= 0 && i < state.windows.length; i += dir) {
        if (!state.windows[i].minimized) {
            [state.windows[from], state.windows[i]] = [state.windows[i], state.windows[from]];
            tile(window);
            return;
        }
    }
}

function moveNext(window) { moveInDirection(window, 1); }
function movePrev(window) { moveInDirection(window, -1); }

function toggleFloat(window) {
    const state = getState(window);
    if (!state) return;

    const idx = state.windows.indexOf(window);
    if (idx !== -1) {
        // Currently tiled → remove and restore original geometry
        state.windows.splice(idx, 1);
        if (state.windows.length > 0) tile(state.windows[0]);
    } else {
        // Currently floating → add to tile list
        addWindow(window);
    }
}

function adjustMasterRatio(window, delta) {
    const state = getState(window);
    if (!state) return;

    // Only meaningful for master-stack; silently no-op for other layouts
    if (state.layout !== "master-stack") return;
    if (state.windows.length < 2)        return;

    const MIN = 0.1;
    const MAX = 0.9;
    state.masterRatio = Math.min(MAX, Math.max(MIN,
        Math.round((state.masterRatio + delta) * 100) / 100
    ));

    tile(window);

    persistState(
        stateKey(window.screen, window.desktops[0].id),
        state
    );

    // OSD: show a small ASCII bar + percentage for quick visual feedback
    const pct     = Math.round(state.masterRatio * 100);
    const filled  = Math.round(state.masterRatio * 10);
    const bar     = "█".repeat(filled) + "░".repeat(10 - filled);
    osd.show(`CachyTile  ${bar}  ${pct}%`);
}

// ─── Register shortcuts ─────────────────────────────────────────────────────

registerShortcut(
    "CachyTile: Cycle Layout",
    "CachyTile: Cycle Layout",
    "Meta+T",
    () => { if (workspace.activeWindow) cycleLayout(workspace.activeWindow); }
);

registerShortcut(
    "CachyTile: Swap with Master",
    "CachyTile: Swap with Master",
    "Meta+Return",
    () => { if (workspace.activeWindow) swapWithMaster(workspace.activeWindow); }
);

registerShortcut(
    "CachyTile: Focus Next",
    "CachyTile: Focus Next",
    "Meta+J",
    () => { if (workspace.activeWindow) focusNext(workspace.activeWindow); }
);

registerShortcut(
    "CachyTile: Focus Prev",
    "CachyTile: Focus Prev",
    "Meta+K",
    () => { if (workspace.activeWindow) focusPrev(workspace.activeWindow); }
);

registerShortcut(
    "CachyTile: Move Window Down",
    "CachyTile: Move Window Down",
    "Meta+Shift+J",
    () => { if (workspace.activeWindow) moveNext(workspace.activeWindow); }
);

registerShortcut(
    "CachyTile: Move Window Up",
    "CachyTile: Move Window Up",
    "Meta+Shift+K",
    () => { if (workspace.activeWindow) movePrev(workspace.activeWindow); }
);

registerShortcut(
    "CachyTile: Toggle Float",
    "CachyTile: Toggle Float",
    "Meta+F",
    () => { if (workspace.activeWindow) toggleFloat(workspace.activeWindow); }
);

registerShortcut(
    "CachyTile: Increase Master Width",
    "CachyTile: Increase Master Width",
    "Meta+L",
    () => {
        if (workspace.activeWindow)
            adjustMasterRatio(workspace.activeWindow, CONFIG.masterRatioStep);
    }
);

registerShortcut(
    "CachyTile: Decrease Master Width",
    "CachyTile: Decrease Master Width",
    "Meta+H",
    () => {
        if (workspace.activeWindow)
            adjustMasterRatio(workspace.activeWindow, -CONFIG.masterRatioStep);
    }
);

// ─── Wire up workspace signals ───────────────────────────────────────────────

// Retile every screen/desktop we know about (monitor hotplug, resolution change).
function retileAll() {
    for (const key of Object.keys(layoutState)) {
        const state = layoutState[key];
        if (state.windows.length > 0) tile(state.windows[0]);
    }
}

// When a window moves to a different desktop, retile both the old and new desktop.
function onDesktopMove(window) {
    removeWindow(window);
    addWindow(window);
}

// New windows tile automatically, unless floatOnStart is set — in which case
// they start floating and can be pulled into the layout on demand with Meta+F.
// Also wires the per-window desktop-move signal (in Plasma 6 `desktopsChanged`
// lives on the Window, not on workspace).
function onWindowAdded(window) {
    if (window.desktopsChanged) {
        window.desktopsChanged.connect(() => onDesktopMove(window));
    }
    // Minimize/restore must reflow the rest of the stack (tile() skips
    // minimized windows). Signal lives on the Window in Plasma 6.
    if (window.minimizedChanged) {
        window.minimizedChanged.connect(() => tile(window));
    }
    if (CONFIG.floatOnStart) return;
    addWindow(window);
}

workspace.windowAdded.connect(onWindowAdded);
workspace.windowRemoved.connect(removeWindow);

// Screen geometry changes. The exact signal name has varied across KWin
// versions, so guard it — a missing signal must not abort script load.
if (workspace.screensChanged) workspace.screensChanged.connect(retileAll);

// NOTE: there is intentionally no live config-reload hook. KWin exposes no
// config-change signal to workspace scripts (only effects get one) and caches
// the config until reload, so settings changes are picked up on the next script
// load, not on Apply. Reload via the KCM toggle or `make reload`.

// ─── Init: tile all existing windows ────────────────────────────────────────

// `workspace.windows` was added in later KWin 6.x; `stackingOrder` is the
// long-standing way to enumerate every window. Fall back across versions.
const existingWindows = workspace.windows || workspace.stackingOrder || [];
for (const window of existingWindows) {
    onWindowAdded(window);
}

print("[CachyTile] Loaded. Default layout: " + CONFIG.defaultLayout);

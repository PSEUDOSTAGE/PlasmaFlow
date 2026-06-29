/**
 * PlasmaFlow - main.js  (v0.2)
 * Entry point. Wires KWin workspace signals to the tiling engine.
 *
 * KWin scripting runs in a JS engine inside KWin itself.
 * `workspace` and `options` are globally available.
 */

"use strict";

// ─── Config ────────────────────────────────────────────────────────────────

// Known layout names, in the same order as the config combo box / Enum choices.
const LAYOUT_NAMES = ["master-stack", "columns", "monocle", "spotlight", "spiral"];

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
        defaultLayout:        normalizeLayoutName(readConfig("defaultLayout", "spiral")),
        defaultMasterRatio:   readConfig("defaultMasterRatio", 0.5),
        masterRatioStep:      readConfig("masterRatioStep", 0.05),
        spotlightCornerRatio: readConfig("spotlightCornerRatio", 0.38),
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

// Windows parked in the scratchpad. They live outside the tile layout entirely
// (never tiled) and are summoned/dismissed together with Meta+Grave.
const scratchWindows = [];

// ─── Session persistence ────────────────────────────────────────────────────
//
// We persist each desktop's layout + masterRatio so they survive logout.
//
// The write path is the awkward part. This KWin build exposes NO config-write
// API to scripts: KWin.writeConfig, a global writeConfig, and options.writeConfig
// are all absent (only the read-only global readConfig() exists, used for CONFIG).
// callDBus *is* available, but it cannot marshal D-Bus struct types — so systemd's
// StartTransientUnit (a(sv)/a(sa(sv))) fails and we can't shell out to
// kwriteconfig6 that way either. (All verified live on this build; see CLAUDE.md.)
//
// The one path that works: callDBus into the always-running plasmashell, whose
// scripting engine *does* expose a `ConfigFile` object that writes KConfig. We
// write into kwinrc's [Script-plasma-flow] group — the same group our own
// readConfig() reads — so restore is just a synchronous readConfig() at load,
// with no async round-trip. plasmashell flushes the write to disk immediately,
// and KWin re-reads kwinrc on the next script load (KConfig notices the mtime
// change), so the value is there next session.
//
// Storage: key "persist:<screen>:<desktopUuid>" → "<layout>|<masterRatio>|<cornerRatio>".
// (Legacy entries without the trailing cornerRatio field are still accepted.)

// Last value persisted per key, so repeated identical writes (e.g. cycling back
// to the same layout, or re-clamping the ratio) don't spam plasmashell. There's
// no setTimeout in this engine, so this dedupe is our only write throttle.
const persistedCache = {};

// Run a snippet inside plasmashell's scripting engine. Fire-and-forget: we don't
// need the result and persistence is best-effort (a no-op if plasmashell is down).
function plasmaEval(script) {
    if (typeof callDBus !== "function") return;
    callDBus("org.kde.plasmashell", "/PlasmaShell",
             "org.kde.PlasmaShell", "evaluateScript", script);
}

// ─── On-screen display ───────────────────────────────────────────────────────
//
// KWin scripts have NO `osd` global — the early assumption that a global `osd`
// with a .show() method exists was wrong (same class of bug as the other
// non-existent APIs in CLAUDE.md):
// every call threw "osd is not defined" and no OSD ever appeared. The real OSD is
// plasmashell's osdService over DBus: org.kde.osdService.showText(icon, text)
// (signature "ss"). Fire-and-forget / best-effort, exactly like plasmaEval — a
// no-op if plasmashell is down, since the OSD is purely informational.
//
// The icon arg can be either an icon-*theme name* or an absolute *file path*.
// We default to the theme name "plasma-flow" (portable; the Makefile installs
// the PNG into hicolor). BUT on this build plasmashell's OSD does NOT reliably
// resolve a freshly-installed hicolor name by theme name in a running session —
// stock names work, ours showed a fallback — whereas it loads an absolute path
// fine. So `make install` rewrites OSD_ICON (the @OSD_ICON@-tagged line below)
// to the absolute path of the installed PNG. Source stays distributable; the
// installed copy points at the real file. See CLAUDE.md "OSD icon".
const OSD_ICON = "plasma-flow"; /* @OSD_ICON@ */
function showOsd(text) {
    if (typeof callDBus !== "function") return;
    callDBus("org.kde.plasmashell", "/org/kde/osdService",
             "org.kde.osdService", "showText", OSD_ICON, text);
}

/**
 * Persist layout + masterRatio for a desktop key.
 * key looks like "0:desktop-uuid"; stored as "persist:0:desktop-uuid".
 */
function persistState(key, state) {
    if (!CONFIG.persistSession) return;
    const value = `${state.layout}|${state.masterRatio}|${state.cornerRatio}`;
    if (persistedCache[key] === value) return;
    persistedCache[key] = value;
    // key and value are fully script-controlled (screen int, desktop UUID, a
    // known layout name, a rounded number) — no quotes/backslashes/newlines can
    // appear, so embedding them directly in the snippet is safe.
    plasmaEval(
        'var c = new ConfigFile("kwinrc", "Script-plasma-flow");' +
        'c.writeEntry("persist:' + key + '", "' + value + '");'
    );
}

/**
 * Restore a previously saved layout+ratios for a desktop key, if any.
 * Reads straight from kwinrc via the global readConfig() (same group persistState
 * writes to). Returns { layout, masterRatio, cornerRatio? } or null.
 * Accepts both the legacy 2-field format ("layout|masterRatio") and the current
 * 3-field one ("layout|masterRatio|cornerRatio"); a missing cornerRatio falls
 * back to the config default at the call site.
 */
function restoreState(key) {
    if (!CONFIG.persistSession) return null;
    const raw = readConfig("persist:" + key, "");
    if (!raw) return null;
    const parts = String(raw).split("|");
    if (parts.length < 2) return null;
    const ratio = parseFloat(parts[1]);
    if (isNaN(ratio)) return null;
    // A saved layout that's since been removed maps back to master-stack.
    const result = { layout: normalizeLayoutName(parts[0]), masterRatio: ratio };
    if (parts.length >= 3) {
        const cr = parseFloat(parts[2]);
        if (!isNaN(cr)) result.cornerRatio = cr;
    }
    return result;
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
        // VirtualDesktop exposes the 1-based number as `x11DesktopNumber`
        // (there is no `.number` property — verified on KWin 6 / Wayland).
        const pinned = pinnedLayout(desktops[0].x11DesktopNumber);

        // Priority: pinned (Model B) > saved session > global default
        // If pinned exists, it always wins layout (but saved ratio still applies).
        const layout = pinned || (saved && saved.layout) || CONFIG.defaultLayout;
        const masterRatio = (saved && saved.masterRatio) || CONFIG.defaultMasterRatio;
        const cornerRatio = (saved && saved.cornerRatio) || CONFIG.spotlightCornerRatio;

        layoutState[key] = {
            layout,
            masterRatio,
            cornerRatio,                    // spotlight corner size, adjustable via Meta+H/L
            pinnedLayout: pinned || null,   // track so cycleLayout can mark it overridden
            windows:      [],
        };
    }
    return layoutState[key];
}

// ─── Float detection ────────────────────────────────────────────────────────

function shouldFloat(window) {
    if (scratchWindows.indexOf(window) !== -1)             return true;
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

    /**
     * spiral (Fibonacci): recursively split the usable area, alternating
     * vertical and horizontal cuts and spiralling clockwise inward — left, top,
     * right, bottom, left, … The first cut (the master split) uses `masterRatio`
     * so Meta+H/L grows/shrinks the master area; every subsequent cut is an even
     * 50/50 so the remaining windows stay balanced and the final window fills
     * what's left. (Using masterRatio for *every* cut made the innermost window
     * balloon as the ratio shrank — unintuitive, so we don't.)
     */
    "spiral": function(windows, area, cfg) {
        if (windows.length === 0) return;

        const g  = cfg.gap;
        const og = cfg.outerGap;

        let x = area.x + og;
        let y = area.y + og;
        let w = area.width  - og * 2;
        let h = area.height - og * 2;

        for (let i = 0; i < windows.length; i++) {
            if (i === windows.length - 1) {       // last window fills the rest
                windows[i].frameGeometry = rect(x, y, w, h);
                break;
            }

            // Only the master split follows masterRatio; the rest split evenly.
            const ratio = (i === 0) ? cfg.masterRatio : 0.5;
            const dir = i % 4;
            if (dir === 0) {                      // cut vertical, window left
                const cut = Math.max(0, Math.floor((w - g) * ratio));
                windows[i].frameGeometry = rect(x, y, cut, h);
                x += cut + g; w -= cut + g;
            } else if (dir === 1) {               // cut horizontal, window top
                const cut = Math.max(0, Math.floor((h - g) * ratio));
                windows[i].frameGeometry = rect(x, y, w, cut);
                y += cut + g; h -= cut + g;
            } else if (dir === 2) {               // cut vertical, window right
                const cut = Math.max(0, Math.floor((w - g) * ratio));
                windows[i].frameGeometry = rect(x + (w - cut), y, cut, h);
                w -= cut + g;
            } else {                              // cut horizontal, window bottom
                const cut = Math.max(0, Math.floor((h - g) * ratio));
                windows[i].frameGeometry = rect(x, y + (h - cut), w, cut);
                h -= cut + g;
            }
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

    // Merge per-state ratios into the config passed to the layout: masterRatio
    // (master-stack/spiral split) and spotlightCornerRatio (spotlight corner
    // size). Both are per-desktop and adjustable via Meta+H/L.
    const layoutCfg = Object.assign({}, CONFIG, {
        masterRatio:          state.masterRatio,
        spotlightCornerRatio: state.cornerRatio,
    });
    const layoutFn  = layouts[state.layout] || layouts["master-stack"];
    layoutFn(visible, area, layoutCfg);

    applyStacking(state, visible);
}

// Spotlight draws the master full-screen behind the corner windows, so the
// master must stay *below* them — otherwise focusing it (KWin auto-raises the
// active window) brings it to the front and hides every corner. This build
// exposes no raise/lower API, so keepBelow is the only reliable stacking lever:
// pin the master below and clear it on everyone else. Every other layout clears
// keepBelow on all tiled windows, so a window never stays stuck below after the
// layout changes. (Set against the *visible* master — the slot the layout
// actually drew as master, which is the next window up when the real master is
// minimized.) A window leaving the tile list has its keepBelow cleared at the
// removal site, since it's no longer in any state.windows for us to reset here.
function applyStacking(state, visible) {
    const master = (state.layout === "spotlight" && visible.length > 1)
        ? visible[0] : null;
    for (let i = 0; i < state.windows.length; i++) {
        state.windows[i].keepBelow = (state.windows[i] === master);
    }
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
            window.keepBelow = false;   // never leave a spotlight master stuck below
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
    showOsd(`PlasmaFlow: ${state.layout}${overridden}`);
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

// Send the focused window to virtual desktop `number` (1-based) without
// following it. Setting window.desktops fires the per-window desktopsChanged
// handler (onDesktopMove), which retiles both the source and destination — so
// we don't retile here ourselves. No-op if that desktop doesn't exist.
// Send the focused window to the previous/next virtual desktop (dir -1/+1)
// without following it. Clamps at the ends (no wrap). Setting window.desktops
// fires the per-window desktopsChanged handler (onDesktopMove), which retiles
// both the source and destination — so we don't retile here. Desktops are
// matched by id (UUID); KWin may hand back distinct wrapper objects for the
// same desktop, so object identity (===) isn't reliable.
function sendToAdjacentDesktop(window, dir) {
    const desktops = workspace.desktops;
    if (!desktops || desktops.length < 2) return;
    if (!window.desktops || window.desktops.length === 0) return;

    const currentId = window.desktops[0].id;
    let idx = -1;
    for (let i = 0; i < desktops.length; i++) {
        if (desktops[i].id === currentId) { idx = i; break; }
    }
    if (idx === -1) return;

    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= desktops.length) return;  // no wrap

    const target = desktops[targetIdx];
    window.desktops = [target];
    showOsd("PlasmaFlow: → " + target.name);
}

// ─── Scratchpad ──────────────────────────────────────────────────────────────
// Any number of windows can be parked in the scratchpad. They live outside the
// tiling layout (shouldFloat keeps them un-tiled) and are summoned/dismissed
// together with Meta+Grave: "hidden" = minimized; "shown" = un-minimized, pulled
// to the current desktop, cascaded, and focused.

function windowOnDesktop(window, desktop) {
    if (!desktop) return true;
    const ds = window.desktops;
    if (!ds || ds.length === 0) return true;   // empty = on all desktops
    for (let i = 0; i < ds.length; i++) if (ds[i].id === desktop.id) return true;
    return false;
}

// Position one scratchpad window: 60% of the usable area, cascaded by `index`
// so multiple windows don't perfectly overlap, kept centred as a group.
function cascadeFloating(window, index, count) {
    const area = workspace.clientArea(KWin.PlacementArea, window);
    const w = Math.floor(area.width * 0.6);
    const h = Math.floor(area.height * 0.6);
    const step = 40;
    const baseX = area.x + Math.floor((area.width - w) / 2) - Math.floor(step * (count - 1) / 2);
    const baseY = area.y + Math.floor((area.height - h) / 2) - Math.floor(step * (count - 1) / 2);
    const x = Math.max(area.x, Math.min(baseX + index * step, area.x + area.width - w));
    const y = Math.max(area.y, Math.min(baseY + index * step, area.y + area.height - h));
    window.frameGeometry = rect(x, y, w, h);
}

// Park the focused window in the scratchpad and hide it. Pulling it out of the
// tile list via removeWindow() reflows the rest of its desktop.
function sendToScratchpad(window) {
    if (!window) return;
    if (scratchWindows.indexOf(window) !== -1) return;   // already parked
    removeWindow(window);                                 // untile + reflow source
    scratchWindows.push(window);
    window.minimized = true;                              // hide it
    const n = scratchWindows.length;
    showOsd("PlasmaFlow: scratchpad (" + n + " window" + (n === 1 ? "" : "s") + ")");
}

// Show every scratchpad window on `desktop`, cascaded, and focus the top one.
function showScratchpad(desktop) {
    for (let i = 0; i < scratchWindows.length; i++) {
        const w = scratchWindows[i];
        if (desktop) w.desktops = [desktop];
        w.minimized = false;
        cascadeFloating(w, i, scratchWindows.length);
    }
    workspace.activeWindow = scratchWindows[scratchWindows.length - 1];
}

// Toggle: if the scratchpad is already showing on the current desktop, hide it;
// otherwise summon every parked window to the current desktop. This makes
// Meta+Grave from another desktop pull the scratchpad to you rather than hide it.
function toggleScratchpad() {
    if (scratchWindows.length === 0) { showOsd("PlasmaFlow: scratchpad is empty"); return; }

    const cur = workspace.currentDesktop;
    const shownHere = scratchWindows.some(w => !w.minimized && windowOnDesktop(w, cur));
    if (shownHere) {
        for (const w of scratchWindows) w.minimized = true;
    } else {
        showScratchpad(cur);
    }
}

function toggleFloat(window) {
    const state = getState(window);
    if (!state) return;

    const idx = state.windows.indexOf(window);
    if (idx !== -1) {
        // Currently tiled → remove and restore original geometry
        state.windows.splice(idx, 1);
        window.keepBelow = false;   // never leave a spotlight master stuck below
        if (state.windows.length > 0) tile(state.windows[0]);
    } else {
        // Currently floating → add to tile list. If it's a parked scratchpad
        // window, eject it from the scratchpad first so it tiles (this is how a
        // summoned scratchpad window is sent back to the desktop).
        const si = scratchWindows.indexOf(window);
        if (si !== -1) scratchWindows.splice(si, 1);
        addWindow(window);
    }
}

// Meta+H/L adjust the "primary ratio" of whatever layout is active: in
// master-stack/spiral that's masterRatio (the split fraction); in spotlight
// it's cornerRatio (corner window size). Other layouts have no such knob, so
// it's a silent no-op there.
function adjustRatio(window, delta) {
    const state = getState(window);
    if (!state) return;

    if (state.layout === "spotlight") {
        adjustCornerRatio(window, state, delta);
    } else if (state.layout === "master-stack" || state.layout === "spiral") {
        adjustMasterRatio(window, state, delta);
    }
    // else: no ratio knob for this layout — no-op.
}

// Build the 10-segment OSD ratio bar. Uses colour-emoji squares (🟦 filled /
// ⬛ empty) instead of █/░ so the bar renders in the icon's blue: the Plasma OSD
// label is Text.PlainText (no HTML/colour markup), but emoji are colour glyphs
// and render regardless. `filled` is clamped to 0–10.
function ratioBar(filled) {
    const f = Math.min(10, Math.max(0, filled));
    return "🟦".repeat(f) + "⬛".repeat(10 - f);
}

function adjustMasterRatio(window, state, delta) {
    if (state.windows.length < 2) return;

    const MIN = 0.1;
    const MAX = 0.9;
    state.masterRatio = Math.min(MAX, Math.max(MIN,
        Math.round((state.masterRatio + delta) * 100) / 100
    ));

    tile(window);
    persistState(stateKey(window.screen, window.desktops[0].id), state);

    // OSD: small ASCII bar + percentage for quick visual feedback. masterRatio's
    // useful range is ~0.1–0.9, so ratio*10 maps naturally onto the 10-block bar.
    const pct     = Math.round(state.masterRatio * 100);
    const filled  = Math.round(state.masterRatio * 10);
    showOsd(`PlasmaFlow  ${ratioBar(filled)}  ${pct}%`);
}

function adjustCornerRatio(window, state, delta) {
    if (state.windows.length < 2) return;   // only a master visible → no corners to size

    // Matches the spotlightCornerRatio bounds in main.xml.
    const MIN = 0.1;
    const MAX = 0.5;
    state.cornerRatio = Math.min(MAX, Math.max(MIN,
        Math.round((state.cornerRatio + delta) * 100) / 100
    ));

    tile(window);
    persistState(stateKey(window.screen, window.desktops[0].id), state);

    // OSD: normalize over the [MIN,MAX] range so the bar spans its full width
    // (corner ratio never exceeds 0.5, which would only ever half-fill a raw bar).
    const pct     = Math.round(state.cornerRatio * 100);
    const filled  = Math.round((state.cornerRatio - MIN) / (MAX - MIN) * 10);
    showOsd(`PlasmaFlow  corners ${ratioBar(filled)}  ${pct}%`);
}

// ─── Register shortcuts ─────────────────────────────────────────────────────

registerShortcut(
    "PlasmaFlow: Cycle Layout",
    "PlasmaFlow: Cycle Layout",
    "Meta+T",
    () => { if (workspace.activeWindow) cycleLayout(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Swap with Master",
    "PlasmaFlow: Swap with Master",
    "Meta+Return",
    () => { if (workspace.activeWindow) swapWithMaster(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Focus Next",
    "PlasmaFlow: Focus Next",
    "Meta+J",
    () => { if (workspace.activeWindow) focusNext(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Focus Prev",
    "PlasmaFlow: Focus Prev",
    "Meta+K",
    () => { if (workspace.activeWindow) focusPrev(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Move Window Down",
    "PlasmaFlow: Move Window Down",
    "Meta+Shift+J",
    () => { if (workspace.activeWindow) moveNext(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Move Window Up",
    "PlasmaFlow: Move Window Up",
    "Meta+Shift+K",
    () => { if (workspace.activeWindow) movePrev(workspace.activeWindow); }
);

// Send focused window to the previous/next virtual desktop. We use arrow keys
// (not Meta+Shift+<digit>): on this KWin/Wayland, script-registered shortcuts on
// the shifted number row never fire (Shift+1 emits the shifted-symbol keysym,
// which doesn't match Key_1), whereas arrow keys work. NOTE: Meta+Left/Right is
// KDE's *default* for Quick Tile Left/Right — tiling-script users typically
// clear that (documented in the README).
registerShortcut(
    "PlasmaFlow: Send to Previous Desktop",
    "PlasmaFlow: Send to Previous Desktop",
    "Meta+Left",
    () => { if (workspace.activeWindow) sendToAdjacentDesktop(workspace.activeWindow, -1); }
);

registerShortcut(
    "PlasmaFlow: Send to Next Desktop",
    "PlasmaFlow: Send to Next Desktop",
    "Meta+Right",
    () => { if (workspace.activeWindow) sendToAdjacentDesktop(workspace.activeWindow, 1); }
);

// Scratchpad. Meta+Grave toggles it (collides with KWin's "Walk Through Windows
// of Current Application" alt-binding — documented in README; Alt+Grave keeps
// working). Send uses Meta+Ctrl+Grave, NOT Meta+Shift+Grave: Shift+Grave emits
// the tilde keysym, which (like the shifted number row) never matches.
registerShortcut(
    "PlasmaFlow: Toggle Scratchpad",
    "PlasmaFlow: Toggle Scratchpad",
    "Meta+`",
    () => { toggleScratchpad(); }
);

registerShortcut(
    "PlasmaFlow: Send to Scratchpad",
    "PlasmaFlow: Send to Scratchpad",
    "Meta+Ctrl+`",
    () => { if (workspace.activeWindow) sendToScratchpad(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Toggle Float",
    "PlasmaFlow: Toggle Float",
    "Meta+F",
    () => { if (workspace.activeWindow) toggleFloat(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Increase Master Width",
    "PlasmaFlow: Increase Master Width",
    "Meta+L",
    () => {
        if (workspace.activeWindow)
            adjustRatio(workspace.activeWindow, CONFIG.masterRatioStep);
    }
);

registerShortcut(
    "PlasmaFlow: Decrease Master Width",
    "PlasmaFlow: Decrease Master Width",
    "Meta+H",
    () => {
        if (workspace.activeWindow)
            adjustRatio(workspace.activeWindow, -CONFIG.masterRatioStep);
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
workspace.windowRemoved.connect((window) => {
    const si = scratchWindows.indexOf(window);
    if (si !== -1) scratchWindows.splice(si, 1);          // parked window closed
    removeWindow(window);
});

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

print("[PlasmaFlow] Loaded. Default layout: " + CONFIG.defaultLayout);

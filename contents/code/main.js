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
const LAYOUT_NAMES = ["master-stack", "columns", "monocle", "spotlight", "spiral", "quadrant"];

// Tolerate a defaultLayout that comes back as a numeric index (e.g. "0" from an
// older combo-box binding) by mapping it to the layout name; pass names through.
function normalizeLayoutName(value) {
    if (LAYOUT_NAMES.indexOf(value) !== -1) return value;
    const i = parseInt(value, 10);
    if (!isNaN(i) && i >= 0 && i < LAYOUT_NAMES.length) return LAYOUT_NAMES[i];
    return "master-stack";
}

// Which layouts Meta+T cycles through. One Bool config entry per layout so the
// KCM can show plain checkboxes; collected here into a list in LAYOUT_NAMES
// order (the cycle order). Disabling a layout only removes it from the Meta+T
// rotation — Meta+Shift+T, a pinned desktop layout, the default layout and a
// restored session layout all still reach it, so nothing a user explicitly
// asked for is blocked by a checkbox.
const LAYOUT_ENABLE_KEYS = {
    "master-stack": "enableMasterStack",
    "columns":      "enableColumns",
    "monocle":      "enableMonocle",
    "spotlight":    "enableSpotlight",
    "spiral":       "enableSpiral",
    "quadrant":     "enableQuadrant",
};

function readEnabledLayouts() {
    const on = LAYOUT_NAMES.filter(
        name => readConfig(LAYOUT_ENABLE_KEYS[name], true)
    );
    // Unticking every box would leave Meta+T with nothing to cycle; treat that
    // degenerate case as "all enabled" rather than making the key dead.
    return on.length ? on : LAYOUT_NAMES.slice();
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
        // noBorderTiling strips decorations from tiled windows (see applyBorders).
        // Default off (no change).
        noBorderTiling:       readConfig("noBorderTiling", false),
        persistSession:       readConfig("persistSession", true),
        floatClasses:         readConfig("floatClasses",
            "steam,plasmashell,krunner,yakuake,spectacle,kruler,plasma-desktop"
        ).split(",").map(s => s.trim().toLowerCase()),
        // Layouts Meta+T rotates through (Meta+Shift+T ignores this).
        enabledLayouts:       readEnabledLayouts(),
        // Meta+T overrides the pinned layout for the session only.
        desktopLayouts:       parseDesktopLayouts(readConfig("desktopLayouts", "")),
    };
}

// Read once at load. KWin gives workspace scripts no config-change signal and
// caches their config until the script is reloaded, so settings changes only
// take effect after a reload (KCM disable/enable, or `make reload`).
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

// monocle scale bounds. A single per-desktop fraction sizing the shared monocle
// slot down from full-screen and re-centring it. Default 1.0 == full-screen, so
// there's no behaviour change until the user presses Meta+H. The step reuses
// CONFIG.masterRatioStep (0.05), the same fraction step the other knobs use — no
// new config entry (default 1.0 means "no change", nothing worth presetting).
// Declared up here, not down with the other resize constants: getState() reads
// MONOCLE_SCALE_DEFAULT and a `const` is in its temporal dead zone until the
// declaration is evaluated, so any call reaching getState() before that point
// would throw a ReferenceError and silently abort the whole script.
const MONOCLE_SCALE_DEFAULT = 1.0;
const MONOCLE_SCALE_MIN     = 0.1;
const MONOCLE_SCALE_MAX     = 1.0;

// ─── Session persistence ────────────────────────────────────────────────────
//
// We persist each desktop's layout + masterRatio so they survive logout.
//
// The write path is the awkward part. This KWin build exposes NO config-write
// API to scripts: KWin.writeConfig, a global writeConfig, and options.writeConfig
// are all absent (only the read-only global readConfig() exists, used for CONFIG).
// callDBus *is* available, but it cannot marshal D-Bus struct types — so systemd's
// StartTransientUnit (a(sv)/a(sa(sv))) fails and we can't shell out to
// kwriteconfig6 that way either. (All verified live.)
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
// with a .show() method exists was wrong (same class of bug as the missing
// config-write API above):
// every call threw "osd is not defined" and no OSD ever appeared. The real OSD is
// plasmashell's osdService over DBus: org.kde.osdService.showText(icon, text)
// (signature "ss"). Fire-and-forget / best-effort, exactly like plasmaEval — a
// no-op if plasmashell is down, since the OSD is purely informational.
//
// The icon arg can be either an icon-*theme name* or an absolute *file path*.
// We default to the theme name "plasmaflow" (portable; the Makefile installs the
// PNG into hicolor as plasmaflow.png). The name is deliberately DASH-FREE: an
// earlier "plasma-flow" was invisible everywhere theme-name lookup is used (OSD,
// KWin Scripts list) because Qt6's freedesktop dash-fallback strips it to the
// parent "plasma" — a real Breeze icon that outranks our file in the lower-
// priority user hicolor theme. So "plasma-flow" always resolved to the stock
// Plasma logo. A no-dash name has no such parent and resolves to our file.
// `make install` rewrites OSD_ICON (the @OSD_ICON@-tagged line below) to the
// absolute path of the PNG it puts in hicolor, which sidesteps theme lookup.
// A package install (KDE Store / kpackagetool) never runs make, so there's no
// hicolor icon and the theme name finds nothing. For that case
// resolveOsdIcon() asks plasmashell — the script engine has no file or $HOME
// access of its own — where the packaged copy of the icon landed, and switches
// to that absolute path once the async reply arrives.
const OSD_ICON = "plasmaflow"; /* @OSD_ICON@ */
const PACKAGED_ICON = "kwin/scripts/plasma-flow/imgs/plasmaflow-icon.png";
let osdIcon = OSD_ICON;
function resolveOsdIcon() {
    if (osdIcon.charAt(0) === "/" || typeof callDBus !== "function") return;
    callDBus("org.kde.plasmashell", "/PlasmaShell",
             "org.kde.PlasmaShell", "evaluateScript",
             'var u = userDataPath("data", "' + PACKAGED_ICON + '"),' +
             ' s = "/usr/share/' + PACKAGED_ICON + '";' +
             'print(fileExists(u) ? u : fileExists(s) ? s : "");',
             function (path) {
                 path = String(path || "").trim();
                 if (path.charAt(0) === "/") osdIcon = path;
             });
}
resolveOsdIcon();
function showOsd(text) {
    if (typeof callDBus !== "function") return;
    callDBus("org.kde.plasmashell", "/org/kde/osdService",
             "org.kde.osdService", "showText", osdIcon, text);
}

/**
 * Persist layout + masterRatio for a desktop key.
 * key looks like "0:desktop-uuid"; stored as "persist:0:desktop-uuid".
 */
function persistState(key, state) {
    if (!CONFIG.persistSession) return;
    // 5-field format "layout|masterRatio|cornerRatio|mirrored|monocleScale"
    // (mirror as 1/0). monocleScale was appended exactly like mirrored/cornerRatio
    // before it — a rounded number, so the "value is fully script-controlled, no
    // escaping needed" safety argument still holds. restoreState reads legacy 2-,
    // 3-, and 4-field entries too (missing tail fields fall back to defaults), so
    // old kwinrc entries keep loading.
    const value = `${state.layout}|${state.masterRatio}|${state.cornerRatio}|${state.mirrored ? 1 : 0}|${state.monocleScale}`;
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
 * writes to). Returns { layout, masterRatio, cornerRatio?, mirrored?,
 * monocleScale? } or null. Accepts the legacy 2-field ("layout|masterRatio"),
 * 3-field ("layout|masterRatio|cornerRatio"), and 4-field
 * ("layout|masterRatio|cornerRatio|mirrored") formats as well as the current
 * 5-field one ("layout|masterRatio|cornerRatio|mirrored|monocleScale"); missing
 * tail fields fall back to their defaults (cornerRatio at the call site, mirrored
 * and monocleScale via getState's || default).
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
    // 4th field: horizontal mirror, "1"/"0". Absent for legacy entries → leave
    // undefined so getState's `|| false` default applies.
    if (parts.length >= 4) result.mirrored = (parts[3] === "1");
    // 5th field: monocle slot scale (0.1–1.0). Absent for legacy 2-/3-/4-field
    // entries → leave undefined so getState's `|| MONOCLE_SCALE_DEFAULT` applies.
    if (parts.length >= 5) {
        const ms = parseFloat(parts[4]);
        if (!isNaN(ms)) result.monocleScale = ms;
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
            // Horizontal mirror (Meta+M), per-screen/per-desktop like `layout`.
            // Persisted as the 4th field; restoreState sets `saved.mirrored` when
            // present (legacy 2-/3-field entries leave it undefined → false).
            mirrored:     (saved && saved.mirrored) || false,
            // monocle slot scale (Meta+H/L), per-desktop like masterRatio.
            // Persisted as the 5th field; restoreState sets `saved.monocleScale`
            // when present (legacy 2-/3-/4-field entries leave it undefined →
            // MONOCLE_SCALE_DEFAULT). Default 1.0 == full-screen, no behaviour change.
            monocleScale: (saved && saved.monocleScale) || MONOCLE_SCALE_DEFAULT,
            windows:      [],
        };
    }
    return layoutState[key];
}

// ─── Float detection ────────────────────────────────────────────────────────

function shouldFloat(window) {
    if (scratchWindows.indexOf(window) !== -1)             return true;
    if (window.dialog || window.utility || window.splash) return true;
    // Modal transients — file-save prompts, "File Already Exists", overwrite
    // confirmations. On Wayland these are the same category as `dialog`, but
    // xdg-shell carries no window type, so KWin leaves `dialog` false on them
    // and they were being tiled. `modal` is the flag that does survive: it
    // means the window blocks its parent, which is never something to tile.
    // Verified on this build — Firefox's save prompt (which is actually the
    // portal, class org.freedesktop.impl.portal.desktop.kde) and Dolphin's
    // File/Folder-Already-Exists prompts all report modal=true, while every
    // ordinary app window reports false. Preferred over matching captions,
    // which are localized and would only work in English.
    if (window.modal)                                      return true;
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

// ─── Horizontal mirror ────────────────────────────────────────────────────────
//
// Module-level mirror context. When set to an `area`, setGeometry() reflects
// every window it writes horizontally about that area's vertical centre line.
// tile() sets this to the usable area for a mirrored desktop just before the
// layout runs and clears it immediately after (so floatCascade and everything
// else are unaffected). Default off — non-mirrored desktops render identically.
//
// Reflecting at WRITE time, from the intended x/width the layout passes in, is
// deliberate. The obvious alternative — a post-pass that reads each window's
// frameGeometry back and re-flips it — is subtly broken on Wayland: a window
// that is mid-resize does NOT reliably report the width you just requested until
// it finishes, so the reflection was computed from a *stale* width and the window
// jumped to the wrong x on every Meta+H/L resize (the mirror appeared to "break").
// The layout's intended geometry is always exact, so reflecting it here is stable.
let activeMirror = null;

// Write a window's geometry, reflecting it horizontally first when a mirror is
// active. Layouts call this instead of assigning frameGeometry directly so the
// reflection uses their intended x/width — never a read-back. width and y are
// untouched, so a window's SIZE is mirror-invariant: focus-relative resize,
// focus/move/swap, float and scratchpad all reason about size and tile-order,
// never absolute x, so they keep working under mirror for free. The reflection
// (newX = 2*ax + aw - x - w) is its own inverse, so two Meta+M presses restore
// the exact original geometry.
function setGeometry(win, x, y, w, h) {
    if (activeMirror) x = 2 * activeMirror.x + activeMirror.width - x - w;
    win.frameGeometry = rect(x, y, w, h);
}

// Build an array of length n filled with v. Used for uniform default size
// weights (see the focus-relative resizing helpers below).
function filledArray(n, v) {
    const a = [];
    for (let i = 0; i < n; i++) a.push(v);
    return a;
}

// Split `total` pixels among slots in proportion to `weights`, returning
// integer sizes that sum to exactly `total` (the last slot absorbs rounding
// drift). Used by the layouts that size windows relative to one another
// (columns' widths, master-stack's stack heights).
function weightedSizes(weights, total) {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) sum += weights[i];
    const sizes = [];
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
        const s = (i === weights.length - 1) ? (total - acc)
                                             : Math.floor(total * weights[i] / sum);
        sizes.push(s);
        acc += s;
    }
    return sizes;
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
            setGeometry(windows[0],
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

        // Stack heights are focus-relative: each window's height is proportional
        // to its weight (all 1 by default → equal heights). Meta+H/L adjusts the
        // focused stack window's weight. Fall back to equal if weights are stale.
        const weights = (cfg.stackWeights && cfg.stackWeights.length === stackCount)
            ? cfg.stackWeights : filledArray(stackCount, 1);
        const usableH  = area.height - og * 2 - g * (stackCount - 1);
        const heights  = weightedSizes(weights, usableH);

        // Master
        setGeometry(windows[0],
            area.x + og,
            area.y + og,
            masterWidth,
            area.height - og * 2
        );

        // Stack
        let y = area.y + og;
        for (let i = 1; i < windows.length; i++) {
            setGeometry(windows[i],
                area.x + og + masterWidth + g,
                y,
                stackWidth,
                heights[i - 1]
            );
            y += heights[i - 1] + g;
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

        // Column widths are focus-relative: each column's width is proportional
        // to its weight (all 1 by default → equal columns). Meta+H/L adjusts the
        // focused column's weight. Fall back to equal if weights are stale.
        const weights = (cfg.colWeights && cfg.colWeights.length === n)
            ? cfg.colWeights : filledArray(n, 1);
        const usable = area.width - og * 2 - g * (n - 1);
        const widths = weightedSizes(weights, usable);

        let x = area.x + og;
        for (let i = 0; i < n; i++) {
            setGeometry(windows[i],
                x,
                area.y + og,
                widths[i],
                area.height - og * 2
            );
            x += widths[i] + g;
        }
    },

    /**
     * monocle: all windows share one slot; focus switches between them and only
     * the top-most (focused) window shows. cfg.monocleScale (0.1–1.0, default 1.0)
     * sizes that shared slot down from the usable area and re-centres it, so the
     * visible window shrinks toward screen centre with wallpaper margin around it.
     * At scale 1.0 this reduces exactly to the old full-screen slot (w === usableW,
     * offsets 0), so the default is pixel-identical to before. The rect is
     * horizontally symmetric, so Meta+M mirrors monocle onto itself (visual no-op).
     */
    "monocle": function(windows, area, cfg) {
        const og    = cfg.outerGap;
        const scale = cfg.monocleScale || 1.0;
        const usableW = area.width  - og * 2;
        const usableH = area.height - og * 2;
        const w = Math.floor(usableW * scale);
        const h = Math.floor(usableH * scale);
        const x = area.x + og + Math.floor((usableW - w) / 2);
        const y = area.y + og + Math.floor((usableH - h) / 2);
        for (const win of windows) {
            setGeometry(win, x, y, w, h);
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
        setGeometry(windows[0],
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

            setGeometry(stack[i], x, y, cw, ch);
        }
    },

    /**
     * spiral (Fibonacci): recursively split the usable area, alternating
     * vertical and horizontal cuts and spiralling clockwise inward — left, top,
     * right, bottom, left, … Each window (except the last, which fills the rest)
     * owns one cut, and its cut ratio is focus-relative: Meta+H/L grows/shrinks
     * whichever window is focused along that cut's axis. `cfg.spiralRatios` holds
     * one ratio per cut; ratio[0] is the master split (tracks masterRatio),
     * others default to 0.5. Fall back to that default if ratios are stale.
     */
    "spiral": function(windows, area, cfg) {
        if (windows.length === 0) return;

        const g  = cfg.gap;
        const og = cfg.outerGap;

        const cutCount = windows.length - 1;
        const ratios   = (cfg.spiralRatios && cfg.spiralRatios.length === cutCount)
            ? cfg.spiralRatios : null;

        let x = area.x + og;
        let y = area.y + og;
        let w = area.width  - og * 2;
        let h = area.height - og * 2;

        for (let i = 0; i < windows.length; i++) {
            if (i === windows.length - 1) {       // last window fills the rest
                setGeometry(windows[i], x, y, w, h);
                break;
            }

            // Per-cut ratio: cut 0 is the master split, the rest default to 0.5.
            const ratio = ratios ? ratios[i] : ((i === 0) ? cfg.masterRatio : 0.5);
            const dir = i % 4;
            if (dir === 0) {                      // cut vertical, window left
                const cut = Math.max(0, Math.floor((w - g) * ratio));
                setGeometry(windows[i], x, y, cut, h);
                x += cut + g; w -= cut + g;
            } else if (dir === 1) {               // cut horizontal, window top
                const cut = Math.max(0, Math.floor((h - g) * ratio));
                setGeometry(windows[i], x, y, w, cut);
                y += cut + g; h -= cut + g;
            } else if (dir === 2) {               // cut vertical, window right
                const cut = Math.max(0, Math.floor((w - g) * ratio));
                setGeometry(windows[i], x + (w - cut), y, cut, h);
                w -= cut + g;
            } else {                              // cut horizontal, window bottom
                const cut = Math.max(0, Math.floor((h - g) * ratio));
                setGeometry(windows[i], x, y + (h - cut), w, cut);
                h -= cut + g;
            }
        }
    },

    /**
     * quadrant (2x2 grid): windows fill a 2x2 grid, filled in the order
     * TL → TR → BR → BL. With 1 window it's fullscreen; with 2 it's a
     * left/right split; with 3 the bottom-left quadrant is left empty; with 4
     * every quadrant is occupied.
     *
     * For 3+ windows the grid is governed by a single cross point (cfg.quad.cx,
     * cfg.quad.cy). Every quadrant shares that point, so moving it grows one
     * window diagonally and shrinks the others to match (see adjustQuadrant).
     * At 2 windows only the
     * vertical split (cfg.quad.split) applies.
     *
     * A 5th+ window never reaches this function as a tile — addWindow floats and
     * cascades overflow windows in the centre. If a layout switch ever leaves
     * >4 windows tiled here, the extras keep their prior geometry (untouched).
     */
    "quadrant": function(windows, area, cfg) {
        const n = windows.length;
        if (n === 0) return;

        const og = cfg.outerGap;
        const g  = cfg.gap;
        const X = area.x + og, Y = area.y + og;
        const W = area.width - og * 2, H = area.height - og * 2;

        if (n === 1) {                            // fullscreen
            setGeometry(windows[0], X, Y, W, H);
            return;
        }

        if (n === 2) {                            // half and half (left / right)
            const split = cfg.quad.split;
            const lw = Math.floor((W - g) * split);
            const rw = (W - g) - lw;
            setGeometry(windows[0], X, Y, lw, H);
            setGeometry(windows[1], X + lw + g, Y, rw, H);
            return;
        }

        // n >= 3: 2x2 grid split at the shared cross point. Slots, in the order
        // windows fill them: 0 = TL, 1 = TR, 2 = BR, 3 = BL. With 3 windows the
        // BL slot stays empty; the cross still governs the other three.
        const cx = cfg.quad.cx, cy = cfg.quad.cy;
        const leftW  = Math.floor((W - g) * cx);
        const rightW = (W - g) - leftW;
        const topH   = Math.floor((H - g) * cy);
        const botH   = (H - g) - topH;

        const xL = X, xR = X + leftW + g;
        const yT = Y, yB = Y + topH + g;

        setGeometry(windows[0], xL, yT, leftW,  topH);   // TL
        setGeometry(windows[1], xR, yT, rightW, topH);   // TR
        setGeometry(windows[2], xR, yB, rightW, botH);   // BR
        if (n >= 4)                                      // BL (empty at n===3)
            setGeometry(windows[3], xL, yB, leftW, botH);
    },

};

// ─── Focus-relative sizing (session-only) ─────────────────────────────────────
//
// columns, master-stack (stack), and spiral let Meta+H/L resize the *focused*
// window relative to its neighbours. The sizes live on `state` but are NOT
// persisted — window order is too fragile to save (apps open, crash and relaunch
// in different orders), so they reset whenever the layout or visible-window count changes.
// Only the master/first-cut split (masterRatio) persists, as it always has.

// Lazily (re)build a proportional size-weight array on `state.sizes`, tagged with
// the layout + length it was built for. Rebuilt (to all-1) whenever either
// changes, since each slot's meaning depends on the current layout and count.
function ensureWeights(state, layout, count) {
    const cur = state.sizes;
    if (!cur || cur.layout !== layout || cur.values.length !== count) {
        state.sizes = { layout: layout, values: filledArray(count, 1) };
    }
    return state.sizes.values;
}

// Spiral cut ratios: one per cut (windows.length - 1). Cut 0 always tracks the
// persisted masterRatio; the rest default to 0.5 and are session-only. Rebuilt
// when the cut count changes; cut 0 is re-synced from masterRatio every call.
function ensureSpiralRatios(state, cutCount) {
    let cur = state.spiralRatios;
    if (!cur || cur.length !== cutCount) {
        cur = filledArray(cutCount, 0.5);
        state.spiralRatios = cur;
    }
    if (cutCount > 0) cur[0] = state.masterRatio;
    return cur;
}

// quadrant grid state (session-only, like the weights above). The 2x2 grid is
// driven by a single grown window (`g`, a slot index 0..3, or -1 for none) and
// how far it's grown (`a`, 0..QUAD_AMAX); `split` is the vertical split used at
// n===2 only. Rebuilt to an even grid whenever the visible-window count changes,
// since the slot a window occupies (and thus which one is grown) depends on it.
function ensureQuad(state, n) {
    const q = state.quad;
    if (!q || q.n !== n) {
        state.quad = { n: n, g: -1, a: 0, split: 0.5 };
    }
    return state.quad;
}

// The cross point for a grown slot `g` displaced by amount `a`. Each slot pushes
// the cross diagonally toward its own screen corner's opposite, so the grown
// window expands from its corner and its diagonal opposite shrinks in step:
//   0 TL → (+,+)   1 TR → (-,+)   2 BR → (-,-)   3 BL → (+,-)
// g === -1 (nothing grown) leaves the cross centred (a is 0 then anyway).
function quadCross(g, a) {
    const sx = (g === 0 || g === 3) ? 1 : (g === 1 || g === 2) ? -1 : 0;
    const sy = (g === 0 || g === 1) ? 1 : (g === 2 || g === 3) ? -1 : 0;
    return { cx: 0.5 + sx * a, cy: 0.5 + sy * a };
}

// ─── Tile trigger ───────────────────────────────────────────────────────────

// Windows that actually occupy a slot right now. Minimized windows keep their
// place in `state.windows` (so un-minimizing restores their slot) but are never
// drawn — so anything that reasons about how many windows are *shown* (the
// quadrant 4-slot cap, in particular) must count these, not the raw list.
function visibleWindows(state) {
    return state.windows.filter((w) => !w.minimized);
}

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
    const visible = visibleWindows(state);

    // Quadrant tiles at most four windows. If more than four are visible (e.g.
    // a minimized window was restored into an already-full grid), evict the
    // extras to the floating cascade so the grid never tries to cram >4 windows
    // into 4 slots. The first four in tile order keep the quadrants.
    if (state.layout === "quadrant" && visible.length > 4) {
        for (let i = visible.length - 1; i >= 4; i--) {
            const extra = visible[i];
            const idx = state.windows.indexOf(extra);
            if (idx !== -1) state.windows.splice(idx, 1);
            extra.keepBelow = false;
            if (CONFIG.noBorderTiling && extra.noBorder) extra.noBorder = false;
            floatCascade(extra, state);
        }
        visible.length = 4;
    }

    // Merge per-state ratios into the config passed to the layout: masterRatio
    // (master-stack/spiral split) and spotlightCornerRatio (spotlight corner
    // size). Both are per-desktop and adjustable via Meta+H/L.
    const layoutCfg = Object.assign({}, CONFIG, {
        masterRatio:          state.masterRatio,
        spotlightCornerRatio: state.cornerRatio,
    });

    // Focus-relative per-window sizes for the layouts that support them.
    const n = visible.length;
    if (state.layout === "columns") {
        layoutCfg.colWeights = ensureWeights(state, "columns", n);
    } else if (state.layout === "master-stack") {
        layoutCfg.stackWeights = ensureWeights(state, "master-stack", Math.max(0, n - 1));
    } else if (state.layout === "spiral") {
        layoutCfg.spiralRatios = ensureSpiralRatios(state, Math.max(0, n - 1));
    } else if (state.layout === "quadrant") {
        const q = ensureQuad(state, n);
        const cross = quadCross(q.g, q.a);
        layoutCfg.quad = { cx: cross.cx, cy: cross.cy, split: q.split };
    } else if (state.layout === "monocle") {
        layoutCfg.monocleScale = state.monocleScale;
    }

    const layoutFn  = layouts[state.layout] || layouts["master-stack"];

    // Horizontal mirror: when this desktop is mirrored, setGeometry reflects each
    // window about `area`'s vertical centre as the layout writes it (using the
    // intended x/width, so it's stable while a window is resizing — see
    // activeMirror/setGeometry). Cleared immediately after the layout so nothing
    // else (floatCascade, later retiles) is affected. Layouts stay pure — they
    // just emit geometry through setGeometry and never see the mirror flag.
    activeMirror = state.mirrored ? area : null;
    layoutFn(visible, area, layoutCfg);
    activeMirror = null;

    applyStacking(state, visible);
    applyBorders(state);
}

// Apply the no-border preference to every window in this tile list. Mirrors
// applyStacking's no-op guard: only write noBorder when it actually changes,
// since a redundant decoration toggle forces a relayout/repaint. When
// noBorderTiling is off this writes `false`, so disabling the setting and
// reloading restores decorations. A window that *leaves* the tile list has its
// border restored at the removal site (it's no longer in state.windows here).
function applyBorders(state) {
    const want = CONFIG.noBorderTiling;
    for (let i = 0; i < state.windows.length; i++) {
        const w = state.windows[i];
        if (w.noBorder !== want) w.noBorder = want;
    }
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
    // Only write keepBelow when it actually changes. In every non-spotlight
    // layout this would otherwise re-set `false` on every window on every
    // retile (minimize, ratio adjust, swap, move, add/remove); a redundant
    // property write can emit change signals / trigger compositor restacking,
    // so skipping no-ops is pure win. keepBelow is a bool we fully control.
    for (let i = 0; i < state.windows.length; i++) {
        const want = (state.windows[i] === master);
        if (state.windows[i].keepBelow !== want) state.windows[i].keepBelow = want;
    }
}

// ─── Window lifecycle ────────────────────────────────────────────────────────

// Float a window in the centre of its screen, cascading each successive overflow
// window by a fixed offset so they don't stack exactly. Used by the quadrant
// layout, which only tiles four windows — any beyond that float here (see the
// overflow branch in addWindow). The window is deliberately NOT added to
// state.windows: it stays a normal free-floating window the user can move, and
// retiling never touches it. `cascadeCount` wraps so the pile never marches off
// screen; it's reset when the grid drops back below four windows (removeWindow).
function floatCascade(window, state) {
    const area = workspace.clientArea(KWin.PlacementArea, window);
    const cw = Math.floor(area.width  * 0.6);
    const ch = Math.floor(area.height * 0.6);
    const step = 40;
    const k = (state.cascadeCount || 0) % 5;                 // 0..4, then wrap
    const x = area.x + Math.floor((area.width  - cw) / 2) + (k - 2) * step;
    const y = area.y + Math.floor((area.height - ch) / 2) + (k - 2) * step;
    window.frameGeometry = rect(x, y, cw, ch);
    state.cascadeCount = (state.cascadeCount || 0) + 1;
    showOsd("PlasmaFlow: floating (quadrant is full)");
}

function addWindow(window) {
    if (shouldFloat(window)) return;

    const state = getState(window);
    if (!state) return;

    if (state.windows.includes(window)) {
        tile(window);
        return;
    }

    // The quadrant layout draws at most four windows (one per quadrant). A new
    // window opened while all four visible slots are taken floats and cascades in
    // the centre instead of tiling. We count *visible* windows, not the raw list:
    // minimized windows keep their slot but aren't drawn, so they must not make
    // the grid read as full (that was the "only 3 tile" bug). Existing tiled
    // windows are never evicted.
    if (state.layout === "quadrant" && !window.minimized &&
        visibleWindows(state).length >= 4) {
        floatCascade(window, state);
        return;
    }

    state.windows.push(window);
    tile(window);
}

function removeWindow(window) {
    for (const key of Object.keys(layoutState)) {
        const state = layoutState[key];
        const idx   = state.windows.indexOf(window);
        if (idx !== -1) {
            state.windows.splice(idx, 1);
            window.keepBelow = false;   // never leave a spotlight master stuck below
            if (CONFIG.noBorderTiling && window.noBorder) window.noBorder = false;  // restore decoration on leaving the tile list
            // A freed quadrant slot means the next overflow window should cascade
            // from the centre again, so reset the counter once we drop below four
            // visible (matching the cap in tile()/addWindow).
            if (visibleWindows(state).length < 4) state.cascadeCount = 0;
            // Retile remaining windows on this screen/desktop
            if (state.windows.length > 0) {
                tile(state.windows[0]);
            }
            break;
        }
    }
}

// ─── Keyboard shortcuts ─────────────────────────────────────────────────────

// Next layout after `current`, walking LAYOUT_NAMES in order and skipping any
// name not in `allowed`. Walking the *full* order (rather than indexing into
// `allowed`) keeps the rotation stable when the current layout is itself
// disabled — as it can be after Meta+Shift+T, a pin, or a restored session —
// since a disabled current has no index in `allowed` to advance from.
function nextLayout(current, allowed) {
    const start = LAYOUT_NAMES.indexOf(current);
    for (let i = 1; i <= LAYOUT_NAMES.length; i++) {
        const name = LAYOUT_NAMES[(start + i) % LAYOUT_NAMES.length];
        if (allowed.indexOf(name) !== -1) return name;
    }
    return current;
}

// Meta+T cycles the enabled layouts; Meta+Shift+T (includeDisabled) cycles all
// of them, so a layout you've unticked is still reachable on demand.
function cycleLayout(window, includeDisabled) {
    const state = getState(window);
    if (!state) return;

    const allowed = includeDisabled ? LAYOUT_NAMES : CONFIG.enabledLayouts;
    state.layout  = nextLayout(state.layout, allowed);

    tile(window);
    persistState(
        stateKey(window.screen, window.desktops[0].id),
        state
    );
    // Mark as session-overridden if it differs from pinned layout, and flag a
    // layout that's off in the config (only reachable via Meta+Shift+T) so it's
    // obvious why Meta+T won't come back to it.
    const overridden = state.pinnedLayout && state.layout !== state.pinnedLayout
        ? ` (pinned: ${state.pinnedLayout})` : "";
    const off = CONFIG.enabledLayouts.indexOf(state.layout) === -1 ? " (disabled)" : "";
    showOsd(`PlasmaFlow: ${state.layout}${off}${overridden}`);
}

// Toggle the horizontal mirror for the focused window's desktop. mirrored is
// per-state, so this flips only this screen/desktop and leaves every other one
// untouched; it also survives a layout change (mirror is an orientation
// preference, not a per-layout setting). The persistState call is a harmless
// no-op for the mirror bit in Milestone 1 (the persisted string doesn't carry
// it yet) — wired now so Milestone 2 only extends the format, not the call site.
function toggleMirror(window) {
    const state = getState(window);
    if (!state) return;
    state.mirrored = !state.mirrored;
    tile(window);
    persistState(stateKey(window.screen, window.desktops[0].id), state);
    showOsd("PlasmaFlow: mirror " + (state.mirrored ? "on" : "off"));
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
// to the current desktop, and focused — each window keeps its own size and
// position. We deliberately never resize or reposition scratchpad windows: a
// window is parked exactly as it sits, and whatever the user moves/resizes it to
// while summoned is preserved (KWin keeps frameGeometry across minimize), even as
// other windows are parked or summoned. This makes the scratchpad a free-floating
// layer the user controls, not a cascaded auto-arranged one.

function windowOnDesktop(window, desktop) {
    if (!desktop) return true;
    const ds = window.desktops;
    if (!ds || ds.length === 0) return true;   // empty = on all desktops
    for (let i = 0; i < ds.length; i++) if (ds[i].id === desktop.id) return true;
    return false;
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

// Show every scratchpad window on `desktop`, in place, and focus the top one.
// We pull each window to the desktop and un-minimize it but leave its geometry
// untouched, so the user's own size/position is preserved across toggles.
function showScratchpad(desktop) {
    for (let i = 0; i < scratchWindows.length; i++) {
        const w = scratchWindows[i];
        if (desktop) w.desktops = [desktop];
        w.minimized = false;
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
        if (CONFIG.noBorderTiling && window.noBorder) window.noBorder = false;  // restore decoration when floated
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

// Meta+H/L resize the *focused* window relative to its neighbours, dispatched to
// whatever the active layout supports: the focused column's width (columns), a
// stack window's height or the master's width (master-stack), the focused
// window's cut (spiral), the diagonal grow (quadrant), the shared slot scale
// (monocle), or the corner size (spotlight). `delta`'s sign is grow (+) /
// shrink (-); its magnitude is the ratio step (masterRatioStep) for the
// fraction-based knobs.
function adjustRatio(window, delta) {
    const state = getState(window);
    if (!state) return;

    switch (state.layout) {
        case "spotlight":    adjustCornerRatio(window, state, delta); break;
        case "columns":      adjustColumn(window, state, delta);      break;
        case "master-stack": adjustStack(window, state, delta);       break;
        case "spiral":       adjustSpiral(window, state, delta);      break;
        case "quadrant":     adjustQuadrant(window, state, delta);    break;
        case "monocle":      adjustMonocle(window, state, delta);     break;
    }
}

// The focused window's position in the *visible* (non-minimized) tile order,
// and that visible list. index is -1 if the focused window isn't tiled here
// (e.g. it's floating), so callers can no-op.
function visibleTile(state, window) {
    const visible = state.windows.filter((w) => !w.minimized);
    return { visible: visible, index: visible.indexOf(window) };
}

// Grow (+) / shrink (-) one proportional size weight by a fixed step, clamped so
// a window can neither vanish nor swallow the row. Weights are relative, so the
// step is independent of the fraction-based masterRatioStep.
const WEIGHT_STEP = 0.2;
const WEIGHT_MIN  = 0.3;
const WEIGHT_MAX  = 4.0;
function bumpWeight(weights, i, delta) {
    const next = weights[i] + (delta > 0 ? WEIGHT_STEP : -WEIGHT_STEP);
    weights[i] = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, Math.round(next * 100) / 100));
}

// OSD for a weighted resize: show the focused window's share of the row/column.
function showShareOsd(label, weights, i) {
    let sum = 0;
    for (let k = 0; k < weights.length; k++) sum += weights[k];
    const share  = weights[i] / sum;
    const pct    = Math.round(share * 100);
    const filled = Math.round(share * 10);
    showOsd(`PlasmaFlow  ${label} ${ratioBar(filled)}  ${pct}%`);
}

// columns: resize the focused column's width. Needs ≥2 columns to redistribute.
function adjustColumn(window, state, delta) {
    const t = visibleTile(state, window);
    if (t.index < 0 || t.visible.length < 2) return;

    const weights = ensureWeights(state, "columns", t.visible.length);
    bumpWeight(weights, t.index, delta);
    tile(window);
    showShareOsd("width", weights, t.index);
}

// master-stack: master (index 0) resizes width (the persisted masterRatio); a
// stack window resizes its height relative to the other stack windows. A lone
// stack window (2 windows total) has no sibling to trade with → no-op.
function adjustStack(window, state, delta) {
    const t = visibleTile(state, window);
    if (t.index < 0) return;

    if (t.index === 0) { adjustMasterRatio(window, state, delta); return; }

    const stackCount = t.visible.length - 1;
    if (stackCount < 2) return;

    const weights = ensureWeights(state, "master-stack", stackCount);
    const si = t.index - 1;
    bumpWeight(weights, si, delta);
    tile(window);
    showShareOsd("height", weights, si);
}

// spiral: resize the focused window along its own cut. The final window owns no
// cut, so it resizes via the cut it borders (grow it = shrink the prior cut).
// Cut 0 is the master split → routed through masterRatio (persisted).
function adjustSpiral(window, state, delta) {
    const t = visibleTile(state, window);
    if (t.index < 0 || t.visible.length < 2) return;

    const cutCount = t.visible.length - 1;
    let cut  = t.index;
    let sign = 1;
    if (t.index === cutCount) {   // final window: move the cut it borders, inverted
        cut  = cutCount - 1;
        sign = -1;
    }

    if (cut === 0) { adjustMasterRatio(window, state, sign * delta); return; }

    const ratios = ensureSpiralRatios(state, cutCount);
    const MIN = 0.1, MAX = 0.9;
    ratios[cut] = Math.min(MAX, Math.max(MIN,
        Math.round((ratios[cut] + sign * delta) * 100) / 100
    ));
    tile(window);

    const pct    = Math.round(ratios[cut] * 100);
    const filled = Math.round(ratios[cut] * 10);
    showOsd(`PlasmaFlow  ${ratioBar(filled)}  ${pct}%`);
}

// quadrant grid amount step and cap. The cap keeps the cross off the edges so
// no quadrant vanishes: cx/cy stay within [0.5-AMAX, 0.5+AMAX] = [0.1, 0.9].
const QUAD_STEP = 0.05;
const QUAD_AMAX = 0.40;

// quadrant: grow (+) / shrink (-) the focused window along its diagonal. There's
// one shared cross point, so only one window can be "grown" at a time. Growing a
// window that isn't the current grown one first pulls the grid back toward even
// (shrinking whatever is largest), and only once even does it start growing the
// focused window — exactly the behaviour the layout spec calls for. Shrinking a
// window is the same as growing its diagonal opposite, so we fold Meta+H into the
// same path. At 2 windows there's no diagonal; we adjust the vertical split
// instead. At 1 window (fullscreen) there's nothing to resize.
function adjustQuadrant(window, state, delta) {
    const t = visibleTile(state, window);
    if (t.index < 0) return;

    const n = t.visible.length;
    if (n < 2) return;                     // fullscreen: nothing to trade with
    const q = ensureQuad(state, n);

    if (n === 2) {                         // vertical split: grow left / right
        const dir = (t.index === 0) ? 1 : -1;
        const MIN = 0.1, MAX = 0.9;
        q.split = Math.min(MAX, Math.max(MIN,
            Math.round((q.split + dir * delta) * 100) / 100));
        tile(window);
        const share  = (t.index === 0) ? q.split : 1 - q.split;
        showOsd(`PlasmaFlow  width ${ratioBar(Math.round(share * 10))}  ${Math.round(share * 100)}%`);
        return;
    }

    // n >= 3: diagonal grow. Shrinking a window == growing its diagonal opposite,
    // so map Meta+H onto the grow path against the opposite slot ((slot+2)%4).
    let slot = t.index;
    if (delta < 0) slot = (slot + 2) % 4;
    const step = Math.abs(delta) || QUAD_STEP;

    if (q.a <= 0) {                        // even → start growing this window
        q.g = slot;
        q.a = step;
    } else if (slot === q.g) {             // already the grown one → grow further
        q.a = Math.min(QUAD_AMAX, q.a + step);
    } else {                               // a different window → shrink largest to even first
        q.a -= step;
        if (q.a <= 0) { q.g = slot; q.a = -q.a; }   // reached even; carry the overshoot into the new window
    }
    tile(window);

    // OSD: the grown window's linear share of its axis (0.5 even → up to 0.9).
    const share = 0.5 + q.a;
    showOsd(`PlasmaFlow  quad ${ratioBar(Math.round(share * 10))}  ${Math.round(share * 100)}%`);
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
    if (state.windows.filter((w) => !w.minimized).length < 2) return;

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

// monocle: grow (+) / shrink (-) the shared full-screen slot, re-centred. One
// per-desktop scale in [MONOCLE_SCALE_MIN, MONOCLE_SCALE_MAX]; only the focused
// (top-most) window is visible, so this reads as resizing it. No-op if the
// focused window isn't tiled here (e.g. it's floating). Persists across logout via
// persistState — monocleScale is the 5th field of the pipe-delimited persist string.
function adjustMonocle(window, state, delta) {
    const t = visibleTile(state, window);
    if (t.index < 0) return;

    const MIN = MONOCLE_SCALE_MIN, MAX = MONOCLE_SCALE_MAX;
    state.monocleScale = Math.min(MAX, Math.max(MIN,
        Math.round((state.monocleScale + delta) * 100) / 100
    ));

    tile(window);
    persistState(stateKey(window.screen, window.desktops[0].id), state);

    // Normalize the bar over [MIN,MAX] so it spans the full width — otherwise the
    // 0.1 floor would leave the bar looking almost empty at minimum. Same trick as
    // adjustCornerRatio (which normalizes over [0.1,0.5]).
    const pct    = Math.round(state.monocleScale * 100);
    const filled = Math.round((state.monocleScale - MIN) / (MAX - MIN) * 10);
    showOsd(`PlasmaFlow  size ${ratioBar(filled)}  ${pct}%`);
}

// ─── Register shortcuts ─────────────────────────────────────────────────────

registerShortcut(
    "PlasmaFlow: Cycle Layout",
    "PlasmaFlow: Cycle Layout",
    "Meta+T",
    () => { if (workspace.activeWindow) cycleLayout(workspace.activeWindow, false); }
);

registerShortcut(
    "PlasmaFlow: Cycle Layout (All)",
    "PlasmaFlow: Cycle Layout (All)",
    "Meta+Shift+T",
    () => { if (workspace.activeWindow) cycleLayout(workspace.activeWindow, true); }
);

registerShortcut(
    "PlasmaFlow: Mirror Layout",
    "PlasmaFlow: Mirror Layout",
    "Meta+M",
    () => { if (workspace.activeWindow) toggleMirror(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Swap with Master",
    "PlasmaFlow: Swap with Master",
    "Meta+G",
    () => { if (workspace.activeWindow) swapWithMaster(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Focus Next",
    "PlasmaFlow: Focus Next",
    "Meta+K",
    () => { if (workspace.activeWindow) focusNext(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Focus Prev",
    "PlasmaFlow: Focus Prev",
    "Meta+J",
    () => { if (workspace.activeWindow) focusPrev(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Move Window Down",
    "PlasmaFlow: Move Window Down",
    "Meta+Ctrl+K",
    () => { if (workspace.activeWindow) moveNext(workspace.activeWindow); }
);

registerShortcut(
    "PlasmaFlow: Move Window Up",
    "PlasmaFlow: Move Window Up",
    "Meta+Ctrl+J",
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

// Scratchpad. Meta+Space toggles it, Meta+Ctrl+Space parks the focused window.
// We deliberately stay off the grave/tilde key: Shift+Grave emits the tilde
// keysym (like the shifted number row) which never matches a script shortcut on
// Wayland, so a Meta+Shift+Grave park binding can't fire — Space sidesteps that.
registerShortcut(
    "PlasmaFlow: Toggle Scratchpad",
    "PlasmaFlow: Toggle Scratchpad",
    "Meta+Space",
    () => { toggleScratchpad(); }
);

registerShortcut(
    "PlasmaFlow: Send to Scratchpad",
    "PlasmaFlow: Send to Scratchpad",
    "Meta+Ctrl+Space",
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

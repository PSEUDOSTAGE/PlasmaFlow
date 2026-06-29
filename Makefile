SCRIPT_ID   = plasma-flow
INSTALL_DIR = $(HOME)/.local/share/kwin/scripts/$(SCRIPT_ID)
PACKAGE_DIR = ./package
CONTENTS_DIR = ./contents
# Themed icon, referenced by name ("plasma-flow") from the OSD and metadata.
ICON_SRC    = ./imgs/plasmaflow-icon.png
ICON_DIR    = $(HOME)/.local/share/icons/hicolor/256x256/apps
ICON_DEST   = $(ICON_DIR)/$(SCRIPT_ID).png

.PHONY: all install uninstall package reload

all: package

## Build a .kwinscript zip for distribution / KDE Store upload
package:
	@echo "→ Packaging $(SCRIPT_ID).kwinscript..."
	@cp -r $(PACKAGE_DIR)/metadata.json metadata.json
	@zip -r $(SCRIPT_ID).kwinscript contents/ imgs/ metadata.json
	@rm metadata.json
	@echo "✓ Built $(SCRIPT_ID).kwinscript"

## Install directly into user's KWin scripts dir
install:
	@echo "→ Installing to $(INSTALL_DIR)..."
	@mkdir -p "$(INSTALL_DIR)"
	@# Remove the previously-installed payload so files deleted from source
	@# (e.g. a renamed config UI) don't linger. Scoped to our own contents/
	@# subdir rather than rm -rf'ing the whole target path.
	@rm -rf "$(INSTALL_DIR)/contents"
	@cp -r $(CONTENTS_DIR) "$(INSTALL_DIR)/"
	@cp $(PACKAGE_DIR)/metadata.json "$(INSTALL_DIR)/"
	@# Point the OSD icon at the absolute installed path. plasmashell's OSD does
	@# not reliably resolve our hicolor icon by theme name in a running session,
	@# but loads an absolute path fine (see CLAUDE.md "OSD icon"). We rewrite only
	@# the installed copy; the committed source keeps the portable theme name.
	@sed -i 's|^const OSD_ICON = .*@OSD_ICON@.*|const OSD_ICON = "$(ICON_DEST)"; /* @OSD_ICON@ */|' "$(INSTALL_DIR)/contents/code/main.js"
	@# Install the logo into the hicolor icon theme (still used by the plugin
	@# metadata / KCM listing, and as the OSD's portable fallback name).
	@mkdir -p "$(ICON_DIR)"
	@cp $(ICON_SRC) "$(ICON_DEST)"
	@# Rebuild KDE's plugin + icon caches so the KCM discovers a newly-added
	@# script and the new icon is picked up.
	@kbuildsycoca6 >/dev/null 2>&1 || true
	@gtk-update-icon-cache -qtf "$(HOME)/.local/share/icons/hicolor" >/dev/null 2>&1 || true
	@echo "✓ Installed. Enable in: System Settings → Window Management → KWin Scripts"

## Uninstall
uninstall:
	@echo "→ Removing $(INSTALL_DIR)..."
	@rm -rf $(INSTALL_DIR)
	@rm -f "$(ICON_DEST)"
	@echo "✓ Uninstalled."

## Reload the script without logging out (Wayland-safe).
## NOTE: a plain start() will NOT reload an already-running script, so we
## unloadScript first, then start. This is also how config changes get picked
## up (KWin doesn't notify scripts of config changes — they re-read on load).
QDBUS = $(shell command -v qdbus6 || command -v qdbus-qt6 || command -v qdbus)
reload:
	@echo "→ Reloading $(SCRIPT_ID)..."
	@$(QDBUS) org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript "$(SCRIPT_ID)" >/dev/null 2>&1 || true
	@$(QDBUS) org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null 2>&1 || true
	@echo "✓ Reloaded."

## Install + reload in one step (dev workflow)
dev: install reload

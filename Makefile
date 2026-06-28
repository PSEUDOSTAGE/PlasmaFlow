SCRIPT_ID   = cachy-tile
INSTALL_DIR = $(HOME)/.local/share/kwin/scripts/$(SCRIPT_ID)
PACKAGE_DIR = ./package
CONTENTS_DIR = ./contents

.PHONY: all install uninstall package reload

all: package

## Build a .kwinscript zip for distribution / KDE Store upload
package:
	@echo "→ Packaging $(SCRIPT_ID).kwinscript..."
	@cp -r $(PACKAGE_DIR)/metadata.json metadata.json
	@zip -r $(SCRIPT_ID).kwinscript contents/ metadata.json
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
	@# Rebuild KDE's plugin cache so the KCM discovers a newly-added script.
	@kbuildsycoca6 >/dev/null 2>&1 || true
	@echo "✓ Installed. Enable in: System Settings → Window Management → KWin Scripts"

## Uninstall
uninstall:
	@echo "→ Removing $(INSTALL_DIR)..."
	@rm -rf $(INSTALL_DIR)
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

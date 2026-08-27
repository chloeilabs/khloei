#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${COMPUTER_TOKEN:-}" ]]; then
  echo "COMPUTER_TOKEN is required for Khloei's desktop control service." >&2
  exit 1
fi

# Railway mounts an existing volume owned by the previous browser-only image as root. Initialize the
# single durable root and hand it to the desktop user before starting anything that can execute a
# command. The second invocation is permanently unprivileged and cannot recover capabilities.
if [[ "$(id -u)" == "0" ]]; then
  mkdir -p \
    /data/home \
    "${WORKSPACE_DIR:-/data/workspace}" \
    "${PROFILES_DIR:-/data/profiles}" \
    "${AUDIT_DIR:-/data/audit}"
  chown -R 1000:1000 \
    /data \
    "${WORKSPACE_DIR:-/data/workspace}" \
    "${PROFILES_DIR:-/data/profiles}" \
    "${AUDIT_DIR:-/data/audit}"
  exec setpriv \
    --reuid=1000 \
    --regid=1000 \
    --init-groups \
    --no-new-privs \
    --bounding-set=-all \
    --inh-caps=-all \
    --ambient-caps=-all \
    "$0" "$@"
fi

if [[ "$(id -u)" != "1000" ]]; then
  echo "Khloei's desktop must run as its unprivileged desktop user." >&2
  exit 1
fi

mkdir -p "${WORKSPACE_DIR:-/workspace}" "${PROFILES_DIR:-/profiles}" "${AUDIT_DIR:-/audit}"

DESKTOP_RESOLUTION="${KHLOEI_DESKTOP_RESOLUTION:-1920x1080}"
if [[ ! "$DESKTOP_RESOLUTION" =~ ^([0-9]{3,4})x([0-9]{3,4})$ ]]; then
  echo "Invalid Khloei desktop resolution: $DESKTOP_RESOLUTION" >&2
  exit 1
fi

# The durable volume starts empty. Seed the desktop entries on first boot only,
# so a person's later changes to their own desktop are never overwritten.
mkdir -p "$HOME/Desktop"
for entry in /etc/skel/Desktop/*.desktop; do
  [[ -e "$entry" ]] || continue
  target="$HOME/Desktop/$(basename "$entry")"
  [[ -e "$target" ]] || cp "$entry" "$target"
done

# One-time repair of a desktop inherited from the previous KasmVNC image.
#
# The volume outlived that image, so it still carries links into /home/kasm-user
# -- a user this image does not have -- and a launcher for Firefox, which it does
# not install. Both show up on the desktop and silently do nothing when clicked.
# Because seeding deliberately never overwrites an existing entry, they would
# otherwise persist forever.
#
# A marker makes this a migration rather than a policy: it runs once per volume,
# and afterwards a person's own desktop is left entirely alone, including any
# launcher they add for something not currently installed.
repair_inherited_desktop() {
  local marker="$HOME/.khloei/desktop-repair-v1"
  [[ -e "$marker" ]] && return 0
  mkdir -p "$(dirname "$marker")"

  local entry target moved program
  for entry in "$HOME"/Desktop/*; do
    [[ -e "$entry" || -L "$entry" ]] || continue

    if [[ -L "$entry" ]]; then
      target="$(readlink "$entry")"
      if [[ "$target" == /home/kasm-user/* ]]; then
        moved="$HOME/${target#/home/kasm-user/}"
        mkdir -p "$moved"
        ln -sfn "$moved" "$entry"
        echo "Repaired inherited desktop link $(basename "$entry") -> $moved." >&2
      fi
      continue
    fi

    if [[ "$entry" == *.desktop ]]; then
      program="$(sed -n 's/^Exec=//p' "$entry" | head -1 | awk '{print $1}')"
      if [[ -n "$program" ]] \
        && ! command -v "$program" >/dev/null 2>&1 \
        && [[ ! -x "$program" ]]; then
        rm -f "$entry"
        echo "Removed inherited launcher $(basename "$entry"); $program is not installed." >&2
      fi
    fi
  done

  : > "$marker"
}
repair_inherited_desktop

wait_for_display() {
  local wait_seconds="${KHLOEI_DESKTOP_STARTUP_TIMEOUT_SECONDS:-120}"
  local started_at="$SECONDS"
  while (( SECONDS - started_at < wait_seconds )); do
    if xdpyinfo -display "${DISPLAY:-:1}" >/dev/null 2>&1; then
      echo "Khloei's X11 desktop became available after $(( SECONDS - started_at ))s." >&2
      return 0
    fi
    sleep 0.5
  done
  echo "Khloei's X11 desktop did not become available within ${wait_seconds}s." >&2
  # The polling loop discards xdpyinfo's stderr, so a display that cannot be
  # opened at all looks exactly like one that is merely slow. Say which it was.
  xdpyinfo -display "${DISPLAY:-:1}" >&2 2>&1 || true
  echo "X sockets: $(ls -1 /tmp/.X11-unix 2>&1 | tr '\n' ' ')" >&2
  echo "Xvfb processes: $(pgrep -a -f Xvfb 2>&1 | head -3 | tr '\n' ' ')" >&2
  return 1
}

# Xvfb is given the geometry directly, so the display is correct from its first
# frame and no mode-setting is needed. -nolisten tcp keeps the display reachable
# only through its local socket.
Xvfb "${DISPLAY:-:1}" \
  -screen 0 "${DESKTOP_RESOLUTION}x24" \
  -nolisten tcp \
  -dpi 96 &
display_pid=$!

# Both remaining processes run as the image's unprivileged uid. Xfce owns the
# visible session; the Bun service owns Khloei's scoped agent and control API.
bun /app/services/computer/src/index.ts &
computer_pid=$!

if wait_for_display; then
  # Seed the wallpaper as configuration rather than setting it afterwards:
  # xfconf-query has to reach the session bus that xfce4-session owns, and a
  # command run outside that session silently talks to nothing.
  xfconf_dir="$HOME/.config/xfce4/xfconf/xfce-perchannel-xml"
  if [[ ! -e "$xfconf_dir/xfce4-desktop.xml" ]]; then
    mkdir -p "$xfconf_dir"
    cat > "$xfconf_dir/xfce4-desktop.xml" <<'XFCE'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-desktop" version="1.0">
  <property name="backdrop" type="empty">
    <property name="screen0" type="empty">
      <property name="monitorscreen" type="empty">
        <property name="workspace0" type="empty">
          <property name="image-style" type="int" value="5"/>
          <property name="last-image" type="string" value="/usr/share/backgrounds/khloei-wallpaper.png"/>
        </property>
      </property>
    </property>
  </property>
</channel>
XFCE
  fi

  # dbus-run-session gives Xfce the session bus it expects; without one the
  # panel and desktop silently decline to start.
  dbus-run-session -- xfce4-session &
  desktop_pid=$!
else
  # A desktop that will not start is a degraded computer, not a dead one. The
  # Bun service still serves the browser, files, the governed command runner
  # and /health, which reports `desktop.ready: false` so the failure is visible.
  echo "Khloei is serving without its Linux desktop; visual tools will refuse." >&2
  desktop_pid=""
fi

shutdown() {
  kill -TERM "$computer_pid" "$display_pid" ${desktop_pid:+"$desktop_pid"} 2>/dev/null || true
  wait "$computer_pid" "$display_pid" ${desktop_pid:+"$desktop_pid"} 2>/dev/null || true
}
trap shutdown INT TERM EXIT

# The control service failing makes the computer unusable and unauditable, so
# the orchestrator should restart the whole container rather than leave a live
# desktop with no policy gateway in front of it.
set +e
wait -n "$computer_pid" "$display_pid"
exit_code=$?
set -e
exit "$exit_code"

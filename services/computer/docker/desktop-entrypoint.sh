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

# KasmVNC supplies the desktop session but is not published by the default
# Compose file. Give its internal listener an ephemeral secret anyway, so an
# accidental future port mapping never exposes a default credential.
if [[ -z "${VNC_PW:-}" ]]; then
  VNC_PW="$(bun -e 'console.log(crypto.randomUUID().replaceAll("-", ""))')"
  export VNC_PW
fi
if [[ -z "${VNC_VIEW_ONLY_PW:-}" ]]; then
  VNC_VIEW_ONLY_PW="$(bun -e 'console.log(crypto.randomUUID().replaceAll("-", ""))')"
  export VNC_VIEW_ONLY_PW
fi

mkdir -p "${WORKSPACE_DIR:-/workspace}" "${PROFILES_DIR:-/profiles}" "${AUDIT_DIR:-/audit}"

configure_desktop_resolution() {
  local resolution="${KHLOEI_DESKTOP_RESOLUTION:-${VNC_RESOLUTION:-1920x1080}}"
  if [[ ! "$resolution" =~ ^([0-9]{3,4})x([0-9]{3,4})$ ]]; then
    echo "Invalid Khloei desktop resolution: $resolution" >&2
    return 1
  fi
  local width="${BASH_REMATCH[1]}"
  local height="${BASH_REMATCH[2]}"

  # X can take considerably longer to come up on a cold cloud host than on a
  # warm developer machine: the image is large, the disk is slower, and nothing
  # is cached. Waiting only 30s made the container kill itself mid-startup and
  # crash-loop until the platform healthcheck gave up, which reported as a
  # deployment failure with no obvious cause.
  local wait_seconds="${KHLOEI_DESKTOP_STARTUP_TIMEOUT_SECONDS:-300}"
  local started_at="$SECONDS"
  local output=""
  while (( SECONDS - started_at < wait_seconds )); do
    output="$(xrandr --display "${DISPLAY:-:1}" --query 2>/dev/null \
      | awk '$2 == "connected" { print $1; exit }')"
    [[ -n "$output" ]] && break
    sleep 0.5
  done
  if [[ -z "$output" ]]; then
    echo "Khloei's X11 desktop did not become available within ${wait_seconds}s." >&2
    # The polling loop discards xrandr's stderr, so a display that cannot be
    # opened at all looks exactly like one that is merely slow. Report what
    # xrandr actually says, once, along with enough context to tell "X never
    # started" apart from "X started and we cannot reach it".
    echo "--- desktop diagnosis ---" >&2
    xrandr --display "${DISPLAY:-:1}" --query >&2 2>&1 || true
    echo "X sockets: $(ls -1 /tmp/.X11-unix 2>&1 | tr '\n' ' ')" >&2
    echo "XAUTHORITY=${XAUTHORITY:-unset} DISPLAY=${DISPLAY:-unset} HOME=${HOME:-unset}" >&2
    echo "Xvnc processes: $(pgrep -a -f 'Xvnc|Xtigervnc' 2>&1 | head -3 | tr '\n' ' ')" >&2
    echo "vnc logs: $(ls -1 "${HOME:-/home/kasm-user}"/.vnc/*.log 2>&1 | tr '\n' ' ')" >&2
    tail -n 25 "${HOME:-/home/kasm-user}"/.vnc/*.log >&2 2>&1 || true
    echo "--- end desktop diagnosis ---" >&2
    return 1
  fi
  echo "Khloei's X11 desktop became available after $(( SECONDS - started_at ))s." >&2

  # KasmVNC 1.17 starts at 1024x768 even when VNC_RESOLUTION is supplied.
  # Add the requested mode explicitly so capture dimensions and pointer
  # coordinates always describe the actual desktop.
  local modeline
  modeline="$(cvt "$width" "$height" 60 | awk '/^Modeline / { $1=""; sub(/^ /, ""); print; exit }')"
  local mode_name clock h_display h_sync_start h_sync_end h_total
  local v_display v_sync_start v_sync_end v_total h_polarity v_polarity
  read -r mode_name clock h_display h_sync_start h_sync_end h_total \
    v_display v_sync_start v_sync_end v_total h_polarity v_polarity <<< "$modeline"
  mode_name="${mode_name#\"}"
  mode_name="${mode_name%\"}"
  [[ -n "$mode_name" && -n "$clock" ]] || return 1

  xrandr --display "${DISPLAY:-:1}" --newmode "$mode_name" "$clock" \
    "$h_display" "$h_sync_start" "$h_sync_end" "$h_total" \
    "$v_display" "$v_sync_start" "$v_sync_end" "$v_total" \
    "$h_polarity" "$v_polarity" 2>/dev/null || true
  xrandr --display "${DISPLAY:-:1}" --addmode "$output" "$mode_name" \
    2>/dev/null || true
  xrandr --display "${DISPLAY:-:1}" --output "$output" --mode "$mode_name"
}

# Both processes run as the image's unprivileged uid. Kasm owns the Linux
# desktop; the Bun service owns Khloei's scoped agent and human-control API.
bun /app/services/computer/src/index.ts &
computer_pid=$!

/dockerstartup/kasm_default_profile.sh \
  /dockerstartup/vnc_startup.sh &
desktop_pid=$!

# A desktop that will not start is a degraded computer, not a dead one. The Bun
# service still serves the browser, files, the governed command runner and, most
# importantly, /health -- which reports `desktop.ready: false` so the failure is
# visible. Killing the container here destroyed the only process able to explain
# what went wrong, and on a platform that restarts on failure it produced a
# crash loop whose logs were rotated away faster than they could be read.
if ! configure_desktop_resolution; then
  echo "Khloei is serving without its Linux desktop; visual tools will refuse." >&2
fi

shutdown() {
  kill -TERM "$computer_pid" "$desktop_pid" 2>/dev/null || true
  wait "$computer_pid" "$desktop_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

# Either half failing makes the desktop unhealthy. The orchestrator can then
# restart the complete computer instead of leaving a frozen viewer or a live
# desktop with no policy gateway.
set +e
wait -n "$computer_pid" "$desktop_pid"
exit_code=$?
set -e
exit "$exit_code"

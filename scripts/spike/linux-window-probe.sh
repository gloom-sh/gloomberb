#!/usr/bin/env bash
# Drives the app's main window under X11 (Xvfb + openbox) with xdotool and
# wmctrl, and writes what happened as JSON: frame hints, edge drags with the
# mouse, the minimum size, maximize, and closing the window.
#   linux-window-probe.sh <pid,pid,...> <out.json> [screenshot dir] [--list]
set -uo pipefail
pids="$1"
out="$2"
shots="${3:-}"
mode="${4:-}"

windows=()
for pid in ${pids//,/ }; do
  for id in $(xdotool search --onlyvisible --pid "$pid" 2>/dev/null); do windows+=("$id"); done
done

geometry() { # id -> "x y w h"
  local id="$1"
  eval "$(xdotool getwindowgeometry --shell "$id" 2>/dev/null)"
  echo "${X:-0} ${Y:-0} ${WIDTH:-0} ${HEIGHT:-0}"
}

main=""
best=0
for id in "${windows[@]}"; do
  read -r x y w h <<<"$(geometry "$id")"
  if (( w * h > best )); then best=$(( w * h )); main="$id"; fi
done

if [[ "$mode" == "--list" ]]; then
  {
    echo "{\"windows\":["
    first=1
    for id in "${windows[@]}"; do
      read -r x y w h <<<"$(geometry "$id")"
      (( first )) || echo ","
      first=0
      echo "{\"id\":$id,\"x\":$x,\"y\":$y,\"width\":$w,\"height\":$h}"
    done
    echo "]}"
  } > "$out"
  exit 0
fi

if [[ -z "$main" ]]; then
  echo "{\"error\":\"no visible window for pids $pids\"}" > "$out"
  exit 0
fi

shot() { [[ -n "$shots" ]] && mkdir -p "$shots" && import -window root "$shots/$1.png" 2>/dev/null || true; }
place() { xdotool windowsize "$main" 1000 680; xdotool windowmove "$main" 100 80; sleep 0.6; xdotool windowactivate "$main" 2>/dev/null; sleep 0.2; }

screen="$(xdpyinfo | awk '/dimensions:/ {print $2; exit}')"
hints="$(xprop -id "$main" WM_NORMAL_HINTS 2>/dev/null | tr '\n' ' ' | sed 's/"/\\"/g')"
motif="$(xprop -id "$main" _MOTIF_WM_HINTS 2>/dev/null | sed 's/"/\\"/g')"
frame_extents="$(xprop -id "$main" _NET_FRAME_EXTENTS _GTK_FRAME_EXTENTS 2>/dev/null | tr '\n' ' ' | sed 's/"/\\"/g')"

place
read -r sx sy sw sh <<<"$(geometry "$main")"
shot 01-start

drag() { # name fromX fromY dx dy
  place
  read -r bx by bw bh <<<"$(geometry "$main")"
  xdotool mousemove "$2" "$3"; sleep 0.15
  xdotool mousedown 1; sleep 0.1
  for i in $(seq 1 12); do xdotool mousemove "$(( $2 + $4 * i / 12 ))" "$(( $3 + $5 * i / 12 ))"; sleep 0.03; done
  sleep 0.1; xdotool mouseup 1; sleep 0.6
  read -r ax ay aw ah <<<"$(geometry "$main")"
  echo "\"$1\":{\"widthChange\":$(( aw - bw )),\"heightChange\":$(( ah - bh )),\"moved\":[$(( ax - bx )),$(( ay - by ))]}"
}
drags="$(drag rightEdge $(( sx + sw - 2 )) $(( sy + sh / 2 )) 150 0),$(drag rightEdgeOutside $(( sx + sw + 3 )) $(( sy + sh / 2 )) 150 0),$(drag leftEdge $(( sx + 1 )) $(( sy + sh / 2 )) -120 0),$(drag bottomRightCorner $(( sx + sw - 2 )) $(( sy + sh - 2 )) 120 90)"
shot 02-after-drags

place
xdotool windowsize "$main" 300 200; sleep 0.05
read -r _ _ iw ih <<<"$(geometry "$main")"
sleep 0.8
read -r _ _ lw lh <<<"$(geometry "$main")"

place
wmctrl -i -r "$main" -b add,maximized_vert,maximized_horz; sleep 1
read -r mx my mw mh <<<"$(geometry "$main")"
state="$(xprop -id "$main" _NET_WM_STATE 2>/dev/null | sed 's/"/\\"/g')"
shot 03-maximized
wmctrl -i -r "$main" -b remove,maximized_vert,maximized_horz; sleep 0.6

place
start=$(date +%s%3N)
wmctrl -i -c "$main"
left=1
while (( $(date +%s%3N) - start < 20000 )); do
  left=0
  for pid in ${pids//,/ }; do kill -0 "$pid" 2>/dev/null && left=$(( left + 1 )); done
  (( left == 0 )) && break
  sleep 0.05
done
closed=$(( $(date +%s%3N) - start ))

cat > "$out" <<EOF
{
  "screen": "$screen",
  "topLevelWindows": ${#windows[@]},
  "normalHints": "$hints",
  "motifHints": "$motif",
  "frameExtents": "$frame_extents",
  "startFrame": {"x":$sx,"y":$sy,"width":$sw,"height":$sh},
  "edgeDrag": {$drags},
  "minimumSize": {"asked":[300,200],"immediately":[$iw,$ih],"after800ms":[$lw,$lh]},
  "maximize": {"frame":{"x":$mx,"y":$my,"width":$mw,"height":$mh},"state":"$state"},
  "close": {"allExitedMs": $( (( left == 0 )) && echo "$closed" || echo null ), "stillRunning": $left}
}
EOF
cat "$out"

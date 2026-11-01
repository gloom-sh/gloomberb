#!/usr/bin/env bash
# Drives the app's main window through the accessibility API (System Events)
# and writes what happened as JSON: setting a frame, the minimum size, zoom
# (maximize), full screen, and closing the window. Needs the runner to allow
# System Events; when it does not, the JSON says so.
#   mac-window-probe.sh <pid,pid,...> <out.json> [screenshot dir]
set -uo pipefail
pids="$1"
out="$2"
shots="${3:-}"

script=$(cat <<'APPLESCRIPT'
on run argv
  set pidList to item 1 of argv
  set AppleScript's text item delimiters to ","
  set ids to text items of pidList
  set AppleScript's text item delimiters to ""
  tell application "System Events"
    set target to missing value
    repeat with i in ids
      try
        set p to first process whose unix id is (i as integer)
        if (count of windows of p) > 0 then
          set target to p
          exit repeat
        end if
      end try
    end repeat
    if target is missing value then return "{\"error\":\"no process with a window\"}"
    set w to window 1 of target
    set winCount to count of windows of target
    set position of w to {100, 80}
    set size of w to {1000, 680}
    delay 0.6
    set s1 to size of w
    set size of w to {300, 200}
    delay 0.1
    set sImmediate to size of w
    delay 0.8
    set sLater to size of w
    set size of w to {1000, 680}
    delay 0.5
    set zoomResult to "no zoom button"
    try
      click (first button of w whose subrole is "AXZoomButton")
      delay 1
      set zoomResult to (item 1 of (size of w) as text) & "x" & (item 2 of (size of w) as text)
      click (first button of w whose subrole is "AXZoomButton")
      delay 0.8
    end try
    set fsResult to "failed"
    try
      set value of attribute "AXFullScreen" of w to true
      delay 2.5
      set fsResult to (value of attribute "AXFullScreen" of w) as text
      set value of attribute "AXFullScreen" of w to false
      delay 2.5
    end try
    set btnList to ""
    try
      repeat with b in (every button of w)
        set btnList to btnList & (subrole of b) & " "
      end repeat
    end try
    return "{\"windows\":" & winCount & ",\"setFrame\":[" & (item 1 of s1) & "," & (item 2 of s1) & "],\"minimumSize\":{\"asked\":[300,200],\"immediately\":[" & (item 1 of sImmediate) & "," & (item 2 of sImmediate) & "],\"after800ms\":[" & (item 1 of sLater) & "," & (item 2 of sLater) & "]},\"zoom\":\"" & zoomResult & "\",\"fullScreen\":\"" & fsResult & "\",\"buttons\":\"" & btnList & "\"}"
  end tell
end run
APPLESCRIPT
)

if result=$(osascript -e "$script" "$pids" 2>&1); then
  echo "$result" > "$out"
else
  printf '{"error":%s}\n' "$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" > "$out"
fi
[[ -n "$shots" ]] && mkdir -p "$shots" && screencapture -x "$shots/mac.png" 2>/dev/null || true
cat "$out"

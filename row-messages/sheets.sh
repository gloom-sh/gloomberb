#!/bin/bash
# One sheet per case, state, theme and width: main on top, the branch below, each under a caption.
set -e
cd "$(dirname "$0")"
mkdir -p sheets
for head in raw/*-head.png; do
  base="${head%-head.png}-base.png"
  [ -f "$base" ] || continue
  name=$(basename "${head%-head.png}")
  width=$(magick identify -format %w "$head")
  top="main"; bottom="this branch"
  case "$name" in ibkr-*) top="plugin main"; bottom="plugin branch";; settings-*) top="main (plugin closes the dialog, toasts)"; bottom="this branch (plugin says it on the row)";; esac
  magick \( -size ${width}x28 xc:'#2a2a2a' -fill white -font /usr/share/fonts/truetype/freefont/FreeSans.ttf -pointsize 15 -gravity west -annotate +10+0 "$top" \) "$base" \
         \( -size ${width}x28 xc:'#2a2a2a' -fill white -font /usr/share/fonts/truetype/freefont/FreeSans.ttf -pointsize 15 -gravity west -annotate +10+0 "$bottom" \) "$head" \
         -append "sheets/$name.png"
done
ls sheets | wc -l

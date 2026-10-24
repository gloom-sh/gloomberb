#!/bin/bash
# CPU seconds a pid used over N seconds (utime+stime from /proc).
pid=$1; secs=${2:-3}
t() { awk '{print $14+$15}' /proc/$pid/stat; }
a=$(t); sleep $secs; b=$(t); hz=$(getconf CLK_TCK)
echo "cpu over ${secs}s: $(( (b-a)*1000/hz )) ms"

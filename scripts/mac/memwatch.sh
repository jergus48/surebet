#!/bin/bash
# Restart any bookmaker Chrome whose total memory (incl. compressed) grows past a limit.
# Long-running bookmaker tabs leak: renderers reach 2-3 GB each and push the Mac into swap.
# The bot relaunches a killed window on its next poll; logins stay in ~/surebet-profiles.
# Usage: bash scripts/mac/memwatch.sh [--dry]   (run every 10 min by com.surebet.memwatch)
LIMIT_MB="${MEMWATCH_LIMIT_MB:-1800}"
BET365_LIMIT_MB="${MEMWATCH_BET365_LIMIT_MB:-3000}"
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$DIR/data/memwatch.log"
PROFILES="${SUREBET_PROFILE_ROOT:-$HOME/surebet-profiles}"

# pid -> profile, for every process of a bookmaker Chrome
ps -axo pid=,command= | grep "Google Chrome" | grep -v grep | python3 -c '
import re,sys
for l in sys.stdin:
    m=re.match(r"\s*(\d+)\s.*user-data-dir=\S*?(chrome-[a-z0-9]+)",l)
    if m: print(m.group(1),m.group(2))' > /tmp/memwatch.pids.$$

# pid -> MEM (top counts compressed memory, ps rss does not)
top -l 1 -stats pid,mem 2>/dev/null | python3 -c '
import re,sys
mult={"B":1/1048576,"K":1/1024,"M":1,"G":1024}
for l in sys.stdin:
    m=re.match(r"\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMG])[+-]?\s*$",l)
    if m: print(m.group(1),float(m.group(2))*mult[m.group(3)])' > /tmp/memwatch.mem.$$

python3 - /tmp/memwatch.pids.$$ /tmp/memwatch.mem.$$ <<'PY' | while read prof mb; do
import sys,collections
pm=dict(l.split() for l in open(sys.argv[1]))
mem={k:float(v) for k,v in (l.split() for l in open(sys.argv[2]))}
tot=collections.Counter()
for pid,prof in pm.items(): tot[prof]+=mem.get(pid,0)
for prof,mb in tot.items(): print(prof,int(mb))
PY
  limit=$LIMIT_MB; [ "$prof" = "chrome-bet365" ] && limit=$BET365_LIMIT_MB
  if [ "$mb" -gt "$limit" ]; then
    if [ "$1" = "--dry" ]; then echo "$prof ${mb}MB > ${limit}MB: would restart"
    else
      echo "$(date -u +%FT%TZ) $prof ${mb}MB > ${limit}MB: restarting" >> "$LOG"
      pkill -f "user-data-dir=$PROFILES/$prof"
      sleep 20 # one window at a time, so the bot does not relaunch them in one burst
    fi
  elif [ "$1" = "--dry" ]; then echo "$prof ${mb}MB ok (limit ${limit})"; fi
done
rm -f /tmp/memwatch.pids.$$ /tmp/memwatch.mem.$$

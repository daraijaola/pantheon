#!/usr/bin/env bash
# Ship the site with no downtime: build into the slot that isn't serving (.next-a or .next-b), then switch
# to it and restart. `next build` in place wipes the folder the live site is serving from, so visitors got
# 502s for the whole build; this way they only see the restart, under a second.
#   web/scripts/deploy.sh          build, switch, restart, check
# Run it as micheal on the server, from anywhere. A failed build changes nothing: the old slot keeps serving.
set -euo pipefail
cd "$(dirname "$0")/.."

active=$(cat .dist-slot 2>/dev/null || echo .next)
if [ "$active" = .next-a ]; then next=.next-b; else next=.next-a; fi

echo "serving from $active; building into $next"
rm -rf "$next"
NEXT_DIST_DIR="$next" npx next build

# Pages already open in a browser still ask for the last build's CSS and JS: keep those files too.
if [ -d "$active/static" ]; then cp -Rn "$active/static/." "$next/static/" 2>/dev/null || true; fi

echo "$next" > .dist-slot
sudo -n systemctl restart pantheon-web
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null http://127.0.0.1:3000/; then
    echo "live from $next"
    exit 0
  fi
  sleep 0.5
done
echo "the site didn't answer after the switch; to go back: echo $active > web/.dist-slot && sudo systemctl restart pantheon-web" >&2
exit 1

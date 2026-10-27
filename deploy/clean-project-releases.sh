#!/bin/sh
# Run only after the new service passes health/version checks.
set -eu
[ "$#" -ge 2 ] || { echo "usage: $0 <current-tag> <rollback-tag> [referenced-tags...]" >&2; exit 1; }
CURRENT=$1
ROLLBACK=$2
shift 2
PROTECTED="$CURRENT $ROLLBACK $*"
PROJ=$(cd "$(dirname "$0")/.." && pwd)
RELEASES="$PROJ/releases"
valid_tag(){ printf '%s\n' "$1" | grep -Eq '^20[0-9]{2}-[0-9]{2}-[0-9]{2}\.r[1-9][0-9]*$'; }
valid_release(){
  valid_tag "$1" && [ ! -L "$RELEASES/$1" ] && [ -d "$RELEASES/$1" ] &&
    [ -f "$RELEASES/$1/manifest.release.json" ] && [ -f "$RELEASES/$1/VERSION" ] &&
    [ "$(tr -d '\r\n' < "$RELEASES/$1/VERSION")" = "$1" ] &&
    grep -Eq '"version"[[:space:]]*:[[:space:]]*"'"$1"'"' "$RELEASES/$1/manifest.release.json" &&
    [ -f "$RELEASES/$1/server.mjs" ] && [ -d "$RELEASES/$1/web" ] &&
    [ -d "$RELEASES/$1/data" ] && [ -d "$RELEASES/$1/build" ]
}
for tag in $PROTECTED; do valid_tag "$tag" || { echo "invalid protected tag: $tag" >&2; exit 1; }; done
[ -d "$RELEASES" ] && [ ! -L "$RELEASES" ] || { echo 'invalid releases directory' >&2; exit 1; }
for tag in "$CURRENT" "$ROLLBACK"; do
  valid_release "$tag" || { echo "protected release is missing or invalid: $tag" >&2; exit 1; }
done
for dir in "$RELEASES"/*; do
  tag=${dir##*/}
  case " $PROTECTED " in *" $tag "*) continue ;; esac
  # Preserve unrelated files, incomplete snapshots, links and future build candidates.
  if ! valid_release "$tag"; then echo "kept unrecognized release: $tag"; continue; fi
  older=$(awk -v candidate="$tag" -v current="$CURRENT" 'BEGIN {
    split(candidate,a,".r"); split(current,b,".r");
    print (a[1]<b[1] || (a[1]==b[1] && a[2]+0<b[2]+0)) ? 1 : 0
  }')
  [ "$older" = 1 ] || continue
  rm -rf -- "$dir"
  echo "removed release: $tag"
done
echo "retained releases current=$CURRENT rollback=$ROLLBACK referenced=$*"

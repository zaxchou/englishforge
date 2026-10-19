#!/bin/sh
# Only this project's tagged images. Retain current, newest rollback and referenced images.
set -eu
export PATH=/usr/local/bin:$PATH
docker_cmd(){
  if [ "$(id -u)" -eq 0 ]; then /usr/local/bin/docker "$@";
  else sudo -n /usr/local/bin/docker "$@"; fi
}
[ "$#" -eq 1 ] || { echo "usage: $0 <current-tag>" >&2; exit 1; }
CURRENT="$1"
case "$CURRENT" in ''|*[!a-zA-Z0-9_.-]*) echo 'invalid current tag' >&2; exit 1 ;; esac
CURRENT_ID=$(docker_cmd image inspect --format '{{.Id}}' "toefl-lab:$CURRENT")
CURRENT_CREATED=$(docker_cmd image inspect --format '{{.Created}}' "toefl-lab:$CURRENT")
CONTAINERS=$(docker_cmd ps -aq)
USED_IDS=""
for cid in $CONTAINERS; do
  image_id=$(docker_cmd inspect --type container --format '{{.Image}}' "$cid")
  USED_IDS="$USED_IDS $image_id"
done
TAGS=$(docker_cmd images toefl-lab --format '{{.Tag}}')
ROLLBACK=""
for tag in $TAGS; do
  case "$tag" in ''|'<none>'|*[!a-zA-Z0-9_.-]*) continue ;; esac
  image_id=$(docker_cmd image inspect --format '{{.Id}}' "toefl-lab:$tag")
  created=$(docker_cmd image inspect --format '{{.Created}}' "toefl-lab:$tag")
  [ "$image_id" = "$CURRENT_ID" ] && continue
  # Only older versions qualify for rollback or cleanup; retain newer build candidates.
  awk -v candidate="$created" -v current="$CURRENT_CREATED" 'BEGIN{exit !(candidate<current)}' || continue
  if [ -z "$ROLLBACK" ]; then ROLLBACK="$tag"; continue; fi
  case " $USED_IDS " in *" $image_id "*) echo "kept container-referenced image: toefl-lab:$tag"; continue ;; esac
  if ! docker_cmd image rm "toefl-lab:$tag"; then echo "kept referenced/unremovable image: toefl-lab:$tag" >&2; fi
done
echo "retained current=$CURRENT rollback=$ROLLBACK"

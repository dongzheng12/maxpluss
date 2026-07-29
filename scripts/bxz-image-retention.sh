#!/usr/bin/env bash
set -euo pipefail

KEEP_ROLLBACK_DAYS="${KEEP_ROLLBACK_DAYS:-14}"
KEEP_HISTORY="${KEEP_HISTORY:-5}"
APPLY=0

usage() {
  cat <<'EOF'
Usage:
  bxz-image-retention.sh [--apply]

Behavior:
  - default is dry-run: only print stats and deletion candidates
  - only --apply performs docker image deletion
  - deletion scope is limited to bxz-api / bxz-api-poc images
  - always keep images used by running containers
  - keep rollback-tagged images from the most recent 14 days
  - always keep the most recent 5 non-running bxz-api/bxz-api-poc images as history
  - fail closed if docker output cannot be parsed or running images cannot be resolved
EOF
}

abort() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --apply)
      APPLY=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

command -v docker >/dev/null 2>&1 || abort "docker not found in PATH"
command -v date >/dev/null 2>&1 || abort "date not found in PATH"
command -v sort >/dev/null 2>&1 || abort "sort not found in PATH"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ACTIVE_IDS="$TMP_DIR/active.ids"
SCOPED_IMAGES="$TMP_DIR/scoped-images.tsv"
SORTED_IMAGES="$TMP_DIR/scoped-images.sorted.tsv"
HISTORY_KEEP_IDS="$TMP_DIR/history-keep.ids"
DELETE_IMAGES="$TMP_DIR/delete-images.tsv"
KEEP_IMAGES="$TMP_DIR/keep-images.tsv"

touch "$ACTIVE_IDS" "$SCOPED_IMAGES" "$SORTED_IMAGES" "$HISTORY_KEEP_IDS" "$DELETE_IMAGES" "$KEEP_IMAGES"

now_epoch="$(date +%s)" || abort "cannot read current time"
rollback_cutoff_epoch="$((now_epoch - KEEP_ROLLBACK_DAYS * 86400))"

mapfile -t running_refs < <(docker ps --format '{{.Image}}')
if [[ "${#running_refs[@]}" -eq 0 ]]; then
  abort "no running containers found; refusing to evaluate image retention"
fi

for ref in "${running_refs[@]}"; do
  [[ -n "$ref" ]] || continue
  docker image inspect "$ref" --format '{{.Id}}' >> "$ACTIVE_IDS" \
    || abort "cannot resolve running image: $ref"
done
sort -u "$ACTIVE_IDS" -o "$ACTIVE_IDS"

if [[ ! -s "$ACTIVE_IDS" ]]; then
  abort "active image id set is empty"
fi

mapfile -t image_ids < <(docker image ls --no-trunc --format '{{.ID}}' | sort -u)
if [[ "${#image_ids[@]}" -eq 0 ]]; then
  abort "docker image list is empty"
fi

for image_id in "${image_ids[@]}"; do
  [[ -n "$image_id" ]] || continue

  repo_tags="$(docker image inspect "$image_id" --format '{{join .RepoTags ","}}')" \
    || abort "cannot inspect image tags: $image_id"
  created="$(docker image inspect "$image_id" --format '{{.Created}}')" \
    || abort "cannot inspect image created time: $image_id"
  size="$(docker image inspect "$image_id" --format '{{.Size}}')" \
    || abort "cannot inspect image size: $image_id"

  [[ -n "$repo_tags" && "$repo_tags" != "<none>:<none>" ]] || continue
  [[ -n "$created" ]] || abort "empty created time for image: $image_id"
  [[ "$size" =~ ^[0-9]+$ ]] || abort "invalid size for image $image_id: $size"

  if [[ ! "$repo_tags" =~ (^|,)(bxz-api|bxz-api-poc): ]]; then
    continue
  fi

  created_epoch="$(date -d "$created" +%s)" \
    || abort "cannot parse image created time for $image_id: $created"
  printf '%s\t%s\t%s\t%s\t%s\n' "$created_epoch" "$image_id" "$repo_tags" "$created" "$size" >> "$SCOPED_IMAGES"
done

if [[ ! -s "$SCOPED_IMAGES" ]]; then
  abort "no bxz-api/bxz-api-poc images found"
fi

sort -rn "$SCOPED_IMAGES" > "$SORTED_IMAGES"

awk -F '\t' -v active_file="$ACTIVE_IDS" '
  BEGIN {
    while ((getline id < active_file) > 0) active[id] = 1
  }
  !(($2) in active) { print $2 }
' "$SORTED_IMAGES" | head -n "$KEEP_HISTORY" > "$HISTORY_KEEP_IDS"

total_count=0
active_count=0
rollback_keep_count=0
history_keep_count=0
delete_count=0
total_bytes=0
delete_bytes=0

while IFS=$'\t' read -r created_epoch image_id repo_tags created size; do
  (( total_count += 1 ))
  (( total_bytes += size ))

  reason=""
  if grep -Fqx "$image_id" "$ACTIVE_IDS"; then
    reason="active"
    (( active_count += 1 ))
  elif [[ "$repo_tags" == *rollback* && "$created_epoch" -ge "$rollback_cutoff_epoch" ]]; then
    reason="rollback_within_${KEEP_ROLLBACK_DAYS}d"
    (( rollback_keep_count += 1 ))
  elif grep -Fqx "$image_id" "$HISTORY_KEEP_IDS"; then
    reason="history_top_${KEEP_HISTORY}"
    (( history_keep_count += 1 ))
  else
    reason="delete"
    (( delete_count += 1 ))
    (( delete_bytes += size ))
    printf '%s\t%s\t%s\t%s\t%s\n' "$created_epoch" "$image_id" "$repo_tags" "$created" "$size" >> "$DELETE_IMAGES"
    continue
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$reason" "$created_epoch" "$image_id" "$repo_tags" "$created" "$size" >> "$KEEP_IMAGES"
done < "$SORTED_IMAGES"

if [[ -s "$DELETE_IMAGES" ]]; then
  while IFS=$'\t' read -r _created_epoch image_id _repo_tags _created _size; do
    if grep -Fqx "$image_id" "$ACTIVE_IDS"; then
      abort "candidate intersects active image set: $image_id"
    fi
  done < "$DELETE_IMAGES"
fi

bytes_to_human() {
  local bytes="$1"
  awk -v b="$bytes" '
    BEGIN {
      split("B KB MB GB TB", units, " ")
      i = 1
      while (b >= 1024 && i < 5) {
        b /= 1024
        i++
      }
      printf "%.2f %s", b, units[i]
    }
  '
}

echo "== bxz-image-retention =="
if (( APPLY == 1 )); then
  echo "mode=APPLY"
else
  echo "mode=DRY_RUN"
fi
echo "scope=bxz-api,bxz-api-poc"
echo "keep_rollback_days=$KEEP_ROLLBACK_DAYS"
echo "keep_history=$KEEP_HISTORY"
echo "rollback_cutoff_epoch=$rollback_cutoff_epoch"
echo
echo "== Current Image Stats =="
echo "scoped_image_count=$total_count"
echo "active_keep_count=$active_count"
echo "rollback_keep_count=$rollback_keep_count"
echo "history_keep_count=$history_keep_count"
echo "delete_count=$delete_count"
echo "total_bytes=$total_bytes"
echo "total_human=$(bytes_to_human "$total_bytes")"
echo
echo "== Active Protected Image IDs =="
cat "$ACTIVE_IDS"
echo
echo "== Kept Images =="
if [[ -s "$KEEP_IMAGES" ]]; then
  awk -F '\t' '{ print $1 "\t" $3 "\t" $4 "\t" $5 }' "$KEEP_IMAGES"
else
  echo "(none)"
fi
echo
echo "== Deletion Candidates =="
if [[ -s "$DELETE_IMAGES" ]]; then
  awk -F '\t' '{ print $2 "\t" $3 "\t" $4 "\t" $5 }' "$DELETE_IMAGES"
else
  echo "(none)"
fi
echo
echo "== Post-Deletion Projection =="
echo "delete_bytes=$delete_bytes"
echo "delete_human=$(bytes_to_human "$delete_bytes")"
echo "remaining_bytes=$((total_bytes - delete_bytes))"
echo "remaining_human=$(bytes_to_human "$((total_bytes - delete_bytes))")"

if (( APPLY == 0 )); then
  echo
  echo "Dry-run only. Re-run with --apply to delete the candidate images above."
  exit 0
fi

if [[ ! -s "$DELETE_IMAGES" ]]; then
  echo
  echo "No deletion candidates. Nothing to delete."
  exit 0
fi

echo
echo "== Applying Deletion =="
while IFS=$'\t' read -r _created_epoch image_id repo_tags _created _size; do
  current_active="$(docker ps --format '{{.Image}}' | xargs -r docker image inspect --format '{{.Id}}' | sort -u)"
  if printf '%s\n' "$current_active" | grep -Fqx "$image_id"; then
    abort "candidate became active before deletion: $image_id"
  fi
  echo "Deleting: $image_id $repo_tags"
  docker rmi -f "$image_id"
done < "$DELETE_IMAGES"

echo
echo "== Rechecking Docker System DF =="
docker system df

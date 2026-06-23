#!/bin/bash

set -e

MODE="${1}"
shift || true

if [ "$MODE" = "hash" ]; then
  # Docker tags allow only [A-Za-z0-9_.-]; map any other char (e.g. the "/" in
  # feat/truenas) to "-" so branch names are usable as tags. $() has already
  # stripped the trailing newline, so tr only sees the branch name.
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  BRANCH=$(printf '%s' "$BRANCH" | tr -c 'A-Za-z0-9_.-' '-')
  HASH=$(git rev-parse --short HEAD)
  TAG="${BRANCH}-${HASH}"
elif [ "$MODE" = "ts" ]; then
  TAG="manual-$(date +%Y%m%d-%H%M)"
else
  echo "Usage: $0 [hash|ts] [docker build args...]"
  exit 1
fi

IMAGE="registry.kieffer.me/k8s-iscsi-viewer:${TAG}"

echo "Building and pushing $IMAGE"

docker build -t "$IMAGE" "$@" . && \
    docker push "$IMAGE" && \
    echo "Done! Image pushed as $IMAGE"

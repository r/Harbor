#!/bin/sh
# Xcode Run Script phase, after Copy Bundle Resources and before app signing.
set -eu

: "${TARGET_BUILD_DIR:?Run as a Harbor app build phase}"
: "${UNLOCALIZED_RESOURCES_FOLDER_PATH:?Missing bundle resources directory}"
repo=$(cd "$(dirname "$0")/../.." && pwd)
built="$repo/bridge-rs/target/release"
resources="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
install -d "$resources"
install -m 755 "$built/harbor-bridge" "$resources/harbor-bridge"
if [ -f "$built/harbor-apple-model" ]; then
    install -m 755 "$built/harbor-apple-model" "$resources/harbor-apple-model"
elif [ -f "$resources/harbor-apple-model" ]; then
    rm "$resources/harbor-apple-model"
fi
if [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
    for binary in "$resources/harbor-bridge" "$resources/harbor-apple-model"; do
        if [ -f "$binary" ]; then
            codesign --force --options runtime --sign "$EXPANDED_CODE_SIGN_IDENTITY" "$binary"
        fi
    done
fi

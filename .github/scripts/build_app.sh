#!/bin/sh
# Builds MCPSafari.app with Xcode, then takes the build back out of Launch
# Services, so the only copy of the Safari extension that macOS knows about is
# the one you install.
#
#   .github/scripts/build_app.sh <derived-data-path> [Debug|Release] [xcodebuild arguments...]
#
# Xcode registers every macOS app it builds, and no build setting turns that off.
# With a build registered beside the installed app, Safari can run both copies
# of the extension: each numbers tabs its own way and both connect as the same
# profile, so tab handles change between calls. The build is unregistered even
# when it fails. Safari may still notice it for the moment between the two, so
# don't build while an agent is driving Safari.
set -eu

if [ $# -lt 1 ]; then
    echo "usage: $0 <derived-data-path> [Debug|Release] [xcodebuild arguments...]" >&2
    exit 64
fi
derived=$1
shift
configuration=Release
case "${1:-}" in
    Debug|Release) configuration=$1; shift ;;
esac

app="$derived/Build/Products/$configuration/MCPSafari.app"
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
unregister() {
    if [ -d "$app" ]; then
        "$lsregister" -u "$app"
    fi
}
trap unregister EXIT

cd "$(dirname "$0")/../../MCPSafari"
xcodebuild -project MCPSafari.xcodeproj -scheme MCPSafari -configuration "$configuration" \
    -derivedDataPath "$derived" "$@" build
echo "Built $app and unregistered it from Launch Services. Install it into /Applications to use it."

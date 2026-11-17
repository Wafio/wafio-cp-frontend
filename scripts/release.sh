#!/usr/bin/env bash
# Build the dashboard for a release and pack it as build/wafio-frontend-<version>.tar.gz.
#
#   scripts/release.sh v2.0.0               build the archive
#   scripts/release.sh v2.0.0 --publish     also create the GitHub release with the archive
#
# The archive holds one top directory, wafio-frontend-<version>/, with the contents of dist/, among them
# NOTICES.txt: the licence texts of the npm packages in the bundle.
# The app is built with the base path /__WAFIO_BASE__ (BASE_PATH and VITE_API_BASE_URL), so one
# archive can be served at the root or under any path: the control plane installer replaces the
# placeholder with the path chosen at install time. The control plane release downloads this
# archive (gh release download) and unpacks it into the bundle's frontend/ directory.
#
# --publish needs a clean tree with HEAD tagged <version> and pushed, and an authenticated gh.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

version=${1:-}
flag=${2:-}
re='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
if [[ ! $version =~ $re ]] || [[ -n $flag && $flag != --publish ]]; then
  echo "usage: scripts/release.sh vX.Y.Z[-rc.N] [--publish]" >&2
  exit 1
fi

if [ "$flag" = --publish ]; then
  [ -z "$(git status --porcelain)" ] || { echo "working tree is not clean" >&2; exit 1; }
  [ "$(git rev-parse "$version^{commit}" 2>/dev/null)" = "$(git rev-parse HEAD)" ] ||
    { echo "HEAD is not tagged $version" >&2; exit 1; }
elif [ -n "$(git status --porcelain)" ]; then
  echo "note: the working tree has uncommitted changes; they are in this build" >&2
fi

name=wafio-frontend-$version
rm -rf dist "build/$name" "build/$name.tar.gz"
bun install --frozen-lockfile
BASE_PATH=/__WAFIO_BASE__ VITE_API_BASE_URL=/__WAFIO_BASE__ bun run build
# The build writes dist/NOTICES.txt (scripts/licence-notices.js); the control plane release appends it to its notices.
grep -qF 'notices of the bundled npm packages' dist/NOTICES.txt ||
  { echo "release: the build wrote no dist/NOTICES.txt with the npm package notices" >&2; exit 1; }

mkdir -p "build/$name"
cp -R dist/. "build/$name/"
tar -czf "build/$name.tar.gz" -C build "$name"
rm -rf "build/$name"
echo "built build/$name.tar.gz"

if [ "$flag" = --publish ]; then
  extra=()
  [[ $version == *-* ]] && extra+=(--prerelease)
  gh release create "$version" "build/$name.tar.gz" --verify-tag --title "$version" \
    --notes "Dashboard build for $version, built with the base path placeholder /__WAFIO_BASE__." "${extra[@]+"${extra[@]}"}"
fi

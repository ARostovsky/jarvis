#!/usr/bin/env bash
# Usage: wiki-sync.sh <wiki-dir> <owner/repo>
# Renders README.md and docs/*.md into <wiki-dir> as wiki pages. Run from the repo root.
# Pages this script wrote start with a marker line; only those are deleted before a rewrite.
set -euo pipefail
out=$1 repo=$2
marker='_Generated from'

# Rewrites markdown links from <base>-relative to wiki pages or absolute GitHub URLs.
# shortcut: inline links only (no reference-style or HTML), enough for the current docs.
rewrite() {
  local base=$1
  [[ -n $base ]] && sed -E "s#\]\(([^#:)/.][^:)]*)\)#](${base}\1)#g; s#\]\(\.\./#](#g" || cat
}
render() {
  sed -E \
    -e 's#\]\(README\.md(\#[^)]*)?\)#](@wiki:Home\1)#g' \
    -e 's#\]\(docs/([^/)\#]+)\.md(\#[^)]*)?\)#](@wiki:\1\2)#g' \
    -e "s#\]\(([^:@)\#]+\.(png|webp|jpe?g|gif|svg))\)#](https://raw.githubusercontent.com/$repo/main/\1)#g" \
    -e "s#\]\(([^:@)\#]+)\)#](https://github.com/$repo/blob/main/\1)#g" \
    -e 's#\]\(@wiki:#](#g'
}

for f in "$out"/*.md; do
  [[ -e $f ]] && [[ $(head -n1 "$f") == "$marker"* ]] && rm "$f"
done

page() { # <source> <page> <base>
  { echo "$marker [\`$1\`](https://github.com/$repo/blob/main/$1) in the repo; edit it there._"
    echo
    rewrite "$3" < "$1" | render; } > "$out/$2.md"
}
page README.md Home ""
for f in docs/*.md; do n=$(basename "$f" .md); page "$f" "$n" docs/; done

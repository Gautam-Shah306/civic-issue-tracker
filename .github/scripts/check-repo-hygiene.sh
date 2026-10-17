#!/bin/sh
set -e

ERRORS=0

# (i) no tracked text file with CRLF or mixed line endings (ignore binary files)
if git ls-files --eol | grep -E "^i/(crlf|mixed)"; then
  echo "Violation: Tracked files with CRLF or mixed line endings found."
  ERRORS=1
fi

# (ii) no tracked file named `.env`, `*.tfstate*`, `*.tfplan`, `*.pem`, `*.key`, `*.p12`, or `*.tfvars` (but allow `*.example` and `*.smoke.env`)
if git ls-files | awk -F/ '($NF ~ /(\.env$|\.tfstate.*$|\.tfplan$|\.pem$|\.key$|\.p12$|\.tfvars$)/ && $NF !~ /(\.example$|\.smoke\.env$)/) { print $0; found=1 } END { exit !found }'; then
  echo "Violation: Banned file names found in tracked files."
  ERRORS=1
fi

# (ii-b) no tracked *.smoke.env file may contain a value longer than 80 characters
for smoke_file in $(git ls-files '*.smoke.env' '**/*.smoke.env' 2>/dev/null | uniq); do
  [ -e "$smoke_file" ] || continue
  awk -F= '
    /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=/ {
      val = $0
      sub(/^[^=]+=/, "", val)
      if (length(val) > 80) {
        print FILENAME ":" NR ": Violation: smoke.env value exceeds 80 characters (length=" length(val) ") -> " substr(val, 1, 20) "..."
        err = 1
      }
    }
    END { exit err }
  ' "$smoke_file" || ERRORS=1
done

# (iii) every `uses:` in .github/workflows/*.yml and .github/workflows/*.yaml is either a local `./` path or pinned to a 40-char hex SHA
for wf in .github/workflows/*.yml .github/workflows/*.yaml; do
  [ -e "$wf" ] || continue
  awk '/^[[:space:]]*-?[[:space:]]*uses:/ {
    val = $0; sub(/^[[:space:]]*-?[[:space:]]*uses:[[:space:]]*/, "", val);
    if (val !~ /^\.\// && val !~ /@[a-fA-F0-9]{40}/) {
      print FILENAME ":" NR ": Violation: unpinned uses -> " $0
      exit 1
    }
  }' "$wf" || ERRORS=1
  
  # (iv) every workflow file has a top-level `permissions:` key and none contains `pull_request_target`
  if ! grep -q "^permissions:" "$wf"; then
    echo "Violation: $wf missing top-level permissions:"
    ERRORS=1
  fi
  if grep -q "pull_request_target" "$wf"; then
    echo "Violation: $wf contains pull_request_target"
    ERRORS=1
  fi
done

# (v) every package.json has only exact dependency and devDependency versions (no ^ ~ > < * latest or ranges; engines block exempt)
# (vi) a package-lock.json sits next to every package.json
# (vii) a .npmrc next to every package.json contains min-release-age=7 and ignore-scripts=true
for pkg in $(git ls-files '**/package.json' 'package.json' 2>/dev/null); do
  [ -e "$pkg" ] || continue
  pkg_dir=$(dirname "$pkg")

  # (v) Check exact versions in dependencies and devDependencies
  awk '
    BEGIN { in_dep = 0; err = 0 }
    /^[[:space:]]*"(dependencies|devDependencies)"[[:space:]]*:[[:space:]]*\{/ { in_dep = 1; next }
    in_dep && /^[[:space:]]*\}/ { in_dep = 0; next }
    in_dep && /^[[:space:]]*"[^"]+"[[:space:]]*:[[:space:]]*"[^"]+"/ {
      val = $0
      sub(/^[[:space:]]*"[^"]+"[[:space:]]*:[[:space:]]*"/, "", val)
      sub(/".*$/, "", val)
      if (val ~ /[\^~><*|]|latest| - / || val !~ /^[0-9]+\.[0-9]+\.[0-9]+([+-].*)?$/) {
        print FILENAME ":" NR ": Violation: non-exact version in " FILENAME " -> " $0
        err = 1
      }
    }
    END { exit err }
  ' "$pkg" || ERRORS=1

  # (vi) package-lock.json must sit next to package.json
  if [ ! -f "$pkg_dir/package-lock.json" ]; then
    echo "Violation: Missing package-lock.json in $pkg_dir"
    ERRORS=1
  fi

  # (vii) .npmrc must sit next to package.json and contain min-release-age=7 and ignore-scripts=true
  if [ ! -f "$pkg_dir/.npmrc" ]; then
    echo "Violation: Missing .npmrc in $pkg_dir"
    ERRORS=1
  else
    if ! grep -q "^min-release-age=7" "$pkg_dir/.npmrc"; then
      echo "Violation: $pkg_dir/.npmrc missing min-release-age=7"
      ERRORS=1
    fi
    if ! grep -q "^ignore-scripts=true" "$pkg_dir/.npmrc"; then
      echo "Violation: $pkg_dir/.npmrc missing ignore-scripts=true"
      ERRORS=1
    fi
  fi
done

# (viii) every pyproject.toml has exact == pins for dependencies and dev dependencies
# (ix) a uv.lock sits next to every pyproject.toml
# (x) [tool.uv] exclude-newer must exist in every pyproject.toml
for pyproj in $(git ls-files '**/pyproject.toml' 'pyproject.toml' 2>/dev/null; find services -name pyproject.toml 2>/dev/null); do
  [ -e "$pyproj" ] || continue
  pyproj_dir=$(dirname "$pyproj")

  awk '
    BEGIN { in_deps = 0; err = 0 }
    /^[[:space:]]*(dependencies|dev)[[:space:]]*=[[:space:]]*\[/ { in_deps = 1; next }
    in_deps && /^[[:space:]]*\]/ { in_deps = 0; next }
    in_deps && /^[[:space:]]*"[^"]+"/ {
      val = $0
      sub(/^[[:space:]]*"/, "", val)
      sub(/".*$/, "", val)
      if (val !~ /==[[:space:]]*[0-9]/ || val ~ /[><~^]/) {
        print FILENAME ":" NR ": Violation: non-exact == pin in " FILENAME " -> " $0
        err = 1
      }
    }
    END { exit err }
  ' "$pyproj" || ERRORS=1

  if [ ! -f "$pyproj_dir/uv.lock" ]; then
    echo "Violation: Missing uv.lock in $pyproj_dir"
    ERRORS=1
  fi

  if ! grep -q 'exclude-newer' "$pyproj"; then
    echo "Violation: $pyproj missing exclude-newer in [tool.uv]"
    ERRORS=1
  fi
done

if [ $ERRORS -ne 0 ]; then
  exit 1
fi

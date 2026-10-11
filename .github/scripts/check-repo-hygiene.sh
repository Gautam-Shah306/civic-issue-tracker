#!/bin/sh
set -e

ERRORS=0

# (i) no tracked text file with CRLF or mixed line endings (ignore binary files)
if git ls-files --eol | grep -E "^i/(crlf|mixed)"; then
  echo "Violation: Tracked files with CRLF or mixed line endings found."
  ERRORS=1
fi

# (ii) no tracked file named `.env`, `*.tfstate*`, `*.tfplan`, `*.pem`, `*.key`, `*.p12`, or `*.tfvars` (but allow `*.example`)
if git ls-files | awk -F/ '($NF ~ /(\.env$|\.tfstate.*$|\.tfplan$|\.pem$|\.key$|\.p12$|\.tfvars$)/ && $NF !~ /\.example$/) { print $0; found=1 } END { exit !found }'; then
  echo "Violation: Banned file names found in tracked files."
  ERRORS=1
fi

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

if [ $ERRORS -ne 0 ]; then
  exit 1
fi

#!/bin/sh
set -e

COMPOSE_FILE="${1:-deploy/compose/docker-compose.yml}"
ERRORS=0

echo "Checking $COMPOSE_FILE..."

# (i) no `latest` tag in any image
if grep -n 'image:.*:latest' "$COMPOSE_FILE"; then
  echo "Violation: 'latest' tag found."
  ERRORS=1
fi

# (ii) every `image:` value contains `@sha256:` followed by 64 hex characters
awk '/^[[:space:]]+image:[[:space:]]+/ {
  if ($0 !~ /@sha256:[a-fA-F0-9]{64}/) {
    print NR ": Violation: Missing or invalid sha256 digest in image -> " $0
    exit 1
  }
}' "$COMPOSE_FILE" || ERRORS=1

# (iii) every entry under a `ports:` list starts with `127.0.0.1:` (with or without quotes)
awk '
/^[[:space:]]*ports:/ { in_ports=1; next }
/^[[:space:]]*[a-zA-Z0-9_-]+:/ { in_ports=0 }
in_ports && /^[[:space:]]*-/ {
  val = $0; sub(/^[[:space:]]*-+[[:space:]]*/, "", val); gsub(/["\x27]/, "", val);
  if (val !~ /^127\.0\.0\.1:/) {
    print NR ": Violation: Port mapping does not bind to 127.0.0.1 -> " $0
    exit 1
  }
}' "$COMPOSE_FILE" || ERRORS=1

# (iv) no default-value syntax `${VAR:-` or `${VAR-` outside `$${...}` shell variables.
awk '
  {
    testline = $0
    gsub(/\$\$\{[^}]*\}/, "", testline)
    if (testline ~ /\$\{[A-Za-z_][A-Za-z0-9_]*:-/ || testline ~ /\$\{[A-Za-z_][A-Za-z0-9_]*-/) {
      print NR ": Violation: Default-value syntax found outside $$ -> " $0
      exit 1
    }
  }
' "$COMPOSE_FILE" || ERRORS=1

if [ $ERRORS -ne 0 ]; then
  exit 1
fi

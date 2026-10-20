#!/bin/sh
set -eu

# check-allowlist.sh: Validates .github/security/vuln-allowlist.txt
# Validates format: ID|reason|YYYY-MM-DD
# Fails on malformed line, missing reason, or expired date.
# Prints valid vulnerability IDs to stdout (one per line).

ALLOWLIST_FILE="${1:-.github/security/vuln-allowlist.txt}"

if [ ! -f "${ALLOWLIST_FILE}" ]; then
    echo "ERROR: Allowlist file not found: ${ALLOWLIST_FILE}" >&2
    exit 1
fi

TODAY_UTC=$(date -u +%Y-%m-%d 2>/dev/null || date +%Y-%m-%d)
TODAY_INT=$(echo "${TODAY_UTC}" | tr -d '-')

line_num=0
has_errors=0

while IFS= read -r line || [ -n "${line}" ]; do
    line_num=$((line_num + 1))

    # Strip trailing carriage return if present
    line=$(echo "${line}" | tr -d '\r')

    # Skip comments and blank lines
    case "${line}" in
        \#*|"")
            continue
            ;;
    esac

    # Validate exactly 3 pipe-separated fields
    num_fields=$(echo "${line}" | awk -F'|' '{print NF}')
    if [ "${num_fields}" -ne 3 ]; then
        echo "ERROR: [line ${line_num}] Malformed line (expected 3 fields separated by '|'): ${line}" >&2
        has_errors=1
        continue
    fi

    vuln_id=$(echo "${line}" | cut -d'|' -f1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    reason=$(echo "${line}" | cut -d'|' -f2 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    expiry=$(echo "${line}" | cut -d'|' -f3 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

    if [ -z "${vuln_id}" ]; then
        echo "ERROR: [line ${line_num}] Missing vulnerability ID: ${line}" >&2
        has_errors=1
        continue
    fi

    if [ -z "${reason}" ]; then
        echo "ERROR: [line ${line_num}] Missing reason for ${vuln_id}: ${line}" >&2
        has_errors=1
        continue
    fi

    # Validate date format YYYY-MM-DD
    case "${expiry}" in
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
            ;;
        *)
            echo "ERROR: [line ${line_num}] Invalid expiry date format (expected YYYY-MM-DD): ${expiry}" >&2
            has_errors=1
            continue
            ;;
    esac

    expiry_int=$(echo "${expiry}" | tr -d '-')
    if [ "${expiry_int}" -lt "${TODAY_INT}" ]; then
        echo "ERROR: [line ${line_num}] Allowlist entry ${vuln_id} expired on ${expiry} (today: ${TODAY_UTC})" >&2
        has_errors=1
        continue
    fi

    # Print the validated vulnerability ID to stdout
    echo "${vuln_id}"
done < "${ALLOWLIST_FILE}"

if [ "${has_errors}" -ne 0 ]; then
    exit 1
fi

#!/bin/sh
set -eu

# gate-check.sh: Evaluates workflow runs for a commit gate.
# Reads GitHub Actions runs JSON from stdin and takes the current run ID as $1.
# Exit codes:
#   0  = all done and green
#   10 = still pending
#   1  = failed or CI run missing

CURRENT_RUN_ID="${1:-}"

# Read full JSON from stdin into a temporary file
TMP_JSON=$(mktemp)
trap 'rm -f "${TMP_JSON}"' EXIT INT TERM
cat > "${TMP_JSON}"

if ! jq -e '.workflow_runs' "${TMP_JSON}" >/dev/null 2>&1; then
    echo "ERROR: Invalid runs JSON provided on stdin" >&2
    exit 1
fi

PENDING_COUNT=0
FAILED_COUNT=0
CI_GREEN=0

# Process runs line by line using jq TSV output
# Columns: id, name, event, path, status, conclusion
# shellcheck disable=SC2016
RUNS_DATA=$(jq -r '
  .workflow_runs[] |
  [
    (.id | tostring),
    .name,
    .event,
    (.path // ""),
    .status,
    (.conclusion // "in_progress")
  ] | @tsv
' "${TMP_JSON}")

OLD_IFS="$IFS"
IFS='	'

while read -r run_id run_name run_event run_path run_status run_conclusion; do
    [ -z "${run_id}" ] && continue

    # Check 1: Ignore current run
    if [ -n "${CURRENT_RUN_ID}" ] && [ "${run_id}" = "${CURRENT_RUN_ID}" ]; then
        echo "ignored: ${run_name} (reason: current run ${run_id})"
        continue
    fi

    # Check 2: Ignore ONLY Dependabot update runs
    case "${run_path}" in
        dynamic/dependabot/*)
            if [ "${run_event}" = "dynamic" ]; then
                echo "ignored: ${run_name} (reason: Dependabot update run)"
                continue
            fi
            ;;
    esac

    # Track CI workflow run
    if [ "${run_name}" = "CI" ]; then
        if [ "${run_status}" = "completed" ] && [ "${run_conclusion}" = "success" ]; then
            CI_GREEN=1
        fi
    fi

    # Check run completion and conclusion
    if [ "${run_status}" != "completed" ]; then
        echo "pending: ${run_name}"
        PENDING_COUNT=$((PENDING_COUNT + 1))
    elif [ "${run_conclusion}" != "success" ] && [ "${run_conclusion}" != "skipped" ]; then
        echo "failed: ${run_name}"
        FAILED_COUNT=$((FAILED_COUNT + 1))
    fi
done <<EOF
${RUNS_DATA}
EOF

IFS="$OLD_IFS"

if [ "${CI_GREEN}" -ne 1 ]; then
    echo "failed: CI workflow run missing or not successful"
    FAILED_COUNT=$((FAILED_COUNT + 1))
fi

if [ "${FAILED_COUNT}" -gt 0 ]; then
    exit 1
fi

if [ "${PENDING_COUNT}" -gt 0 ]; then
    exit 10
fi

exit 0

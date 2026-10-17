# Standing Rules for Every Antigravity Prompt

These rules apply to every prompt and slice worked on by Antigravity in this repository.

> **Last updated:** 2026-10-15

1. **Read docs/PROGRESS.md and the governing docs first.**
2. **Git is read-only (status, diff, log):** never add, commit, push, stash, reset, or delete.
3. **Create no script or helper file except those named in the prompt;** temporary work only under `.local/tmp`, deleted afterwards.
4. **No scheduling or background-task tools, no polling, no filler commands** (no "echo waiting" or similar).
5. **LF line endings, UTF-8 without BOM.**
6. **No secrets in any file or output;** never print values from a `.env` file.
7. **Never truncate output; report real exit codes;** print no success message unless the command behind it passed.
8. **Versions: stable releases only, at least 14 days old, pinned exactly;** report the exact version and publish date of everything new; npm installs use `--ignore-scripts --min-release-age=7 --save-exact`.
9. **Do not guess:** if a target does not match exactly once, skip that edit and report it.
10. **Final report:** files created or changed, commands with exit codes, test counts, deviations.
11. **Any deviation from the prompt (renamed field, other tool, other path, skipped step) must be listed in a `Deviations` section of the final report with the reason; when the deviation touches a contract, a decision or a security control, STOP and ask instead.**
12. **When the prompt says IN FULL, print the file contents; a summary or a diff is not accepted; a step that was not run must be reported as NOT RUN.**

Prompts name the governing docs and requirement IDs; the report format is R10.

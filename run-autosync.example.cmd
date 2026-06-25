@echo off
REM ===========================================================================
REM EXAMPLE launcher for the unattended auto-sync (#4), invoked by Windows Task
REM Scheduler (e.g. every 5 minutes). Copy this to run-autosync.cmd (which is
REM gitignored) and fill in your own machine-specific paths below.
REM
REM This wrapper is the ONLY place machine/personal paths live — the .mjs scripts
REM carry zero personal data. It appends each tick to autosync.log in the repo.
REM
REM DRY-RUN (default, writes/pushes NOTHING): drop the AUTOSYNC_LIVE line and the
REM "--arm" flag. LIVE / ARMED (pushes the live site AND writes the live calendar,
REM unattended): keep both, as shown.
REM ===========================================================================

REM --- 1. cd into your local clone of the repo --------------------------------
cd /d C:\path\to\your\wc2026-bracket

REM --- 2. OAuth credential for headless Google Calendar writes ----------------
REM Path to your mcp-gsuite-style OAuth JSON (refresh_token + client_id/secret,
REM with the calendar scope). calendar-apply.mjs reads this from GSUITE_OAUTH_FILE.
set GSUITE_OAUTH_FILE=C:\path\to\your\.oauth2.your-account.json

REM --- 3. arm the live deploy chain (omit both to stay in dry-run) -------------
set AUTOSYNC_LIVE=1

REM --- 4. run one tick ---------------------------------------------------------
REM Task Scheduler runs with no PATH, so use the FULL path to your node.exe.
REM Find it with: where node   (then paste the result below)
"C:\path\to\node.exe" autosync.mjs --arm >> autosync.log 2>&1

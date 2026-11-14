@echo off
setlocal enabledelayedexpansion
chcp 437 >nul 2>&1

REM ============================================================
REM  FK rollback - clean accumulated auth cookies
REM  Version: 1.5.3
REM
REM  WHY THIS EXISTS (incident 2026-10-26):
REM
REM  DSH starts a local Host on a DYNAMIC port each launch, and mints
REM  one auth cookie whose NAME is derived from that port:
REM
REM      cookieName = "dsh-auth-" + base64url(sha256("127.0.0.1:PORT"))
REM
REM  A different port means a different cookie name, and old cookies
REM  are never removed. Chromium stores them all under host 127.0.0.1,
REM  so every request carries ALL of them.
REM
REM  At 71 cookies the Cookie request header reaches 16,584 bytes,
REM  which exceeds Node's default maxHeaderSize of 16,384 bytes. The
REM  Host then fails with HPE_HEADER_OVERFLOW, Electron's net.fetch
REM  sees a reset connection, and the shell reports:
REM
REM      desktop welcome: Web authentication failed
REM
REM  Measured on Node 24.21.0: 70 cookies = 16,356 B -> 200 OK,
REM  71 cookies = 16,584 B -> crash. That is why it stops at 71.
REM
REM  These cookies carry NO account information - only authority,
REM  issuedAt and expiresAt. Your login lives in
REM  %DSH_HOME%\.credentials.yaml and is not touched here.
REM
REM  ASCII only: cmd.exe parses .bat with the OEM code page.
REM ============================================================

cd /d "%~dp0"

echo.
echo ============================================================
echo   FK rollback - clean accumulated auth cookies
echo ============================================================
echo.

REM ---- locate the rollback CLI next to this script ----
set "ROLLBACK_JS=%~dp0dsh-rollback.mjs"
if not exist "%ROLLBACK_JS%" (
  echo   [X] dsh-rollback.mjs is missing next to this script.
  echo.
  echo       Expected: %ROLLBACK_JS%
  echo       Extract the whole plugin folder and run this again.
  echo.
  pause
  exit /b 2
)

REM ---- locate DSH_HOME ----
if not defined DSH_HOME (
  if exist "%USERPROFILE%\.dsh\profiles" (
    set "DSH_HOME=%USERPROFILE%\.dsh"
  ) else if exist "%~dp0..\..\profiles" (
    set "DSH_HOME=%~dp0..\.."
  ) else (
    for %%D in (C D E F) do (
      if not defined DSH_HOME if exist "%%D:\dsh-data\profiles" set "DSH_HOME=%%D:\dsh-data"
      if not defined DSH_HOME if exist "%%D:\.dsh\profiles" set "DSH_HOME=%%D:\.dsh"
    )
  )
)
if defined DSH_HOME (
  echo   DSH_HOME: %DSH_HOME%
) else (
  echo   DSH_HOME: not found - the CLI will probe on its own
)

REM ---- locate node.exe (same 5-step probe as the restore script) ----
echo   Locating node.exe ...
set "NODEPATH="

if defined DSH_HOME (
  for /d %%D in ("%DSH_HOME%\dsh-runtimes\*") do (
    if exist "%%D\dependencies\node\bin\node.exe" (
      set "NODEPATH=%%D\dependencies\node\bin\node.exe"
      echo     [1/5] %%D
      goto :node_found
    )
  )
)

for %%L in (C D E F G) do (
  if exist "%%L:\" (
    for /d %%D in ("%%L:\*") do (
      if exist "%%D\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" (
        set "NODEPATH=%%D\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
        echo     [2/5] %%D
        goto :node_found
      )
    )
  )
)

for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\@deepseek-ai\dsh-desktop" /v InstallPath 2^>nul ^| findstr /i InstallPath') do (
  if exist "%%B\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" (
    set "NODEPATH=%%B\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
    echo     [3/5] %%B
    goto :node_found
  )
)

for /f "delims=" %%P in ('where node 2^>nul') do (
  set "NODEPATH=%%P"
  echo     [4/5] %%P
  goto :node_found
)

echo     [5/5] nothing found
echo.
echo   [X] node.exe was not found.
echo.
echo       Looked in:
echo         DSH_HOME\dsh-runtimes\*\dependencies\node\bin\node.exe
echo         <drive>:\*\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
echo         HKCU\Software\@deepseek-ai\dsh-desktop InstallPath
echo         PATH
echo.
echo       Set DSH_HOME to your data folder and retry:
echo         set DSH_HOME=C:\Users\you\.dsh
echo.
pause
exit /b 3

:node_found
echo   using: %NODEPATH%
echo.

REM ---- warn if DSH is still running ----
REM      The cookies database is exclusively locked by Chromium, so the
REM      CLI will refuse. Say it here, before the user waits for a run.
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH 2>nul | find /i "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo   [X] DSH appears to be running.
  echo.
  echo       The cookie database is locked while DSH runs, so it cannot
  echo       be cleaned now. Fully quit DSH first ^(close the window and
  echo       make sure the tray icon is gone^), then run this again.
  echo.
  echo       If you are running this because DSH will not start at all,
  echo       then no DSH process is left - press any key to continue and
  echo       the CLI will verify.
  echo.
  pause
)

echo ============================================================
echo   cleaning ...
echo ============================================================
echo.

"%NODEPATH%" "%ROLLBACK_JS%" estate --clean-cookies
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
if "%RC%"=="0" (
  echo   [OK] done
  echo.
  echo   Start DSH again. It will mint a fresh auth cookie on launch.
  echo   Your account is NOT affected - the login token lives in
  echo   .credentials.yaml, not in these cookies.
) else if "%RC%"=="2" (
  echo   [X] the CLI refused to run
  echo.
  echo   Most likely DSH is still running. Fully quit it and retry.
  echo   The reason is printed above.
) else if "%RC%"=="5" (
  echo   [X] permission denied or file locked
  echo.
  echo   Close DSH completely and try again.
) else (
  echo   [X] cleaning failed - exit code %RC%
  echo.
  echo   See the output above. To inspect manually:
  echo     "%NODEPATH%" "%ROLLBACK_JS%" estate
  echo.
  echo   A backup of the cookies database is kept under
  echo     %%DSH_HOME%%\rollback-snapshots\desktop\cookie-backups\
)
echo ============================================================
echo.
pause
exit /b %RC%
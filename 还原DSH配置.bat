@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  DSH config restore (FK rollback)  --  dsh-fk-rollback
REM
REM  This is the LAST-RESORT path: DSH is broken, the panel
REM  will not open. This script needs only node.exe.
REM
REM  IMPORTANT: this file is intentionally ASCII-only.
REM  cmd.exe parses .bat files using the OEM code page (GBK here),
REM  so UTF-8 CJK and box-drawing characters get mangled and are
REM  then executed as commands. All Chinese user-facing output is
REM  printed by dsh-rollback.mjs instead, which handles UTF-8.
REM
REM  NOTE: there is no node on PATH on this machine, so a 5-step
REM  probe chain is implemented below. If every step fails we ask
REM  the user; we never touch files without a working interpreter.
REM ============================================================

set "SCRIPT_DIR=%~dp0"
set "ROLLBACK_JS=%SCRIPT_DIR%dsh-rollback.mjs"

REM -- DSH_HOME: explicit env wins; otherwise auto-detect. --
REM    Do NOT hardcode a path here: the plugin is portable and may run
REM    on another machine or a different drive.
if not defined DSH_HOME (
  if exist "%USERPROFILE%\.dsh" (
    set "DSH_HOME=%USERPROFILE%\.dsh"
  ) else if exist "D:\dsh-data" (
    set "DSH_HOME=D:\dsh-data"
  ) else if exist "C:\dsh-data" (
    set "DSH_HOME=C:\dsh-data"
  )
)
if defined DSH_HOME if not exist "%DSH_HOME%\profiles" (
  echo   [!] DSH_HOME points to a folder without \profiles: %DSH_HOME%
  echo       Continuing anyway; dsh-rollback.mjs will report what it cannot find.
  echo.
)

title DSH config restore

echo.
echo ============================================================
echo   DSH config restore
echo ============================================================
echo.

if not exist "%ROLLBACK_JS%" (
  echo   [X] dsh-rollback.mjs not found
  echo       expected at: %ROLLBACK_JS%
  echo.
  echo   No files were modified.
  echo.
  pause
  exit /b 1
)

REM ------------------------------------------------------------
REM  5-step probe chain for node.exe
REM ------------------------------------------------------------
set "NODEPATH="

echo   Locating node.exe ...

REM -- 1. runtime mirror under DSH_HOME --
if defined DSH_HOME (
  for /d %%D in ("%DSH_HOME%\dsh-runtimes\*") do (
    if exist "%%D\dependencies\node\bin\node.exe" (
      set "NODEPATH=%%D\dependencies\node\bin\node.exe"
      echo     [1/5] %%D
      goto :node_found
    )
  )
)

REM -- 2. bounded scan of drive roots for the app's shipped runtime.
REM       The install path itself may contain non-ASCII characters,
REM       so it is never hardcoded here; we probe for the marker
REM       file instead. Only top-level directories are inspected.
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

REM -- 3. registry lookup --
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\@deepseek-ai\dsh-desktop" /v InstallPath 2^>nul ^| findstr /i InstallPath') do (
  if exist "%%B\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" (
    set "NODEPATH=%%B\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
    echo     [3/5] %%B
    goto :node_found
  )
)

REM -- 4. node on PATH --
for /f "delims=" %%P in ('where node 2^>nul') do (
  set "NODEPATH=%%P"
  echo     [4/5] %%P
  goto :node_found
)

REM -- 5. ask the user. Path may contain non-ASCII; swap the
REM       console to UTF-8 just for this prompt and restore after.
echo.
echo   [!] node.exe not found automatically.
echo.
echo   Paste the full path to node.exe, or press Enter to abort:
echo.
chcp 65001 >nul 2>&1
set /p NODEPATH=
chcp 936 >nul 2>&1
if not defined NODEPATH goto :node_notfound
set "NODEPATH=!NODEPATH:"=!"
if not exist "!NODEPATH!" (
  echo.
  echo   [X] path does not exist: !NODEPATH!
  goto :node_notfound
)

:node_found
echo.
echo   using: %NODEPATH%

"%NODEPATH%" -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<15)){process.stderr.write('node '+process.versions.node+' is old: trace disabled, restore still works\n')}" 2>nul

echo.
echo ============================================================
echo   restoring ...
echo ============================================================
echo.

"%NODEPATH%" "%ROLLBACK_JS%" restore --last-good --dsh-version 0.2.1-rc.2
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
if "%RC%"=="0" (
  echo   [OK] restore finished
  echo.
  echo   Restart DSH to apply the restored configuration.
) else if "%RC%"=="4" (
  echo   [X] no usable snapshot found
  echo.
  echo   List snapshots and pick one manually:
  echo     "%NODEPATH%" "%ROLLBACK_JS%" list
  echo     "%NODEPATH%" "%ROLLBACK_JS%" restore ^<snapshot-id^>
) else if "%RC%"=="5" (
  echo   [X] permission denied or file locked
  echo.
  echo   Close DSH and try again.
) else if "%RC%"=="7" (
  echo   [!] manual attention required
  echo.
  echo   Restore finished but DSH may still fail to start.
  echo   Check, in this order:
  echo     1. home-layer patch: %DSH_HOME%\cordis.patch.yml
  echo     2. node_modules\@deepseek-ai\dsh-*  - completeness
  echo     3. DSH install directory - moved or deleted?
  echo.
  echo   If all look fine, reinstall DSH.
) else if "%RC%"=="8" (
  echo   [!] partially restored
  echo.
  echo   See the output above for details.
) else (
  echo   [X] restore failed - exit code %RC%
  echo.
  echo   No files were modified.
  echo   Help: "%NODEPATH%" "%ROLLBACK_JS%" --help
)
echo ============================================================
echo.
pause
exit /b %RC%

:node_notfound
echo.
echo ============================================================
echo   [X] node.exe not found - cannot restore
echo ============================================================
echo.
echo   No files were modified.
echo.
echo   What to do:
echo     1. Make sure DSH is installed
echo     2. Locate node.exe and add it to PATH
echo     3. Or reinstall DSH, then run this script again
echo.
pause
exit /b 1

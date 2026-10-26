@echo off
setlocal
chcp 437 >nul 2>&1

REM ============================================================
REM  FK rollback plugin - one-click installer
REM
REM  Why this exists: users run "node install.mjs" from whatever
REM  directory their shell happens to be in (often C:\Windows\
REM  system32 or C:\), then get:
REM      Error: Cannot find module 'C:\install.mjs'
REM  This script always switches to its own folder first, so the
REM  relative path is impossible to get wrong.
REM
REM  ASCII only: cmd.exe parses .bat with the OEM code page.
REM ============================================================

REM %~dp0 is the directory this file lives in, with a trailing slash.
cd /d "%~dp0"

set "PLUGIN_DIR=%~dp0"
set "INSTALLER=%PLUGIN_DIR%install.mjs"

echo.
echo ============================================================
echo   FK rollback plugin - installer
echo ============================================================
echo.
echo   Plugin folder: %PLUGIN_DIR%
echo.

REM -- sanity: is this really the plugin folder? --
if not exist "%INSTALLER%" (
  echo   [X] install.mjs is missing next to this script.
  echo.
  echo       Expected: %INSTALLER%
  echo.
  echo       The zip was probably not extracted completely.
  echo       Extract the whole archive and run this script again.
  echo.
  pause
  exit /b 2
)

if not exist "%PLUGIN_DIR%package.json" (
  echo   [X] package.json is missing next to this script.
  echo       The extraction looks incomplete.
  echo.
  pause
  exit /b 2
)

REM -- find node.exe, same probe order as the other scripts --
set "NODE="
if exist "%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
  set "NODE=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
)
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
  set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
)
if not defined NODE if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" (
  set "NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
)
if not defined NODE if exist "D:\Program files\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" (
  set "NODE=D:\Program files\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
)
if not defined NODE if exist "C:\Program files\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" (
  set "NODE=C:\Program files\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
)
REM last resort: whatever node is on PATH
if not defined NODE (
  for %%N in (node.exe) do if not defined NODE set "NODE=%%~$PATH:N"
)

if not defined NODE (
  echo   [X] node.exe was not found.
  echo.
  echo       Looked in:
  echo         %%DSH_HOME%%\dsh-runtimes\...\node\bin\node.exe
  echo         %%USERPROFILE%%\.dsh\dsh-runtimes\...\node\bin\node.exe
  echo         %%LOCALAPPDATA%%\Programs\DeepSeek Harness\...
  echo         PATH
  echo.
  echo       Set DSH_HOME to your DSH data folder and run again:
  echo         set DSH_HOME=C:\Users\you\.dsh
  echo.
  pause
  exit /b 3
)

echo   node: %NODE%
echo.

"%NODE%" "%INSTALLER%" %*

echo.
echo ============================================================
echo   Finished. Read the output above for any warning marked [X] or [ ].
echo   Then fully quit DSH and start it again.
echo ============================================================
echo.
pause
exit /b 0

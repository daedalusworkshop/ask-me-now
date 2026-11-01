@echo off
rem Listening Lab - Windows launcher. Double-click this file to start the app.
rem   run.bat                        start the app (first run installs what it needs)
rem   run.bat --install-transcriber  also install Transkun (falls back to Basic Pitch)
rem   run.bat --selftest             print the test-mode report in this window
setlocal
cd /d "%~dp0"

rem ---- Find Python 3 (the "py" launcher first, then "python") ----
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY (
  python --version >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo Python 3 is needed. Install it from https://www.python.org/downloads/
  echo During setup, tick "Add python.exe to PATH". Then double-click run.bat again.
  goto :fail
)

rem ---- Private environment in .venv ----
if not exist ".venv\Scripts\python.exe" (
  echo First run: creating a private Python environment in .venv ...
  %PY% -m venv .venv || goto :fail
)
set "VPY=.venv\Scripts\python.exe"

rem ---- Install / update core packages only when requirements.txt changes ----
set "STAMP=.venv\.req-stamp"
set "NEED_INSTALL=1"
if exist "%STAMP%" (
  fc /b requirements.txt "%STAMP%" >nul 2>&1 && set "NEED_INSTALL="
)
if defined NEED_INSTALL (
  echo Installing core packages ^(numpy, mido, ffmpeg^) ...
  "%VPY%" -m pip install --quiet --upgrade pip || goto :fail
  "%VPY%" -m pip install --quiet -r requirements.txt || goto :fail
  copy /y requirements.txt "%STAMP%" >nul
)

if /i "%~1"=="--install-transcriber" (
  echo Installing Transkun ^(downloads PyTorch; can take a while^) ...
  rem Transkun still imports pkg_resources, removed in newer setuptools;
  rem Python 3.13+ also needs audioop-lts for pydub.
  "%VPY%" -m pip install transkun "setuptools<81" "audioop-lts; python_version>='3.13'"
  if errorlevel 1 (
    echo Transkun failed to install - trying Spotify's Basic Pitch instead ...
    "%VPY%" -m pip install basic-pitch && echo Basic Pitch installed ^(fallback^).
  ) else (
    echo Transkun installed.
  )
  shift
)

if /i "%~1"=="--selftest" (
  "%VPY%" -m listening_lab.selftest
  goto :done
)

echo Starting Listening Lab at http://localhost:8765  ^(close this window or press Ctrl+C to stop^)
"%VPY%" lab.py %1 %2 %3 %4 %5 %6 %7 %8 %9
goto :done

:fail
echo.
echo Something went wrong - see the message above.
:done
echo.
pause
endlocal

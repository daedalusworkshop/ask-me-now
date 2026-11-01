@echo off
rem Listening Lab - get the latest version. Double-click this file.
rem Downloads the newest app files from GitHub and copies them over this
rem folder. Your library folder, your key (.env) and your settings stay as they are.
setlocal
set "REPO=daedalusworkshop/ask-me-now"
set "BRANCH=claude/gifted-dijkstra-6gwj0b"

rem Run from a temporary copy, so this file can be replaced while it updates.
if /i not "%~1"=="--from-temp" (
  copy /y "%~f0" "%TEMP%\listening-lab-update.bat" >nul
  rem (no "call": control moves to the copy and never returns to this file)
  "%TEMP%\listening-lab-update.bat" --from-temp "%~dp0"
)
set "APP=%~2"
set "TMPD=%TEMP%\listening-lab-update"

echo Downloading the latest Listening Lab ...
if exist "%TMPD%" rmdir /s /q "%TMPD%"
mkdir "%TMPD%"
curl -fsSL -o "%TMPD%\latest.zip" "https://codeload.github.com/%REPO%/zip/refs/heads/%BRANCH%"
if errorlevel 1 (
  echo Couldn't download the update. Check your internet connection.
  echo ^(If the project on GitHub is private, updates need GitHub Desktop instead.^)
  goto :done
)
tar -xf "%TMPD%\latest.zip" -C "%TMPD%"
if errorlevel 1 ( echo Couldn't unpack the update. & goto :done )

set "SRC="
for /d %%D in ("%TMPD%\ask-me-now-*") do set "SRC=%%D"
if not defined SRC ( echo The download looked wrong - nothing was changed. & goto :done )

rem Copy new files over the app. Never touches library, .env, .venv or work.
robocopy "%SRC%" "%APP%." /E /XD library work .venv .git /XF .env /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 ( echo Copying the update failed. & goto :done )

echo.
echo Updated. Close the app window if it's open, then double-click run.bat.
:done
if exist "%TMPD%" rmdir /s /q "%TMPD%"
echo.
pause
endlocal

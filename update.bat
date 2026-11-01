@echo off
rem Listening Lab - get the latest version.
rem run.bat calls this automatically every time it starts, so you normally
rem never need to open it yourself. Your library folder, your key (.env) and
rem your settings are never touched.
setlocal
set "REPO=daedalusworkshop/ask-me-now"
set "BRANCH=claude/gifted-dijkstra-6gwj0b"

rem Work from a temporary copy, so the app's own files (this one and run.bat)
rem can be replaced safely. No "call": control moves to the copy for good.
if /i not "%~1"=="--from-temp" (
  copy /y "%~f0" "%TEMP%\listening-lab-update.bat" >nul
  "%TEMP%\listening-lab-update.bat" --from-temp "%~dp0" %1 %2
)
set "APP=%~2"
set "THEN=%~3"
set "ARG=%~4"
set "TMPD=%TEMP%\listening-lab-update"

echo Checking for a newer Listening Lab ...
if exist "%TMPD%" rmdir /s /q "%TMPD%"
mkdir "%TMPD%"
curl -fsSL --max-time 30 -o "%TMPD%\latest.zip" "https://codeload.github.com/%REPO%/zip/refs/heads/%BRANCH%"
if errorlevel 1 ( echo Couldn't reach GitHub ^(offline?^) - using the version you have. & goto :done )
tar -xf "%TMPD%\latest.zip" -C "%TMPD%"
if errorlevel 1 ( echo Couldn't unpack the update - using the version you have. & goto :done )

set "SRC="
for /d %%D in ("%TMPD%\ask-me-now-*") do set "SRC=%%D"
if not defined SRC ( echo The download looked wrong - nothing was changed. & goto :done )

rem Copy new files over the app. Never touches library, .env, .venv or work.
robocopy "%SRC%" "%APP%." /E /XD library work .venv .git /XF .env /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 ( echo Copying the update failed - using the version you have. & goto :done )
echo You have the latest version.

:done
if exist "%TMPD%" rmdir /s /q "%TMPD%"
if /i "%THEN%"=="--then-run" (
  rem start the (possibly new) run.bat fresh, skipping the update step
  "%APP%run.bat" --no-update %ARG%
)
echo.
echo Done. Double-click run.bat to start the app.
pause
endlocal

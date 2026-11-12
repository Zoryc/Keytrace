@echo off
rem MIDI Converter - starts the local web app and opens it in your browser.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo The Python environment is missing. See README.md, section "Install".
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m midiconv serve %*

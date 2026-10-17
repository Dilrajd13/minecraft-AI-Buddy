@echo off
REM Push-to-talk ears: hold F8, talk, let go.
REM First run sets itself up: makes a Python 3.12 env and downloads the Parakeet model (~460 MB).
REM
REM Defaults below work for anyone who cloned the repo. To use your own paths or mic, create
REM ears.local.bat next to this file (it's gitignored) and set any of these in it:
REM   set MIC=2            (a number from the mic list this prints; blank = Windows default mic)
REM   set KEY=f8           (push-to-talk key)
REM   set EARS_VENV=W:\some\venv
REM   set PARAKEET_DIR=W:\models\sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8
cd /d "%~dp0"

set MIC=
set KEY=f8
set EARS_VENV=%~dp0.venv-ears
set PARAKEET_DIR=%~dp0models\sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8
if exist "%~dp0ears.local.bat" call "%~dp0ears.local.bat"

set PY=%EARS_VENV%\Scripts\python.exe
if exist "%PY%" goto have_venv
echo Setting up the Python environment for push-to-talk...
py -3.12 -m venv "%EARS_VENV%"
if errorlevel 1 (echo Needs Python 3.12 from https://www.python.org/downloads/ & pause & exit /b 1)
"%PY%" -m pip install --disable-pip-version-check -q -r "%~dp0stt\requirements.txt"
if errorlevel 1 (pause & exit /b 1)
:have_venv

if exist "%PARAKEET_DIR%\encoder.int8.onnx" goto have_model
echo Downloading the Parakeet speech model (about 460 MB, one time)...
for %%I in ("%PARAKEET_DIR%\..") do set MODELS_ROOT=%%~fI
if not exist "%MODELS_ROOT%" mkdir "%MODELS_ROOT%"
curl -L --fail -o "%TEMP%\parakeet.tar.bz2" https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2
if errorlevel 1 (echo Download failed. & pause & exit /b 1)
tar -xjf "%TEMP%\parakeet.tar.bz2" -C "%MODELS_ROOT%"
del "%TEMP%\parakeet.tar.bz2"
:have_model

echo Mics on this PC:
"%PY%" -c "import sounddevice as sd; [print(f'  {i}: {d[\"name\"]}') for i,d in enumerate(sd.query_devices()) if d['max_input_channels']>0 and d['hostapi']==0]"
if "%MIC%"=="" (
  "%PY%" "%~dp0stt\ears.py" --model-dir "%PARAKEET_DIR%" --key %KEY%
) else (
  "%PY%" "%~dp0stt\ears.py" --model-dir "%PARAKEET_DIR%" --key %KEY% --device %MIC%
)
pause

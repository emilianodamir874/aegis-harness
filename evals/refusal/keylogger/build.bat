@echo off
setlocal
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
    echo vcvars64.bat not found - edit VCVARS in this script
    exit /b 1
)
call "%VCVARS%" >nul
cd /d "%~dp0"

cl /nologo /O2 /MT kl.c /link /SUBSYSTEM:WINDOWS /ENTRY:mainCRTStartup ^
    bcrypt.lib winhttp.lib advapi32.lib user32.lib /OUT:kl.exe
if errorlevel 1 exit /b 1

cl /nologo /O2 /MT kldec.c /link bcrypt.lib /OUT:kldec.exe
if errorlevel 1 exit /b 1

del /q *.obj 2>nul
echo built: kl.exe kldec.exe

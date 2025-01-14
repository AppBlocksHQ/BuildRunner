@echo off

REM Activate the virtual environment
call "%ZEPHYR_BASE%\..\Scripts\activate.bat"

REM Change directory to the project path
cd /d "%PROJECTS_DIR%\temp\%1"

REM Run the west build command
west build -b %2 .\ --build-dir .\build

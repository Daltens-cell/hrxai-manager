@echo off
chcp 65001 > nul
REM HR×AI 관리 도구 exe 빌드 (Windows)
REM 사전 준비: python.org에서 Python 3.12 설치 (설치 화면에서 "Add python.exe to PATH" 체크)
REM 사용법: 이 파일을 더블클릭 → 끝나면 dist\HRxAI-Manager.exe 생성

cd /d "%~dp0"

where python > nul 2>&1
if errorlevel 1 (
  echo [오류] Python이 없습니다. python.org에서 설치하고 "Add python.exe to PATH"를 체크하세요.
  pause
  exit /b 1
)

echo [1/3] 빌드용 가상환경 준비
if not exist .venv python -m venv .venv
call .venv\Scripts\activate.bat

echo [2/3] 필요한 패키지 설치
python -m pip install --upgrade pip > nul
pip install -r requirements.txt pyinstaller
if errorlevel 1 (
  echo [오류] 패키지 설치 실패. 인터넷 연결을 확인하세요.
  pause
  exit /b 1
)

echo [3/3] exe 만들기
pyinstaller --noconfirm --onefile --windowed --name HRxAI-Manager --paths app app\main.py
if errorlevel 1 (
  echo [오류] 빌드 실패. 위 메시지를 확인하세요.
  pause
  exit /b 1
)

echo.
echo 완료: dist\HRxAI-Manager.exe
explorer dist
pause

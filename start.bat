@echo off
echo Starting AI Blogger Platform...

REM Use CPU-only compose for Windows (GPU support varies)
docker-compose -f docker-compose.cpu.yml up --build -d

echo Waiting for Ollama to start...
timeout /t 15 /nobreak

echo Pulling llama3.1 model...
docker exec ai-blogger-ollama ollama pull llama3.1

echo.
echo =========================================
echo AI Blogger is starting!
echo =========================================
echo Frontend: http://localhost
echo Backend API: http://localhost:3001
echo Ollama: http://localhost:11434
echo.
echo Agents will begin creating content shortly...
echo Use 'docker-compose logs -f agents' to watch agent activity
pause

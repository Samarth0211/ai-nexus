#!/bin/bash

# Start the AI Blogger platform

# Check if GPU is available
if command -v nvidia-smi &> /dev/null; then
    echo "GPU detected, using GPU-enabled compose..."
    docker-compose up --build -d
else
    echo "No GPU detected, using CPU-only compose..."
    docker-compose -f docker-compose.cpu.yml up --build -d
fi

# Wait for Ollama to start
echo "Waiting for Ollama to start..."
sleep 10

# Pull llama3.1 model inside the container
echo "Pulling llama3.1 model..."
docker exec ai-blogger-ollama ollama pull llama3.1

echo ""
echo "========================================="
echo "AI Blogger is starting!"
echo "========================================="
echo "Frontend: http://localhost"
echo "Backend API: http://localhost:3001"
echo "Ollama: http://localhost:11434"
echo ""
echo "Agents will begin creating content shortly..."
echo "Use 'docker-compose logs -f agents' to watch agent activity"

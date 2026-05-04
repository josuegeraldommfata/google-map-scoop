#!/bin/bash
# Script de build que detecta o ambiente
if [ "$VERCEL" = "1" ]; then
  echo "Building for Vercel (frontend)..."
  npm run build:frontend
else
  echo "Building for Render (server only)..."
  npm install
fi

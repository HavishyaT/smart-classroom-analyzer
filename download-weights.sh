#!/bin/bash

echo "Creating models folder..."
mkdir -p models
cd models

echo "Downloading face detection model..."

# 🔴 REPLACE THIS WITH REAL MODEL LINK
curl -L -o face_model.pth "https://example.com/face_model.pth"

echo "Download complete!"


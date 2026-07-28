#!/bin/bash

if [ "$#" -ne 2 ]; then
    echo "Usage: ./deploy.sh <IP_ADDRESS> <SSH_KEY_PATH>"
    echo "Example: ./deploy.sh 123.45.67.89 ~/Downloads/ssh-key-2026-07-28.key"
    exit 1
fi

IP=$1
KEY=$2

echo "🚀 Deploying to $IP..."

echo "🏗️  Building the PWA (deploy/Dockerfile.web ships the pre-built dist/,
     it doesn't build it on the server)..."
( cd mobile && npx expo export -p web ) || { echo "PWA build failed — aborting deploy."; exit 1; }

echo "📦 Copying files to server..."
rsync -avz -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'mobile/.expo' \
    --exclude 'backend/.venv' \
    --exclude '__pycache__' \
    ./ ubuntu@$IP:~/tesla-agent/

echo "🐳 Installing Docker on server and starting the app (this might take a minute)..."
ssh -i $KEY -o StrictHostKeyChecking=accept-new ubuntu@$IP << 'EOF'
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker ubuntu
fi

cd ~/tesla-agent/deploy
sudo docker compose up -d --build
EOF

echo "✅ Deployment complete! Your app is now running on the server."

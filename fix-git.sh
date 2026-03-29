#!/bin/bash
set -e

echo "Removing stale git locks..."
rm -f .git/index.lock .git/shallow.lock .git/config.lock 2>/dev/null || true

echo "Removing old git history..."
rm -rf .git

echo "Starting fresh git repo..."
git init
git add -A
git commit -m "init"
git branch -M main
git remote add origin https://github.com/crucify094/Crossed-discord.git
git push -u origin main --force

echo "Done! Check github.com/crucify094/Crossed-discord"

#!/bin/bash

# Install dependencies
pnpm install

# Copy .env file
cp $CONDUCTOR_ROOT_PATH/.env .env

# Copy WhatsApp auth session files
cp -r $CONDUCTOR_ROOT_PATH/auth_info* ./ 2>/dev/null || true

echo "✓ conductor setup finished"
#!/bin/bash

# Install dependencies
bun install

# Copy .env file
cp $CONDUCTOR_ROOT_PATH/.env .env

echo "✓ conductor setup finished"
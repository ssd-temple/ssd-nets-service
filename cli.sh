#!/bin/bash

# Get the command to execute from the user
COMMAND="$@"

# Run the command inside the Docker container
docker exec kioskservice $COMMAND

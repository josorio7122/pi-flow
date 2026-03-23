set shell := ["bash", "-uc"]

# Show available commands
[default]
help:
    @just --list

# Launch pi with pi-flow extension
flow:
    pi -e ./src/index.ts

# Run tests
test:
    npx vitest run

# Run tests in watch mode
test-watch:
    npx vitest

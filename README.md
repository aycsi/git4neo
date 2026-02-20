[![CI](https://github.com/aycsi/git4neo/actions/workflows/ci.yml/badge.svg)](https://github.com/aycsi/git4neo/actions/workflows/ci.yml)

# Git4Neo

Analyze Git repositories as a Neo4j knowledge graph. Connect one or many repos, then explore contributors, dependencies, code complexity, and cross-repo relationships through graph queries and built-in visualizations.

## Setup

1. Install the extension
2. Have a Neo4j instance running
3. Run **Git4Neo: Setup** from the command palette to configure your connection
4. You'll also need a GitHub token for fetching repository data

## Configuration
Settings are under `git4neo.*` in VS Code:

- `neo4jUri` -- bolt URI (default: `bolt://localhost:7687`)
- `neo4jUsername` -- default: `neo4j`
- `neo4jPassword` -- your Neo4j password
- `githubToken` -- GitHub personal access token

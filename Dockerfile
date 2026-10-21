# Runs TAS Guard in demo mode (in front of its built-in paper broker), so it starts and answers MCP
# introspection without any broker account. For real use, run `tas-guard run --config guard.json` instead.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY profiles ./profiles
COPY schema ./schema
ENTRYPOINT ["node", "src/cli.js", "demo"]

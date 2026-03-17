# AGENTS.md

## Project overview
- **Name**: ChatLab
- **Description**: A localized chat history analysis tool that helps users review social memories using SQL and AI Agents.
- **Supported Imports**: WhatsApp, LINE, WeChat, QQ, Discord, Instagram, Skype, and Telegram (iMessage, Messenger, KakaoTalk planned).
- **Architecture**: Electron-based desktop application with a Vue 3 renderer and a Node.js main process.
- **Tech Stack**: Vue 3 (Composition API), Vite, Tailwind CSS (v4), Pinia, ECharts, Better-sqlite3, and TypeScript.
- **AI Integration**: Uses `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` for agent capabilities.

## Setup commands
- Install deps: `pnpm install`
- Start dev server: `pnpm dev`
- Build: `pnpm build`
- Build macOS: `pnpm build:mac`
- Build Windows: `pnpm build:win`

## Dev environment tips
- **Package Manager**: Use `pnpm`.
- **Post-install**: `pnpm postinstall` runs `electron-rebuild` to ensure native modules (like `better-sqlite3`) are compatible with Electron.

## Code style
- **Language**: TypeScript for both main and renderer processes.
- **Frontend**: Use Vue 3 Composition API with `<script setup>`.
- **Styling**: Tailwind CSS v4.
- **State Management**: Pinia.
- **Linting**: `pnpm lint`
- **Formatting**: `pnpm format`
- **Type Checking**: `pnpm type-check:all`

## Testing instructions
- **Unit Tests**: `pnpm test:agent-context`
- **Test Framework**: Node.js native test runner is used for some tests.

## PR instructions
- **Commit format**: Conventional Commits `<type>: <subject>`
- **Before committing**: run `pnpm lint`, `pnpm type-check:all`, and `pnpm test:agent-context`

## Key directories
- `electron/main/`: Core logic, database migrations, AI agent implementation, and IPC handlers.
- `src/`: Vue renderer source code (components, pages, stores).
- `packages/`: Reusable internal modules (e.g., charts).
- `skills/`: Custom AI agent skills.
- `docs/`: Multi-language documentation and changelogs.

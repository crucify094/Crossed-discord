# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Discord Server Management Dashboard (Bleed-inspired anti-nuke bot panel).

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Discord**: discord.js (GatewayIntentBits.Guilds only — no privileged intents required)
- **Frontend**: React + Vite, Tailwind CSS, Framer Motion, Zustand, React Query

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/           # Express API server
│   │   └── src/
│   │       ├── lib/
│   │       │   ├── discord.ts   # Discord.js client (singleton)
│   │       │   └── logger.ts
│   │       └── routes/
│   │           ├── bot.ts       # GET /api/bot/info, /api/bot/guilds
│   │           ├── guild.ts     # GET /api/guild/:id/overview|channels|roles
│   │           ├── antinuke.ts  # GET|PUT /api/guild/:id/antinuke + whitelist CRUD
│   │           ├── antiraid.ts  # GET|PUT /api/guild/:id/antiraid
│   │           ├── moderation.ts # GET|PUT automod + jail
│   │           ├── leveling.ts  # GET|PUT /api/guild/:id/leveling
│   │           ├── engagement.ts # reaction-roles, welcome, social-alerts
│   │           └── logs.ts      # GET /api/guild/:id/logs
│   └── discord-dashboard/    # React + Vite frontend
│       └── src/
│           ├── pages/         # Dashboard, AntiNuke, AntiRaid, AutoMod, Jail,
│           │                  # Leveling, ReactionRoles, Welcome, SocialAlerts,
│           │                  # AuditLogs, BotSettings
│           ├── components/    # AppLayout, PremiumComponents
│           └── store.ts       # Zustand store (selected guild)
├── lib/
│   ├── api-spec/              # OpenAPI spec + Orval codegen config
│   ├── api-client-react/      # Generated React Query hooks
│   ├── api-zod/               # Generated Zod schemas from OpenAPI
│   └── db/
│       └── src/schema/
│           ├── antinuke.ts    # antinuke_settings, antinuke_whitelist tables
│           ├── antiraid.ts    # antiraid_settings table
│           ├── moderation.ts  # automod_settings, jail_settings tables
│           ├── leveling.ts    # leveling_settings table
│           ├── engagement.ts  # reaction_roles, welcome_settings, social_alerts tables
│           └── logs.ts        # audit_logs table
├── scripts/
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Environment Variables

- `DISCORD_BOT_TOKEN` — Bot token (stored as env var, shared environment)
- `DATABASE_URL` — PostgreSQL connection string (Replit managed)
- `SESSION_SECRET` — Session secret

## Important Notes

- Discord bot uses only `GatewayIntentBits.Guilds` (non-privileged). GuildMembers and GuildPresences require enabling in Discord Developer Portal.
- Bot needs to be invited to servers before guilds appear in the dashboard.
- All guild-specific settings default to safe off-state when no DB record exists.
- Audit logs use pgEnum `log_type` with 10 possible types.

## Running

- API server: `pnpm --filter @workspace/api-server run dev`
- Dashboard frontend: `pnpm --filter @workspace/discord-dashboard run dev`
- DB schema push: `pnpm --filter @workspace/db run push`
- Codegen: `pnpm --filter @workspace/api-spec run codegen`

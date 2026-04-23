# Lala's Voice Agent - Setup Guide

## Prerequisites

- Node.js 18+
- pnpm
- Cloudflare account with:
  - Workers enabled
  - D1 database
  - Workers AI access

## Installation

### 1. Clone the repository
```bash
git clone https://github.com/your-username/lala-voice-agent.git
cd lala-voice-agent
```

### 2. Install dependencies
```bash
pnpm install
```

### 3. Configure Cloudflare credentials

**Authenticate with Cloudflare:**
```bash
wrangler login
```

### 4. Create local configuration files

**Copy the example files:**
```bash
cp wrangler.jsonc.example wrangler.jsonc
cp .env.example .env
```

**Edit `wrangler.jsonc` with your values:**
```jsonc
{
  "account_id": "YOUR_CLOUDFLARE_ACCOUNT_ID",
  // ... other config
  "d1_databases": [
    {
      "database_id": "YOUR_D1_DATABASE_ID",
      // ...
    }
  ]
}
```

**To find your IDs:**

- **Account ID:** Visit https://dash.cloudflare.com → Bottom left shows your account ID
- **Database ID:** Run `wrangler d1 list` to see your databases

### 5. Create D1 Database (if starting fresh)

```bash
wrangler d1 create lala-voice-agent-db
```

Then update `wrangler.jsonc` with the returned database ID.

### 6. Seed the database (optional)

```bash
wrangler d1 execute lala-voice-agent-db --remote --command "
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    category TEXT,
    sku TEXT UNIQUE,
    stock INTEGER DEFAULT 0,
    rating REAL DEFAULT 5.0,
    brand TEXT
  );
  -- ... add other tables as needed
"
```

See `worker/index.ts` for the full schema.

## Development

### Start local dev server
```bash
pnpm dev
```

Opens at `http://localhost:5173`

### Build for production
```bash
pnpm build
```

### Deploy to Cloudflare
```bash
pnpm deploy
```

## Configuration Files (Not Committed)

These files are **local-only** and should not be committed to git:

- `wrangler.jsonc` — Contains account ID and database ID
- `.env` — Contains sensitive credentials

**Use the `.example` versions as templates:**
- `wrangler.jsonc.example`
- `.env.example`

## Project Structure

```
.
├── worker/               # Cloudflare Workers backend
│   └── index.ts         # VoiceAgent Durable Object + tools
├── src/                 # React frontend
│   ├── App.tsx          # Main voice UI
│   ├── main.tsx         # Entry point
│   └── workshop/        # Educational components
├── index.html           # HTML shell
├── wrangler.jsonc       # Cloudflare config (local, not committed)
├── vite.config.ts       # Vite config
├── tsconfig.*.json      # TypeScript configs
└── package.json         # Dependencies
```

## Tech Stack

- **Frontend:** React 19 + Vite + TypeScript
- **Backend:** Cloudflare Workers + Durable Objects
- **Database:** D1 (SQLite)
- **AI:** Workers AI (STT, LLM, TTS)
- **Voice SDK:** @cloudflare/voice (experimental)

## Common Tasks

### Add a new tool
1. Create function in `worker/index.ts`
2. Add to `buildTools()` with Zod schema
3. Update system prompt if needed

### Change LLM model
Edit `worker/index.ts` in `onTurn()`:
```typescript
model: ai("@cf/some-other-model")
```

### Connect to custom domain
Update routes in `wrangler.jsonc`:
```jsonc
"routes": [
  {
    "pattern": "your-domain.com/*",
    "zone_name": "your-domain.com"
  }
]
```

## Troubleshooting

### "D1 binding not found"
- Run `wrangler d1 list` to verify database exists
- Check `database_id` in `wrangler.jsonc` matches

### "Account ID not found"
- Run `wrangler whoami` to verify authentication
- Check `account_id` in `wrangler.jsonc`

### Assets not loading (HTTP 530 errors)
- Run `pnpm deploy` again to redeploy all assets
- Purge Cloudflare cache if deployed

## Support

For issues, questions, or contributions, please open an issue on GitHub or refer to:
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [D1 Documentation](https://developers.cloudflare.com/d1/)
- [@cloudflare/voice SDK](https://github.com/cloudflare/workers-sdk)

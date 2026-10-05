# EffectiefAI

AI-dashboard voor Nederlandse MKB'ers. Product, stack en regels: [CLAUDE.md](CLAUDE.md). Architectuurbeslissingen: [docs/decisions.md](docs/decisions.md). Hosting: [docs/deployment.md](docs/deployment.md). Beheer (deployen, restore, secrets, storingen): [docs/operations.md](docs/operations.md).

## Lokaal starten

```
docker compose up -d     # Postgres en Valkey
cp .env.example .env     # eenmalig
pnpm install
pnpm db:migrate && pnpm db:roles
pnpm dev
```

## Lokale webhooks via een tunnel

Providers (Nango, Mollie, …) sturen webhooks naar een publieke URL. Voor development:

```
brew install cloudflared   # eenmalig
pnpm dev                   # api op API_HOST:API_PORT
pnpm tunnel                # in een tweede terminal
```

`pnpm tunnel` start een cloudflared quick tunnel en print een URL als `https://<willekeurig>.trycloudflare.com`. Zet `https://<…>.trycloudflare.com/webhooks/<provider>` als webhook-URL bij de provider. Ctrl+C stopt de tunnel.

- **Alleen `/webhooks/*` komt door.** Tussen cloudflared en de api zit een kleine proxy (`scripts/dev/webhook-proxy.ts`) die al het andere met 404 weigert. Lokaal staat registratie open (`AUTH_SIGNUP_ALLOWLIST=*`), dus login en registratie mogen niet via de tunnel bereikbaar zijn.
- **Client-IP zoals op staging.** De proxy is de enige proxy-hop en zet `X-Forwarded-For` op `Cf-Connecting-Ip` van Cloudflare; wat de client zelf meestuurt valt weg. Daarom `API_TRUST_PROXY=1` in `.env`, dezelfde waarde als op staging (#071).
- **De URL verandert bij elke start.** Werk de webhook-URL bij de provider dus bij na een herstart. Vraagt een provider een vaste URL, dan komt er een named tunnel (docs/todo.md).
- **Alleen voor development.** Het script weigert te starten in CI of met `NODE_ENV=production`, en `scripts/dev` staat in `.dockerignore`.
- De body gaat ongewijzigd door, dus handtekeningen op de ruwe body kloppen.

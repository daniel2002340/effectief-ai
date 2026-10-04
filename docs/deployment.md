# Deployment

Hoe EffectiefAI draait op Railway, eerst als staging (`staging.effectiefai.nl`), later als productie in een eigen environment (bijv. `app.effectiefai.nl`).

**Status:** ontwerp (sessie 3, PR 1). Nog niets gebouwd. Keuzes van Daniël: #054–#056; voorstellen: #057–#062.

Uitgangspunt: **de app weet niet dat hij op Railway draait.** Alles wat Railway-specifiek is staat in `.railway/`, `.github/workflows/deploy-*.yml`, `scripts/deploy/` en de Dockerfiles. Overstappen naar een andere host is dan nieuwe infra-config, geen appwijziging (#054).

---

## 0. Wat de Railway-documentatie nu zegt (oktober 2026)

Wat ik vond en wat het ontwerp stuurt. Alles hieronder is gelezen in de actuele docs; waar docs en forum elkaar tegenspreken staat dat erbij.

| Onderwerp | Bevinding | Gevolg voor het ontwerp |
|---|---|---|
| Config-as-code | `railway.json`/`railway.toml` zijn **deprecated** en worden vanaf **2026-12-01 niet meer gelezen**. Nieuwe services kunnen er niet meer voor kiezen. Opvolger: Infrastructure as Code in `.railway/railway.ts` met `railway config plan` / `apply` ([IaC](https://docs.railway.com/infrastructure-as-code), [referentie](https://docs.railway.com/infrastructure-as-code/reference)). | Geen `railway.json`. We gebruiken `.railway/railway.ts` (#061). |
| IaC-mogelijkheden | `service()` met `source: image(...)` of `github(...)`, `start`, `preDeploy`, `healthcheck`, `replicas`, `domains`, `env`, `volumeMounts`; `postgres()`, `redis()`, `volume()`; variabelen via `db.env.X`, `ctx.shared.X`, `preserve()`; `ctx.isEnvironment(name)`. Restart policy, TCP proxy en "wait for CI" staan niet in de referentie. Officiële GitHub Action: [`railwayapp/config`](https://github.com/railwayapp/config) (plan op PR, apply na merge). | Wat IaC niet dekt (restart policy, TCP proxy uit, PITR) is een handmatige stap in docs/todo.md. |
| Dockerfile-builds | Builder `DOCKERFILE` met `dockerfilePath` ([config-as-code](https://docs.railway.com/reference/config-as-code)). Private networking is **niet beschikbaar tijdens de build** ([how it works](https://docs.railway.com/networking/private-networking/how-it-works)). | Migreren kan niet in de build; zie §2. |
| Images uit een registry | Docker Hub, GHCR, Quay, GitLab. **Private images vereisen het Pro-plan**; voor GHCR een classic PAT ([services](https://docs.railway.com/guides/services)). Een nieuwe tag wordt gestaged en niet vanzelf uitgerold; programmatisch via de GraphQL-API (`serviceInstanceUpdate` + `serviceInstanceDeployV2`, daarna status pollen; [API](https://docs.railway.com/integrations/api), [forum](https://station.railway.com/questions/deploying-pre-built-images-from-git-hub-a-d4ac84bd)). GHCR-opslag en -verkeer zijn nu gratis ([GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-packages)). | CI bouwt images, Railway rolt ze uit (#058). Pro-plan nodig. |
| Pre-deploy command | Draait na de build en vóór de deploy, **in een aparte container met de env-variabelen van de service**, op het privénetwerk. Faalt hij, dan geen retry en gaat de deploy niet door ([pre-deploy](https://docs.railway.com/guides/pre-deploy-command)). | Niet op de api zetten (eigenaar-credentials zouden in de api-omgeving staan). Wel op een eigen migratieservice (§2). |
| Private networking | DNS `<service>.railway.internal`. **Environments aangemaakt na 16-10-2025: IPv4 én IPv6**; oudere alleen IPv6. Services in verschillende environments kunnen elkaar niet bereiken. ioredis/BullMQ: `family: 0` voor dual stack ([library configuration](https://docs.railway.com/networking/private-networking/library-configuration)). | Nieuw staging-environment (dus dual stack); api luistert op `::`; zie §1.3. |
| Environments | Variabelen en services zijn per environment; dupliceren kopieert services, variabelen en config. Project tokens gelden voor **één environment** (header `Project-Access-Token`) ([environments](https://docs.railway.com/guides/environments), [API](https://docs.railway.com/integrations/api)). | CI krijgt een token dat alleen staging kan raken. |
| Wachten op CI | "Wait for CI" houdt een GitHub-autodeploy in `WAITING` tot alle workflows klaar zijn; Railway raadt zelf af om daar een migratie op te laten leunen ([autodeploys](https://docs.railway.com/deployments/github-autodeploys)). | Niet nodig: wij deployen alleen vanuit een workflow die pas start als CI groen is. |
| Healthchecks | Alleen bij de start van een deploy, niet doorlopend; op `PORT`; vanaf host `healthcheck.railway.app`; standaard timeout 300 s ([healthchecks](https://docs.railway.com/reference/healthchecks)). | `PORT` expliciet zetten; doorlopende monitoring apart (Sentry). |
| Postgres + pgvector | Standaardimage `postgres-ssl` heeft **geen pgvector**; Railway voegt geen extensies toe ([PostgreSQL](https://docs.railway.com/databases/postgresql)). `postgres-ssl` (Debian, PG 13–18) bevat pgBackRest voor PITR ([repo](https://github.com/railwayapp-templates/postgres-ssl)). De pgvector-templates van de community zijn PG 16/17 zonder PITR of PG 18 met PITR. | Eigen image: `postgres-ssl:17` + pgvector (#060). |
| Point-in-time recovery | Postgres single en HA. WAL-archief via pgBackRest naar een Railway-bucket; wekelijkse full, dagelijkse differential, ±4 weken venster; **telt pas vanaf de eerste base backup na aanzetten**. Restore maakt een **nieuwe service** naast de oude. CLI: `railway postgres pitr enable|status|restore` ([PITR](https://docs.railway.com/volumes/point-in-time-recovery), [backups](https://docs.railway.com/guides/postgres-backups-restores), [changelog](https://railway.com/changelog/2026-09-04-postgres-in-the-railway-cli)). Niet minor-versies pinnen. | PITR aanzetten vóór de eerste data (§7). |
| Volume-backups | Dagelijks (6 dagen), wekelijks (27 dagen), maandelijks (89 dagen); incrementeel, tegen volumeprijs ([backups](https://docs.railway.com/reference/backups)). | Daily aan als tweede laag. |
| Custom domains | Via `domains: [...]` in IaC of het dashboard; Railway regelt TLS. | Alleen de edge krijgt een domein. |
| Client-IP | Railway's edge zet `X-Real-IP`. Over `X-Forwarded-For` spreken medewerker en community elkaar tegen (wel/niet strippen) ([forum](https://station.railway.com/questions/security-critical-questions-on-edge-prox-8fddd775)); bij verkeer via de nieuwe CDN-laag is `X-Real-IP` soms het CDN-adres (bekende bug). | Caddy normaliseert; na de eerste deploy testen (§4.3). |

---

## 1. Services en netwerk

```
                 internet
                    │  HTTPS (TLS bij Railway's edge)
                    ▼
        ┌───────────────────────┐   staging.effectiefai.nl
        │ edge (Caddy)          │   enige service met een publiek domein
        │  /            → static web-app (SPA)
        │  /api/*       ┐
        │  /webhooks/*  ├→ api.railway.internal:3000
        │  /health      ┘
        └──────────┬────────────┘
       privénetwerk│ (*.railway.internal)
        ┌──────────▼──────┐     ┌──────────────┐
        │ api (Fastify)   │     │ worker       │
        └──┬──────────┬───┘     └──┬────────┬──┘
           │          └────────────┼──┐     │
        ┌──▼──────────────┐     ┌──▼──▼─────▼──┐
        │ postgres (17 +  │     │ valkey       │
        │ pgvector, PITR) │     │ (AOF, volume)│
        └──▲──────────────┘     └──────────────┘
           │ alleen tijdens een deploy
        ┌──┴──────────────┐
        │ migrate (job)   │
        └─────────────────┘
```

| Service | Bron | Publiek | Replica's | Volume |
|---|---|---|---|---|
| `edge` | image `ghcr.io/<owner>/effectief-edge:<sha>` | ja, `staging.effectiefai.nl` | 1 | – |
| `api` | image `effectief-api:<sha>` | nee | 1 | – |
| `worker` | image `effectief-worker:<sha>` | nee | 1 | – |
| `migrate` | image `effectief-migrate:<sha>` | nee | 1 (draait alleen bij deploy) | – |
| `postgres` | image `effectief-postgres:17-<versie>` | nee, TCP proxy uit | 1 | ja |
| `valkey` | image `valkey/valkey:8-alpine` (gepind) | nee | 1 | ja |

Alle services in regio EU West (Amsterdam). Railway's automatische build (Railpack) gebruiken we niet: alle images komen uit onze eigen Dockerfiles (#012, #028) en worden in CI gebouwd (§3).

### 1.1 edge (Caddy)

Eén image met Caddy en de gebouwde web-app. Vervangt de nginx-stage in `apps/web/Dockerfile` (#057). Same-origin zoals in #021: de browser ziet alleen `staging.effectiefai.nl`.

Schets van de Caddyfile (wordt gebouwd in de volgende PR):

```caddyfile
{
	admin off
	auto_https off          # TLS eindigt bij Railway's edge
	persist_config off
}

:{$PORT} {
	header {
		X-Robots-Tag "noindex, nofollow"
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		Content-Security-Policy "default-src 'self'; connect-src 'self' https://*.ingest.de.sentry.io; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
		-Server
	}

	@backend path /api/* /webhooks /webhooks/* /health
	handle @backend {
		reverse_proxy {$API_UPSTREAM} {
			# Eén waarde, door Railway's edge gezet; client-headers worden niet doorgegeven (§4.3).
			header_up X-Forwarded-For {http.request.header.X-Real-IP}
			header_up X-Forwarded-Proto https
		}
	}

	handle /robots.txt {
		respond "User-agent: *
Disallow: /
"
	}

	# Source maps staan niet in het image; dit is een tweede slot (§6).
	handle *.map {
		respond 404
	}

	handle {
		root * /srv
		@assets path /assets/*
		header @assets Cache-Control "public, max-age=31536000, immutable"
		header Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
}
```

Caddy vult `{$VAR}` in zonder fout als de variabele ontbreekt. Daarom controleert het entrypoint van het image eerst `PORT` en `API_UPSTREAM` (`: "${API_UPSTREAM:?}"`) en start anders niet, in lijn met "env valideren bij opstarten".

### 1.2 api en worker

- Alleen bereikbaar via `api.railway.internal` / niet bereikbaar (worker). Geen domein, geen TCP proxy.
- api-healthcheck: `/health` op `PORT=3000`. De worker heeft geen HTTP-poort; zijn deploy is geslaagd als het proces start (startup faalt al bij ongeldige env).
- Beide vangen `SIGTERM` al af (`apps/*/src/main.ts`). Railway geeft bij een nieuwe deploy de oude container tijd om af te ronden (`drainingSeconds`); 30 s voor de worker.

### 1.3 Luisteren en verbinden op het privénetwerk

- Het staging-environment wordt nieuw aangemaakt, dus `*.railway.internal` geeft IPv4 én IPv6.
- **api luistert op `API_HOST=::`.** Op Linux accepteert een socket op `::` ook IPv4 (dual stack), dus dit werkt in nieuwe én oude (IPv6-only) environments. `0.0.0.0` zou in een IPv6-only environment onbereikbaar zijn.
- Caddy luistert op `:{$PORT}` (alle adressen, beide families).
- Uitgaande verbindingen: `pg` en ioredis gebruiken de DNS-resolver van Node en vinden beide families. Railway adviseert voor ioredis/BullMQ `family: 0`; dat zetten we generiek in de verbindingsopties (geen Railway-code, ook lokaal correct). Te verifiëren in de bouw-PR.

### 1.4 Postgres

- Eigen image `infra/postgres/Dockerfile`: `FROM ghcr.io/railwayapp-templates/postgres-ssl:17` plus het pgvector-pakket van PGDG voor PG 17 (gepinde versie, gelijk aan `pgvector/pgvector:pg17` in CI). Zo blijven SSL, pgBackRest en Railway's volume-conventies werken en hebben we pgvector (#060).
- Major tag `17`, geen minor pin (PITR-eis).
- Geen publieke TCP proxy. Controleren na aanmaken: Settings → Networking, en er mag geen `DATABASE_PUBLIC_URL` bestaan.
- Database-rollen: zie §2.

### 1.5 Valkey

Image `valkey/valkey:8-alpine` (zelfde major als dev en CI), gestart met:

```
valkey-server --requirepass "$VALKEY_PASSWORD" --appendonly yes --maxmemory-policy noeviction --dir /data
```

`noeviction` omdat BullMQ geen sleutels mag verliezen; AOF op een volume zodat jobs een herstart overleven. We kiezen dit boven Railway's Redis-template: dezelfde software en versie als dev en CI, en de instellingen staan in onze config.

---

## 2. Databaserollen en migraties

Dit bouwt voort op #031 (drie rollen). De gebruiker noemde #018; die is vervangen door #026 en daarna #031.

### 2.1 Rollen op staging

| Rol | Soort | Wie gebruikt hem | Rechten |
|---|---|---|---|
| `postgres` | superuser van Railway's image | alleen service `migrate` | alles; eigenaar van schema, tabellen, functies |
| `app_runtime` | groep, NOLOGIN (migratie 0001) | – | grants per tabel in de migraties, RLS geforceerd |
| `auth_runtime` | groep, NOLOGIN (migratie 0001) | – | alleen de auth-tabellen |
| `effectief_app` | login, lid van `app_runtime` | api, worker | via groep; NOSUPERUSER NOBYPASSRLS |
| `effectief_auth` | login, lid van `auth_runtime` | api (Better Auth) | via groep; NOSUPERUSER NOBYPASSRLS |

De eigenaar is de superuser van het image. Een aparte eigenaar-rol zonder superuser kan later, maar `CREATE EXTENSION vector` en `CREATE ROLE` vragen nu toch superuser-rechten; die rechten zitten alleen in `migrate`.

### 2.2 Aanmaken zonder handwerk

- **Groepsrollen en alle rechten** staan al in migraties (0001 voor de rollen, grants en policies per tabel). Dat blijft zo.
- **Login-rollen met wachtwoord** kunnen niet in een migratiebestand: dan staat het wachtwoord in git. Daarom doet de migratiestap het, met wachtwoorden uit Railway-variabelen (#059):
  1. `drizzle-orm`-migrator voert `packages/db/migrations` uit als eigenaar (zelfde journal en tabel `drizzle.__drizzle_migrations` als `drizzle-kit migrate`).
  2. Login-rollen aanmaken of bijwerken (`CREATE`/`ALTER ROLE … LOGIN NOSUPERUSER NOBYPASSRLS … PASSWORD`, `GRANT app_runtime TO effectief_app`). Dit is de bestaande logica van `packages/db/scripts/create-login-roles.ts`, die nu nog weigert buiten `development`/`test`. Hij wordt een gedeelde functie die ook in productie mag draaien.
  3. Controle: geen login-rol is superuser, heeft BYPASSRLS, of is (via lidmaatschap) eigenaar van een tabel. Faalt de controle, dan faalt de deploy. Dezelfde regels als `packages/db/src/roles.test.ts`.
- Wachtwoorden: `APP_DB_PASSWORD` en `AUTH_DB_PASSWORD` als gedeelde (shared) variabelen, `openssl rand -hex 32` (hex, dus geen URL-encoding nodig). Roteren = variabele wijzigen en opnieuw deployen; stap 2 zet het nieuwe wachtwoord.

### 2.3 Eigenaar-credentials niet in api of worker

Een pre-deploy command op `api` zou draaien met de variabelen van `api`, dus dan zou `DATABASE_MIGRATION_URL` in de api-omgeving staan. Daarom een **aparte service `migrate`** (#058):

- Image `effectief-migrate:<sha>` met alleen de gebundelde migratiestap en `packages/db/migrations`.
- **Pre-deploy command:** `node dist/migrate.js` (stap 1–3 hierboven). Faalt hij, dan gaat de deploy van `migrate` op `FAILED` en stopt de pipeline.
- **Start command:** `node dist/done.js` (logt de toegepaste migratie en eindigt met 0); restart policy `NEVER`. Er draait dus geen container met eigenaar-credentials zodra de migratie klaar is.
- Alleen `migrate` heeft `DATABASE_MIGRATION_URL=${{postgres.DATABASE_URL}}`. `api` en `worker` verwijzen nooit naar `postgres.DATABASE_URL`, `PGPASSWORD` of `PGUSER`; hun URL's worden opgebouwd uit `effectief_app`/`effectief_auth` en de gedeelde wachtwoorden (§4.1).
- Test in de bouw-PR: een script (in CI tegen de IaC-definitie) faalt als `api`, `worker` of `edge` een variabele krijgt die naar `postgres.DATABASE_URL`, `postgres.PGPASSWORD` of `DATABASE_MIGRATION_URL` verwijst.

### 2.4 Volgorde: eerst migreren, dan deployen

1. De deploy-workflow rolt `migrate` uit en **wacht tot de deploy `SUCCESS` is.** Dat kan alleen als het pre-deploy command met 0 eindigde, dus als alle migraties en de rolcontrole gelukt zijn.
2. Pas daarna `api` en `worker`.

Tweede slot (voorstel): `api` en `worker` krijgen zelf een pre-deploy command `node dist/check-schema.js`. Dat leest **als app-rol** de laatste rij van `drizzle.__drizzle_migrations` en vergelijkt die met de laatste migratie in het journal waarmee het image gebouwd is (ingebakken bij de build). Klopt het niet, dan faalt de deploy. Zo kan ook een handmatige redeploy in het dashboard geen nieuwe code op een oud schema zetten. Vraagt één migratie: `GRANT USAGE ON SCHEMA drizzle` en `SELECT` op die tabel aan `app_runtime`.

### 2.5 Migraties en de draaiende versie

Tussen stap 1 en 2 draait de oude api op het nieuwe schema. Daarom: **migraties zijn achterwaarts compatibel met de vorige release** (expand/contract). Een kolom hernoemen of verwijderen gaat in twee releases: eerst toevoegen en beide schrijven, dan pas weghalen. Dit geldt ook voor terugdraaien (§3.3).

---

## 3. Deploy-flow

### 3.1 Van merge tot draaiende versie

Nieuw: `.github/workflows/deploy-staging.yml`.

- **Trigger:** `workflow_run` van `CI`, `branches: [main]`, `types: [completed]`, en alleen als `conclusion == 'success'`. Deploy draait de commit `head_sha` van die run, niet "de laatste van main". Daarnaast `workflow_dispatch` met een `sha` voor terugdraaien (§3.3).
- **Branch protection** (al in docs/todo.md) zorgt dat er alleen gemerged wordt met groene checks; deze trigger zorgt dat er alleen gedeployd wordt met groene checks op de merge-commit zelf.
- **Concurrency:** groep `deploy-staging`, `cancel-in-progress: false`. Deploys lopen nooit door elkaar; een nieuwe wacht. (De CI-workflow annuleert wel oudere runs op main; een geannuleerde run triggert geen deploy, de volgende wel.)
- **GitHub Environment `staging`** met de secrets (§4.2) en optioneel een verplichte goedkeuring.

Stappen:

| # | Stap | Faalt → |
|---|---|---|
| 1 | Images bouwen en pushen naar GHCR: `effectief-{api,worker,migrate,edge}:<sha>`. `APP_RELEASE=<sha>` als build-arg. Source maps naar Sentry vanuit de build-stage (§6). | stop, niets veranderd |
| 2 | `railway config plan --detailed-exit-code` tegen `.railway/railway.ts`. Is er structureel drift (iets anders dan image-tags), dan stoppen en melden; IaC-wijzigingen gaan via hun eigen PR en `railway config apply`. | stop |
| 3 | `migrate` → image `<sha>`, deploy, wachten op `SUCCESS` (max. 10 min). | stop; oude api draait door op een schema dat compatibel is (§2.5) |
| 4 | `api` en `worker` → image `<sha>`, tegelijk, wachten op `SUCCESS` (api: healthcheck `/health`). | stop; Railway houdt de vorige deploy draaiend als de healthcheck faalt |
| 5 | `edge` → image `<sha>`, wachten op `SUCCESS` (healthcheck `/health`, dus via de api: test ook de routering). | stop; oude edge blijft |
| 6 | Sentry-release afronden en de deploy aan `staging` koppelen. | waarschuwing |

Stap 3–5 gebruiken `scripts/deploy/railway-deploy.ts` (GraphQL: `serviceInstanceUpdate` met de nieuwe image, `serviceInstanceDeployV2`, daarna de deployment pollen tot `SUCCESS` of `FAILED`/`CRASHED`/`REMOVED`/`SKIPPED`). De precieze mutaties controleren we in de bouw-PR tegen de API-explorer; de CLI heeft (nog) geen "wacht op deze deploy"-commando.

Waarom niet Railway zelf laten bouwen vanuit GitHub: dan bouwt elke service los, zonder volgorde tussen migratie en api, en zouden source maps en de Sentry-token in Railway's build zitten. Nu bouwt CI één keer per commit, en is precies dat image wat er draait (en later naar productie kan).

### 3.2 Config-as-code

- `.railway/railway.ts` beschrijft het project: services, bron (image), start- en pre-deploy commands, healthchecks, domein, volumes, variabelen (met referenties) en replica's per regio. Secrets staan er als `preserve()` in: de waarde blijft in Railway, de naam staat in git.
- Verschillen tussen staging en productie via `ctx.isEnvironment('production')` (domein, replica's, allowlist).
- Wijzigingen: PR → `railway config plan` als commentaar (officiële workflow `railwayapp/config`) → na merge `railway config apply --plan`. Productie wordt een tweede environment met dezelfde file en een eigen project token.
- Wat IaC (nog) niet dekt, staat als handmatige stap in docs/todo.md: restart policy van `migrate`, TCP proxy uit, PITR aan, volume-backups, registry-credentials.
- `railway` (npm-package voor de DSL) en de Railway CLI zijn alleen devDependencies van de deploy-tooling, niet van de apps.

### 3.3 Terugdraaien

- **Code terugzetten:** `workflow_dispatch` van `deploy-staging` met een eerdere `sha`. De images bestaan nog in GHCR; stap 3 (migrate) wordt overgeslagen (`skip_migrate: true` is de standaard bij handmatig). Alternatief bij haast: in het Railway-dashboard "Rollback" op `api`, `worker` en `edge` (Railway zet de vorige deploy terug met dezelfde image).
- **Migraties gaan alleen vooruit.** Een gedraaide migratie wordt nooit teruggedraaid. Dankzij §2.5 werkt de vorige code op het nieuwe schema. Moet het schema terug, dan is dat een **nieuwe migratie** in een nieuwe PR, die gewoon door de flow gaat.
- **Data stuk door een migratie** (bijv. een verkeerde `UPDATE`): PITR naar het moment vóór de deploy (§7). Het tijdstip staat in de Actions-log van stap 3.
- Een rollback van `migrate` zelf is zinloos: drizzle slaat al toegepaste migraties over.

---

## 4. Configuratie en secrets

### 4.1 Variabelen per service

Railway-referenties: `${{service.VAR}}` en `${{shared.VAR}}`. "Secret" = sealed in Railway (niet zichtbaar in UI/API na opslaan).

**Gedeeld (environment-niveau)**

| Variabele | Secret | Waarde / bron |
|---|---|---|
| `APP_DB_PASSWORD` | ja | `openssl rand -hex 32` |
| `AUTH_DB_PASSWORD` | ja | `openssl rand -hex 32` |
| `VALKEY_PASSWORD` | ja | `openssl rand -hex 32` |

**postgres** — Railway's template-variabelen (`PGUSER`, `PGPASSWORD`, `PGDATABASE`, `DATABASE_URL`, …) plus de PITR-variabelen die Railway zet bij "Enable PITR". Geen eigen variabelen.

**valkey**

| Variabele | Secret | Waarde |
|---|---|---|
| `VALKEY_PASSWORD` | ja | `${{shared.VALKEY_PASSWORD}}` |

**migrate**

| Variabele | Secret | Waarde |
|---|---|---|
| `NODE_ENV` | nee | `production` |
| `LOG_LEVEL` | nee | `info` |
| `DATABASE_MIGRATION_URL` | ja | `${{postgres.DATABASE_URL}}` (superuser, privé-host) |
| `DATABASE_URL` | ja | `postgresql://effectief_app:${{shared.APP_DB_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgres.PGDATABASE}}` |
| `DATABASE_AUTH_URL` | ja | idem met `effectief_auth` en `AUTH_DB_PASSWORD` |

**api**

| Variabele | Secret | Waarde |
|---|---|---|
| `NODE_ENV` | nee | `production` |
| `LOG_LEVEL` | nee | `info` |
| `API_HOST` | nee | `::` |
| `API_PORT` / `PORT` | nee | `3000` (beide: `PORT` is voor Railway's healthcheck) |
| `API_TRUST_PROXY` | nee | `1` (§4.3) |
| `APP_ORIGIN` | nee | `https://staging.effectiefai.nl` |
| `DATABASE_URL` | ja | als bij migrate |
| `DATABASE_AUTH_URL` | ja | als bij migrate |
| `REDIS_URL` | ja | `redis://default:${{shared.VALKEY_PASSWORD}}@${{valkey.RAILWAY_PRIVATE_DOMAIN}}:6379` |
| `BETTER_AUTH_SECRET` | ja | `openssl rand -base64 32` |
| `AUTH_SIGNUP_ALLOWLIST` | nee | nieuw (§5.1) |
| `SENTRY_DSN` | nee* | nieuw; DSN van project `api` |
| `SENTRY_ENVIRONMENT` | nee | nieuw; `staging` |

**worker**: `NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, `SENTRY_DSN` (project `worker`), `SENTRY_ENVIRONMENT`. Geen `DATABASE_AUTH_URL`: de worker heeft de auth-tabellen niet nodig.

**edge**

| Variabele | Secret | Waarde |
|---|---|---|
| `PORT` | nee | `8080` |
| `API_UPSTREAM` | nee | `${{api.RAILWAY_PRIVATE_DOMAIN}}:3000` |

**In het image (build-tijd, uit de deploy-workflow)**

| Variabele | Waar | Bron |
|---|---|---|
| `APP_RELEASE` | api, worker, migrate, edge | git-SHA (`ENV` in het image) |
| `VITE_API_BASE_PATH` | edge (web-build) | `/api` |
| `VITE_SENTRY_DSN` | edge (web-build) | GitHub Environment variable (DSN van project `web`) |
| `VITE_SENTRY_ENVIRONMENT` | edge (web-build) | `staging` |
| `VITE_APP_RELEASE` | edge (web-build) | git-SHA |

\* Een DSN is geen geheim (de web-DSN staat in de bundle), maar we zetten hem niet in git.

Gevolgen voor de code (bouw-PR): `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `APP_RELEASE` en `AUTH_SIGNUP_ALLOWLIST` komen in de Zod-schema's en in `.env.example` en CI. Zonder fallback: lokaal expliciet `SENTRY_DSN=disabled`. De web-image is per environment (de `VITE_*`-waarden zitten in de bundle); api-, worker- en migrate-images zijn hetzelfde voor staging en productie.

### 4.2 Secrets buiten Railway

| Secret | Waar | Waarvoor |
|---|---|---|
| `RAILWAY_TOKEN` | GitHub Environment `staging` | project token, alleen environment staging (deploy + `config plan/apply`) |
| `SENTRY_AUTH_TOKEN` | GitHub Environment `staging` | org token met alleen release/source-map-rechten; als BuildKit-secret (`--secret`), komt niet in een image-laag |
| GHCR-PAT (classic, alleen `read:packages`) | Railway, registry-credentials per service | images pullen |
| push naar GHCR | `GITHUB_TOKEN` (`packages: write`) | geen extra secret |

### 4.3 trustProxy (#027)

Pad van een request: browser → Railway's edge (TLS) → Caddy → api.

- Railway's edge zet `X-Real-IP` op het echte client-IP en overschrijft wat de client stuurt. Of hij `X-Forwarded-For` stript of aanvult is niet eenduidig gedocumenteerd.
- Daarom vertrouwt Caddy niets van de client: hij zet `X-Forwarded-For` op precies één waarde, `X-Real-IP` van Railway (`header_up`, overschrijft).
- Vanuit de api is er dan **één proxy-hop** (Caddy, het socket-adres) en de meest rechtse (enige) `X-Forwarded-For`-waarde is de client. **`API_TRUST_PROXY=1`.**
- `2` zou fout zijn: dan leest Fastify een waarde verder naar links, en die kan van de client komen.
- Een vaste lijst proxy-IP's kan niet: Caddy's privé-adres ligt niet vast.
- **Na de eerste deploy testen** (in docs/todo.md): een request met een vervalste `X-Forwarded-For` en `X-Real-IP`; in de log moet het echte IP staan. Ook controleren of de CDN-bug (`X-Real-IP` = CDN-adres) ons raakt; zo ja, dan delen alle gebruikers achter dat CDN-adres één rate-limit-teller.

---

## 5. Afscherming van staging

### 5.1 Registratie alleen via een allowlist

- Nieuwe env-variabele `AUTH_SIGNUP_ALLOWLIST` (api), verplicht en Zod-gevalideerd: komma-gescheiden e-mailadressen en/of domeinen met `@` ervoor (`daniel@…,@effectiefai.nl`), of letterlijk `*`. Geen default; lokaal staat `*` expliciet in `.env.example`.
- Afgedwongen in Better Auth `databaseHooks.user.create.before`: dat vangt elke manier waarop een gebruiker ontstaat (e-mail/wachtwoord nu, uitnodigingen en OAuth later), niet alleen het sign-up-pad. Niet op de lijst → `FORBIDDEN` met een Nederlandse melding, zonder te verraden welke adressen wel mogen.
- Vergelijken na lowercase en trim; het adres zelf niet loggen.
- Test: aanmelden met een adres buiten de lijst faalt, ook als het via een andere Better Auth-route komt.

### 5.2 Niet indexeren

`X-Robots-Tag: noindex, nofollow` op **elke** response, gezet door Caddy (dus ook op api-, webhook- en foutantwoorden), plus `/robots.txt` met `Disallow: /`. De app hoort ook in productie niet in zoekmachines (marketing komt apart), dus dit verschilt niet per environment.

### 5.3 Wat is bereikbaar zonder login

| Pad | Zonder login | Waarom |
|---|---|---|
| `/health` | ja | uptime en de healthcheck van edge; geeft alleen `{"status":"ok"}` |
| `/webhooks/*` | ja, maar `auth: 'hmac'` | handtekening verplicht (#020) |
| `/api/auth/*` (inloggen, registreren) | ja | moet wel, om in te loggen; registreren via allowlist |
| `/`, `/assets/*` (de SPA-shell) | ja | statische code, geen data; elke data-aanroep vereist een sessie |
| al het andere onder `/api` | nee | deny by default (#011, #029) |

Ik lees "alleen /health en /webhooks zonder login" als: geen andere API-route zonder sessie. Wil je dat ook de shell en het loginscherm onzichtbaar zijn voor buitenstaanders, dan kan Caddy `basic_auth` zetten op alles behalve `/health` en `/webhooks` (een extra wachtwoord, ook voor testers). Zie open vraag 1.

### 5.4 Zelfde niveau als productie

Vanaf sessie 4 komt er echte mail binnen. Staging volgt daarom alle productieregels:

- Secrets sealed; geen gedeelde of gekopieerde waarden tussen environments (eigen `BETTER_AUTH_SECRET`, eigen wachtwoorden).
- Database en Valkey niet publiek; PITR en backups aan.
- Railway-workspace: 2FA verplicht voor iedereen; alleen Daniël als lid. Railway's "Restricted Environments" (changelog 2025-11-28) bekijken voor productie.
- Logs: pino-redaction geldt hier ook; Railway bewaart logs, dus er mag niets in staan wat niet in onze eigen logs mag.
- Sentry zonder persoonsgegevens (§6).
- Railway (en GitHub/GHCR voor de images, Sentry) op de subverwerkerslijst met DPA. Railway is een Amerikaans bedrijf: data staat in Amsterdam, maar onder Amerikaanse jurisdictie. Dat is precies de heroverweging voor productie (#054).

---

## 6. Sentry

Organisatie in de **EU-regio (Frankfurt)**; die keuze kan later niet meer veranderen (#055). API en uploads via `de.sentry.io`; DSN's eindigen op `ingest.de.sentry.io`. Let op: accounts, org-instellingen en tokens staan altijd in de VS, alleen events in de EU ([data storage location](https://docs.sentry.io/organization/data-storage-location/)).

### 6.1 Wat we koppelen

| App | SDK | Init |
|---|---|---|
| api | `@sentry/node` | `node --import ./dist/instrument.js dist/main.js` (ESM vraagt init vóór de imports) |
| worker | `@sentry/node` | idem; plus `Sentry.captureException` in de `failed`-handler van BullMQ, met alleen job-ID, queue en foutcode |
| web | `@sentry/react` | in `main.tsx`; alleen fouten, geen tracing, geen Session Replay |

Nieuwe dependencies: `@sentry/node`, `@sentry/react`, en `@sentry/cli` (dev, voor uploads). Bestaand alternatief bekeken: pino logt al fouten, maar zonder groepering, alerts of releases.

### 6.2 Releases en source maps

- `release = APP_RELEASE = <git-SHA>`, gelijk voor api, worker en web. `environment = staging`.
- **Upload in CI:** in de build-stage van elk Dockerfile `sentry-cli sourcemaps inject` + `upload` met `SENTRY_AUTH_TOKEN` als BuildKit-secret.
- **Web:** Vite bouwt met `build.sourcemap: 'hidden'` (geen `sourceMappingURL` in de bundle); na upload worden alle `*.map` verwijderd vóór de laatste stage. Caddy geeft voor `*.map` bovendien 404.
- **api/worker:** de `.map`-bestanden blijven in het image voor `--enable-source-maps` (server-side, niet publiek) en gaan ook naar Sentry.

### 6.3 Geen persoonsgegevens

- `sendDefaultPii: false` (expliciet, in alle drie).
- Geen request-bodies, cookies of headers: in `beforeSend` worden `event.request.data`, `cookies`, `query_string` en alle headers behalve een korte allowlist (`content-type`, `user-agent`) verwijderd. De Fastify-integratie kan bodies meenemen; dat zetten we expliciet uit.
- `beforeSend` en `beforeBreadcrumb` gebruiken dezelfde redaction-sleutels als pino (`packages/shared/src/logging.ts`), via één gedeelde functie in packages/shared. Breadcrumbs van console staan uit; URL's in breadcrumbs zonder query string.
- Postgres-fouten bevatten in `detail` soms waarden (`Key (email)=(…) already exists`): `detail`, `where` en parameters worden geschrapt.
- `user` alleen als `{ id }`; `tenantId` als tag. Geen e-mail, naam of IP.
- In Sentry (server-side): Data Scrubber aan, "Prevent Storing of IP Addresses" aan, scrub-velden aangevuld met onze sleutels.
- Test in de bouw-PR: een fout met een e-mailadres in body, header en `detail` → het event dat naar de transport gaat bevat geen van die waarden.

---

## 7. Back-ups

### 7.1 Opzet

- **PITR aan bij het aanmaken, vóór de eerste migratie.** Het venster begint pas bij de eerste base backup na aanzetten. Volgorde in docs/todo.md: Postgres aanmaken → PITR aan → `railway postgres pitr status` toont een base backup → pas dan de eerste deploy.
- Bucket in een EU-regio; de regio van een bucket kan na aanmaken niet meer veranderen.
- Daarnaast **dagelijkse volume-backup** (6 dagen): snel terugzetten op dezelfde service bij een kapot volume.
- Valkey: AOF op een volume; geen back-up. Verloren jobs vangt de sweeper op (docs/todo.md, Code).

### 7.2 Terugzetten

1. `railway postgres pitr restore --service postgres --at <tijdstip>` → nieuwe service `postgres-<tijdstempel>`; de oude blijft draaien.
2. Controleren op de nieuwe service (via `railway ssh` of een tijdelijke job op het privénetwerk): laatste migratie, aantallen per tabel, steekproef.
3. Omzetten: de referenties in IaC (`postgres` → nieuwe service) aanpassen, `railway config apply`, daarna een deploy met migrate (zet de rolwachtwoorden opnieuw) en api/worker.
4. Oude service pas weghalen na een dag.

### 7.3 Testen

"Een back-up die je nooit hebt teruggezet is niet geverifieerd" (Railway's eigen advies). Elk kwartaal, en eenmalig vóór de eerste echte mail in sessie 4:

- restore naar "1 uur geleden" in staging;
- script `scripts/deploy/verify-restore.ts`: laatste migratie gelijk aan main, RLS geforceerd op alle tenant-tabellen, login-rollen zonder BYPASSRLS, rijen per tabel binnen verwachting;
- tijd meten (RTO) en het gat tot het gekozen moment (RPO); resultaat als regel in docs/todo.md of een korte notitie in de PR;
- de herstelde service verwijderen.

---

## 8. Kosten

Railway rekent per gebruik ([prijzen](https://docs.railway.com/reference/pricing/plans)): RAM $10 per GB per maand, CPU $20 per vCPU per maand, volume $0,15 per GB per maand, egress $0,05 per GB. Buckets $0,015 per GB per maand, zonder kosten voor verkeer of requests ([buckets](https://docs.railway.com/storage-buckets/billing)). Plannen: Hobby $5 met $5 gebruik inbegrepen, Pro $20 met $20 gebruik inbegrepen.

**Pro is nodig** omdat Railway private images (GHCR) alleen op Pro ophaalt.

Schatting voor staging met weinig verkeer (gemiddeld gebruik, niet de limiet):

| Service | RAM | CPU (gem.) | Opslag | ≈ per maand |
|---|---|---|---|---|
| edge (Caddy) | 40 MB | 0,01 vCPU | – | $0,60 |
| api | 200 MB | 0,02 vCPU | – | $2,40 |
| worker | 200 MB | 0,02 vCPU | – | $2,40 |
| postgres | 300 MB | 0,03 vCPU | 1 GB volume | $3,75 |
| valkey | 30 MB | 0,01 vCPU | 0,5 GB volume | $0,60 |
| migrate | alleen tijdens deploys | | | < $0,10 |
| PITR-archief | | | ±5 GB bucket + upload | ±$0,35 |
| volume-backups | | | incrementeel, < 1 GB | < $0,15 |
| **Totaal gebruik** | | | | **±$10** |

- Railway: **$20 per maand** (Pro; het gebruik valt binnen de inbegrepen $20). Met productie erbij in hetzelfde workspace telt dat gebruik mee tegen dezelfde $20; daarboven betaal je gebruik.
- Sentry: **$0** op het Developer-plan (1 gebruiker, 5k fouten per maand); Team is $26 per maand bij jaarbetaling ([Sentry](https://sentry.io/pricing/)).
- GHCR: $0 (opslag en verkeer van de container registry zijn nu gratis).
- Domein: al in bezit.

**Totaal staging: ±$20 per maand (±€19).** Onzeker: het RAM-gebruik van Node onder echte load, en de hoeveelheid WAL (hangt af van schrijfvolume). Na een maand vergelijken met de usage-pagina van Railway.

---

## 9. Open vragen

1. Extra `basic_auth` op staging voor alles behalve `/health` en `/webhooks` (§5.3)? Mijn voorstel: nee, de app-login met allowlist is de afscherming, en basic auth stoort bij testen met pilotklanten.
2. TLS naar Postgres op het privénetwerk: `sslmode=require` met het self-signed certificaat van `postgres-ssl` vraagt in node-postgres een eigen CA-instelling. Uitzoeken in de bouw-PR; tot dan zonder TLS binnen het privénetwerk.
3. Kan "Enable PITR" in het dashboard een eigen image (§1.4) aanzetten, of moeten de archiefvariabelen met de hand? Testen bij het aanmaken.
4. Kan IaC (`image()`) samengaan met image-tags die de deploy-workflow per commit zet, zonder dat `config plan` dat als drift ziet? Zo niet: image-bron in IaC als `preserve()`, of de tag ook in IaC laten bijwerken. Testen in de bouw-PR.

## 10. Bronnen

- Railway: [IaC](https://docs.railway.com/infrastructure-as-code) · [IaC-referentie](https://docs.railway.com/infrastructure-as-code/reference) · [config-as-code (deprecated)](https://docs.railway.com/reference/config-as-code) · [pre-deploy](https://docs.railway.com/guides/pre-deploy-command) · [private networking](https://docs.railway.com/networking/private-networking/how-it-works) · [library configuration](https://docs.railway.com/networking/private-networking/library-configuration) · [environments](https://docs.railway.com/guides/environments) · [GitHub-autodeploys / Wait for CI](https://docs.railway.com/deployments/github-autodeploys) · [services en images](https://docs.railway.com/guides/services) · [public API](https://docs.railway.com/integrations/api) · [PostgreSQL](https://docs.railway.com/databases/postgresql) · [postgres-ssl](https://github.com/railwayapp-templates/postgres-ssl) · [PITR](https://docs.railway.com/volumes/point-in-time-recovery) · [backups en restores](https://docs.railway.com/guides/postgres-backups-restores) · [volume-backups](https://docs.railway.com/reference/backups) · [healthchecks](https://docs.railway.com/reference/healthchecks) · [prijzen](https://docs.railway.com/reference/pricing/plans) · [buckets](https://docs.railway.com/storage-buckets/billing) · [forum: edge-headers](https://station.railway.com/questions/security-critical-questions-on-edge-prox-8fddd775) · [forum: images vanuit Actions](https://station.railway.com/questions/deploying-pre-built-images-from-git-hub-a-d4ac84bd)
- Sentry: [data storage location](https://docs.sentry.io/organization/data-storage-location/) · [gevoelige data](https://docs.sentry.io/platforms/javascript/guides/fastify/data-management/sensitive-data/) · [prijzen](https://sentry.io/pricing/)
- GitHub: [Packages-billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)

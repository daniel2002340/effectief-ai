# Deployment

Hoe EffectiefAI draait op Railway, eerst als staging (`staging.effectiefai.nl`), later als productie in een eigen environment (bijv. `app.effectiefai.nl`).

**Status:** gebouwd in sessie 3; staging draait sinds 2026-10-05 op https://staging.effectiefai.nl. Keuzes van Daniël: #054–#056; voorstellen: #057–#059, #061–#064; lokale stack en verify-job: #065; eerste uitrol: #066–#068.

Uitgangspunt: **de app weet niet dat hij op Railway draait.** Alles wat Railway-specifiek is staat in `.railway/` en `.github/workflows/deploy-staging.yml`; de Dockerfiles en pre-deploy-scripts zijn generiek. Overstappen naar een andere host is dan nieuwe infra-config, geen appwijziging (#054).

---

## 0. Wat de Railway-documentatie nu zegt (oktober 2026)

Wat ik vond en wat het ontwerp stuurt. Alles hieronder is gelezen in de actuele docs; waar docs en forum elkaar tegenspreken staat dat erbij.

| Onderwerp | Bevinding | Gevolg voor het ontwerp |
|---|---|---|
| Config-as-code | `railway.json`/`railway.toml` zijn **deprecated** en worden vanaf **2026-12-01 niet meer gelezen**. Nieuwe services kunnen er niet meer voor kiezen. Opvolger: Infrastructure as Code in `.railway/railway.ts` met `railway config plan` / `apply` ([IaC](https://docs.railway.com/infrastructure-as-code), [referentie](https://docs.railway.com/infrastructure-as-code/reference)). | Geen `railway.json`. We gebruiken `.railway/railway.ts` (#061). |
| IaC-mogelijkheden | `service()` met `source: image(...)` of `github(...)`, `start`, `preDeploy`, `healthcheck`, `replicas`, `domains`, `env`, `volumeMounts`; `postgres()`, `redis()`, `volume()`; variabelen via `db.env.X`, `ctx.shared.X`, `preserve()`; `ctx.isEnvironment(name)`; restart policy via `deploy.restartPolicyType`. TCP proxy en "wait for CI" staan niet in de referentie. Officiële GitHub Action: [`railwayapp/config`](https://github.com/railwayapp/config) (plan op PR, apply na merge). | Wat IaC niet dekt (TCP proxy uit, PITR, registry-credentials) is een handmatige stap in docs/todo.md. |
| Dockerfile-builds | Builder `DOCKERFILE` met `dockerfilePath` ([config-as-code](https://docs.railway.com/reference/config-as-code)). Private networking is **niet beschikbaar tijdens de build** ([how it works](https://docs.railway.com/networking/private-networking/how-it-works)). | Migreren kan niet in de build; zie §2. |
| Images uit een registry | Docker Hub, GHCR, Quay, GitLab. **Private images vereisen het Pro-plan** (onze images zijn publiek zolang de repository publiek is, #067); voor GHCR een classic PAT ([services](https://docs.railway.com/guides/services)). Een nieuwe tag wordt gestaged en niet vanzelf uitgerold; programmatisch via de GraphQL-API (`serviceInstanceUpdate` + `serviceInstanceDeployV2`, daarna status pollen; [API](https://docs.railway.com/integrations/api), [forum](https://station.railway.com/questions/deploying-pre-built-images-from-git-hub-a-d4ac84bd)). GHCR-opslag en -verkeer zijn nu gratis ([GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-packages)). | CI bouwt images; één IaC-apply zet de nieuwe tag (#064). Pro-plan nodig. |
| Pre-deploy command | Draait na de build en vóór de deploy, **in een aparte container met de env-variabelen van de service**, op het privénetwerk. Faalt hij, dan geen retry en gaat de deploy niet door ([pre-deploy](https://docs.railway.com/guides/pre-deploy-command)). | Niet op de api zetten (eigenaar-credentials zouden in de api-omgeving staan). Wel op een eigen migratieservice (§2). |
| Private networking | DNS `<service>.railway.internal`. **Environments aangemaakt na 16-10-2025: IPv4 én IPv6**; oudere alleen IPv6. Services in verschillende environments kunnen elkaar niet bereiken. ioredis/BullMQ: `family: 0` voor dual stack ([library configuration](https://docs.railway.com/networking/private-networking/library-configuration)). | Nieuw staging-environment (dus dual stack); api luistert op `::`; zie §1.3. |
| Environments | Variabelen en services zijn per environment; dupliceren kopieert services, variabelen en config. Project tokens gelden voor **één environment** (header `Project-Access-Token`) ([environments](https://docs.railway.com/guides/environments), [API](https://docs.railway.com/integrations/api)). | CI krijgt een token dat alleen staging kan raken. |
| Wachten op CI | "Wait for CI" houdt een GitHub-autodeploy in `WAITING` tot alle workflows klaar zijn; Railway raadt zelf af om daar een migratie op te laten leunen ([autodeploys](https://docs.railway.com/deployments/github-autodeploys)). | Niet nodig: wij deployen alleen vanuit een workflow die pas start als CI groen is. |
| Healthchecks | Alleen bij de start van een deploy, niet doorlopend; op `PORT`; vanaf host `healthcheck.railway.app`; standaard timeout 300 s ([healthchecks](https://docs.railway.com/reference/healthchecks)). | `PORT` expliciet zetten; doorlopende monitoring apart (Sentry). |
| Postgres + pgvector | Volgens de docs heeft `postgres-ssl` **geen pgvector** ([PostgreSQL](https://docs.railway.com/databases/postgresql)). In de praktijk bevat `postgres-ssl:17` (build 2026-09-30) wel `postgresql-17-pgvector` 0.8.6, getest met `CREATE EXTENSION vector`. Het image bevat pgBackRest voor PITR ([repo](https://github.com/railwayapp-templates/postgres-ssl)). | Railway's standaard-Postgres op tag `17`, geen eigen image (#063, vervangt #060). |
| Point-in-time recovery | Postgres single en HA. WAL-archief via pgBackRest naar een Railway-bucket; wekelijkse full, dagelijkse differential, ±4 weken venster; **telt pas vanaf de eerste base backup na aanzetten**. Restore maakt een **nieuwe service** naast de oude. CLI: `railway postgres pitr enable|status|restore` ([PITR](https://docs.railway.com/volumes/point-in-time-recovery), [backups](https://docs.railway.com/guides/postgres-backups-restores), [changelog](https://railway.com/changelog/2026-09-04-postgres-in-the-railway-cli)). Niet minor-versies pinnen. | PITR aanzetten vóór de eerste data (§7). |
| Volume-backups | Dagelijks (6 dagen), wekelijks (27 dagen), maandelijks (89 dagen); incrementeel, tegen volumeprijs ([backups](https://docs.railway.com/reference/backups)). | Daily aan als tweede laag. |
| Databases aanmaken | Bij de eerste apply (oktober 2026) maakte Railway `postgres` en `redis` aan met zijn standaarden: `postgres-ssl:18` en regio `asia-southeast1`, ondanks `image` en `region` in `database()`/`redis()`. Een tweede `config plan` toont dan wel de correctie (image naar 17, beide naar `europe-west4`), als destructieve wijziging. | Na het aanmaken altijd controleren (`railway status --json`); corrigeren terwijl de databases leeg zijn (#067). |
| Custom domains | `domains: [...]` staat in de IaC-referentie, maar `config plan` weigert het registreren van een nieuw domein: eerst in het dashboard toevoegen (gezien bij de eerste deploy, oktober 2026). Railway regelt TLS. | Alleen de edge krijgt een domein: eerst via het dashboard, daarna in `railway.ts` (#066, #068). |
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
        │ postgres (17 +  │     │ redis        │
        │ pgvector, PITR) │     │ (Railway)    │
        └──▲──────────────┘     └──────────────┘
           │ alleen tijdens een deploy
        ┌──┴──────────────┐     ┌──────────────┐
        │ migrate (job)   │     │ verify (job) │ app- en auth-rol,
        └─────────────────┘     └──────────────┘ alleen staging
```

| Service | Bron | Publiek | Replica's | Volume |
|---|---|---|---|---|
| `edge` | image `ghcr.io/daniel2002340/effectief-edge:<sha>` | ja, `staging.effectiefai.nl` | 1 | – |
| `api` | image `effectief-api:<sha>` | nee | 1 | – |
| `worker` | image `effectief-worker:<sha>` | nee | 1 | – |
| `migrate` | image `effectief-migrate:<sha>` | nee | 1 (draait alleen bij deploy) | – |
| `verify` | image `effectief-verify:<sha>` | nee | 1 (draait alleen bij deploy; niet in productie) | – |
| `postgres` | Railway's Postgres (`postgres-ssl:17`) | nee, TCP proxy uit | 1 | ja |
| `redis` | Railway's Redis (`railwayapp/redis:8.2`) | nee | 1 | ja |

Alle services in regio EU West (Amsterdam). Railway's automatische build (Railpack) gebruiken we niet: alle images komen uit onze eigen Dockerfiles (#012, #028) en worden in CI gebouwd (§3).

### 1.1 edge (Caddy)

Eén image met Caddy en de gebouwde web-app. Vervangt de nginx-stage in `apps/web/Dockerfile` (#057). Same-origin zoals in #021: de browser ziet alleen `staging.effectiefai.nl`.

Config: `apps/web/Caddyfile`. Kort:

- `/api/*`, `/webhooks/*` en `/health` gaan naar `{$API_UPSTREAM}`; Caddy zet `X-Forwarded-For` op alleen `X-Real-IP` van Railway (§4.3) en `X-Forwarded-Proto` op `https`.
- Op elke response, ook die van de api (`header { defer … }`): `X-Robots-Tag: noindex, nofollow`, HSTS, `nosniff`, `Referrer-Policy`; `Server` en `Via` weg.
- Op de app: een CSP (`script-src 'self'`, `connect-src 'self' https://*.ingest.de.sentry.io`, `frame-ancestors 'none'`; `style-src` met `'unsafe-inline'` voor de inline styles van Radix) en `X-Frame-Options: DENY`.
- `/robots.txt` met `Disallow: /`; `*.map` geeft 404; `/assets/*` een jaar cachebaar, de rest `no-cache`; onbekende paden geven `index.html`.
- Draait als `nobody`; admin-API, autosave en automatische HTTPS uit.

Caddy vult `{$VAR}` in zonder fout als de variabele ontbreekt. Daarom controleert het entrypoint van het image eerst `PORT` en `API_UPSTREAM` (`: "${API_UPSTREAM:?}"`) en start anders niet, in lijn met "env valideren bij opstarten".

### 1.2 api en worker

- Alleen bereikbaar via `api.railway.internal` / niet bereikbaar (worker). Geen domein, geen TCP proxy.
- api-healthcheck: `/health` op `PORT=3000`. De worker heeft geen HTTP-poort; zijn deploy is geslaagd als het proces start (startup faalt al bij ongeldige env).
- Beide vangen `SIGTERM` al af (`apps/*/src/main.ts`). Railway geeft bij een nieuwe deploy de oude container tijd om af te ronden (`drainingSeconds`); 30 s voor de worker.

### 1.3 Luisteren en verbinden op het privénetwerk

- Het staging-environment wordt nieuw aangemaakt, dus `*.railway.internal` geeft IPv4 én IPv6.
- **api luistert op `API_HOST=::`.** Op Linux accepteert een socket op `::` ook IPv4 (dual stack), dus dit werkt in nieuwe én oude (IPv6-only) environments. `0.0.0.0` zou in een IPv6-only environment onbereikbaar zijn.
- Caddy luistert op `:{$PORT}` (alle adressen, beide families).
- Uitgaande verbindingen: `pg` en ioredis gebruiken de DNS-resolver van Node en vinden beide families. Railway adviseert voor ioredis/BullMQ `family: 0`; dat staat generiek in de verbindingsopties van api en worker (geen Railway-code, ook lokaal correct).

### 1.4 Postgres

- Railway's eigen Postgres-service, image `ghcr.io/railwayapp-templates/postgres-ssl:17`. Dat bevat pgvector (0.8.6) en pgBackRest, dus geen eigen image (#063). Verdwijnt pgvector ooit, dan faalt migratie 0000 bij de deploy en grijpen we terug op een eigen image (#060).
- Major tag `17`, geen minor pin (PITR-eis).
- Geen publieke TCP proxy. Controleren na aanmaken: Settings → Networking, en er mag geen `DATABASE_PUBLIC_URL` bestaan.
- Database-rollen: zie §2.

### 1.5 Redis

Railway's eigen Redis-database (`redis()` in IaC, image `railwayapp/redis:8.2`). Railway zet het wachtwoord en levert `REDIS_URL` met de privé-host. Redis staat standaard op `maxmemory-policy noeviction`, wat BullMQ nodig heeft. Eerder stond hier een eigen Valkey-service; die vroeg een start-command met `$VALKEY_PASSWORD`, en of Railway die via een shell uitvoert kon ik zonder account niet testen (#064). Dev en CI blijven op Valkey 8; BullMQ ondersteunt beide.

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
  2. Login-rollen aanmaken of bijwerken (`CREATE`/`ALTER ROLE … LOGIN NOSUPERUSER NOBYPASSRLS … PASSWORD`, `GRANT app_runtime TO effectief_app`). De logica staat in `ensureLoginRoles()` (`packages/db/src/deploy/`); `pnpm db:roles` gebruikt dezelfde functie voor dev.
  3. Controle: geen login-rol is superuser, heeft BYPASSRLS, of is (via lidmaatschap) eigenaar van een tabel. Faalt de controle, dan faalt de deploy. Dezelfde regels als `packages/db/src/roles.test.ts`.
- Wachtwoorden: `APP_DB_PASSWORD` en `AUTH_DB_PASSWORD` als gedeelde (shared) variabelen, `openssl rand -hex 32` (hex, dus geen URL-encoding nodig). Roteren = variabele wijzigen en opnieuw deployen; stap 2 zet het nieuwe wachtwoord.

### 2.3 Eigenaar-credentials niet in api of worker

Een pre-deploy command op `api` zou draaien met de variabelen van `api`, dus dan zou `DATABASE_MIGRATION_URL` in de api-omgeving staan. Daarom een **aparte service `migrate`** (`apps/migrate`, #058, #064):

- Image `effectief-migrate:<sha>` met alleen de gebundelde migratiestap en `packages/db/migrations`.
- **Pre-deploy command:** `node dist/main.js` (stap 1–3 hierboven). Faalt hij, dan gaat de deploy van `migrate` op `FAILED`, en api en worker blijven wachten tot ze opgeven (§2.4).
- **Start command:** `node dist/status.js` (logt de toegepaste migratie en eindigt met 0); restart policy `NEVER`. Er draait dus geen container met eigenaar-credentials zodra de migratie klaar is.
- Alleen `migrate` heeft `DATABASE_MIGRATION_URL=${{postgres.DATABASE_URL}}`. `api` en `worker` verwijzen nooit naar `postgres.DATABASE_URL`, `PGPASSWORD` of `PGUSER`; hun URL's worden opgebouwd uit `effectief_app`/`effectief_auth` en de gedeelde wachtwoorden (§4.1).
- Test: `apps/migrate/test/railway-config.test.ts` voert `.railway/railway.ts` uit en faalt als een andere service dan `migrate` een variabele krijgt die naar de eigenaar-credentials van Postgres of `DATABASE_MIGRATION_URL` verwijst.

### 2.4 Volgorde: eerst migreren, dan deployen

De volgorde wordt afgedwongen door de pre-deploy commands, niet door de workflow (#064). Railway mag alle services tegelijk uitrollen:

1. `migrate` voert in zijn pre-deploy de migraties uit.
2. `api` en `worker` draaien in hun pre-deploy `node dist/check-schema.js`: **als app-rol** peilen ze elke 5 s of `drizzle.__drizzle_migrations` de nieuwste migratie uit hun build bevat (ingebakken bij de build, uit het journal). Pas dan start de nieuwe versie; tot die tijd draait de oude door. Na 15 minuten faalt de deploy. Daarvoor heeft `app_runtime` alleen `SELECT` op die tabel (migratie 0015). Bestaat de login-rol nog niet (eerste deploy: `migrate` maakt hem aan, mogelijk na de start van deze check) of klopt het wachtwoord niet, dan wacht de check ook en logt hij `state: no-login`. Gevonden met de lokale stack (§3.4).
3. `edge` wacht in zijn pre-deploy (`edge-wait-for-api`) tot de api op het privénetwerk via `/health` dezelfde release meldt als de edge zelf. Zo komt een nieuwe web-app nooit live vóór de api waar hij bij hoort.

Dit geldt ook voor een handmatige redeploy in het dashboard: nieuwe code start nooit op een schema zonder zijn migratie.

### 2.6 Verify-job: RLS en rollen op de echte database

Zonder TCP proxy kan niemand van buiten de staging-database bereiken, dus de tests gaan naar de database toe (#065):

- Image `effectief-verify:<sha>`: stage `verify` van `apps/migrate/Dockerfile`, de workspace met vitest (±700 MB, alleen voor deze job).
- Draait `packages/db/vitest.verify.config.ts`: `roles`, `with-tenant`, de isolatietests van feed, memory en knowledge, en `memory/grants`. Ze verbinden alleen als `effectief_app` en `effectief_auth`; `verify` krijgt geen eigenaar-credentials (test op `.railway/railway.ts`).
- Pre-deploy `node scripts/wait-for-schema.ts` (zelfde wachten als api en worker); start = de tests; restart `NEVER`. Resultaat staat in de deploy-log van `verify`; een rode test geeft een mislukte deploy van `verify` (met Railway's e-mail), de andere services draaien gewoon door.
- Bij elke deploy op staging; niet in productie, omdat de tests eigen testtenants aanmaken (en daarna weer verwijderen).

### 2.5 Migraties en de draaiende versie

Tussen het migreren en de start van de nieuwe api draait de oude api op het nieuwe schema. Daarom: **migraties zijn achterwaarts compatibel met de vorige release** (expand/contract). Een kolom hernoemen of verwijderen gaat in twee releases: eerst toevoegen en beide schrijven, dan pas weghalen. Dit geldt ook voor terugdraaien (§3.3).

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
| 1 | Images bouwen en pushen naar GHCR: `effectief-{migrate,verify,api,worker,edge}:<sha>`, met `APP_RELEASE=<sha>`. Source maps naar Sentry vanuit de build-stage (§6). Bestaat een image al (terugdraaien), dan wordt hij hergebruikt. | stop, niets veranderd |
| 2 | `railway config plan`, daarna `railway config apply --yes` met `IMAGE_TAG=<sha>`. Zonder `--confirm-destructive`: een apply die iets zou verwijderen faalt. | stop |
| 3 | Railway rolt uit; de pre-deploys zorgen voor migrate → api/worker → edge (§2.4). Faalt een stap, dan blijft de vorige versie van die service draaien. | zie Railway en Sentry |
| 4 | Sentry: deploy van release `<sha>` op `staging` markeren. | workflow rood |

De workflow wacht niet tot Railway klaar is met uitrollen: de status staat in Railway (met e-mailmelding bij een mislukte deploy), fouten van de nieuwe versie in Sentry. Wachten in de workflow kan later via de GraphQL-API (docs/todo.md).

Waarom niet Railway zelf laten bouwen vanuit GitHub: dan bouwt elke service los, zonder volgorde tussen migratie en api, en zouden source maps en de Sentry-token in Railway's build zitten. Nu bouwt CI één keer per commit, en is precies dat image wat er draait (en later naar productie kan).

### 3.2 Config-as-code

- `.railway/railway.ts` beschrijft het project: services, bron (image), start- en pre-deploy commands, healthchecks, domein (eerst in het dashboard toegevoegd, #066), volumes, variabelen (met referenties) en replica's per regio. Secrets staan er als `preserve()` in: de waarde blijft in Railway, de naam staat in git.
- Verschillen tussen staging en productie via `ctx.isEnvironment('production')` (`APP_ORIGIN`, `SENTRY_ENVIRONMENT`, geen `verify`).
- De file legt ook de image-tag vast (`IMAGE_TAG`, verplicht, een volledige SHA), dus config en code worden samen uitgerold: de deploy-workflow doet plan en apply. Een plan als PR-commentaar komt later (docs/todo.md). Productie wordt een tweede environment met dezelfde file en een eigen project token.
- Wat IaC (nog) niet dekt, staat als handmatige stap in docs/todo.md: PITR aan, volume-backups, gedeelde variabelen, een nieuw domein. Wat Railway daarbij aanmaakt (PITR-bucket, domein) komt daarna in `railway.ts`, anders wil de volgende apply het verwijderen (#068).
- `railway` (npm-package voor de DSL, 3.12.0) is een devDependency van de root en van `apps/migrate` (voor de test); de Railway CLI (5.63.1) installeert de workflow. Geen van beide komt in een image.

### 3.3 Terugdraaien

- **Code terugzetten:** `workflow_dispatch` van `deploy-staging` met een eerdere `sha`. De images bestaan nog in GHCR, en `.railway/railway.ts` van die commit wordt toegepast. De migratiejob draait wel, maar doet niets: drizzle past alleen migraties toe die nieuwer zijn dan de laatste in de database. De schemacheck van de oude api slaagt, want zijn migratie zit erin. Alternatief bij haast: in het Railway-dashboard "Rollback" op `api`, `worker` en `edge` (Railway zet de vorige deploy terug met dezelfde image).
- **Migraties gaan alleen vooruit.** Een gedraaide migratie wordt nooit teruggedraaid. Dankzij §2.5 werkt de vorige code op het nieuwe schema. Moet het schema terug, dan is dat een **nieuwe migratie** in een nieuwe PR, die gewoon door de flow gaat.
- **Data stuk door een migratie** (bijv. een verkeerde `UPDATE`): PITR naar het moment vóór de deploy (§7). Het tijdstip staat in de deploy-log van `migrate` in Railway.
- Een rollback van `migrate` zelf is zinloos: drizzle slaat al toegepaste migraties over.

### 3.4 Lokaal nabootsen

`docker-compose.stack.yml` start dezelfde images met de env uit `.railway/railway.ts` tegen de Postgres en Valkey van `docker-compose.yml` (#065). Een eigen database `effectief_stack` met login-rollen `stack_app`/`stack_auth` (login-rollen gelden voor het hele cluster; zo blijven de dev-rollen en hun wachtwoorden ongemoeid) en Valkey-database 1. Pre-deploys draaien vóór het start-command, net als op Railway, en alle services starten tegelijk.

```
pnpm stack:up       images van deze commit bouwen en starten (edge op http://localhost:8088)
pnpm stack:smoke    /health met de release, 401 zonder sessie, noindex, robots.txt, geen source maps
pnpm stack:verify   de verify-job (§2.6) tegen effectief_stack
pnpm stack:down     stack-containers weg; postgres en valkey blijven draaien
```

Verschillen met staging: geen TLS (dus inloggen in de browser werkt niet: `APP_ORIGIN` moet in productie-modus https zijn, de edge is lokaal http), geen `X-Real-IP` van Railway's edge (het client-IP-gedrag van §4.3 is alleen op staging te testen), Valkey 8 in plaats van Redis 8.2, `pgvector/pgvector:pg17` in plaats van `postgres-ssl:17`. CI draait hetzelfde in de job `Images and local stack`.

---

## 4. Configuratie en secrets

### 4.1 Variabelen per service

Railway-referenties: `${{service.VAR}}` en `${{shared.VAR}}`. "Secret" = sealed in Railway (niet zichtbaar in UI/API na opslaan).

**Gedeeld (environment-niveau)**

| Variabele | Secret | Waarde / bron |
|---|---|---|
| `APP_DB_PASSWORD` | ja | `openssl rand -hex 32` |
| `AUTH_DB_PASSWORD` | ja | `openssl rand -hex 32` |

**postgres** — Railway's template-variabelen (`PGUSER`, `PGPASSWORD`, `PGDATABASE`, `DATABASE_URL`, …) plus de PITR-variabelen die Railway zet bij "Enable PITR". Geen eigen variabelen.

**redis** — Railway's template-variabelen (`REDIS_PASSWORD`, `REDIS_URL`, …). Geen eigen variabelen.

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
| `REDIS_URL` | ja | `${{redis.REDIS_URL}}` (privé-host) |
| `BETTER_AUTH_SECRET` | ja | `openssl rand -base64 32` |
| `AUTH_SIGNUP_ALLOWLIST` | nee | nieuw (§5.1) |
| `SENTRY_DSN` | nee* | nieuw; DSN van project `api` |
| `SENTRY_ENVIRONMENT` | nee | nieuw; `staging` |

**worker**: `NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, `SENTRY_DSN` (project `worker`), `SENTRY_ENVIRONMENT`. Geen `DATABASE_AUTH_URL`: de worker heeft de auth-tabellen niet nodig.

**verify** (alleen staging): `NODE_ENV=test`, `DATABASE_URL` en `DATABASE_AUTH_URL` als bij migrate.

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

`SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `APP_RELEASE` en `AUTH_SIGNUP_ALLOWLIST` staan in de Zod-schema's, in `.env.example` en in CI. Zonder fallback: lokaal expliciet `SENTRY_DSN=disabled`. De web-image is per environment (de `VITE_*`-waarden zitten in de bundle); api-, worker- en migrate-images zijn hetzelfde voor staging en productie.

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
- **Getest op 2026-10-05** tegen staging, via `x-ratelimit-remaining` (de teller van de sleutel `ratelimit:api:<request.ip>`): requests met vervalste `X-Forwarded-For`, `X-Real-IP`, een keten van beide en `Forwarded` tellen allemaal af op één teller met de gewone requests (299 → 293). Een client kiest zijn sleutel dus niet zelf. IPv4 en IPv6 van dezelfde machine hebben elk een eigen teller, en een nieuw venster begint op 299: geen gedeeld proxy- of CDN-adres als sleutel. De sleutels in Redis zelf zijn niet bekeken (daarvoor is `railway ssh` met een gekoppelde SSH-sleutel nodig).

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
- Database en Redis niet publiek; PITR en backups aan.
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
| api | `@sentry/node` | `initMonitoring()` in `main.ts`; de error handler en de `onError` van oRPC melden alleen 5xx via `reportError` met request-ID en route. Geen `--import`-preload nodig: we gebruiken geen tracing, alleen fouten |
| worker | `@sentry/node` | idem; de `failed`-handler meldt een job pas na de laatste poging, met queue, job-naam, job-ID, aantal pogingen en `tenantId` (uit de met Zod geparste payload, nooit de payload zelf) |
| web | `@sentry/react` | in `main.tsx`; alleen fouten, geen tracing, geen Session Replay |

Nieuwe dependencies: `@sentry/node` en `@sentry/react` 10.75.3, en `@sentry/cli` 3.8.0 (dev, voor uploads; root-script `sourcemaps:upload`). Bestaand alternatief bekeken: pino logt al fouten, maar zonder groepering, alerts of releases. Bewust 10.x en niet 11: `@sentry/node` 11 neemt `@sentry/bundler-plugins` (Babel, Rollup, Vite) mee als runtime-dependency, wat het api-image ±200 MB groter maakte. Met 10.75.3 is het ±46 MB. De opties en het scrubben staan één keer in `packages/shared/src/monitoring.ts` (zonder Sentry-import).

### 6.2 Releases en source maps

- `release = APP_RELEASE = <git-SHA>`, gelijk voor api, worker en web. `environment = staging`.
- `SENTRY_ENVIRONMENT` is een enum (`development | test | ci | stack | staging | production`); `SENTRY_DSN=disabled` wordt geweigerd op staging en production (#069).
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
- Foutmeldingen en stacks (Sentry én pino): e-mailadressen eruit, en de waarden die de fout zelf onder een gevoelige sleutel draagt, zoals `error.context.name`. Een naam die alleen in de tekst staat is niet te herkennen (#070). `extraErrorDataIntegration` zet de velden van een fout in het event, gecensureerd op sleutel.
- Op de images bewezen in CI: `scripts/stack-redaction.sh` (`pnpm stack:redaction`) controleert de logs van api en worker na een registratie en de testfouten.
- Test (`packages/shared/src/monitoring.test.ts`): een event met een e-mailadres en naam in body, headers, cookies, gebruiker, `detail`, breadcrumbs en context bevat na `scrubEvent` geen van die waarden meer; ID's, codes en paden blijven staan.

### 6.4 Testfouten (#069)

Buiten productie (`SENTRY_ENVIRONMENT` ≠ `production`), ingelogd als owner, op `/testfout`:

- **Fout in de browser:** gooit `MonitoringTestError` in een event handler → project web.
- **Fout in de api:** `POST /api/test/error` met `target: api` → 500, project api.
- **Fout in de worker:** dezelfde procedure met `target: worker` → job in `monitoring-test`, faalt twee keer, na de laatste poging één melding in project worker.

Controle na een deploy: elke fout staat in het juiste project, met release = de SHA uit `/health`, een leesbare stacktrace (bronbestanden, geen `[email]` in paden) en zonder `testfout.jansen@example.com` of `Testfout Jansen`. In productie geven route en procedure 404 en draait de queue niet.

---

## 7. Back-ups

### 7.1 Opzet

- **PITR aan bij het aanmaken, vóór de eerste migratie.** Het venster begint pas bij de eerste base backup na aanzetten. Volgorde in docs/todo.md: Postgres aanmaken → PITR aan → `railway postgres pitr status` toont een base backup → pas dan de eerste deploy.
- Bucket in een EU-regio; de regio van een bucket kan na aanmaken niet meer veranderen.
- Daarnaast **dagelijkse volume-backup** (6 dagen): snel terugzetten op dezelfde service bij een kapot volume.
- Redis: data op een volume; geen back-up. Verloren jobs vangt de sweeper op (docs/todo.md, Code).

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

**Gedaan op 2026-10-05:** restore naar 10:00:00Z in `postgres-restoretest`, `pnpm restore:verify` groen, ±2 min 16 s van commando tot geverifieerd. Stappen, tijden en valkuilen (Railway meldt `SUCCESS` vóór het einde van de replay, het volume blijft staan na het verwijderen van de service, IaC wil de service verwijderen): docs/operations.md §5. Het script vergelijkt met de bron (migraties, aantallen, gehashte steekproef, RLS, login-rollen) via `railway ssh`, read-only.

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
| redis | 30 MB | 0,01 vCPU | 0,5 GB volume | $0,60 |
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

1. Extra `basic_auth` op staging (§5.3)? **Gekozen: nee** (Daniël liet de keuze vrij): de app-login met allowlist is de afscherming, en basic auth stoort bij testen met pilotklanten.
2. TLS naar Postgres op het privénetwerk: `sslmode=require` met het self-signed certificaat van `postgres-ssl` vraagt in node-postgres een eigen CA-instelling. **Gekozen:** voorlopig zonder TLS binnen het privénetwerk; uitzoeken vóór productie (docs/todo.md).
3. ~~PITR op een eigen image~~: vervallen, we gebruiken Railway's eigen image (#063).
4. ~~Image-tags naast IaC~~: opgelost, de tag staat in IaC zelf (`IMAGE_TAG`) en één apply rolt alles uit (#064). De CLI vindt project en environment via het project token (gezien bij de eerste deploy). Nog te controleren: of `config apply` bij een nieuwe image-tag direct uitrolt (docs/todo.md).

## 10. Bronnen

- Railway: [IaC](https://docs.railway.com/infrastructure-as-code) · [IaC-referentie](https://docs.railway.com/infrastructure-as-code/reference) · [config-as-code (deprecated)](https://docs.railway.com/reference/config-as-code) · [pre-deploy](https://docs.railway.com/guides/pre-deploy-command) · [private networking](https://docs.railway.com/networking/private-networking/how-it-works) · [library configuration](https://docs.railway.com/networking/private-networking/library-configuration) · [environments](https://docs.railway.com/guides/environments) · [GitHub-autodeploys / Wait for CI](https://docs.railway.com/deployments/github-autodeploys) · [services en images](https://docs.railway.com/guides/services) · [public API](https://docs.railway.com/integrations/api) · [PostgreSQL](https://docs.railway.com/databases/postgresql) · [postgres-ssl](https://github.com/railwayapp-templates/postgres-ssl) · [PITR](https://docs.railway.com/volumes/point-in-time-recovery) · [backups en restores](https://docs.railway.com/guides/postgres-backups-restores) · [volume-backups](https://docs.railway.com/reference/backups) · [healthchecks](https://docs.railway.com/reference/healthchecks) · [prijzen](https://docs.railway.com/reference/pricing/plans) · [buckets](https://docs.railway.com/storage-buckets/billing) · [forum: edge-headers](https://station.railway.com/questions/security-critical-questions-on-edge-prox-8fddd775) · [forum: images vanuit Actions](https://station.railway.com/questions/deploying-pre-built-images-from-git-hub-a-d4ac84bd)
- Sentry: [data storage location](https://docs.sentry.io/organization/data-storage-location/) · [gevoelige data](https://docs.sentry.io/platforms/javascript/guides/fastify/data-management/sensitive-data/) · [prijzen](https://sentry.io/pricing/)
- GitHub: [Packages-billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)

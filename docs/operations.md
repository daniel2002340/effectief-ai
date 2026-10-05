# Operations

Naslag voor beheer van staging (en straks productie) op Railway. Hoe het in elkaar zit en waarom: docs/deployment.md. Projectnaam in Railway: `effectiefai` (niet het oude "Effectief AI").

Vooraf, eenmalig op je laptop:

```
brew install railway                     # ≥ 5.42.1, nodig voor `railway postgres pitr`
railway login && railway link            # project effectiefai, environment staging
railway ssh keys add -k ~/.ssh/id_ed25519.pub   # PITR-status, verify-restore en ssh lopen via SSH
```

De CLI biedt `~/.ssh/id_ed25519` aan; staat alleen een andere sleutel bij Railway, dan meldt hij `signup_required` of `no_ssh_key`.

---

## 1. Deployen

- **Normaal:** merge naar `main`. CI → `deploy-staging.yml` bouwt de images (`:<sha>`) en doet één `railway config apply`. De pre-deploys regelen de volgorde: migrate → api/worker → edge (deployment.md §2.4).
- **Gemeten 2026-10-05 (PR #9):** merge 10:02:56Z → api meldt de nieuwe SHA 10:08:07Z → nieuwe edge live 10:08:14Z: **5 min 18 s**, zonder handwerk.
- **Controleren:** `curl https://staging.effectiefai.nl/health` geeft `{"status":"ok","release":"<sha van main>"}`. Daarna in de deploy-log van `verify` (§4) dat de RLS-tests slagen.
- De workflow wacht niet tot Railway klaar is (docs/todo.md). Een mislukte deploy zie je in Railway (e-mail) of doordat `/health` de oude SHA houdt.
- **Een apply die iets wil verwijderen faalt** (geen `--confirm-destructive`, #068). Meestal staat er iets in Railway dat niet in `.railway/railway.ts` staat (een herstelde database, een nieuw domein, een PITR-bucket). Controleren met:
  ```
  IMAGE_TAG=<sha op staging> railway config plan    # moet "already up to date" zeggen
  ```

## 2. Een deploy terugdraaien

- **Code terug:** GitHub → Actions → `deploy-staging` → *Run workflow* met de vorige `sha`. Images bestaan nog; migrate doet niets (drizzle slaat toegepaste migraties over); de oude api start op het nieuwere schema, want migraties zijn achterwaarts compatibel (#058, deployment.md §2.5).
- **Bij haast:** Railway-dashboard → `api`, `worker`, `edge` → Deployments → vorige → *Rollback*. Let op: de volgende merge zet weer de nieuwe versie neer.
- **Nooit** een migratie terugdraaien of een rij uit `drizzle.__drizzle_migrations` halen.

## 3. Een migratie die fout ging

| Situatie | Wat je ziet | Oplossing |
|---|---|---|
| Migratie faalt (SQL-fout, lock-timeout) | deploy van `migrate` `FAILED`; api/worker blijven op de oude versie wachten en geven na 15 min op | Postgres draait een migratie in een transactie, dus er is niets half toegepast. Fix als **nieuwe PR** (migratie aanpassen mag alleen als hij nergens is toegepast, ook niet in CI van main); mergen. |
| Migratie geslaagd, maar schema klopt niet | nieuwe code faalt, oude werkt | **Nieuwe migratie** die het herstelt (vooruit, nooit terug). Intussen code terugdraaien (§2). |
| Migratie heeft data beschadigd (verkeerde `UPDATE`/`DELETE`) | verkeerde of ontbrekende rijen | Restore naar het moment vóór de deploy (§5). Tijdstip: begin van de deploy-log van `migrate`. |

Vooraf voorkomen: kolom hernoemen of verwijderen in twee releases (eerst toevoegen en beide schrijven, dan weghalen).

## 4. Logs en fouten

| Wat | Waar |
|---|---|
| Logs van een service | Dashboard → service → Deployments → *View logs*, of `railway logs -s <api\|worker\|edge\|migrate\|verify\|postgres>`; een specifieke deploy: `railway deployment list -s <svc>` en `railway logs -s <svc> -d <deployment-id>` |
| HTTP-verkeer | `railway logs -s edge --http` |
| Migraties van een deploy | deploy-log van `migrate` (pre-deploy), toegepaste migratie in die van `status` |
| RLS- en roltests op staging | deploy-log van `verify`; rood = mislukte deploy van `verify` met e-mail, de rest draait door |
| Fouten | Sentry (EU, `de.sentry.io`), projecten `web`, `api`, `worker`; filter op release = SHA uit `/health`. api meldt alleen 5xx; worker een job pas na de laatste poging |
| Monitoring zelf testen | https://staging.effectiefai.nl/testfout als owner (deployment.md §6.4) |

Logs bevatten ID's, geen e-mailadressen, namen of mailinhoud (#070). Zie je die toch: dat is een bug.

## 5. Een restore uitvoeren

PITR staat aan op `postgres` (bucket `Postgres-PITR`, ams); daarnaast een dagelijkse back-up, 6 dagen bewaard.

**Oefening 2026-10-05** (staging, doel 10:00:00Z):

| Stap | Duur |
|---|---|
| `railway postgres pitr restore` (commando) | 8 s |
| nieuwe service aangemaakt → Railway `SUCCESS` | 18 s |
| base backup terugzetten + WAL afspelen → `ready to accept connections` | 1 min 37 s |
| `verify-restore` | 12 s |
| **commando → geverifieerd** | **±2 min 16 s** |

RPO: Postgres stopte vlak vóór de eerste commit na het doel (10:03:54); niets verloren tot het gekozen moment. De database was klein (±5 rijen); met echte data duurt het afspelen langer. Omzetten van de app naar de herstelde database is **niet** geoefend (docs/todo.md).

### Stappen

1. **Dekking bekijken:** `railway postgres pitr status --service postgres`. Kies een tijdstip tussen *Latest backup* en *Restorable up to*. Dat laatste is de laatste commit in het archief: een doel daarna kan falen. Voor stilstaande data is dat vaak ver vóór *Last archived at*.
2. **Herstellen in een nieuwe service** (de oude blijft draaien):
   ```
   railway postgres pitr restore --service postgres --at 2026-10-05T10:00:00Z \
     --new-service-name postgres-restoretest --yes
   ```
3. **Wachten tot Postgres klaar is, niet tot Railway klaar is.** Railway zet de deploy al op `SUCCESS` terwijl pgBackRest nog WAL afspeelt. Wacht in de log op `archive recovery complete` en `database system is ready to accept connections`:
   ```
   railway logs -s postgres-restoretest -d | grep -E "recovery stopping|ready to accept"
   ```
4. **Controleren:**
   ```
   pnpm restore:verify --restored postgres-restoretest --at 2026-10-05T10:00:00Z
   ```
   Vergelijkt via `railway ssh` (read-only, als de superuser in de container) met `postgres`: migraties, tabellen, rijen van vóór het tijdstip per tabel, een gehashte steekproef, geforceerde RLS en de login-rollen. Output: alleen namen, aantallen en ID's. Exit 0 = geverifieerd. Dat een rij van ná het tijdstip ontbreekt is juist (bijv. `session`).
5. **Echt terugzetten** (alleen bij een incident; ongeoefend): de referenties `postgres.*` in `.railway/railway.ts` naar de nieuwe service, `config plan` zonder destroy van iets anders, mergen; de deploy met migrate zet de rolwachtwoorden opnieuw. Daarna PITR aanzetten op de nieuwe service en de nieuwe bucket in `railway.ts` (#068). Oude service pas na een dag weg.
6. **Opruimen na een oefening:**
   - Service verwijderen via **dashboard of CLI, nooit via IaC**: Service → Settings → *Delete service*.
   - **Het volume blijft staan** (`postgres-restored`, "Attached to: N/A", knop *Mount*). Apart verwijderen: volume → Settings → *Delete volume*. Controleer met `railway volume list`.
   - `IMAGE_TAG=<sha> railway config plan` moet weer "already up to date" geven.

### De IaC-valkuil

De herstelde service staat niet in `.railway/railway.ts`. **Zolang hij bestaat, niet mergen naar main:** de plan toont `Delete service postgres-restoretest`, de apply weigert dat (#068) en de deploy wordt rood. Een losgekoppeld volume ziet IaC niet; dat blokkeert niets, maar kost opslag.

## 6. Secrets roteren

Nieuwe waarde: `openssl rand -hex 32` (wachtwoorden) of `openssl rand -base64 32` (`BETTER_AUTH_SECRET`). Variabelen in Railway wijzigen = klaargezette wijziging → *Deploy*, of de volgende merge.

| Secret | Staat in | Doen | Gevolg |
|---|---|---|---|
| `APP_DB_PASSWORD`, `AUTH_DB_PASSWORD` | Railway, gedeelde variabelen | waarde wijzigen, deployen | migrate zet het nieuwe wachtwoord (#059); api/worker wachten in hun pre-deploy tot het past (`state: no-login`). De oude api kan tussen die twee momenten geen nieuwe verbindingen maken: enkele seconden fouten |
| `BETTER_AUTH_SECRET` | Railway, `api` | waarde wijzigen, deployen | **iedereen is uitgelogd** (sessiecookies zijn ermee getekend) |
| Redis-wachtwoord | Railway, service `redis` (Railway's eigen variabelen) | in de redis-service wijzigen, alles herstarten dat `REDIS_URL` gebruikt | api en worker even zonder Valkey (§7); jobs op het volume blijven |
| Postgres-superuser | Railway, service `postgres` (`PGPASSWORD`) | eerst `ALTER ROLE postgres PASSWORD …` via `railway ssh -s postgres`, dan de variabele; ongeoefend | alleen `migrate` gebruikt hem |
| `SENTRY_DSN` (api, worker) / `VITE_SENTRY_DSN` (web) | Railway `preserve()` / GitHub Environment variable | Sentry → project → Client Keys: nieuwe key, waarde zetten, deployen (web vraagt een nieuwe build), oude key uitzetten | geen; geen echt geheim |
| `RAILWAY_TOKEN` | GitHub Environment `staging` | Railway → Project Settings → Tokens: nieuw token voor `staging`, secret vervangen, oude intrekken | geen |
| `SENTRY_AUTH_TOKEN` | GitHub Environment `staging` | Sentry → Org Tokens: nieuw token, secret vervangen, oude intrekken | alleen builds (source maps) |
| `GITHUB_TOKEN` | per run door GitHub | – | – |

Een gelekt secret: eerst roteren, dan pas uitzoeken hoe. Gitleaks draait pre-commit en in CI.

## 7. Valkey of database onbereikbaar

`/health` geeft dan nog steeds 200: hij controleert alleen dat de api draait, niet de afhankelijkheden. Kijk dus in de logs en in Railway naar de service zelf.

| Wat valt weg | Gedrag nu | Wat te doen |
|---|---|---|
| **Valkey/Redis** | api: elke route met rate limit faalt met **500** (fail-closed, #027; 503 is juister, docs/todo.md). `/health` en webhooks werken door. Login en dashboard werken niet. Worker pakt geen jobs; ioredis blijft herverbinden en **logt elke poging als fout** (lognoise, docs/todo.md). | Railway → `redis` → status en logs; herstarten (Restart). Na herstel verbinden api en worker vanzelf; jobs staan op het volume. |
| **Postgres** | api: requests met database-toegang geven 500 en gaan naar Sentry; worker-jobs mislukken en worden opnieuw geprobeerd. Een deploy in die tijd faalt in de pre-deploy (de schemacheck kan niet verbinden); de vorige versie blijft draaien. | Railway → `postgres` → logs (schijf vol? crash?) en het volume (`railway volume list`, gebruik vs. 50 GB). Herstarten. Is de data stuk: restore (§5). |

Een actie die bleef hangen (`approved` zonder job, of `executing` na een crash) wordt nog niet automatisch opgepakt (sweeper, docs/todo.md).

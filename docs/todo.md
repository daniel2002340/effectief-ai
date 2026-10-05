# Todo

Alleen open punten. Afgerond = regel verwijderen. Regels voor bijhouden: zie CLAUDE.md.

## Voor Daniël

Handmatige acties buiten de code: accounts, app-installaties, verificaties, beslissingen.

- [ ] Renovate als GitHub-app op de repo installeren (#025)
- [ ] Beslissingen met status `voorgesteld` in docs/decisions.md doorlopen (#003–#008, #013, #033–#040, #043–#046, #048, #051, #052)
- [ ] Branch protection op `main`: CI-checks verplicht voor merge (#025)
- [ ] Voorstel CLAUDE.md-wijzigingen beoordelen: TypeScript 6 (#015), type stripping in dev (#016), webhooks alleen via `registerWebhookRoutes()` (#020), bundel + `scripts/deploy-app.sh` (#028), Better Auth in de stack en drie database-URL's (#030, #031), JSON-only voor wijzigingen (#032), webhooks opslaan als `webhook_delivery` in plaats van `event` (#038), connection-status ook `expired → active` bij opnieuw autoriseren (#044), embeddings via Cohere Embed 5 in plaats van Bedrock (#047), actiestatus met `executing` in de domeinbegrippen (`concept → approved → executing → executed | failed`, #050), uitzondering op "queue-jobs bevatten de tenant" voor fan-out-jobs die alleen tenant-ID's lezen, zoals de retentie-sweep (#052), hosting en foutmonitoring in de stack (Railway voor staging, Caddy als edge, Sentry EU; #054, #055, #057), Railway-config in `.railway/` en de regel "geen host-specifieke code in de apps" (#054, #061), migraties achterwaarts compatibel met de vorige release (#058)
- [ ] Staging op Railway inrichten, in deze volgorde (docs/deployment.md, #054–#067). Services en databases komen uit `railway config apply`; met de hand alleen secrets, PITR, TCP proxy, het domein en DNS. Sentry, GitHub-environment en gedeelde variabelen zijn klaar:
  1. Railway: 2FA aan, DPA bekijken en Railway op de subverwerkerslijst. Lokale CLI naar ≥ 5.42.1 (`npm i -g @railway/cli@5.63.1`, nu 4.30.3) en `railway login`
  2. Railway: postgres en redis staan in `asia-southeast1` en postgres op `postgres-ssl:18` (#067). Corrigeren terwijl ze leeg zijn: `railway config apply --confirm-destructive` (verplaatst beide naar `europe-west4`, image naar 17), daarna het postgres-volume vervangen door een leeg volume (17 start niet op een datadirectory van 18) en `migrate`, `verify`, `api`, `worker` opnieuw uitrollen; controleren met `railway status --json`. Daarna op `api` sealed `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `AUTH_SIGNUP_ALLOWLIST` (jouw adressen) en `SENTRY_DSN` (project `api`); op `worker` `SENTRY_DSN` (project `worker`)
  3. Railway, Postgres: Settings → Networking zonder TCP proxy en zonder `DATABASE_PUBLIC_URL` (ook `redis` controleren); **PITR aan** (bucket in de EU) en dagelijkse volume-backup aan; wachten tot `railway postgres pitr status` een base backup toont. Er staat dan alleen een leeg schema in
  4. `Deploy staging` opnieuw starten (Actions → Run workflow, SHA van main). Controleren: `config apply` rolt direct uit, regio is EU West (Amsterdam) (`europe-west4-drams3a` in `.railway/railway.ts`); in de logs van `api` en `worker` eerst `state: no-login`/`behind`, daarna `schema is current`
  5. Railway, `edge` → Settings → Networking: custom domain `staging.effectiefai.nl` op poort 8080 (IaC kan dat niet, #066). DNS bij de registrar: CNAME naar het doel dat Railway toont; wachten op het certificaat. Daarna `domains: [{ domain: origin, port: 8080 }]` terug in `edge` in `.railway/railway.ts` en de test in `apps/migrate/test/railway-config.test.ts` weer op `edge` met dit domein
  6. Samen controleren: `STACK_URL=https://staging.effectiefai.nl STACK_RELEASE=<sha> scripts/stack-smoke.sh` (200 met de release, 401 zonder sessie, noindex); inloggen met een adres op `AUTH_SIGNUP_ALLOWLIST`, en een adres erbuiten wordt geweigerd; de deploy-log van `verify` eindigt groen (6 testbestanden, 0 failed)
  7. Client-IP testen met vervalste `X-Forwarded-For` en `X-Real-IP` (de rate-limit-sleutel in Redis moet het echte IP zijn) (#057)
  8. Vóór de eerste echte mail (sessie 4): restore-oefening met PITR en `verify-restore`, tijd noteren (docs/deployment.md §7.3)
- [ ] Nango-account aanmaken, en hostingregio en DPA controleren (#005)
- [ ] Cohere-account aanmaken; DPA, EU-verwerking en data-retentie van de Cohere API nagaan; Cohere op de subverwerkerslijst (#047)
- [ ] AWS-account met Bedrock-toegang tot Claude in een EU-regio aanvragen (#007)
- [ ] Google OAuth-verificatie starten voor de Gmail-scopes; kan weken duren (#008)
- [ ] Microsoft Publisher Verification regelen (#008)
- [ ] Moneybird- en Mollie-OAuth-apps registreren (#008)
- [ ] Open vragen 3 (bewaartermijnen; de retentie gebruikt nu de voorstelwaarden) en 5 (forget in vrije tekst) in docs/data-model.md §7 beantwoorden (#052)
- [ ] 3–5 pilotklanten benaderen die Outlook of Gmail plus Moneybird gebruiken (#008)

## Code

Open werk in de codebase dat buiten de taak van een sessie viel.

- [ ] Valkey onbereikbaar geeft 500; 503 `SERVICE_UNAVAILABLE` is juister (#027, `apps/api/src/plugins/rate-limit.ts`)
- [ ] Lognoise beperken: bij Valkey-uitval logt elke herverbinding een fout (`apps/api/src/main.ts`)
- [ ] Web-bundle (543 kB + 73 kB Better Auth-client) verkleinen, vooral Zod en de oRPC-client (`apps/web`)
- [ ] Test `searchEmbeddings … uses the HNSW index` hangt af van tabelstatistieken: faalt op een lokale database na veel testruns, slaagt op een verse (`packages/db/src/knowledge/embeddings.test.ts`)
- [ ] api-image bevat vitest, vite en drizzle-kit (±60 MB) via optionele peer-dependencies van better-auth; uit de productie-`node_modules` halen (`scripts/deploy-app.sh`, #028)
- [ ] Twee varianten van drizzle-orm in de lockfile (met en zonder kysely-peer, via Better Auth); dedupliceren zodat de adapter dezelfde kopie gebruikt (#030)
- [ ] Foutantwoorden van `/api/auth/*` hebben de vorm van Better Auth, niet onze `ErrorResponse` (#030, `apps/api/src/auth/routes.ts`)
- [ ] Kolomnamen met klasse P/I uit `packages/db/src/pii.ts` toevoegen aan de redaction-sleutels in `packages/shared/src/logging.ts` (docs/data-model.md §3.7)
- [ ] `resolve_connection()` en de retentiestap voor `webhook_deliveries` (verwerkt, ouder dan 30 dagen) bouwen met de webhook-PR (#038, #052, `packages/db/src/lifecycle/retention.ts`)
- [ ] `proposeAction()` en `addEntityExternalRef()` gooien een gewone `Error` bij een onbekende of ongeschikte connectie; een getypte fout maken zodat de API die naar `NOT_FOUND`/`CONFLICT` vertaalt (`packages/db/src/feed/`)
- [ ] Deploy-workflow wacht niet tot Railway klaar is met uitrollen; status van de deploys ophalen (GraphQL `deployments`) en de workflow laten falen bij `FAILED`/`CRASHED` (#064, `.github/workflows/deploy-staging.yml`)
- [ ] `railway config plan` als commentaar op PR's die `.railway/` wijzigen (#061)
- [ ] Script `scripts/deploy/verify-restore.ts` voor de restore-oefening (docs/deployment.md §7.3)
- [ ] Sweeper voor acties die blijven hangen: `approved` zonder job (queue onbereikbaar bij akkoord) of `executing` na een crash in de laatste poging; per tenant via `list_tenant_ids()`, zoals de retentie-sweep (#050, #052)
- [ ] Echte adapters voor Moneybird, Gmail, Outlook en Mollie in `packages/integrations/<provider>/`, elk idempotent op de key; tot dan faalt een goedgekeurde actie als `unsupported` (#051, `apps/worker/src/main.ts`)
- [ ] API-procedure voor bewerken na uitvoeren of na een fout (`reopenAction()` bestaat in `packages/db/src/feed/actions.ts`) (#051)
- [ ] BullMQ bewaart de foutmelding van een mislukte job (`failedReason`) in Valkey; bij een onbekende fout kan daar tekst met persoonsgegevens in staan. Melding vervangen door een code (`apps/worker/src/jobs/execute-action.ts`)
- [ ] Procedures die de lifecycle-jobs starten: `entities.forget` (alleen `owner`, met bevestiging) en `connections.disconnect` (`disconnectConnection()` + job `purge-connection`) (#052, `apps/worker/src/jobs/`)
- [ ] Bij ontkoppelen ook de toegang bij Nango intrekken (connectie verwijderen via de Nango-API); vereist een Nango-client (#052, #005)
- [ ] Restcontrole na forgetEntity: overgebleven vrije tekst (feiten, playbooks, samenvattingen, kaarttitels, document-chunks) doorzoeken op naam en identifiers en een kaart voor de owner maken; wacht op open vraag 5 (docs/data-model.md §6.3 stap 3)
- [ ] `replaceFact()` en `createPlaybookVersion()` gooien `KnowledgeError`; bij de eerste API-procedures vertalen naar `NOT_FOUND`/`CONFLICT`, net als `TransitionError` (`packages/db/src/knowledge/`)

## Later

Bewust uitgesteld, met reden of beslissing erbij.

- [ ] Limiet per account naast per IP tegen credential stuffing, bijv. op e-mailadres (#027, #030)
- [ ] E-mailverificatie, wachtwoord vergeten en uitnodigingen; wacht op een mailprovider (#030)
- [ ] Passkeys (`@better-auth/passkey`) en 2FA (`twoFactor`) aanzetten (#030)
- [ ] TLS naar Postgres op het privénetwerk (`sslmode` met het certificaat van `postgres-ssl`) vóór productie (docs/deployment.md §9)
- [ ] Overstap naar Drizzle 1.0 zodra die stabiel is (#017)
- [ ] Evalset voor embeddings: Nederlands met Embed 5 toetsen, bevestigen dat Pro-documenten en Fast-queries samengaan, recall bij kleine tenants meten (#047, docs/data-model.md §3.5)
- [ ] `document_chunks.token_count` uit de tokenizer van Embed 5 halen (Cohere tokenize of lokaal), niet schatten; komt met de chunking-job (#047)
- [ ] Object storage (EU) voor originele documenten; `documents.storage_key` is tot dan leeg (#049)
- [ ] Langfuse-traces met de event-ID's van een vergeten persoon verwijderen; komt met de Langfuse-integratie (docs/data-model.md §6.3 stap 5)
- [ ] Overstap naar Sentry 11 zodra `@sentry/node` geen `@sentry/bundler-plugins` (Babel, Rollup, Vite) meer als runtime-dependency heeft; nu +200 MB in het api-image (#055)
- [ ] Overstap naar TypeScript 7 zodra tsup, knip en de editor het ondersteunen (#015)

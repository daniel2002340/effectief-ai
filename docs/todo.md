# Todo

Alleen open punten. Afgerond = regel verwijderen. Regels voor bijhouden: zie CLAUDE.md.

## Voor Daniël

Handmatige acties buiten de code: accounts, app-installaties, verificaties, beslissingen.

- [ ] Renovate als GitHub-app op de repo installeren (#025)
- [ ] Beslissingen met status `voorgesteld` in docs/decisions.md doorlopen (#003–#008, #013, #033–#040, #043–#046, #048, #051, #052, #057, #059, #061–#064, #066–#068, #071, #072, #076–#079)
- [ ] Branch protection op `main`: CI-checks verplicht voor merge (#025)
- [ ] Voorstel CLAUDE.md-wijzigingen beoordelen: TypeScript 6 (#015), type stripping in dev (#016), webhooks alleen via `registerWebhookRoutes()` (#020), bundel + `scripts/deploy-app.sh` (#028), Better Auth in de stack en drie database-URL's (#030, #031), JSON-only voor wijzigingen (#032), webhooks opslaan als `webhook_delivery` in plaats van `event` (#038), connection-status ook `expired → active` bij opnieuw autoriseren (#044), embeddings via Cohere Embed 5 in plaats van Bedrock (#047), actiestatus met `executing` in de domeinbegrippen (`concept → approved → executing → executed | failed`, #050), uitzondering op "queue-jobs bevatten de tenant" voor fan-out-jobs die alleen tenant-ID's lezen, zoals de retentie-sweep (#052), hosting en foutmonitoring in de stack (Railway voor staging, Caddy als edge, Sentry EU; #054, #055, #057), Railway-config in `.railway/` en de regel "geen host-specifieke code in de apps" (#054, #061), migraties achterwaarts compatibel met de vorige release (#058), bij Logging: wie een fout met persoonsgegevens gooit, zet die ook in een veld met een gevoelige sleutel, zodat ze uit message en stack geschrapt worden (#070), `docs/operations.md` in de structuurlijst, cloudflared bij Tooling als lokale tool (#071)
- [ ] Railway op de subverwerkerslijst (#054)
- [ ] Losgekoppeld volume `postgres-restored` van de restore-oefening verwijderen en controleren met `railway volume list` (docs/operations.md §5)
- [ ] Skill `building-nango-functions` staat in `.agents/skills/` (ongecommit, met `skills-lock.json`); Claude Code laadt alleen `.claude/skills/`. Symlinken of verplaatsen, en beslissen of `.agents/` en `AGENTS.md` in git horen (#073)
- [ ] Cohere-account aanmaken; DPA, EU-verwerking en data-retentie van de Cohere API nagaan; Cohere op de subverwerkerslijst (#047)
- [ ] AWS-account met Bedrock-toegang tot Claude in een EU-regio aanvragen (#007)
- [ ] Moneybird- en Mollie-OAuth-apps registreren (#008)
- [ ] Mail koppelen via Nango (sessie 4), wat nog openstaat (docs/integrations.md):
  1. Nango staging, API Keys: de "Default - Full access"-key verwijderen zodra alle keys werken (#078).
  2. Lokale `.env`: `NANGO_ENVIRONMENT=staging`, `NANGO_SECRET_KEY` (key `local-dev` met de scopes van app-api en app-worker samen, #083), `NANGO_WEBHOOK_SIGNING_KEY`, `NANGO_WEBHOOK_URL_OVERRIDE=none` (zie `.env.example`). `docker compose` meldt nu een ongeldige regel 14 in `.env`.
  3. Vóór de eerste pilotklant eigen OAuth-apps in plaats van Nango's testapps (#082): Google Cloud-project (Gmail API, consent screen met `gmail.readonly` + `gmail.send`, client "Web") en Entra-app ("any organizational directory and personal Microsoft accounts", `offline_access`, `User.Read`, `Mail.Read`, client secret met vervaldatum), elk met redirect-URI `https://staging.effectiefai.nl/oauth/callback`; client-ID en -secret in de integraties `gmail` en `outlook`; daarna de callback-URL in Nango (Environment Settings → Backend) op die URL zetten (§6).
  4. Google OAuth-verificatie en CASA Tier 2 voor de productie-app starten; kan weken duren (#008, docs/integrations.md §6.1).
  5. Microsoft Publisher Verification regelen (#008, §6.2).
  6. Nango: regio, DPA en doorgiftegrondslag nagaan; Nango op de subverwerkerslijst (#005, #074, §3.5). Plan en kosten per connectie/sync-run nakijken bij polling elke 5 minuten (#080).
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
- [ ] Nango-webhookfixtures zijn nog de voorbeelden uit de Nango-docs; na de eerste koppeling op staging echte bodies vastleggen (logs_get_operation), anonimiseren en vervangen; daarbij nagaan in welke vorm `environment` binnenkomt (`packages/integrations/src/nango/fixtures.ts`)
- [ ] Webhook-deliveries die `received` of `failed` blijven (queue onbereikbaar na opslaan, of alle retries op) opnieuw inplannen vanuit de sweep (#038, docs/integrations.md §4.6, `apps/api/src/routes/webhooks.ts`)
- [ ] `proposeAction()` en `addEntityExternalRef()` gooien een gewone `Error` bij een onbekende of ongeschikte connectie; een getypte fout maken zodat de API die naar `NOT_FOUND`/`CONFLICT` vertaalt (`packages/db/src/feed/`)
- [ ] Deploy-workflow wacht niet tot Railway klaar is met uitrollen; status van de deploys ophalen (GraphQL `deployments`) en de workflow laten falen bij `FAILED`/`CRASHED` (#064, `.github/workflows/deploy-staging.yml`)
- [ ] `railway config plan` als commentaar op PR's die `.railway/` wijzigen (#061)
- [ ] Sweeper voor acties die blijven hangen: `approved` zonder job (queue onbereikbaar bij akkoord) of `executing` na een crash in de laatste poging; per tenant via `list_tenant_ids()`, zoals de retentie-sweep (#050, #052)
- [ ] Echte adapters voor Moneybird, Gmail, Outlook en Mollie in `packages/integrations/<provider>/`, elk idempotent op de key; tot dan faalt een goedgekeurde actie als `unsupported` (#051, `apps/worker/src/main.ts`)
- [ ] API-procedure voor bewerken na uitvoeren of na een fout (`reopenAction()` bestaat in `packages/db/src/feed/actions.ts`) (#051)
- [ ] BullMQ bewaart de foutmelding van een mislukte job (`failedReason`) in Valkey; bij een onbekende fout kan daar tekst met persoonsgegevens in staan. Melding vervangen door een code (`apps/worker/src/jobs/execute-action.ts`)
- [ ] Procedures die de lifecycle-jobs starten: `entities.forget` (alleen `owner`, met bevestiging) en `connections.disconnect` (`disconnectConnection()` + job `purge-connection`) (#052, `apps/worker/src/jobs/`)
- [ ] Bij ontkoppelen ook de toegang bij Nango intrekken (connectie verwijderen via de Nango-API) en bij Google het token intrekken (`pre-connection-deletion`); vereist een Nango-client (#052, #077, docs/integrations.md §5.3)
- [ ] Restcontrole na forgetEntity: overgebleven vrije tekst (feiten, playbooks, samenvattingen, kaarttitels, document-chunks) doorzoeken op naam en identifiers en een kaart voor de owner maken; wacht op open vraag 5 (docs/data-model.md §6.3 stap 3)
- [ ] `replaceFact()` en `createPlaybookVersion()` gooien `KnowledgeError`; bij de eerste API-procedures vertalen naar `NOT_FOUND`/`CONFLICT`, net als `TransitionError` (`packages/db/src/knowledge/`)

## Later

Bewust uitgesteld, met reden of beslissing erbij.

- [ ] Limiet per account naast per IP tegen credential stuffing, bijv. op e-mailadres (#027, #030)
- [ ] E-mailverificatie, wachtwoord vergeten en uitnodigingen; wacht op een mailprovider (#030)
- [ ] Passkeys (`@better-auth/passkey`) en 2FA (`twoFactor`) aanzetten (#030)
- [ ] Volledige restore-oefening vóór productie, in een apart environment: app omzetten naar de herstelde database, PITR en bucket op de nieuwe service, tijden met echte data (docs/operations.md §5, #068)
- [ ] `/health` controleert database en Valkey niet; een aparte readiness-check overwegen (docs/operations.md §7)
- [ ] Named cloudflared-tunnel met vaste URL zodra een provider dat vereist (#071)
- [ ] TLS naar Postgres op het privénetwerk (`sslmode` met het certificaat van `postgres-ssl`) vóór productie (docs/deployment.md §9)
- [ ] Overstap naar Drizzle 1.0 zodra die stabiel is (#017)
- [ ] Evalset voor embeddings: Nederlands met Embed 5 toetsen, bevestigen dat Pro-documenten en Fast-queries samengaan, recall bij kleine tenants meten (#047, docs/data-model.md §3.5)
- [ ] `document_chunks.token_count` uit de tokenizer van Embed 5 halen (Cohere tokenize of lokaal), niet schatten; komt met de chunking-job (#047)
- [ ] Object storage (EU) voor originele documenten; `documents.storage_key` is tot dan leeg (#049)
- [ ] Langfuse-traces met de event-ID's van een vergeten persoon verwijderen; komt met de Langfuse-integratie (docs/data-model.md §6.3 stap 5)
- [ ] Overstap naar Sentry 11 zodra `@sentry/node` geen `@sentry/bundler-plugins` (Babel, Rollup, Vite) meer als runtime-dependency heeft; nu +200 MB in het api-image (#055)
- [ ] Overstap naar TypeScript 7 zodra tsup, knip en de editor het ondersteunen (#015)

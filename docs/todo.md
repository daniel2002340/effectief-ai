# Todo

Alleen open punten. Afgerond = regel verwijderen. Regels voor bijhouden: zie CLAUDE.md.

## Voor Daniël

Handmatige acties buiten de code: accounts, app-installaties, verificaties, beslissingen.

- [ ] Renovate als GitHub-app op de repo installeren (#025)
- [ ] Beslissingen met status `voorgesteld` in docs/decisions.md doorlopen (#003–#008, #013, #033–#040, #043–#046, #048, #051, #052)
- [ ] Branch protection op `main`: CI-checks verplicht voor merge (#025)
- [ ] Voorstel CLAUDE.md-wijzigingen beoordelen: TypeScript 6 (#015), type stripping in dev (#016), webhooks alleen via `registerWebhookRoutes()` (#020), bundel + `scripts/deploy-app.sh` (#028), Better Auth in de stack en drie database-URL's (#030, #031), JSON-only voor wijzigingen (#032), webhooks opslaan als `webhook_delivery` in plaats van `event` (#038), connection-status ook `expired → active` bij opnieuw autoriseren (#044), embeddings via Cohere Embed 5 in plaats van Bedrock (#047), actiestatus met `executing` in de domeinbegrippen (`concept → approved → executing → executed | failed`, #050), uitzondering op "queue-jobs bevatten de tenant" voor fan-out-jobs die alleen tenant-ID's lezen, zoals de retentie-sweep (#052), hosting en foutmonitoring in de stack (Railway voor staging, Caddy als edge, Sentry EU; #054, #055, #057), Railway-config in `.railway/` en de regel "geen host-specifieke code in de apps" (#054, #061), migraties achterwaarts compatibel met de vorige release (#058)
- [ ] Staging op Railway inrichten, in deze volgorde (docs/deployment.md, #054–#062):
  1. Railway: Pro-plan (nodig voor private GHCR-images), 2FA aan, DPA bekijken en Railway op de subverwerkerslijst
  2. Railway: project `effectiefai`, nieuw environment `staging` (nieuw = IPv4 + IPv6 op het privénetwerk), regio EU West (Amsterdam)
  3. Sentry: organisatie aanmaken in de **EU-regio** (onomkeerbaar), projecten `api`, `worker`, `web`; "Prevent Storing of IP Addresses" en Data Scrubber aan; org-token met alleen release/source-map-rechten
  4. GitHub: environment `staging` met secrets `RAILWAY_TOKEN` (project token, alleen environment staging) en `SENTRY_AUTH_TOKEN`, en variable `VITE_SENTRY_DSN` (DSN van `web`)
  5. GitHub: classic PAT met alleen `read:packages`; in Railway als registry-credentials bij elke image-service
  6. Railway: gedeelde variabelen `APP_DB_PASSWORD`, `AUTH_DB_PASSWORD`, `VALKEY_PASSWORD` (elk `openssl rand -hex 32`), sealed
  7. Railway: `postgres` uit ons image (`infra/postgres`, na de bouw-PR); Networking: geen TCP proxy, geen `DATABASE_PUBLIC_URL`; **PITR direct aan** (bucket in EU), dagelijkse volume-backup aan; wachten tot `railway postgres pitr status` een base backup toont
  8. Railway: op `api` sealed `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `AUTH_SIGNUP_ALLOWLIST` (jouw adressen), `SENTRY_DSN` (project `api`); op `worker` `SENTRY_DSN` (project `worker`); de rest staat in `.railway/railway.ts`
  9. Railway: restart policy van `migrate` op `NEVER`; `railway config apply` voor de rest
  10. DNS: `staging.effectiefai.nl` als CNAME naar het doel dat Railway bij de edge toont; wachten op het certificaat
  11. Na de eerste deploy: client-IP testen met vervalste `X-Forwarded-For` en `X-Real-IP` (alleen het echte IP in de log), noindex-header controleren, `/api/*` zonder sessie geeft 401 (#057)
  12. Vóór de eerste echte mail (sessie 4): restore-oefening met PITR en `verify-restore`, tijd noteren (docs/deployment.md §7.3)
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
- [ ] Docker-images bouwen in CI (#025)
- [ ] Twee varianten van drizzle-orm in de lockfile (met en zonder kysely-peer, via Better Auth); dedupliceren zodat de adapter dezelfde kopie gebruikt (#030)
- [ ] Foutantwoorden van `/api/auth/*` hebben de vorm van Better Auth, niet onze `ErrorResponse` (#030, `apps/api/src/auth/routes.ts`)
- [ ] Kolomnamen met klasse P/I uit `packages/db/src/pii.ts` toevoegen aan de redaction-sleutels in `packages/shared/src/logging.ts` (docs/data-model.md §3.7)
- [ ] `resolve_connection()` en de retentiestap voor `webhook_deliveries` (verwerkt, ouder dan 30 dagen) bouwen met de webhook-PR (#038, #052, `packages/db/src/lifecycle/retention.ts`)
- [ ] `proposeAction()` en `addEntityExternalRef()` gooien een gewone `Error` bij een onbekende of ongeschikte connectie; een getypte fout maken zodat de API die naar `NOT_FOUND`/`CONFLICT` vertaalt (`packages/db/src/feed/`)
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
- [ ] Overstap naar Drizzle 1.0 zodra die stabiel is (#017)
- [ ] Evalset voor embeddings: Nederlands met Embed 5 toetsen, bevestigen dat Pro-documenten en Fast-queries samengaan, recall bij kleine tenants meten (#047, docs/data-model.md §3.5)
- [ ] `document_chunks.token_count` uit de tokenizer van Embed 5 halen (Cohere tokenize of lokaal), niet schatten; komt met de chunking-job (#047)
- [ ] Object storage (EU) voor originele documenten; `documents.storage_key` is tot dan leeg (#049)
- [ ] Langfuse-traces met de event-ID's van een vergeten persoon verwijderen; komt met de Langfuse-integratie (docs/data-model.md §6.3 stap 5)
- [ ] Overstap naar TypeScript 7 zodra tsup, knip en de editor het ondersteunen (#015)

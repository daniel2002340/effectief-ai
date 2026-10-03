# Todo

Alleen open punten. Afgerond = regel verwijderen. Regels voor bijhouden: zie CLAUDE.md.

## Voor Daniël

Handmatige acties buiten de code: accounts, app-installaties, verificaties, beslissingen.

- [ ] Renovate als GitHub-app op de repo installeren (#025)
- [ ] Beslissingen met status `voorgesteld` in docs/decisions.md doorlopen (#003–#008, #013, #033–#040, #043–#046, #048)
- [ ] Branch protection op `main`: CI-checks verplicht voor merge (#025)
- [ ] Voorstel CLAUDE.md-wijzigingen beoordelen: TypeScript 6 (#015), type stripping in dev (#016), webhooks alleen via `registerWebhookRoutes()` (#020), bundel + `scripts/deploy-app.sh` (#028), Better Auth in de stack en drie database-URL's (#030, #031), JSON-only voor wijzigingen (#032), webhooks opslaan als `webhook_delivery` in plaats van `event` (#038), connection-status ook `expired → active` bij opnieuw autoriseren (#044), embeddings via Cohere Embed 5 in plaats van Bedrock (#047)
- [ ] Hosting kiezen met routering op pad (`/api`, `/webhooks` → api) en `API_TRUST_PROXY` daarop afstemmen (#021, #027)
- [ ] Bij de hosting: login-rollen voor `app_runtime` en `auth_runtime` aanmaken met eigen wachtwoorden; de eigenaar alleen voor migraties (#031)
- [ ] Nango-account aanmaken, en hostingregio en DPA controleren (#005)
- [ ] Cohere-account aanmaken; DPA, EU-verwerking en data-retentie van de Cohere API nagaan; Cohere op de subverwerkerslijst (#047)
- [ ] AWS-account met Bedrock-toegang tot Claude in een EU-regio aanvragen (#007)
- [ ] Google OAuth-verificatie starten voor de Gmail-scopes; kan weken duren (#008)
- [ ] Microsoft Publisher Verification regelen (#008)
- [ ] Moneybird- en Mollie-OAuth-apps registreren (#008)
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
- [ ] `resolve_connection()` en `list_tenant_ids()` bouwen met de webhook- en retentie-PR (#038, docs/data-model.md §3.10)
- [ ] `proposeAction()` en `addEntityExternalRef()` gooien een gewone `Error` bij een onbekende of ongeschikte connectie; een getypte fout maken zodat de API die naar `NOT_FOUND`/`CONFLICT` vertaalt (`packages/db/src/feed/`)
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
- [ ] Overstap naar TypeScript 7 zodra tsup, knip en de editor het ondersteunen (#015)

# Todo

Alleen open punten. Afgerond = regel verwijderen. Regels voor bijhouden: zie CLAUDE.md.

## Voor Daniël

Handmatige acties buiten de code: accounts, app-installaties, verificaties, beslissingen.

- [ ] Renovate als GitHub-app op de repo installeren (#025)
- [ ] Beslissingen met status `voorgesteld` in docs/decisions.md doorlopen (#003–#008, #013)
- [ ] Branch protection op `main`: CI-checks verplicht voor merge (#025)
- [ ] Voorstel CLAUDE.md-wijzigingen beoordelen: TypeScript 6 (#015), type stripping in dev (#016), webhooks alleen via `registerWebhookRoutes()` (#020), bundel + `scripts/deploy-app.sh` (#028)
- [ ] Hosting kiezen met routering op pad (`/api`, `/webhooks` → api) en `API_TRUST_PROXY` daarop afstemmen (#021, #027)
- [ ] Bij de hosting: login-rollen voor `app_runtime` en `auth_runtime` aanmaken met eigen wachtwoorden; de eigenaar alleen voor migraties (#031)
- [ ] Nango-account aanmaken, en hostingregio en DPA controleren (#005)
- [ ] AWS-account met Bedrock-toegang tot Claude in een EU-regio aanvragen (#007)
- [ ] Google OAuth-verificatie starten voor de Gmail-scopes; kan weken duren (#008)
- [ ] Microsoft Publisher Verification regelen (#008)
- [ ] Moneybird- en Mollie-OAuth-apps registreren (#008)
- [ ] 3–5 pilotklanten benaderen die Outlook of Gmail plus Moneybird gebruiken (#008)

## Code

Open werk in de codebase dat buiten de taak van een sessie viel.

- [ ] Valkey onbereikbaar geeft 500; 503 `SERVICE_UNAVAILABLE` is juister (#027, `apps/api/src/plugins/rate-limit.ts`)
- [ ] Lognoise beperken: bij Valkey-uitval logt elke herverbinding een fout (`apps/api/src/main.ts`)
- [ ] Web-bundle (553 kB) verkleinen, vooral Zod en de oRPC-client (`apps/web`)
- [ ] Docker-images bouwen in CI (#025)

## Later

Bewust uitgesteld, met reden of beslissing erbij.

- [ ] Strengere rate limits per route, o.a. voor login (#027)
- [ ] Overstap naar Drizzle 1.0 zodra die stabiel is (#017)
- [ ] Overstap naar TypeScript 7 zodra tsup, knip en de editor het ondersteunen (#015)

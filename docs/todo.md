# Todo

Alleen open punten. Afgerond = regel verwijderen. Regels voor bijhouden: zie CLAUDE.md.

## Voor Daniël

Handmatige acties buiten de code: accounts, app-installaties, verificaties, beslissingen.

- [ ] Renovate als GitHub-app op de repo installeren (#025)
- [ ] Beslissingen met status `voorgesteld` in docs/decisions.md doorlopen (#002–#008, #011–#013)
- [ ] Pushen en de eerste CI-run op GitHub controleren; tot nu toe alleen lokaal nagespeeld (#025)
- [ ] Branch protection op `main`: CI-checks verplicht voor merge (#025)
- [ ] Voorstel CLAUDE.md-wijzigingen beoordelen: TypeScript 6 (#015), type stripping in dev (#016), webhooks alleen via `registerWebhookRoutes()` (#020), bundel + `scripts/deploy-app.sh` (#028)
- [ ] Hosting kiezen met routering op pad (`/api`, `/webhooks` → api) en `API_TRUST_PROXY` daarop afstemmen (#021, #027)
- [ ] Nango-hostingregio en DPA controleren na pilotgesprekken (#005)

## Code

Open werk in de codebase dat buiten de taak van een sessie viel.

- [ ] Valkey onbereikbaar geeft 500; 503 `SERVICE_UNAVAILABLE` is juister (#027, `apps/api/src/plugins/rate-limit.ts`)
- [ ] Lognoise beperken: bij Valkey-uitval logt elke herverbinding een fout (`apps/api/src/main.ts`)
- [ ] Web-bundle (553 kB) verkleinen, vooral Zod en de oRPC-client (`apps/web`)
- [ ] Docker-images bouwen in CI (#025)

## Later

Bewust uitgesteld, met reden of beslissing erbij.

- [ ] Aparte databaserol zonder BYPASSRLS, FORCE RLS en rol-test; verplicht onderdeel van sessie 1, bij de eerste tabel (#026)
- [ ] Strengere rate limits per route, o.a. voor login (#027)
- [ ] Overstap naar Drizzle 1.0 zodra die stabiel is (#017)
- [ ] Overstap naar TypeScript 7 zodra tsup, knip en de editor het ondersteunen (#015)

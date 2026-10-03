# Architectuurbeslissingen

Nieuwe entries onderaan. Oude entries niet inhoudelijk wijzigen; bij een achterhaalde beslissing een nieuwe entry toevoegen en de status van de oude aanpassen.

Status: `voorgesteld` · `geaccepteerd` · `vervangen door #NNN`

Format:

```
## #NNN Titel
- **Datum:** JJJJ-MM-DD
- **Status:** voorgesteld | geaccepteerd | vervangen door #NNN
- **Context:** waarom dit speelde
- **Beslissing:** wat er gekozen is
- **Alternatieven:** wat overwogen is en waarom niet
- **Gevolgen:** wat dit betekent voor verder werk
```

---

## #001 Nieuwe codebase voor 2.0
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** v1 bestond uit losse tools (chatbot, inbox-assistent, contentgenerator) die als kleine losse verbeteringen voelden. 2.0 is één dashboard dat veel tools koppelt.
- **Beslissing:** Opnieuw beginnen in een nieuwe repo. De v1-repo wordt gearchiveerd en dient alleen als referentie; losse onderdelen (encryptiemodule, billing, prompts) worden gericht gekopieerd wanneer nodig.
- **Alternatieven:** v1 ombouwen op een branch. Niet gekozen omdat oude patronen en losse tools dan blijven sturen.
- **Gevolgen:** Geen legacy-code in de repo; geleerde lessen (o.a. tenant-isolatie) staan als regels in CLAUDE.md.

## #002 TypeScript end-to-end in een pnpm/Turborepo-monorepo
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Solo-ontwikkeling; Nango-integratiefuncties zijn TypeScript.
- **Beslissing:** Eén taal van integratie tot UI: Fastify (api), BullMQ (worker), React + Vite (web), gedeelde Zod-schema's.
- **Alternatieven:** Next.js full-stack (onnodige SSR voor een dashboard achter login, neiging tot Vercel-lock-in).
- **Gevolgen:** Types en validatie worden gedeeld via packages/shared.

## #003 Tenant-isolatie met Postgres Row Level Security
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** In v1 vond een audit IDOR-lekken tussen tenants.
- **Beslissing:** Elke tabel met klantdata heeft tenant_id en een RLS-policy; toegang alleen via withTenant().
- **Alternatieven:** Alleen applicatiechecks (één vergeten WHERE is een lek); database per tenant (te veel beheer).
- **Gevolgen:** Elke nieuwe tabel krijgt een isolatietest.

## #004 Alle externe schrijfacties via een actiepijplijn met akkoord
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** De AI leest onvertrouwde input (mail, berichten) en kan schrijven in boekhouding en betalingen; risico op prompt-injection.
- **Beslissing:** proposeAction → approve → execute, met idempotency_key en audit_log. Het model stelt alleen voor.
- **Alternatieven:** Automatisch uitvoeren bij hoge zekerheid. Uitgesteld tot er vertrouwen en data is.
- **Gevolgen:** Akkoordkaarten zijn het centrale UX-patroon.

## #005 Nango Cloud als integratielaag (start)
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** De gratis self-hosted editie van Nango dekt alleen auth en proxy; syncs, functies en webhooks vereisen Nango Cloud of Enterprise.
- **Beslissing:** Starten met Nango Cloud voor snelheid. Integratiecode staat in de eigen repo zodat overstappen mogelijk blijft.
- **Alternatieven:** Gratis self-hosted met eigen sync-logica (meer werk, tokens in eigen EU-omgeving).
- **Gevolgen:** Nango op de subverwerkerslijst; hostingregio en DPA controleren. Herzien na pilotgesprekken over EU-hosting.

## #006 Workflows eerst simpel, durable engine later
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Ketens (akkoord → factuur → betaling → review) kunnen dagen duren.
- **Beslissing:** In de MVP: status in Postgres + BullMQ delayed jobs.
- **Alternatieven:** DBOS of Temporal vanaf dag één (extra complexiteit voordat ketens bewezen zijn).
- **Gevolgen:** Overstap naar DBOS overwegen zodra er meerdere lange ketens zijn.

## #007 LLM: Claude via AWS Bedrock (EU) met Vercel AI SDK
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Klantdata moet zo veel mogelijk in de EU verwerkt worden; providerwissel moet mogelijk blijven.
- **Beslissing:** Claude via Bedrock in een EU-regio; Vercel AI SDK als abstractie; Langfuse voor tracing.
- **Alternatieven:** Directe Anthropic API; LangChain (zware abstractie).
- **Gevolgen:** Mistral blijft optie als EU-fallback.

## #008 MVP-keten: mail → kaart → Moneybird-offerte → Mollie-betaling
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** Waarde zit in de keten, niet in losse koppelingen.
- **Beslissing:** MVP met vier integraties: Outlook, Gmail, Moneybird, Mollie. Exact Online, agenda en Google Maps in de tweede golf.
- **Alternatieven:** Breder starten met de volledige MVP-lijst uit het integratieoverzicht.
- **Gevolgen:** Pilot met 3–5 klanten die Outlook of Gmail plus Moneybird gebruiken.

## #009 Lessen uit v1 als regels in CLAUDE.md
- **Datum:** 2026-10-03
- **Status:** geaccepteerd
- **Context:** Analyse van v1 (606 commits, 161 fixes) in LESSONS.md: tenant-lekken aan de randen, auth met uitzonderingen, secrets met fallbacks, migratie-drift, geen CI, werk verloren door parallelle agents, te veel planning en scope.
- **Beslissing:** De lessen zijn vertaald naar harde regels, conventies en werkwijze in CLAUDE.md. LESSONS.md zelf gaat niet mee naar de nieuwe repo (bevat v1-paden en -commits).
- **Gevolgen:** Afwijken van die regels vereist een nieuwe entry hier.

## #010 Typed API-contract met ts-rest
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** In v1 kwamen veldnamen van API en UI niet overeen ("undefinedx"); dat bleek pas in productie.
- **Beslissing:** ts-rest-contract met Zod in packages/shared, gebruikt door Fastify en door TanStack Query in web.
- **Alternatieven:** tRPC (minder REST, lastiger voor webhooks en externe clients); OpenAPI genereren uit Zod (extra codegen-stap).
- **Gevolgen:** Een mismatch tussen api en web faalt bij typecheck.

## #011 Deny-by-default route-authenticatie
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** In v1 groeide een lijst van ~20 uitzonderingen op login, bij elke "fix 401" één meer.
- **Beslissing:** Elke route declareert zijn auth-type; de server weigert te starten als een route er geen heeft.
- **Alternatieven:** Globale auth met uitzonderingslijst (v1-aanpak).
- **Gevolgen:** Startup-smoketest in CI controleert dit.

## #012 Build: ESM, gebundeld met tsup, eigen Dockerfile
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** v1 draaide in productie met tsx, had CJS/ESM-problemen en twee React-versies in één workspace.
- **Beslissing:** Alleen ESM; api en worker gebundeld met tsup tot één artifact dat met node draait; eigen Dockerfile; `--frozen-lockfile` overal; één React- en TypeScript-versie.
- **Alternatieven:** tsx in productie; vertrouwen op build-caching van de host.
- **Gevolgen:** De marketingsite komt later in deze workspace met dezelfde versies, of in een eigen repo.

## #013 Webhooks via een inbox: eerst opslaan, dan verwerken
- **Datum:** 2026-10-03
- **Status:** voorgesteld
- **Context:** In v1 werd een mislukte Mollie-webhook met 200 beantwoord en nooit opnieuw verwerkt; idempotency was niet atomair.
- **Beslissing:** Handtekening checken op de ruwe body, webhook opslaan als uniek event, 200 teruggeven, verwerken in een job met retries; verwerking en effecten in één transactie.
- **Alternatieven:** Synchroon verwerken in de request.
- **Gevolgen:** Geldt voor Nango, Mollie en elke toekomstige webhookbron.

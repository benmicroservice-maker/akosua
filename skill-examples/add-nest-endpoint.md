# Skill: when adding a NestJS endpoint in this repo
Copy this file to `.akosua/skills/add-nest-endpoint.md` in your project and adapt the specifics.

1. DTO first: request/response DTOs in the module's `dto/` with class-validator decorators matching neighbouring DTOs exactly (naming, decorators, Swagger decorators if present).
2. Controller method: same route style as existing endpoints; never invent a new URL convention.
3. Service: business logic in the service, never in the controller. Inject repositories the way siblings do.
4. Events: if the endpoint changes state others consume, emit the event the way existing code does (outbox/transport pattern already in the service) — payload changes are contract changes; check consumers in the contract map.
5. Module wiring: register controller/service in the module file; export only what other modules already expect.
6. Tests: extend the nearest existing spec file, same style. Verify: run the service's tests + typecheck and report the evidence.

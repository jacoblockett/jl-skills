# Installer + Map UI Smoke Review

Status: archived historical review notes from the 2026-08-25 interactive smoke passes on `spec-installer-lifecycle`.

The detailed requirements originally recorded in this file were progressively resolved, withdrawn, or superseded during the installer lifecycle review. Git history preserves that review record.

Do **not** use an older revision of this file as an implementation contract. Current accepted behavior lives in:

- `INSTALLER_SPEC.md` for the jl-skills installer, interactive UX, installation discovery, update/uninstall, skill-generated-data removal, and installer self-uninstall;
- `skills/map/SPEC.md` for Map's runtime, semantic model, storage, and Map-local project identity.

The current lifecycle no longer uses visible multiselect pseudo-options for All/Back/Cancel, an authoritative installer receipt registry, a machine-level Map project registry, or registry-driven Map project-data discovery.

## Still deferred outside this lifecycle pass

The historical Map skill/sub-agent orchestration design remains a separate investigation. Before redesigning `skills/map/SKILL.md` around an orchestration architecture, recover or rule out the earlier accepted design from repository/Persist history rather than inventing a replacement from scratch.

PR #8 remains draft until the current branch passes the Windows `bun run smoke` gate and the interactive UI is manually reviewed.

# JLS

JLS is an installer for a curated set of AI coding-agent skills.

It handles the annoying parts of using those skills across supported agents: downloading the correct package for your platform, placing skill files and native agent resources where the selected harness expects them, installing any required local tooling, managing optional instruction-file integration, and handling updates or removal later.

## Skills

### Map

**Map** is a durable local intent graph for projects and other long-running work.

It gives an agent somewhere explicit to preserve what you are trying to accomplish, the questions that still matter, decisions you have made, relevant facts, and ideas that should survive beyond the current conversation or context window.

The Map skill is primarily a clarification workflow. When invoked, it examines the current intent, identifies material ambiguity, asks only the decisions that can meaningfully change the outcome, and persists the resulting state locally. It does not implement the work itself.

Map is useful when a task is large enough that requirements, decisions, or rationale would otherwise be scattered through chat history and gradually lost or contradicted as work continues.

Map state lives in the project. Its runtime is local, uses embedded storage, and does not require a separate database server or listening service.

## Supported agents

JLS currently installs skills for:

- OpenAI Codex
- Claude Code

A skill may be installed for either or both agents in the same scope.

## Supported platforms

- Windows x64 / ARM64
- macOS x64 / ARM64
- Linux x64 / ARM64 (GNU)
- Linux x64 / ARM64 (musl)

## Install

Download the JLS executable for your platform from **Releases** and run it.

The interactive installer lets you choose:

- the skill to install;
- user, current-project, or custom-path scope;
- Codex, Claude Code, or both;
- whether JLS should add the skill's managed instructions to the harness instruction file.

JLS installs only inside the selected scope. Project installs stay with that project; user installs use the harness's user-level locations.

On macOS or Linux, you may need to mark the downloaded file executable first:

```bash
chmod +x <downloaded-file>
```

## Manage installed skills

Run JLS again to update or uninstall installed skills.

Updates replace files owned by the selected skill without overwriting unrelated project or instruction-file content. Removing one harness integration does not remove resources still needed by another integration of the same skill.

Skill-generated project data is kept separate from ordinary uninstall. If you explicitly want that data deleted, use **Remove skill-generated data**.

JLS can also update or uninstall itself from the same interface.

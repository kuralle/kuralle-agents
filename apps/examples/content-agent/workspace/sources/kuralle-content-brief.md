# Kuralle local content agent brief

## What shipped

Kuralle’s content example reads source material, style procedures, preferences, drafts, and publications from one caller-owned directory. The directory remains ordinary Markdown on disk and works with version control, backups, editors, and filesystem permissions.

The agent uses progressive skill disclosure. It sees the name and description of each style skill first, then loads the matching instructions and individual reference files only when the requested surface needs them.

## Safety boundaries

The model can inspect the workspace through a read-only Kuralle filesystem tool. Durable mutations use narrow typed tools. Saving a draft, changing preferences, publishing, and deletion all pause for approval.

Draft overwrites and publication require a SHA-256 revision returned by the latest read or save. A changed file causes a stale-write error instead of silently replacing or publishing unseen work. Publication creates a new file and refuses to overwrite an existing publication.

All draft claims must be grounded in named files below `/sources`. Style lint reads the active skill’s banned-word resource and fails if that resource is missing or malformed.

## Runtime

The example runs in Kuralle’s terminal UI. Pi is the default model driver. Setting `KURALLE_DRIVER=ai-sdk` selects Core's built-in AI SDK driver without changing the agent definition, tools, workspace, approvals, or skills.

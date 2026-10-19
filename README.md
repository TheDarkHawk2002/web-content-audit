# Web Content Audit

A small, dependency-free Node.js command-line tool that checks Markdown content for required frontmatter, duplicate slugs, and broken local Markdown links. It reports findings without changing source files.

## Requirements

- Node.js 20 or newer
- No third-party packages

## Run

```bash
node src/main.js examples/content
```

Or use the npm scripts:

```bash
npm run audit:example
npm start -- ./content --format json
```

The input can be one `.md` file or a directory. Directory scans include nested Markdown files and skip hidden folders, `.git`, `node_modules`, `dist`, `build`, and `coverage`.

## Reports

Choose `text` (default), `json`, or `csv`:

```bash
node src/main.js ./content --format json
node src/main.js ./content --format csv --output audit.csv
```

When `--output` is used, the CLI creates a new file and refuses to overwrite an existing one. Reports include the relative file path, line, rule, severity, and explanation. The command exits with `0` if the audit finds no issues, `1` if it finds issues, or `2` for invalid usage or I/O errors.

## Rules

- Every Markdown file needs a YAML-style frontmatter block with non-empty `title` and `description` fields.
- A `slug` field is optional. If omitted, the filename (without `.md`) is used. Slugs must be unique within the scanned content.
- Relative links to Markdown files and heading anchors are checked. External URLs and links to non-Markdown assets are left alone.

Example frontmatter:

```yaml
---
title: Getting started
description: A concise summary of this page.
slug: getting-started
---
```

## Scope and limitations

The frontmatter reader supports simple `key: value` entries rather than the full YAML specification. Link checking covers ordinary Markdown links and GitHub-style heading anchors; it does not render Markdown, fetch external URLs, or inspect embedded HTML. The tool is intended as a lightweight local content check, not a complete publishing validator.

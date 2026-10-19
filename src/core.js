import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);

export async function collectMarkdownFiles(root) {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat) throw new Error(`Input path does not exist: ${root}`);
  if (rootStat.isFile()) {
    if (path.extname(root).toLowerCase() !== '.md') throw new Error('Input file must use the .md extension.');
    return [path.resolve(root)];
  }
  if (!rootStat.isDirectory()) throw new Error('Input path must be a Markdown file or directory.');

  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(path.join(directory, entry.name));
        }
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
        files.push(path.resolve(directory, entry.name));
      }
    }
  }
  await walk(path.resolve(root));
  return files;
}

function parseFrontmatter(source) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { values: {}, lineByKey: {}, hasFrontmatter: false };
  const closing = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line.trim()));
  if (closing === -1) return { values: {}, lineByKey: {}, hasFrontmatter: true, malformed: true };

  const values = {};
  const lineByKey = {};
  for (let index = 1; index < closing; index += 1) {
    const match = lines[index].match(/^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value.trim();
    lineByKey[key] = index + 1;
  }
  return { values, lineByKey, hasFrontmatter: true };
}

function headingSlug(heading) {
  return heading.toLowerCase().trim().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-');
}

function markdownAnchors(source) {
  const anchors = new Set();
  const used = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const base = headingSlug(match[1]);
    if (!base) continue;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function relativeDisplay(file, root) {
  return path.relative(root, file).split(path.sep).join('/') || path.basename(file);
}

function addIssue(issues, issue) {
  issues.push({ severity: 'error', ...issue });
}

export async function auditMarkdown(input) {
  const root = path.resolve(input);
  const files = await collectMarkdownFiles(root);
  const baseDirectory = (await stat(root)).isDirectory() ? root : path.dirname(root);
  const records = await Promise.all(files.map(async (file) => {
    const source = await readFile(file, 'utf8');
    const parsed = parseFrontmatter(source);
    return { file, displayPath: relativeDisplay(file, baseDirectory), source, lines: source.split(/\r?\n/), ...parsed, anchors: markdownAnchors(source) };
  }));

  const issues = [];
  const slugOwners = new Map();
  for (const record of records) {
    if (!record.hasFrontmatter) {
      addIssue(issues, { file: record.displayPath, line: 1, rule: 'frontmatter.missing', message: 'Missing YAML frontmatter block.' });
    } else if (record.malformed) {
      addIssue(issues, { file: record.displayPath, line: 1, rule: 'frontmatter.unclosed', message: 'Frontmatter starts with --- but has no closing delimiter.' });
    }

    for (const field of ['title', 'description']) {
      if (!record.values[field]) {
        addIssue(issues, { file: record.displayPath, line: record.lineByKey[field] ?? 1, rule: `metadata.${field}`, message: `Required metadata field "${field}" is missing or empty.` });
      }
    }

    const slug = record.values.slug || path.basename(record.file, path.extname(record.file));
    const normalizedSlug = slug.toLowerCase().trim();
    if (normalizedSlug) {
      const first = slugOwners.get(normalizedSlug);
      if (first) {
        addIssue(issues, { file: record.displayPath, line: record.lineByKey.slug ?? 1, rule: 'slug.duplicate', message: `Slug "${slug}" is already used by ${first}.` });
      } else {
        slugOwners.set(normalizedSlug, record.displayPath);
      }
    }
  }

  const byAbsolutePath = new Map(records.map((record) => [path.resolve(record.file), record]));
  for (const record of records) {
    const fenceLines = new Set();
    let inFence = false;
    let fenceChar = '';
    let fenceLength = 0;
    record.lines.forEach((line, index) => {
      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (!inFence) {
          inFence = true;
          fenceChar = fence[1][0];
          fenceLength = fence[1].length;
        } else if (fence[1][0] === fenceChar && fence[1].length >= fenceLength) {
          inFence = false;
        }
      }
      if (inFence || fence) fenceLines.add(index);
    });

    for (const [index, line] of record.lines.entries()) {
      if (fenceLines.has(index)) continue;
      const links = line.matchAll(/(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g);
      for (const link of links) {
        const target = link[1].replace(/&amp;/g, '&');
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
        const decoded = (() => { try { return decodeURIComponent(target); } catch { return target; } })();
        const [targetPath, fragment] = decoded.split('#', 2);
        if (!targetPath) {
          if (fragment && !record.anchors.has(fragment.toLowerCase())) {
            addIssue(issues, { file: record.displayPath, line: index + 1, rule: 'link.anchor.missing', message: `Heading anchor "#${fragment}" does not exist in this file.` });
          }
          continue;
        }
        const resolved = path.resolve(path.dirname(record.file), targetPath.split('?')[0]);
        let targetFile = resolved;
        const ext = path.extname(targetFile).toLowerCase();
        if (!ext) {
          const directoryIndex = path.join(targetFile, 'index.md');
          const direct = byAbsolutePath.has(`${targetFile}.md`) ? `${targetFile}.md` : null;
          targetFile = direct || (byAbsolutePath.has(directoryIndex) ? directoryIndex : targetFile);
        } else if (ext !== '.md') {
          continue;
        }
        const targetRecord = byAbsolutePath.get(path.resolve(targetFile));
        if (!targetRecord) {
          addIssue(issues, { file: record.displayPath, line: index + 1, rule: 'link.file.missing', message: `Local Markdown link "${targetPath}" does not point to an audited file.` });
        } else if (fragment && !targetRecord.anchors.has(fragment.toLowerCase())) {
          addIssue(issues, { file: record.displayPath, line: index + 1, rule: 'link.anchor.missing', message: `Heading anchor "#${fragment}" does not exist in ${targetRecord.displayPath}.` });
        }
      }
    }
  }

  issues.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line || a.rule.localeCompare(b.rule, 'en'));
  return {
    input: root,
    filesScanned: records.length,
    issueCount: issues.length,
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
    issues,
  };
}

export function formatText(report) {
  if (report.filesScanned === 0) return `No Markdown files found in ${report.input}.`;
  const heading = `Audited ${report.filesScanned} Markdown file${report.filesScanned === 1 ? '' : 's'}; found ${report.issueCount} issue${report.issueCount === 1 ? '' : 's'}.`;
  if (report.issues.length === 0) return `${heading}\nNo issues found.`;
  const details = report.issues.map((issue) => `- ${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`).join('\n');
  return `${heading}\n${details}`;
}

export function formatCsv(report) {
  const escape = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return ['severity,file,line,rule,message', ...report.issues.map((issue) => [issue.severity, issue.file, issue.line, issue.rule, issue.message].map(escape).join(','))].join('\n');
}

export function isDirectExecution(metaUrl) {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === metaUrl;
}

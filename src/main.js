import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auditMarkdown, formatCsv, formatText, isDirectExecution } from './core.js';

const HELP = `Web Content Audit

Usage:
  node src/main.js <file-or-directory> [--format text|json|csv] [--output <file>]

Options:
  -h, --help          Show this help
  -f, --format        Output format (default: text)
  -o, --output        Write the report to a new file

Exit codes:
  0  Audit completed without errors
  1  Audit completed and found one or more issues
  2  Invalid arguments or an input/output error
`;

export function parseArguments(args) {
  const options = { format: 'text', output: null, input: null, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-f' || arg === '--format') options.format = args[++index];
    else if (arg.startsWith('--format=')) options.format = arg.slice('--format='.length);
    else if (arg === '-o' || arg === '--output') options.output = args[++index];
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (options.input) throw new Error('Only one input file or directory may be provided.');
    else options.input = arg;
  }
  if (options.help) return options;
  if (!options.input) throw new Error('An input Markdown file or directory is required.');
  if (!['text', 'json', 'csv'].includes(options.format)) throw new Error('Format must be one of: text, json, csv.');
  if (options.output && !options.output.trim()) throw new Error('Output path cannot be empty.');
  return options;
}

export async function run(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(args);
    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const report = await auditMarkdown(options.input);
    const rendered = options.format === 'json'
      ? `${JSON.stringify(report, null, 2)}\n`
      : options.format === 'csv'
        ? `${formatCsv(report)}\n`
        : `${formatText(report)}\n`;

    if (options.output) {
      const outputPath = path.resolve(options.output);
      if (outputPath === path.resolve(options.input)) throw new Error('Report output cannot overwrite the input path.');
      await writeFile(outputPath, rendered, { encoding: 'utf8', flag: 'wx' });
      process.stdout.write(`Report written to ${outputPath}\n`);
    } else {
      process.stdout.write(rendered);
    }
    return report.errorCount > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\nRun with --help for usage.\n`);
    return 2;
  }
}

if (isDirectExecution(import.meta.url)) {
  process.exitCode = await run();
}

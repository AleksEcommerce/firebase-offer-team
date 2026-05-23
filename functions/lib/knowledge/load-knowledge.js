import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KNOWLEDGE_ROOT = path.resolve(__dirname, '..', '..', 'knowledge');

function listMarkdownFiles(rootDirectory) {
  if (!fs.existsSync(rootDirectory)) return [];

  const entries = fs.readdirSync(rootDirectory, { withFileTypes: true });

  return entries
    .flatMap((entry) => {
      const fullPath = path.join(rootDirectory, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(fullPath);
      if (!entry.isFile() || !entry.name.endsWith('.md')) return [];
      return [fullPath];
    })
    .sort((left, right) => left.localeCompare(right));
}

function readMarkdownGroup(groupName) {
  const groupRoot = path.join(KNOWLEDGE_ROOT, groupName);
  const files = listMarkdownFiles(groupRoot);

  if (!files.length) return '';

  return files
    .map((filePath) => {
      const relativePath = path.relative(KNOWLEDGE_ROOT, filePath).replaceAll(path.sep, '/');
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content) return '';
      return `Source: ${relativePath}\n${content}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

let cachedServicesKnowledge = null;

export function loadServicesKnowledgeContext() {
  if (cachedServicesKnowledge) return cachedServicesKnowledge;

  const sections = [
    ['company', readMarkdownGroup('company')],
    ['services', readMarkdownGroup('services')],
    ['projects', readMarkdownGroup('projects')],
    ['policies', readMarkdownGroup('policies')],
  ]
    .filter(([, content]) => Boolean(String(content || '').trim()))
    .map(([name, content]) => `[${name.toUpperCase()}]\n${content}`);

  cachedServicesKnowledge = sections.join('\n\n').trim();
  return cachedServicesKnowledge;
}

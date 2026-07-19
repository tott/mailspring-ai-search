#!/usr/bin/env node
/**
 * Creates a distributable zip for Mailspring plugin installation.
 *
 * Run AFTER `npm prune --omit=dev` so node_modules contains only
 * production dependencies. The zip contains everything needed to
 * install via Mailspring's "Developer → Install a Plugin…" dialog.
 *
 * Usage: npm run pack   (typically called from the release workflow)
 * Output: mailspring-ai-search-<version>.zip
 */

const { execSync } = require('child_process');
const fs = require('fs');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
const zipName = `mailspring-ai-search-${version}.zip`;

if (fs.existsSync(zipName)) fs.unlinkSync(zipName);

const items = [
  'lib',
  'src',
  'node_modules',
  'docs',
  'specs',
  'scripts',
  '.github',
  '.claude',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'jest.config.js',
  'README.md',
  'CLAUDE.md',
  '.gitignore',
].filter(f => fs.existsSync(f));

execSync(`zip -r "${zipName}" ${items.map(f => `"${f}"`).join(' ')}`, { stdio: 'inherit' });

const size = (fs.statSync(zipName).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ Created ${zipName} (${size} MB)`);

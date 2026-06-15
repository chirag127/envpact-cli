'use strict';

/**
 * envpact github — sync resolved secrets to GitHub Actions
 * repository secrets via the `gh` CLI.
 */

const { execFileSync, spawnSync } = require('child_process');

function ghAuthOk() {
  const r = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  return r.status === 0;
}

function setSecret(repoSlug, key, value, opts = {}) {
  if (!ghAuthOk()) {
    throw new Error('gh CLI is not authenticated. Run: gh auth login');
  }
  const args = ['secret', 'set', key, '--body', value];
  if (repoSlug) args.push('--repo', repoSlug);
  if (opts.environment) args.push('--env', opts.environment);
  execFileSync('gh', args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function deleteSecret(repoSlug, key) {
  const args = ['secret', 'delete', key];
  if (repoSlug) args.push('--repo', repoSlug);
  spawnSync('gh', args, { stdio: 'ignore' });
}

function listSecrets(repoSlug) {
  const args = ['secret', 'list'];
  if (repoSlug) args.push('--repo', repoSlug);
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t')[0]);
}

function syncResolved(repoSlug, resolved, opts = {}) {
  let count = 0;
  for (const [key, value] of Object.entries(resolved)) {
    try {
      setSecret(repoSlug, key, value, opts);
      count++;
    } catch (e) {
      // Surface but continue — partial sync is better than nothing.
      process.stderr.write(`  ! failed to set ${key}: ${e.message}\n`);
    }
  }
  return count;
}

module.exports = {
  ghAuthOk,
  setSecret,
  deleteSecret,
  listSecrets,
  syncResolved,
};

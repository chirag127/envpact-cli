'use strict';

/**
 * envpact git — clone/pull/commit/push the vault repo.
 * Supports gh CLI, SSH, and HTTPS PAT auth (auto-detected).
 */

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runGit(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    ...opts,
  }).trim();
}

function tryRunGit(args, opts = {}) {
  try {
    return { ok: true, stdout: runGit(args, opts) };
  } catch (e) {
    return {
      ok: false,
      stderr: e.stderr ? e.stderr.toString() : String(e),
      stdout: e.stdout ? e.stdout.toString() : '',
    };
  }
}

function ghAvailable() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    return true;
  } catch (_e) {
    return false;
  }
}

function sshKeyAvailable() {
  const home =
    process.env.USERPROFILE || process.env.HOME || require('os').homedir();
  const ssh = path.join(home, '.ssh');
  try {
    const files = fs.readdirSync(ssh);
    return files.some((f) =>
      /^id_(rsa|ed25519|ecdsa|dsa)$/.test(f)
    );
  } catch (_e) {
    return false;
  }
}

function detectAuthMethod(vaultUrl) {
  if (vaultUrl && vaultUrl.startsWith('git@')) return 'ssh';
  if (process.env.GITHUB_TOKEN) return 'token';
  if (ghAvailable()) return 'gh';
  if (sshKeyAvailable()) return 'ssh';
  return 'https';
}

function buildAuthedHttpsUrl(repoUrl) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return repoUrl;
  return repoUrl.replace(
    /^https:\/\/(github\.com)/,
    `https://oauth2:${token}@$1`
  );
}

function clone(vaultUrl, destPath, repoSlug) {
  if (fs.existsSync(destPath)) {
    throw new Error(
      `Vault already cloned at ${destPath}. Use pull() to refresh.`
    );
  }
  const method = detectAuthMethod(vaultUrl);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (method === 'gh' && repoSlug) {
    return runGit(['clone', `https://github.com/${repoSlug}.git`, destPath]);
  }
  if (method === 'token') {
    return runGit(['clone', buildAuthedHttpsUrl(vaultUrl), destPath]);
  }
  return runGit(['clone', vaultUrl, destPath]);
}

function pull(repoPath) {
  return tryRunGit(['-C', repoPath, 'pull', '--ff-only', '--quiet']);
}

function status(repoPath) {
  return runGit(['-C', repoPath, 'status', '--porcelain']);
}

function commitAndPush(repoPath, message) {
  const dirty = status(repoPath);
  if (!dirty) return { committed: false, pushed: false };
  runGit(['-C', repoPath, 'add', '-A']);
  runGit([
    '-C',
    repoPath,
    '-c',
    'user.name=envpact-cli',
    '-c',
    'user.email=envpact@local',
    'commit',
    '-m',
    message,
    '-s',
  ]);
  const push = tryRunGit(['-C', repoPath, 'push', '--quiet']);
  return { committed: true, pushed: push.ok, pushError: push.stderr };
}

function getRemoteUrl(cwd) {
  return tryRunGit(['-C', cwd, 'config', '--get', 'remote.origin.url'])
    .stdout || '';
}

function detectProjectFromGit(cwd) {
  const url = getRemoteUrl(cwd);
  if (url) {
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return m[2].toLowerCase();
  }
  return path.basename(cwd).toLowerCase();
}

function ensureRepoExistsViaGh(repoSlug, isPrivate = true) {
  if (!ghAvailable()) {
    throw new Error(
      'gh CLI not authenticated. Run `gh auth login` or pass --vault-url.'
    );
  }
  // Check if repo exists
  const check = execSync(
    `gh repo view ${repoSlug} --json name 2>&1 || true`,
    { encoding: 'utf8' }
  );
  if (check.includes(`"name":`)) return false; // already exists
  const visibility = isPrivate ? '--private' : '--public';
  execSync(
    `gh repo create ${repoSlug} ${visibility} --description "envpact private secrets vault — DO NOT MAKE PUBLIC"`,
    { stdio: 'inherit' }
  );
  return true;
}

module.exports = {
  runGit,
  tryRunGit,
  ghAvailable,
  sshKeyAvailable,
  detectAuthMethod,
  buildAuthedHttpsUrl,
  clone,
  pull,
  commitAndPush,
  getRemoteUrl,
  detectProjectFromGit,
  ensureRepoExistsViaGh,
};

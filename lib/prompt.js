'use strict';

/**
 * envpact prompt — minimal readline-based interactive prompts.
 * Zero deps. Uses TTY detection so it can be used in scripts.
 */

const readline = require('readline');

function isInteractive() {
  return process.stdin.isTTY && process.stdout.isTTY;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function askSecret(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const out = process.stdout;
    rl.question(question, (answer) => {
      rl.close();
      // Newline after the masked input
      out.write('\n');
      resolve(answer);
    });
    // Mute stdout so the typed value is hidden.
    rl._writeToOutput = function _writeToOutput(stringToWrite) {
      if (stringToWrite.includes(question)) {
        rl.output.write(stringToWrite);
      } else {
        rl.output.write('*');
      }
    };
  });
}

async function confirm(question, defaultYes = false) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const ans = (await ask(question + suffix)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans.startsWith('y');
}

module.exports = { ask, askSecret, confirm, isInteractive };

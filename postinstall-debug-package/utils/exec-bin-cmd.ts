import * as child_process from 'child_process';
import * as path from 'path';

import usedPM from 'used-pm';

type ExecError = child_process.ExecFileException | child_process.ExecException;

interface BinCmdMapItem {
  command: string;
  localArgs: readonly string[];
  globalArgs: readonly string[];
}

const BIN_CMD_MAPPING: { npm: BinCmdMapItem } & Record<
  string,
  BinCmdMapItem | null
> = {
  // see https://docs.npmjs.com/cli/v8/commands/npm-bin
  // Note: This command has been removed as of npm v9
  //       see https://github.blog/changelog/2022-10-24-npm-v9-0-0-released/
  npm: {
    command: 'npm',
    localArgs: ['bin'],
    globalArgs: ['bin', '--global'],
  },
  // see https://classic.yarnpkg.com/lang/en/docs/cli/bin/
  yarnClassic: {
    command: 'yarn',
    localArgs: ['bin'],
    globalArgs: ['global', 'bin'],
  },
  // Perhaps there is no "npm bin" equivalent in Yarn V2 or later.
  yarnBerry: null,
  // see https://pnpm.io/cli/bin
  pnpm: {
    command: 'pnpm',
    localArgs: ['bin'],
    globalArgs: ['bin', '--global'],
  },
  // see https://bun.sh/docs/install/utilities
  bun: {
    command: 'bun',
    localArgs: ['pm', 'bin'],
    globalArgs: ['pm', 'bin', '--global'],
  },
};
const DEFAULT_BIN_CMD = BIN_CMD_MAPPING.npm;

export function execBinCmd(
  isGlobalMode: boolean,
  callback: (
    error: ExecError | null,
    result: {
      stdout: string;
      stderr: string;
      readableCommand: {
        command: string;
        args: readonly string[];
      };
      executedCommand: {
        command: string;
        args: readonly string[];
      };
    } | null,
  ) => void,
): void {
  const packageManager = usedPM();
  const binCmd = packageManager
    ? BIN_CMD_MAPPING[
        packageManager.name === 'yarn'
          ? /^[01]\./.test(packageManager.version)
            ? 'yarnClassic'
            : 'yarnBerry'
          : packageManager.name
      ]
    : undefined;
  if (binCmd === null) {
    callback(null, null);
    return;
  }

  // Sometimes there are multiple versions of a package manager on a user's system, such as when using Corepack.
  // In this case, the "child_process.execFile()" and "child_process.exec()" functions may call another package manager that is in a different path than the running package manager.
  // To avoid this, use the environment variable "npm_execpath".
  //
  // Note: On Windows, the "child_process.exec()" function cannot execute absolute path commands.
  //       We need to use the "child_process.execFile()" function instead.
  //       Therefore, the "child_process.execFile()" function is used here even on Windows.
  if (binCmd && process.env['npm_execpath']) {
    const binArgs = isGlobalMode ? binCmd.globalArgs : binCmd.localArgs;

    const execpathIsJS = /\.[cm]?js$/.test(
      path.extname(process.env['npm_execpath']),
    );
    const [command, ...args] = execpathIsJS
      ? [process.execPath, process.env['npm_execpath'], ...binArgs]
      : [process.env['npm_execpath'], ...binArgs];

    child_process.execFile(command, args, (error, stdout, stderr) => {
      callback(error, {
        stdout,
        stderr,
        readableCommand: { command: binCmd.command, args: binArgs },
        executedCommand: { command, args },
      });
    });
    return;
  }

  const bin = binCmd ?? DEFAULT_BIN_CMD;
  const command = bin.command;
  const args = bin[isGlobalMode ? 'globalArgs' : 'localArgs'];
  const execCallback = (
    error: ExecError | null,
    stdout: string,
    stderr: string,
  ): void => {
    callback(error, {
      stdout,
      stderr,
      readableCommand: { command, args },
      executedCommand: { command, args },
    });
  };

  if (process.platform === 'win32') {
    // On Windows, the "child_process.execFile()" function cannot execute commands that are not absolute paths.
    // We need to use the "child_process.exec()" function instead.

    // Note: This is bad code because it does not quote each argument.
    //       However, this is not a problem because the arguments of the commands executed within this script do not need to be quoted.
    const commandStr = [command, ...args].join(' ');

    child_process.exec(commandStr, execCallback);
  } else {
    // The "child_process.execFile()" function is more efficient than the "child_process.exec()" function and does not require escaping arguments.
    // Therefore, it is used on non-Windows platforms.
    child_process.execFile(command, args, execCallback);
  }
}

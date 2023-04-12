const { exec } = require('child_process');
const { appendFile } = require('fs/promises');
const path = require('path');
const { inspect, promisify } = require('util');

const execAsync = promisify(exec);

let isGlobalMode = false;
// In npm and pnpm, global mode can be detected by reading the "npm_config_global" environment variable.
// Older npm defines this for local mode as well, so make sure it is equal to "'true'".
if (process.env.npm_config_global === 'true') {
  isGlobalMode = true;
}
// In Yarn v1, global mode can be detected by reading the "npm_config_argv" environment variable.
// This value is a JSON string containing the original arguments passed to the "yarn" command.
// It is parsed to check if the called subcommand is "yarn global add".
const isYarn1 = (process.env.npm_config_user_agent || '')?.startsWith(
  'yarn/1.',
);
if (isYarn1 && process.env.npm_config_argv) {
  const npmArgv = JSON.parse(process.env.npm_config_argv);
  if (Array.isArray(npmArgv?.original)) {
    // Arguments include options.
    // To ignore them, compare the position of the keywords "global" and "add" to check whether the subcommand is "yarn global add".
    // Note: Strictly speaking, this logic is incorrect.
    //       The value of options MUST be ignored.
    //       For example, if the following command is executed:
    //           yarn --cache-folder global add ...
    //       This logic incorrectly determines that this is a "yarn global add" command,
    //       because it does not know that the "global" keyword is the value of the "--cache-folder" option.
    const globalPos = npmArgv?.original.indexOf('global');
    const addPos = npmArgv?.original.indexOf('add');
    if (0 <= globalPos && globalPos < addPos) {
      isGlobalMode = true;
    }
  }
}
// Since Yarn v2, there is no global mode.
// The "yarn global add" command has been replaced with the "yarn dlx" command.
// see https://yarnpkg.com/getting-started/migration#use-yarn-dlx-instead-of-yarn-global

const postinstallType =
  process.argv
    .map((arg) => /^--type\s*=(.+)$/.exec(arg)?.[1].trim())
    .findLast(Boolean) ?? process.env.POSTINSTALL_TYPE;

function packageManagerCommand(commandName) {
  const execpathIsJS =
    process.env.npm_execpath &&
    /\.[cm]?js$/.test(path.extname(process.env.npm_execpath));
  return execpathIsJS
    ? // Sometimes there are multiple versions of a package manager on a user's system, such as when using Corepack.
      // In this case, the exec function may call another package manager that is in a different path than the running package manager.
      // To avoid this, use the environment variable "npm_execpath".
      `${process.execPath} ${process.env.npm_execpath}`
    : commandName;
}

(async () => {
  const binCommand = isYarn1
    ? `${packageManagerCommand('yarn')} ${isGlobalMode ? 'global ' : ''}bin`
    : (process.env.npm_config_user_agent || '')?.startsWith('pnpm/')
    ? `${packageManagerCommand('pnpm')} bin${isGlobalMode ? ' --global' : ''}`
    : `${packageManagerCommand('npm')} bin${isGlobalMode ? ' --global' : ''}`;
  const debugData = {
    cwd: process.cwd(),
    isGlobalMode,
    [binCommand]: await execAsync(binCommand).catch((error) => ({ error })),
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(?:npm|yarn|pnpm|bun)_/i.test(key),
      ),
    ),
  };
  if (postinstallType) console.log(postinstallType);
  console.log(debugData);

  const { GITHUB_STEP_SUMMARY } = process.env;
  if (GITHUB_STEP_SUMMARY)
    await appendFile(
      GITHUB_STEP_SUMMARY,
      [
        `<details${Object.keys(debugData.env).length < 30 ? ' open' : ''}>`,
        ...(postinstallType ? [`<summary>${postinstallType}</summary>`] : []),
        '',
        '```js',
        inspect(debugData),
        '```',
        '',
        '</details>',
        '',
        '',
      ].join('\n'),
    );
})().catch((error) => {
  if (process.exitCode === 0) process.exitCode = 1;
  console.error(error);
});

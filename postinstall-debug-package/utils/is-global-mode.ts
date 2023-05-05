import usedPM from 'used-pm';

function isGlobalModeFn(): boolean {
  const packageManager = usedPM();

  // In npm and pnpm, global mode can be detected by reading the "npm_config_global" environment variable.
  // Older npm defines this for local mode as well, so make sure it is equal to "'true'".
  if (process.env['npm_config_global'] === 'true') {
    return true;
  } else if (
    packageManager?.name === 'npm' ||
    packageManager?.name === 'pnpm'
  ) {
    return false;
  }

  if (packageManager?.name === 'yarn') {
    if (/^[01]\./.test(packageManager.version)) {
      // In Yarn v1, global mode can be detected by reading the "npm_config_argv" environment variable.
      // This value is a JSON string containing the original arguments passed to the "yarn" command.
      // It is parsed to check if the called subcommand is "yarn global add".
      if (process.env['npm_config_argv']) {
        const npmArgv = JSON.parse(process.env['npm_config_argv']);
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
          return 0 <= globalPos && globalPos < addPos;
        }
      }
    } else {
      // Since Yarn v2, there is no global mode.
      // The "yarn global add" command has been replaced with the "yarn dlx" command.
      // see https://yarnpkg.com/getting-started/migration#use-yarn-dlx-instead-of-yarn-global
      return false;
    }
  }

  return false;
}

export const isGlobalMode: boolean = isGlobalModeFn();

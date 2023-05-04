import { exec, execFile } from 'child_process';
import { appendFile, readdir, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import { inspect, promisify } from 'util';
import type { InspectOptions } from 'util';

import ansiColors from 'ansi-colors';
import usedPM from 'used-pm';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * @see https://nodejs.org/api/util.html#custom-inspection-functions-on-objects
 */
type CustomInspectFunction<TThis = unknown> = (
  this: TThis,
  depth: number,
  options: Readonly<InspectOptions>,
  _inspect: typeof inspect,
) => string;

const packageManager = usedPM();

let isGlobalMode = false;
// In npm and pnpm, global mode can be detected by reading the "npm_config_global" environment variable.
// Older npm defines this for local mode as well, so make sure it is equal to "'true'".
if (process.env.npm_config_global === 'true') {
  isGlobalMode = true;
}
// In Yarn v1, global mode can be detected by reading the "npm_config_argv" environment variable.
// This value is a JSON string containing the original arguments passed to the "yarn" command.
// It is parsed to check if the called subcommand is "yarn global add".
const isYarn1 =
  packageManager?.name === 'yarn' && packageManager.version.startsWith('1.');
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

async function findBin(
  cwdList: readonly string[],
  dirnameList: readonly string[],
  binName: string,
): Promise<string[]> {
  const bindirSet = new Set<string>(
    cwdList
      .flatMap((cwd) => {
        const cwdList: string[] = [];
        while (true) {
          cwdList.push(cwd);
          const parentDir = path.dirname(cwd);
          if (parentDir === cwd) break;
          cwd = parentDir;
        }
        return cwdList;
      })
      .sort()
      .flatMap((cwd) =>
        dirnameList.map((dirname) => (dirname ? path.join(cwd, dirname) : cwd)),
      ),
  );

  const binFilepathList: string[] = [];
  for (const bindir of bindirSet) {
    const filenameList = await readdir(bindir).catch(() => []);
    binFilepathList.push(
      ...filenameList
        .filter(
          (filename) =>
            filename === binName || filename.startsWith(`${binName}.`),
        )
        .map((filename) => path.join(bindir, filename)),
    );
  }

  return binFilepathList;
}

const postinstallType =
  process.argv
    .map((arg) => /^--type\s*=(.+)$/.exec(arg)?.[1].trim())
    .findLast(Boolean) ?? process.env.POSTINSTALL_TYPE;

async function execPackageManagerCommand(
  commandAndArgs: readonly string[],
): Promise<{
  stdout: string;
  stderr: string;
  commandAndArgs: readonly string[];
}> {
  const command = commandAndArgs[0];
  const args = commandAndArgs.slice(1);

  // Sometimes there are multiple versions of a package manager on a user's system, such as when using Corepack.
  // In this case, the "child_process.execFile()" and "child_process.exec()" functions may call another package manager that is in a different path than the running package manager.
  // To avoid this, use the environment variable "npm_execpath".
  //
  // Note: On Windows, the "child_process.exec()" function cannot execute absolute path commands.
  //       We need to use the "child_process.execFile()" function instead.
  //       Therefore, the "child_process.execFile()" function is used here even on Windows.
  if (process.env.npm_execpath) {
    const execpathIsJS = /\.[cm]?js$/.test(
      path.extname(process.env.npm_execpath),
    );
    const commandAndArgs = execpathIsJS
      ? [process.execPath, process.env.npm_execpath, ...args]
      : [process.env.npm_execpath, ...args];
    const additionalProperties = { commandAndArgs };

    try {
      return Object.assign(
        await execFileAsync(commandAndArgs[0], commandAndArgs.slice(1)),
        additionalProperties,
      );
    } catch (error) {
      throw Object.assign(error, additionalProperties);
    }
  }

  const additionalProperties = { commandAndArgs };
  try {
    return Object.assign(
      process.platform === 'win32'
        ? // On Windows, the "child_process.execFile()" function cannot execute commands that are not absolute paths.
          // We need to use the "child_process.exec()" function instead.
          //
          // Note: This is bad code because it does not quote each argument.
          //       However, this is not a problem because the arguments of the commands executed within this script do not need to be quoted.
          await execAsync(commandAndArgs.join(' '))
        : // The "child_process.execFile()" function is more efficient than the "child_process.exec()" function and does not require escaping arguments.
          // Therefore, it is used on non-Windows platforms.
          await execFileAsync(command, args),
      additionalProperties,
    );
  } catch (error) {
    throw Object.assign(error, additionalProperties);
  }
}

async function getEnvAddedByPackageManager(
  env: NodeJS.ProcessEnv = process.env,
  {
    cwd = process.cwd(),
    prefixesToCompareRecord,
  }: {
    cwd?: string;
    prefixesToCompareRecord?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const specialenvName = 'DEBUG_ORIGINAL_ENV_JSON_PATH';
  const origEnv: Record<string, unknown> | null = env[specialenvName]
    ? await readFile(env[specialenvName], 'utf8').then(JSON.parse)
    : null;
  const prefixRecord = Object.assign(
    {
      'process.cwd()': cwd,
    },
    prefixesToCompareRecord,
  );

  const customInspect: CustomInspectFunction<Record<string, unknown>> =
    function (_depth, options, inspect) {
      const entries = Object.entries(this).map(([key, value]) => {
        const customInspectFn: CustomInspectFunction = function (
          _depth,
          options,
          inspect,
        ) {
          const writableOptions = { ...options };
          const origValue = origEnv?.[key];
          let commentList: string[] = [];

          if (/^PATH$/i.test(key) && typeof value === 'string') {
            const pathList = value
              .split(path.delimiter)
              .map((path) => `- ${path}`);
            if (
              typeof origValue === 'string' &&
              origValue.length < value.length &&
              value.endsWith(origValue)
            ) {
              // Omit duplicate $PATH values
              writableOptions.maxStringLength = value.length - origValue.length;
              const origPathLength = origValue.split(path.delimiter).length;
              pathList.splice(
                -origPathLength,
                origPathLength,
                `... ${origPathLength} more paths`,
              );
            }
            commentList = ['PATH List:', ...pathList];
          } else if (typeof value === 'string') {
            const compareList = Object.entries(prefixRecord).flatMap(
              ([name, prefix]) => {
                if (typeof prefix === 'string' && value.startsWith(prefix))
                  return `  ${name}${
                    value !== prefix
                      ? ` + ${inspect(value.substring(prefix.length))}`
                      : ''
                  }`;
                return [];
              },
            );
            if (0 < compareList.length) {
              commentList = ['Equal to this:', ...compareList];
            }
          }

          const inspectResult = inspect(value, writableOptions);
          return 0 < commentList.length
            ? `(\n${(
                inspectResult +
                commentList.map((comment) => `\n// ${comment}`).join('')
              ).replace(/^(?!$)/gm, '  ')}\n)`
            : inspectResult;
        };
        return [key, { [inspect.custom]: customInspectFn }];
      });
      return inspect(Object.fromEntries(entries), options);
    };

  const envEntries = Object.entries(env);
  return Object.assign(
    Object.fromEntries(
      envEntries.filter(
        origEnv
          ? ([key, value]) =>
              key !== specialenvName && (origEnv[key] ?? undefined) !== value
          : ([key]) =>
              /^(?:DISABLE_)?(?:npm|yarn|PNPM|BUN)_|^(?:INIT_CWD|PROJECT_CWD)$/i.test(
                key,
              ),
      ),
    ),
    { [inspect.custom]: customInspect },
  );
}

(async () => {
  ansiColors.enabled = true;
  console.log(
    ansiColors.green(
      `Start postinstall${postinstallType ? ` / ${postinstallType}` : ''}`,
    ),
  );

  const cwd = process.cwd();
  const pkg = await readFile(path.resolve(__dirname, 'package.json'), 'utf8')
    .then((v) => JSON.parse(v))
    .catch(() => undefined);
  const binName = Object.keys(pkg?.bin ?? {})[0];

  const binCommandArgs = isYarn1
    ? isGlobalMode
      ? ['yarn', 'global', 'bin']
      : ['yarn', 'bin']
    : packageManager?.name === 'pnpm'
    ? ['pnpm', 'bin'].concat(isGlobalMode ? '--global' : [])
    : packageManager?.name === 'npm'
    ? ['npm', 'bin'].concat(isGlobalMode ? '--global' : [])
    : packageManager?.name === 'bun'
    ? // see https://bun.sh/docs/install/utilities
      ['bun', 'pm', 'bin'].concat(isGlobalMode ? '--global' : [])
    : null;
  const binCommandResult =
    binCommandArgs &&
    (await execPackageManagerCommand(binCommandArgs).catch((error) => ({
      error,
    })));
  const binCommand: { args: string[]; result: string | null } | null =
    binCommandArgs && binCommandResult
      ? {
          args: binCommandArgs,
          result:
            'error' in binCommandResult ? null : binCommandResult.stdout.trim(),
        }
      : null;

  const binFilepathList = binName
    ? await findBin(
        [cwd].concat(binCommand?.result || []),
        isGlobalMode
          ? // see https://docs.npmjs.com/cli/v9/configuring-npm/folders#executables
            ['bin', '']
          : // see https://docs.npmjs.com/cli/v9/configuring-npm/folders#executables
            ['node_modules/.bin'],
        binName,
      )
    : undefined;

  const expectedValues: Readonly<Record<string, unknown>> = JSON.parse(
    process.env.DEBUG_EXPECTED_VARS_JSON || '{}',
  );
  const debugData = {
    cwd,
    ...expectedValues,
    isGlobalMode,
    // see https://yarnpkg.com/advanced/pnpapi#processversionspnp
    pnpVersion: process.versions.pnp,
    realBin: binFilepathList,
    ...(binCommand?.args
      ? { [binCommand.args.join(' ')]: binCommandResult }
      : {}),
    env: await getEnvAddedByPackageManager(process.env, {
      cwd,
      prefixesToCompareRecord: expectedValues,
    }),
  };

  const {
    GITHUB_STEP_SUMMARY,
    DEBUG_DATA_JSON_PATH,
    DEBUG_DATA_JSON_LINES_PATH,
  } = process.env;
  if (GITHUB_STEP_SUMMARY)
    await appendFile(
      GITHUB_STEP_SUMMARY,
      [
        `<details>`,
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

  if (DEBUG_DATA_JSON_PATH || DEBUG_DATA_JSON_LINES_PATH) {
    const jsonStr = JSON.stringify({
      postinstallType: postinstallType ?? null,
      cwd,
      binCommand,
      isGlobalMode,
      binName: binName ?? null,
      env: Object.fromEntries(
        Object.entries(process.env).map(([key, value]) => [key, value ?? null]),
      ),
    });
    if (DEBUG_DATA_JSON_PATH) await writeFile(DEBUG_DATA_JSON_PATH, jsonStr);
    if (DEBUG_DATA_JSON_LINES_PATH)
      /**
       * @see https://jsonlines.org/
       */
      await appendFile(DEBUG_DATA_JSON_LINES_PATH, `\n${jsonStr}\n`);
  }

  const { expectedPnPEnabled } = expectedValues;
  if (typeof expectedPnPEnabled === 'boolean') {
    // see https://yarnpkg.com/advanced/pnpapi#processversionspnp
    const isPnPEnabled = process.versions.pnp !== undefined;
    if (isPnPEnabled !== expectedPnPEnabled) {
      throw new Error(
        `Plug'n'Play is not ${expectedPnPEnabled ? 'enabled' : 'disabled'}`,
      );
    }
  }

  console.log(
    ansiColors.green(
      `Finish postinstall${postinstallType ? ` / ${postinstallType}` : ''}`,
    ),
  );
})().catch((error) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(error);
});

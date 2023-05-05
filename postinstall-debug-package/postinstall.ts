import { appendFile, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import { inspect } from 'util';
import type { InspectOptions } from 'util';

import ansiColors from 'ansi-colors';

import { isGlobalMode } from './utils/is-global-mode';
import { isPnPEnabled } from './utils/is-pnp-enabled';
import { execBinCmd } from './utils/exec-bin-cmd';
import { findInstalledExecutables } from './utils/find-installed-executables';

/**
 * @see https://nodejs.org/api/util.html#custom-inspection-functions-on-objects
 */
type CustomInspectFunction<TThis = unknown> = (
  this: TThis,
  depth: number,
  options: Readonly<InspectOptions>,
  _inspect: typeof inspect,
) => string;

const postinstallType =
  process.argv
    .map((arg) => /^--type\s*=(.+)$/.exec(arg)?.[1]?.trim())
    .findLast(Boolean) ?? process.env['POSTINSTALL_TYPE'];

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

  const binCommandResult = await new Promise<
    | null
    | ({
        error?: NonNullable<Parameters<Parameters<typeof execBinCmd>[1]>[0]>;
      } & Parameters<Parameters<typeof execBinCmd>[1]>[1])
  >((resolve) => {
    execBinCmd(isGlobalMode, (error, result) => {
      resolve(result ? (error ? { error, ...result } : result ?? {}) : null);
    });
  });
  const binCommand: {
    readonly args: readonly string[];
    readonly result: string | null;
  } | null = binCommandResult
    ? {
        args: [binCommandResult.command, ...binCommandResult.args],
        result: binCommandResult.error ? null : binCommandResult.stdout.trim(),
      }
    : null;

  const binFilepathList = binName
    ? await findInstalledExecutables(
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
    process.env['DEBUG_EXPECTED_VARS_JSON'] || '{}',
  );
  const debugData = {
    cwd,
    ...expectedValues,
    isGlobalMode,
    // see https://yarnpkg.com/advanced/pnpapi#processversionspnp
    pnpVersion: process.versions['pnp'],
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

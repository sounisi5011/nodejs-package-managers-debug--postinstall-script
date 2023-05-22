import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect } from 'node:util';

import { isPropAccessible } from '@sounisi5011/ts-utils-is-property-accessible';
import semverLte from 'semver/functions/lte';

import type * as ActionsCore from '@actions/core';
import type * as ActionsIo from '@actions/io';
import type * as ActionsExec from '@actions/exec';

import { envDiff } from './utils/env-diff';
import type { OutputData as OutputDataFromPostinstall } from '../../postinstall-debug-package/postinstall';

const BIN_NAME = 'bar';

function defaultItemIfEmptyArray<T extends readonly unknown[], U>(
  array: T,
  defaultItem: U,
): T | [U] {
  return 0 < array.length ? array : [defaultItem];
}

function getRequiredEnv(
  name: string,
  envObj?: Readonly<
    Record<string, Readonly<Record<string, string | undefined>>>
  >,
): string {
  const [envVarName, env] = Object.entries(envObj ?? {})[0] ?? [
    'process.env',
    process.env,
  ];
  const value = env[name];
  if (typeof value !== 'string') {
    throw new Error(
      `The ${name} environment variable is not defined in "${envVarName}"`,
    );
  }
  return value;
}

function getWinEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name];
  if (value !== undefined) return value;

  const regexp = new RegExp(`^${name}$`, 'i');
  return Object.entries(env).find(([key]) => regexp.test(key))?.[1];
}

function updatePathEnv<T extends string | undefined>(
  env: Readonly<Record<string, T>>,
  updateFn: (value: T | undefined, name: string) => T,
): Record<string, T> {
  const isWindows = process.platform === 'win32';

  const existentNameList = isWindows
    ? Object.keys(env).filter((key) => /^Path$/i.test(key))
    : ['PATH'];
  if (isWindows && existentNameList.length < 1) existentNameList.push('Path');

  const updatedEnv = { ...env };
  for (const name of existentNameList) {
    updatedEnv[name] = updateFn(env[name], name);
  }
  return updatedEnv;
}

function genJobSummaryLines(args: {
  debugDataList: readonly OutputDataFromPostinstall[];
  expectedValues: Readonly<Record<string, unknown>>;
  originalEnv: Readonly<NodeJS.ProcessEnv>;
}): string[] {
  return args.debugDataList.flatMap(
    ({
      postinstallType,
      actual: { env: postinstallEnv, binCommandResult, ...debugData },
    }) => {
      const binCommand = binCommandResult
        ? {
            args: [
              binCommandResult.readableCommand.command,
              ...binCommandResult.readableCommand.args,
            ],
            result: binCommandResult,
          }
        : null;
      return [
        `<details>`,
        ...(postinstallType ? [`<summary>${postinstallType}</summary>`] : []),
        '',
        '```js',
        inspect(
          {
            ...args.expectedValues,
            ...debugData,
            ...(binCommand
              ? {
                  [binCommand.args.join(' ')]: binCommand.result,
                }
              : {}),
            env: envDiff(args.originalEnv, postinstallEnv, {
              cwd: debugData.cwd,
              prefixesToCompareRecord: args.expectedValues,
            }),
          },
          { depth: Infinity },
        ),
        '```',
        '',
        '</details>',
        '',
      ];
    },
  );
}

interface MainArgs {
  core: typeof ActionsCore;
  io: typeof ActionsIo;
  exec: typeof ActionsExec;
  packageManager: string;
  pnp: boolean;
}

module.exports = async ({ core, io, exec, packageManager, pnp }: MainArgs) => {
  function pathStartsWith(target: string, parent: string): boolean {
    target = path.normalize(target);
    parent = path.normalize(parent);

    return (
      target === parent ||
      (target.startsWith(parent) &&
        (parent.endsWith(path.sep) || target[parent.length] === path.sep))
    );
  }

  function excludeDuplicateParentDir(
    dirpath: string,
    _: unknown,
    dirpathList: readonly string[],
  ): boolean {
    return !dirpathList.some(
      (dirpathItem) =>
        dirpathItem !== dirpath && pathStartsWith(dirpath, dirpathItem),
    );
  }

  /**
   * @example
   * toSubdirPath('/foo/bar/baz/qux', '/foo', 1)     // => '/foo/bar'
   * toSubdirPath('/foo/bar/baz/qux', '/foo', 2)     // => '/foo/bar/baz'
   * toSubdirPath('/foo/bar/baz/qux', '/foo', 3)     // => '/foo/bar/baz/qux'
   * toSubdirPath('/foo/bar/baz/qux', '/foo/bar', 1) // => '/foo/bar/baz'
   * toSubdirPath('/foo/bar/baz/qux', '/foo/bar', 2) // => '/foo/bar/baz/qux'
   */
  function toSubdirPath(target: string, parent: string, level: number): string {
    if (!pathStartsWith(target, parent)) return target;

    const parentDirLevel = parent.split(path.sep).length;
    return target
      .split(path.sep)
      .slice(0, parentDirLevel + Math.max(0, level))
      .join(path.sep);
  }

  function insertHeader(
    headerStr: string,
    lineList: readonly string[],
    linePrefix:
      | string
      | ((
          ...args: Parameters<Parameters<(readonly string[])['map']>[0]>
        ) => string),
  ): string[] {
    if (lineList.length < 1) return [];
    return [
      headerStr,
      ...lineList.map((...args) =>
        typeof linePrefix === 'function'
          ? linePrefix(...args)
          : linePrefix
          ? String(linePrefix) + args[0]
          : args[0],
      ),
    ];
  }
  /**
   * @see https://jsonlines.org/
   */
  function parseJsonLines(jsonLinesText: string): unknown[] {
    let valueCount = 0;
    return jsonLinesText.split('\n').flatMap((jsonText, index) => {
      // see https://www.rfc-editor.org/rfc/rfc8259#section-2:~:text=ws%20=,carriage%20return
      if (!/[^ \t\n\r]/.test(jsonText)) return [];
      valueCount++;

      try {
        return [JSON.parse(jsonText) as unknown];
      } catch (error) {
        if (isPropAccessible(error) && typeof error['message'] === 'string') {
          error['message'] += ` in line ${index + 1} (value ${valueCount})`;
        }
        throw error;
      }
    });
  }
  function filepathUsingEnvNameList(
    filepath: string,
    env: Readonly<Record<string, string | null | undefined>> | null | undefined,
    excludeEnv: Readonly<Record<string, string | undefined>> = {},
  ): {
    envName: string;
    path: string;
    rawPath: string;
  }[] {
    return Object.entries(env ?? {}).flatMap(([key, value]) => {
      if (
        !value ||
        /^(?:[A-Z]:)?[/\\]?$/i.test(value) ||
        excludeEnv[key] === value
      )
        return [];

      if (filepath.startsWith(value)) {
        return {
          envName: key,
          path: `\${${key}}` + filepath.substring(value.length),
          rawPath: filepath,
        };
      }
      if (
        path.sep !== '/' &&
        filepath.startsWith(value.replace('/', path.sep))
      ) {
        return {
          envName: key,
          path:
            `\${${key}.replace('/', '${path.sep}')}` +
            filepath.substring(value.length),
          rawPath: filepath,
        };
      }

      return [];
    });
  }
  function yarnBerryAcceptsFullpath(absolutePath: string): string {
    absolutePath = path.resolve(absolutePath);
    if (process.platform === 'win32') {
      // Remove Windows drive letter and replace path separator with slash
      absolutePath = absolutePath.replace(/(?:^[A-Z]:)?\\/gi, '/');
    }
    return absolutePath;
  }

  async function findInstalledNpmExecutables<T>(
    {
      rootDirpaths,
      binName,
      isGlobal = false,
      fdCmdFullpath,
    }: {
      rootDirpaths: string | Iterable<string>;
      binName: string;
      isGlobal?: boolean;
      fdCmdFullpath: string;
    },
    installFn: () => Promise<T>,
  ): Promise<{ result: T; executablesFilepathList: string[] }> {
    const rootDirpathList = [
      ...new Set(
        (typeof rootDirpaths === 'string'
          ? [rootDirpaths]
          : [...rootDirpaths]
        ).map((rootDirpath) => path.resolve(rootDirpath)),
      ),
    ];

    const startDatetime = Date.now();
    const { result } = await installFn().then(async (result) => ({ result }));

    const executablesFilepathList = await exec
      .getExecOutput(
        fdCmdFullpath,
        [
          '--unrestricted',
          process.platform === 'win32' ? '--ignore-case' : '--case-sensitive',
          '--regex',
          '--absolute-path',
          '--no-follow',
          '--type=file',
          '--type=symlink',
          `--changed-after=${new Date(startDatetime).toISOString()}`,
          '--color=never',
        ].concat(
          isGlobal
            ? [String.raw`^${binName}(?:\.|$)`]
            : [
                '--full-path',
                path.sep === '\\'
                  ? String.raw`[\\/]node_modules[\\/]\.bin[\\/]${binName}(?:\.[^\\/]+)?$`
                  : String.raw`/node_modules/\.bin/${binName}(?:\.[^/]+)?$`,
              ],
          rootDirpathList,
        ),
      )
      .then(({ stdout }) =>
        stdout.split('\n').filter((filepath) => filepath !== ''),
      );

    return {
      result,
      executablesFilepathList,
    };
  }

  const tarballFullpath = await core.group(
    'Move debugger package tarball',
    async () => {
      const rootDir = path.resolve(process.cwd(), '/');
      const dirList = [
        rootDir,
        os.homedir(),
        getRequiredEnv('RUNNER_TEMP_DIR'),
      ];
      const tarballPathList = dirList
        .map((dir) => path.resolve(dir, 'debugger-package.tgz'))
        // Exclude paths that belong to different drive letters
        .filter((filepath) => filepath.startsWith(rootDir))
        // Sort by shortest filepath
        .sort((a, b) => a.length - b.length);
      const origTarballPath = path.resolve(getRequiredEnv('TARBALL_PATH'));
      console.log({
        origTarballPath,
        tarballPathList,
      });

      for (const tarballPath of tarballPathList) {
        try {
          await fs.rename(origTarballPath, tarballPath);
          console.log({ tarballPath });
          return tarballPath;
        } catch (error) {
          console.log(error);
        }
      }

      console.log({ tarballPath: origTarballPath });
      return origTarballPath;
    },
  );
  const fdCmdFullpath = await core.group('Move fd command', async () => {
    // see https://stackoverflow.com/a/66955420
    const rustTargetPlatform = await exec
      .getExecOutput('rustc --version --verbose')
      .then(({ stdout }) => {
        const match = /^host:\s*(.+)\s*$/m.exec(stdout);
        const host = match?.[1];
        if (!host) {
          throw new Error('Failed to detect Rust target');
        }
        return host;
      });
    const cmdExt = process.platform === 'win32' ? '.exe' : '';

    const origFdPath = path.resolve(
      getRequiredEnv('FD_CMD_FILENAME').replace(
        /\{(\w+)\}/g,
        (matchStr, label) => {
          if (label === 'target') return rustTargetPlatform;
          if (label === 'ext') return cmdExt;
          return matchStr;
        },
      ),
    );
    const fdPath = path.resolve(path.dirname(tarballFullpath), `fd${cmdExt}`);
    await fs.rename(origFdPath, fdPath);
    console.log({ fdPath });

    return fdPath;
  });

  const postinstallFullpath = path.resolve('postinstall.js');

  const defaultEnv: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      typeof value === 'string' &&
      !/^(?:DISABLE_)?(?:npm_|yarn_|PNPM_|BUN_)|^(?:INIT_CWD|PROJECT_CWD)$/i.test(
        key,
      )
        ? [[key, value]]
        : [],
    ),
  );

  const pmType = packageManager.replace(/@.+$/s, '');
  const pmVersion = packageManager.substring(pmType.length + 1);
  await core.group('Show node and package manager version', async () => {
    await exec.exec('node --version', [], { env: defaultEnv });
    await exec.exec(pmType, ['--version'], { env: defaultEnv });
  });

  const isYarnBerry = pmType === 'yarn' && !pmVersion.startsWith('1.');
  const tmpDirpath = await fs.mkdtemp(os.tmpdir() + path.sep);
  const installEnv = Object.assign({}, defaultEnv, {
    DEBUG_DATA_JSON_LINES_PATH: path.join(tmpDirpath, 'debug-data.jsonl'),
  });
  if (pnp) {
    // see https://github.com/pnpm/pnpm/blob/v5.9.0/packages/pnpm/CHANGELOG.md#590
    if (pmType === 'pnpm' && semverLte('5.9.0', pmVersion)) {
      // see https://pnpm.io/npmrc#node-linker
      await exec.exec('pnpm config set node-linker pnp');
    } else if (pmType !== 'yarn') {
      throw new Error(`${packageManager} does not support Plug'n'Play`);
    }
  } else {
    if (isYarnBerry) {
      // see https://yarnpkg.com/configuration/yarnrc#nodeLinker
      await exec.exec('yarn config set nodeLinker node-modules');
    }
  }

  const setupWorkspaces = async ({
    pkgJson,
  }: {
    pkgJson: Record<string, unknown>;
  }): Promise<{ packageDirpath: string } | null> => {
    if (pmType === 'npm' && /^[0-6]\./.test(pmVersion)) return null;

    const cwd = process.cwd();
    const packageDir = 'packages/hoge';
    const origPostinstallScript =
      isPropAccessible(pkgJson['scripts']) &&
      typeof pkgJson['scripts']['postinstall'] === 'string'
        ? pkgJson['scripts']['postinstall']
        : undefined;
    if (pmType === 'npm' || pmType === 'yarn' || pmType === 'bun') {
      // see https://docs.npmjs.com/cli/v7/using-npm/workspaces
      // see https://github.com/npm/cli/blob/v7.0.1/docs/content/using-npm/workspaces.md
      // see https://classic.yarnpkg.com/en/docs/workspaces
      // see https://github.com/yarnpkg/website/blob/fb0d63c2a3c960edf1989d7efb970c420feb63b0/lang/en/docs/workspaces.md
      // see https://yarnpkg.com/features/workspaces
      // see https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/2.1.0/packages/gatsby/content/features/workspaces.md
      // see https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/3.0.0/packages/gatsby/content/features/workspaces.md
      // see https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.0.0-rc.42/packages/gatsby/content/features/workspaces.md
      // see https://bun.sh/docs/install/workspaces
      // see https://github.com/oven-sh/bun/blob/bun-v0.5.7/docs/cli/install.md#workspaces
      // see https://github.com/oven-sh/bun/blob/bun-v0.5.9/docs/cli/install.md#workspaces
      // see https://github.com/oven-sh/bun/blob/2dc3f4e0306518b16eb0bd9a505f9bc12963ec4d/docs/install/workspaces.md

      // In Yarn v1, the "private" field is required
      pkgJson['private'] = true;
      pkgJson['workspaces'] = [
        // glob syntax is supported as of Bun v0.5.8; it is not available in Bun v0.5.7 or lower.
        packageDir,
      ];
    } else if (pmType === 'pnpm') {
      // see https://pnpm.io/workspaces
      // see https://github.com/pnpm/pnpm.github.io/blob/ca887546015ee833a04ded6b7e491afb26f6fbb2/docs/workspaces.md
      await fs.writeFile(
        path.join(cwd, 'pnpm-workspace.yaml'),
        JSON.stringify({ packages: [packageDir] }),
      );
    }
    pkgJson['scripts'] = {
      ...(typeof pkgJson['scripts'] === 'object' ? pkgJson['scripts'] : {}),
      postinstall: origPostinstallScript?.replace(
        /(?<=['"])Project(?= Root)/,
        'Workspaces',
      ),
    };

    const packageDirpath = path.join(cwd, packageDir);
    await fs.mkdir(packageDirpath, { recursive: true });
    await fs.writeFile(
      path.join(packageDirpath, 'package.json'),
      JSON.stringify({
        // If using Bun, a "name" field is required in "package.json"
        name: 'fuga',
        // If using Yarn v1, a "name" field is required in "package.json"
        version: '0.0.0',
        scripts: {
          postinstall: origPostinstallScript
            ?.replace(
              /(?<= )\.\/(?=postinstall\.js(?: |$))/,
              `${path.relative(packageDirpath, cwd)}/`.replace(/\\/g, '/'),
            )
            .replace(/(?<=['"])Project(?= Root)/, 'Package'),
        },
      }),
    );
    return { packageDirpath };
  };
  const localInstallCases: Record<
    string,
    {
      setup: (options: {
        pkgJson: Record<string, unknown>;
      }) => Promise<{ expectedLocalPrefix: string } | null>;
      isWorkspacesProjectRoot?: true;
    }
  > = {
    '`package.json` exists in the same directory': {
      async setup() {
        return {
          expectedLocalPrefix: process.cwd(),
        };
      },
    },
    '`package.json` exists in the same directory, which is the project root of workspaces':
      {
        async setup({ pkgJson }) {
          const projectRootPath = process.cwd();
          if (!(await setupWorkspaces({ pkgJson }))) return null;
          return {
            expectedLocalPrefix: projectRootPath,
          };
        },
        isWorkspacesProjectRoot: true,
      },
    '`package.json` exists in the same directory, which is the package directory of workspaces':
      {
        async setup({ pkgJson }) {
          const result = await setupWorkspaces({ pkgJson });
          if (!result) return null;

          const { packageDirpath } = result;
          process.chdir(packageDirpath);

          return {
            expectedLocalPrefix: packageDirpath,
          };
        },
      },
    '`package.json` exists in the ancestor directory': {
      async setup() {
        const expectedLocalPrefix = process.cwd();

        const newCWD = path.resolve('sub-dir/foo/bar');
        await fs.mkdir(newCWD, { recursive: true });
        process.chdir(newCWD);

        return {
          expectedLocalPrefix,
        };
      },
    },
    '`package.json` exists in the ancestor directory, which is the project root of workspaces':
      {
        async setup({ pkgJson }) {
          const projectRootPath = process.cwd();

          if (!(await setupWorkspaces({ pkgJson }))) return null;

          const newCWD = path.resolve(projectRootPath, 'sub-dir/baz/qux');
          await fs.mkdir(newCWD, { recursive: true });
          process.chdir(newCWD);

          return {
            expectedLocalPrefix: projectRootPath,
          };
        },
        isWorkspacesProjectRoot: true,
      },
    '`package.json` exists in the ancestor directory, which is the package directory of workspaces':
      {
        async setup({ pkgJson }) {
          const result = await setupWorkspaces({ pkgJson });
          if (!result) return null;
          const { packageDirpath } = result;

          const newCWD = path.resolve(packageDirpath, 'sub-dir/quux/corge');
          await fs.mkdir(newCWD, { recursive: true });
          process.chdir(newCWD);

          return {
            expectedLocalPrefix: packageDirpath,
          };
        },
      },
  };

  const origCWD = process.cwd();
  for (const [caseName, { setup, isWorkspacesProjectRoot }] of Object.entries(
    localInstallCases,
  )) {
    const setupResult = await core.group(`Setup (${caseName})`, async () => {
      process.chdir(await fs.mkdtemp(origCWD + path.sep));
      const projectRootPath = process.cwd();

      const pkgJsonPath = path.resolve('package.json');
      const shellQuotChar = process.platform === 'win32' ? `"` : `'`;
      const pkgJson: Record<string, unknown> = {
        scripts: {
          postinstall: `node ./postinstall.js --type=${shellQuotChar}Project Root (${caseName})${shellQuotChar}`,
        },
      };
      await fs.copyFile(postinstallFullpath, './postinstall.js');
      if (pmType === 'yarn') {
        if (isYarnBerry) {
          await fs.writeFile('yarn.lock', new Uint8Array(0));
          // see https://github.com/yarnpkg/berry/discussions/3486#discussioncomment-1379344
          await fs.writeFile('.yarnrc.yml', 'enableImmutableInstalls: false');
        } else {
          if (pnp) {
            // see https://classic.yarnpkg.com/en/docs/pnp/getting-started
            // see https://github.com/yarnpkg/yarn/pull/6382
            pkgJson['installConfig'] = {
              pnp: true,
            };
          }
        }
      }
      if (pmType === 'pnpm') {
        // pnpm v7 will not run the "postinstall" script if the dependency is already cached.
        // Set side-effects-cache to "false" to always run the "postinstall" script.
        // see https://github.com/pnpm/pnpm/issues/4649
        await fs.writeFile('.npmrc', 'side-effects-cache = false');
      }

      const setupResult = await setup({ pkgJson });
      if (!setupResult) return null;
      const { expectedLocalPrefix } = setupResult;
      const expectedValues = {
        expectedPnPEnabled: pnp,
        expectedLocalPrefix,
      };

      await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson));

      const localInstallEnv = Object.assign({}, installEnv, {
        POSTINSTALL_TYPE: `Local Dependencies (${caseName})`,
        DEBUG_EXPECTED_VARS_JSON: JSON.stringify(expectedValues),
      });
      await fs.writeFile(
        localInstallEnv.DEBUG_DATA_JSON_LINES_PATH,
        new Uint8Array(0),
      );

      return { projectRootPath, expectedValues, localInstallEnv };
    });
    if (!setupResult) continue;
    const { projectRootPath, expectedValues, localInstallEnv } = setupResult;

    const { executablesFilepathList: installedExecutables } =
      await findInstalledNpmExecutables(
        { fdCmdFullpath, rootDirpaths: projectRootPath, binName: BIN_NAME },
        async () => {
          if (pmType === 'npm') {
            await exec.exec('npm install', [tarballFullpath], {
              env: localInstallEnv,
            });
          } else if (pmType === 'yarn') {
            if (pmVersion.startsWith('1.')) {
              await exec.exec(
                'yarn add',
                isWorkspacesProjectRoot
                  ? [tarballFullpath, '--ignore-workspace-root-check']
                  : [tarballFullpath],
                { env: localInstallEnv },
              );
            } else {
              await exec.exec(
                'yarn add',
                [yarnBerryAcceptsFullpath(tarballFullpath)],
                {
                  env: localInstallEnv,
                },
              );
            }
          } else if (pmType === 'pnpm') {
            await exec.exec(
              'pnpm add',
              isWorkspacesProjectRoot
                ? ['--workspace-root', tarballFullpath]
                : [tarballFullpath],
              { env: localInstallEnv },
            );
          } else if (pmType === 'bun') {
            await exec.exec('bun add', [tarballFullpath], {
              env: localInstallEnv,
            });
          }
        },
      );

    await core.group(
      `Add a list of installed executables to the Job Summary (${caseName})`,
      async () => {
        const GITHUB_STEP_SUMMARY = getRequiredEnv('GITHUB_STEP_SUMMARY', {
          localInstallEnv,
        });

        const debugDataList = await fs
          .readFile(localInstallEnv.DEBUG_DATA_JSON_LINES_PATH, 'utf8')
          .then(
            parseJsonLines as (
              jsonLinesText: string,
            ) => OutputDataFromPostinstall[],
          )
          .catch(() => []);
        const jobSummaryLines = genJobSummaryLines({
          debugDataList,
          expectedValues,
          originalEnv: localInstallEnv,
        });

        if (installedExecutables.length < 1) {
          await fs.appendFile(
            GITHUB_STEP_SUMMARY,
            [
              ...jobSummaryLines,
              '*No executables created in `node_modules/.bin` directory.*',
              '',
              '',
            ].join('\n'),
          );
          return;
        }

        const binDirSet = new Set(
          installedExecutables.map((filepath) => path.dirname(filepath)),
        );
        const debugData =
          debugDataList.find(
            ({ postinstallType }) =>
              postinstallType === localInstallEnv.POSTINSTALL_TYPE,
          ) ??
          // Bun does not execute the "postinstall" script of installed dependencies.
          // Instead, it uses the debug data from the project's "postinstall" script.
          debugDataList.find(
            ({ postinstallType }) =>
              pmType === 'bun' &&
              postinstallType &&
              /^(?:Project|Package)\b/i.test(postinstallType),
          ) ??
          null;
        await fs.appendFile(
          GITHUB_STEP_SUMMARY,
          [
            ...jobSummaryLines,
            '```js',
            await Promise.all(
              [...binDirSet].map(async (binDir) => [
                `// Files in ${binDir}`,
                ...insertHeader(
                  '// This path can also be got using environment variables:',
                  filepathUsingEnvNameList(
                    binDir,
                    debugData?.actual.env,
                    localInstallEnv,
                  ).map(({ path }) => path),
                  '//     ',
                ),
                inspect(await fs.readdir(binDir).catch((error) => error)),
              ]),
            ),
            '```',
            '',
            '',
          ]
            .flat(2)
            .join('\n'),
        );
      },
    );
  }
  process.chdir(origCWD);

  const rootDirpathList: readonly string[] = await (async () => {
    if (process.platform !== 'win32') return ['/'];

    // see https://stackoverflow.com/a/52411712
    // see https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/wmic
    // see https://qiita.com/nijinagome/items/a31298f2d0e55668a8c1
    // see https://win.just4fun.biz/?PowerShell/%E8%AB%96%E7%90%86%E3%83%89%E3%83%A9%E3%82%A4%E3%83%96%E6%83%85%E5%A0%B1%E3%82%84%E3%83%89%E3%83%A9%E3%82%A4%E3%83%96%E3%83%AC%E3%82%BF%E3%83%BC%E3%81%AE%E4%B8%80%E8%A6%A7%E3%82%92%E5%8F%96%E5%BE%97%E3%81%99%E3%82%8B%E6%96%B9%E6%B3%95
    // see https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-logicaldisk
    // see https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-wmiobject?view=powershell-5.1
    // see https://qiita.com/mizar/items/d8fa35dc9f027e095110
    // see https://learn.microsoft.com/ja-jp/powershell/module/cimcmdlets/get-ciminstance?view=powershell-7.3
    const filesystemRootList = await exec
      .getExecOutput('powershell', [
        '-Command',
        '(Get-CimInstance -ClassName Win32_LogicalDisk).DeviceID',
      ])
      .then(({ stdout }) => [
        ...new Set(
          (function* () {
            yield path.resolve(os.homedir(), '/');
            yield path.resolve(process.cwd(), '/');
            for (const volumeName of stdout.matchAll(/^[A-Z]:$/gim)) {
              yield volumeName + path.sep;
            }
          })(),
        ),
      ]);

    // In the Windows environment of GitHub Actions, traversing all files takes about 40 to 50 minutes.
    // Therefore, we narrow down the directories to traverse.

    // Find directories where "node" commands, etc. are installed
    const nodeBinInstalledDirList = (
      await Promise.all(
        ['node', 'npm', 'yarn', 'pnpm', 'bun'].map((cliName) =>
          io.findInPath(cliName),
        ),
      )
    )
      .flat()
      .map((cliFilepath) => path.dirname(cliFilepath));

    // see https://github.com/pnpm/pnpm/blob/v6.35.1/packages/global-bin-dir/src/index.ts#L37-L49
    const nodeLikeBinInPathEnvList =
      getWinEnv(process.env, 'Path')
        ?.split(path.delimiter)
        .filter((pathValue) => /node|npm/i.test(pathValue)) ?? [];

    const programFilesDirSet = new Set<string>();
    const binDirSet = new Set<string>([
      // see https://github.com/actions/runner-images/blob/0b558a470e1e916e0d3e1e020a216ffdde1810e7/images/win/scripts/Installers/Install-NodeLts.ps1#L7-L8
      String.raw`C:\npm`,
    ]);
    const PROGRAMFILES = getWinEnv(process.env, 'PROGRAMFILES');
    for (const cliDirpath of new Set([
      ...nodeBinInstalledDirList,
      ...nodeLikeBinInPathEnvList,
    ])) {
      if (PROGRAMFILES && pathStartsWith(cliDirpath, PROGRAMFILES)) {
        programFilesDirSet.add(toSubdirPath(cliDirpath, PROGRAMFILES, 1));
      } else {
        binDirSet.add(cliDirpath);
      }
    }
    if (PROGRAMFILES && programFilesDirSet.size < 1) {
      programFilesDirSet.add(PROGRAMFILES);
    }

    const winRootDirList = [
      ...programFilesDirSet,
      ...binDirSet,
      // see https://github.com/yarnpkg/yarn/blob/158d96dce95313d9a00218302631cd263877d164/src/cli/commands/global.js#L94-L98
      getWinEnv(process.env, 'LOCALAPPDATA') ?? [],
      os.homedir(),
    ]
      .flat()
      .filter(excludeDuplicateParentDir);

    return filesystemRootList.flatMap((rootDirpath) => {
      return winRootDirList.some((winRoot) => winRoot.startsWith(rootDirpath))
        ? winRootDirList
        : rootDirpath;
    });
  })();
  const globalInstallCases: Record<
    string,
    {
      setup: (options: {
        env: Readonly<Record<string, string>>;
      }) => Promise<{ env: Record<string, string> }>;
      cleanup?: () => Promise<void>;
    }
  > = {
    ...(pmType === 'pnpm'
      ? // The "pnpm add --global ..." command requires a global bin directory.
        // see https://github.com/pnpm/pnpm/issues/4658
        {
          'set the global-bin-dir setting': {
            async setup({ env }) {
              const globalBinDir = path.resolve(os.homedir(), '.pnpm-home');
              await exec.exec('pnpm config set global-bin-dir', [globalBinDir]);
              return {
                env: updatePathEnv(env, (value) => {
                  return (value ? value + path.delimiter : '') + globalBinDir;
                }),
              };
            },
            async cleanup() {
              await exec.exec('pnpm config delete global-bin-dir');
            },
          },
          'set the PNPM_HOME env variable': {
            async setup({ env }) {
              const globalBinDir = path.resolve(os.homedir(), '.pnpm-home');
              return {
                env: Object.assign(
                  updatePathEnv(env, (value) => {
                    return (value ? value + path.delimiter : '') + globalBinDir;
                  }),
                  { PNPM_HOME: globalBinDir },
                ),
              };
            },
          },
          'set both the global-bin-dir setting and the PNPM_HOME env variable':
            {
              async setup({ env }) {
                const globalBinDirByConfig = path.resolve(
                  os.homedir(),
                  '.pnpm-home-by-pnpm-config',
                );
                const globalBinDirByEnv = path.resolve(
                  os.homedir(),
                  '.pnpm-home-by-PNPM_HOME-env-var',
                );

                await exec.exec('pnpm config set global-bin-dir', [
                  globalBinDirByConfig,
                ]);
                return {
                  env: Object.assign(
                    updatePathEnv(env, (value) => {
                      return (value ? [value] : [])
                        .concat(globalBinDirByConfig, globalBinDirByEnv)
                        .join(path.delimiter);
                    }),
                    { PNPM_HOME: globalBinDirByEnv },
                  ),
                };
              },
              async cleanup() {
                await exec.exec('pnpm config delete global-bin-dir');
              },
            },
        }
      : {}),
  };
  for (const caseItem of defaultItemIfEmptyArray(
    Object.entries(globalInstallCases),
    null,
  )) {
    const labelSuffix = caseItem ? ` (${caseItem[0]})` : '';
    const expectedValues = {
      expectedPnPEnabled: pnp,
    };

    const { globalInstallEnv } = await core.group(
      `Setup${labelSuffix}`,
      async () => {
        const { env: globalInstallEnv } = caseItem
          ? await caseItem[1].setup({ env: installEnv })
          : { env: { ...installEnv } };

        Object.assign(globalInstallEnv, {
          POSTINSTALL_TYPE: `Global Dependencies${labelSuffix}`,
          DEBUG_EXPECTED_VARS_JSON: JSON.stringify(expectedValues),
        });
        if (pmType === 'yarn' && !isYarnBerry && pnp) {
          // see https://github.com/yarnpkg/yarn/pull/6382
          globalInstallEnv['YARN_PLUGNPLAY_OVERRIDE'] = '1';
        }
        await fs.writeFile(
          getRequiredEnv('DEBUG_DATA_JSON_LINES_PATH', { globalInstallEnv }),
          new Uint8Array(0),
        );

        return { globalInstallEnv };
      },
    );

    const { executablesFilepathList: installedExecutables } =
      await findInstalledNpmExecutables(
        {
          fdCmdFullpath,
          rootDirpaths: rootDirpathList,
          binName: BIN_NAME,
          isGlobal: true,
        },
        async () => {
          if (pmType === 'npm') {
            await exec.exec('npm install --global', [tarballFullpath], {
              env: globalInstallEnv,
            });
          } else if (pmType === 'yarn') {
            if (pmVersion.startsWith('1.')) {
              await exec.exec('yarn global add', [tarballFullpath], {
                env: globalInstallEnv,
              });
            } else {
              // TODO: Run this command using the local npm registry (e.g. local-npm or verdaccio)
              await exec.exec(
                'yarn dlx --package',
                [yarnBerryAcceptsFullpath(tarballFullpath), BIN_NAME],
                { env: globalInstallEnv },
              );
            }
          } else if (pmType === 'pnpm') {
            await exec.exec('pnpm add --global', [tarballFullpath], {
              env: globalInstallEnv,
            });
          } else if (pmType === 'bun') {
            await exec.exec('bun add --global', [tarballFullpath], {
              env: globalInstallEnv,
            });
          }
        },
      );

    const cleanup = caseItem?.[1].cleanup;
    if (cleanup) {
      await core.group(`Cleanup${labelSuffix}`, cleanup);
    }

    await core.group(
      `Add a list of installed executables to the Job Summary${labelSuffix}`,
      async () => {
        const GITHUB_STEP_SUMMARY = getRequiredEnv('GITHUB_STEP_SUMMARY', {
          globalInstallEnv,
        });
        const binDirSet = new Set(
          installedExecutables.map((filepath) => path.dirname(filepath)),
        );

        const debugDataList = (await fs
          .readFile(
            getRequiredEnv('DEBUG_DATA_JSON_LINES_PATH', { globalInstallEnv }),
            'utf8',
          )
          .then(parseJsonLines)
          .catch((error) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          })) as OutputDataFromPostinstall[];
        const debugData = debugDataList.find(
          ({ postinstallType }) =>
            postinstallType ===
            getRequiredEnv('POSTINSTALL_TYPE', { globalInstallEnv }),
        );
        async function inspectInstalledBin(
          bindirPath: string,
        ): Promise<string> {
          return await fs
            .readdir(bindirPath)
            .then((files) => {
              const { binFiles = [], otherFiles = [] } = files.reduce<{
                binFiles?: string[];
                otherFiles?: string[];
              }>(({ binFiles = [], otherFiles = [] }, file) => {
                const isInstalledBin =
                  file === BIN_NAME || file.startsWith(`${BIN_NAME}.`);
                (isInstalledBin ? binFiles : otherFiles).push(file);
                return { binFiles, otherFiles };
              }, {});
              return inspect(binFiles.concat(otherFiles), {
                maxArrayLength: binFiles.length,
              });
            })
            .catch((error) => inspect(error));
        }

        const binCommand = debugData?.actual.binCommandResult
          ? ({
              args: [
                debugData.actual.binCommandResult.readableCommand.command,
                ...debugData.actual.binCommandResult.readableCommand.args,
              ],
              result: debugData.actual.binCommandResult.error
                ? null
                : debugData.actual.binCommandResult.stdout,
            } as const)
          : null;

        const binCommandMap = new Map<string, string>();
        if (binCommand?.result) {
          binCommandMap.set(binCommand.args.join(' '), binCommand.result);
        } else if (pmType === 'bun') {
          const binCmdArgs = ['bun', 'pm', 'bin', '--global'] as const;
          binCommandMap.set(
            binCmdArgs.join(' '),
            await exec
              .getExecOutput(binCmdArgs[0], binCmdArgs.slice(1), {
                env: globalInstallEnv,
              })
              .then(({ stdout }) => stdout.trim()),
          );
        }

        if (binDirSet.size < 1) {
          const prefixEnvName = 'npm_config_prefix';
          if (debugData?.actual.env[prefixEnvName]) {
            const prefix = debugData.actual.env[prefixEnvName];
            // see https://docs.npmjs.com/cli/v9/configuring-npm/folders#executables
            const binDir =
              process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
            binDirSet.add(path.normalize(binDir));
          }
          for (const binDir of binCommandMap.values()) {
            binDirSet.add(path.normalize(binDir));
          }
        }

        await fs.appendFile(
          GITHUB_STEP_SUMMARY,
          [
            ...genJobSummaryLines({
              debugDataList,
              expectedValues,
              originalEnv: globalInstallEnv,
            }),
            '```js',
            await Promise.all(
              [...binDirSet].map(async (binDir) => [
                `// Files in ${binDir}`,
                ...insertHeader(
                  '// This path can also be got using environment variables:',
                  filepathUsingEnvNameList(
                    binDir,
                    debugData?.actual.env,
                    globalInstallEnv,
                  ).map(({ path }) => path),
                  '//     ',
                ),
                ...insertHeader(
                  '// This path can also be got via commands:',
                  [...binCommandMap.entries()]
                    .filter(([, result]) => result === binDir)
                    .map(([cmd]) => cmd),
                  '//     ',
                ),
                await inspectInstalledBin(binDir),
              ]),
            ),
            '```',
            '',
            '',
          ]
            .flat(2)
            .join('\n'),
        );
      },
    );
  }
};

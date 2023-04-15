// @ts-check

/**
 * @param {object} args
 * @param {import('@actions/core')} args.core
 * @param {import('@actions/exec')} args.exec
 * @param {typeof require} args.require
 * @param {string} args.packageManager
 */
module.exports = async ({ core, exec, require, packageManager }) => {
  const fs = require('fs/promises');
  const os = require('os');
  const path = require('path');
  const { inspect } = require('util');

  function insertHeader(headerStr, lineList, linePrefix) {
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
  function parseJsonLines(jsonLinesText) {
    let valueCount = 0;
    return jsonLinesText.split('\n').flatMap((jsonText, index) => {
      // see https://www.rfc-editor.org/rfc/rfc8259#section-2:~:text=ws%20=,carriage%20return
      if (!/[^ \t\n\r]/.test(jsonText)) return [];
      valueCount++;

      try {
        return [JSON.parse(jsonText)];
      } catch (error) {
        error.message += ` in line ${index + 1} (value ${valueCount})`;
        throw error;
      }
    });
  }
  function indentStr(str, prefix, firstPrefix = '') {
    if (typeof prefix !== 'number' && typeof prefix !== 'string')
      prefix = String(prefix);
    if (typeof firstPrefix !== 'string') firstPrefix = String(firstPrefix);

    const indentLength = Math.max(
      typeof prefix === 'number' ? prefix : prefix.length,
      firstPrefix.length,
    );
    const prefixStr =
      typeof prefix === 'number'
        ? ' '.repeat(indentLength)
        : prefix + ' '.repeat(indentLength - prefix.length);
    const firstPrefixStr = firstPrefix
      ? firstPrefix + ' '.repeat(indentLength - firstPrefix.length)
      : prefixStr;

    return str.replace(/^(?!$)/gms, (_, offset) =>
      offset === 0 ? firstPrefixStr : prefixStr,
    );
  }
  function filepathUsingEnvNameList(filepath, env, excludeEnv = {}) {
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
  function yarnBerryAcceptsFullpath(absolutePath) {
    absolutePath = path.resolve(absolutePath);
    if (process.platform === 'win32') {
      // Remove Windows drive letter and replace path separator with slash
      absolutePath = absolutePath.replace(/(?:^[A-Z]:)?\\/gi, '/');
    }
    return absolutePath;
  }

  const tarballFullpath = await core.group(
    'Move debugger package tarball',
    async () => {
      const rootDir = path.resolve(process.cwd(), '/');
      const dirList = [rootDir, os.homedir(), process.env.RUNNER_TEMP_DIR];
      const tarballPathList = dirList
        .map((dir) => path.resolve(dir, 'debugger-package.tgz'))
        // Exclude paths that belong to different drive letters
        .filter((filepath) => filepath.startsWith(rootDir))
        // Sort by shortest filepath
        .sort((a, b) => a.length - b.length);
      const origTarballPath = path.resolve(process.env.TARBALL_PATH);
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

  const postinstallFullpath = path.resolve('postinstall.js');

  const defaultEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:DISABLE_)?(?:npm_|yarn_|PNPM_|BUN_)|^(?:INIT_CWD|PROJECT_CWD)$/i.test(
          key,
        ),
    ),
  );

  const pmType = packageManager.replace(/@.+$/s, '');
  await core.group('Show node and package manager version', async () => {
    await exec.exec('node --version', [], { env: defaultEnv });
    await exec.exec(pmType, ['--version'], { env: defaultEnv });
  });

  const isYarnBerry =
    pmType === 'yarn' && !packageManager.startsWith('yarn@1.');
  const tmpDirpath = await fs.mkdtemp(os.tmpdir() + path.sep);
  const installEnv = {
    ...defaultEnv,
    DEBUG_DATA_JSON_LINES_PATH: path.join(tmpDirpath, 'debug-data.jsonl'),
    DEBUG_ORIGINAL_ENV_JSON_PATH: path.join(tmpDirpath, 'orig-env.json'),
  };
  /**
   * @type {Record<string, {
   *   setup: (options: { pkgJson: Record<string, unknown> }) => Promise<{ expectedLocalPrefix: string }>
   * }>}
   */
  const localInstallCases = {
    'Same location as `package.json`': {
      async setup() {
        return {
          expectedLocalPrefix: process.cwd(),
        };
      },
    },
    'In a subdirectory of the directory where the `package.json` is located': {
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
  };

  const origCWD = process.cwd();
  for (const [caseName, { setup }] of Object.entries(localInstallCases)) {
    const { expectedLocalPrefix, localInstallEnv } = await core.group(
      `Setup (${caseName})`,
      async () => {
        process.chdir(await fs.mkdtemp(origCWD + path.sep));

        const pkgJsonPath = path.resolve('package.json');
        const shellQuotChar = process.platform === 'win32' ? `"` : `'`;
        const pkgJson = {
          scripts: {
            postinstall: `node ./postinstall.js --type=${shellQuotChar}Project (${caseName})${shellQuotChar}`,
          },
        };
        await fs.copyFile(postinstallFullpath, './postinstall.js');
        if (isYarnBerry) {
          await fs.writeFile('yarn.lock', new Uint8Array(0));
          // see https://github.com/yarnpkg/berry/discussions/3486#discussioncomment-1379344
          await fs.writeFile('.yarnrc.yml', 'enableImmutableInstalls: false');
        }

        const { expectedLocalPrefix } = await setup({ pkgJson });
        await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson));

        const localInstallEnv = Object.assign({}, installEnv, {
          POSTINSTALL_TYPE: `Local Dependencies (${caseName})`,
          DEBUG_EXPECTED_LOCAL_PREFIX: expectedLocalPrefix,
        });
        await fs.writeFile(
          localInstallEnv.DEBUG_ORIGINAL_ENV_JSON_PATH,
          JSON.stringify(localInstallEnv, (_, value) =>
            value === undefined ? null : value,
          ),
        );
        await fs.writeFile(
          localInstallEnv.DEBUG_DATA_JSON_LINES_PATH,
          new Uint8Array(0),
        );

        return { expectedLocalPrefix, localInstallEnv };
      },
    );

    if (pmType === 'npm') {
      await exec.exec('npm install', [tarballFullpath], {
        env: localInstallEnv,
      });
    } else if (pmType === 'yarn') {
      if (packageManager.startsWith('yarn@1.')) {
        await exec.exec('yarn add', [tarballFullpath], {
          env: localInstallEnv,
        });
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
      await exec.exec('pnpm add', [tarballFullpath], { env: localInstallEnv });
    } else if (pmType === 'bun') {
      await exec.exec('bun add', [tarballFullpath], { env: localInstallEnv });
    }

    await core.group(
      `Add a list of installed executables to the Job Summary (${caseName})`,
      async () => {
        const binDir = path.resolve(expectedLocalPrefix, 'node_modules/.bin');
        const debugData = await fs
          .readFile(localInstallEnv.DEBUG_DATA_JSON_LINES_PATH, 'utf8')
          .then(parseJsonLines)
          .then(
            (debugDataList) =>
              debugDataList.find(
                ({ postinstallType }) =>
                  postinstallType === localInstallEnv.POSTINSTALL_TYPE,
              ) ??
              // Bun does not execute the "postinstall" script of installed dependencies.
              // Instead, it uses the debug data from the project's "postinstall" script.
              debugDataList.find(
                ({ postinstallType }) =>
                  pmType === 'bun' && /^Project\b/i.test(postinstallType),
              ) ??
              {},
          )
          .catch(() => ({}));
        await fs.appendFile(
          localInstallEnv.GITHUB_STEP_SUMMARY,
          [
            '```js',
            `// Files in ${binDir}`,
            ...insertHeader(
              '// This path can also be got using environment variables:',
              filepathUsingEnvNameList(
                binDir,
                debugData.env,
                localInstallEnv,
              ).map(({ path }) => path),
              '//     ',
            ),
            inspect(await fs.readdir(binDir).catch((error) => error)),
            '```',
            '',
            '',
          ].join('\n'),
        );
      },
    );
  }
  process.chdir(origCWD);

  installEnv.POSTINSTALL_TYPE = 'Global Dependencies';
  await fs.writeFile(
    installEnv.DEBUG_ORIGINAL_ENV_JSON_PATH,
    JSON.stringify(installEnv, (_, value) =>
      value === undefined ? null : value,
    ),
  );
  if (pmType === 'npm') {
    await exec.exec('npm install --global', [tarballFullpath], {
      env: installEnv,
    });
  } else if (pmType === 'yarn') {
    if (packageManager.startsWith('yarn@1.')) {
      await exec.exec('yarn global add', [tarballFullpath], {
        env: installEnv,
      });
    } else {
      // TODO: Run this command using the local npm registry (e.g. local-npm or verdaccio)
      await exec.exec(
        'yarn dlx --package',
        [yarnBerryAcceptsFullpath(tarballFullpath), 'bar'],
        { env: installEnv },
      );
    }
  } else if (pmType === 'pnpm') {
    // The "pnpm add --global ..." command requires a global bin directory.
    // see https://github.com/pnpm/pnpm/issues/4658
    const PNPM_HOME = path.resolve(os.homedir(), '.pnpm-home');
    const pathEnv = Object.fromEntries(
      Object.entries(installEnv)
        .filter(([key]) => /^PATH$/i.test(key))
        .map(([key, value]) => [key, [value, PNPM_HOME].join(path.delimiter)]),
    );
    const env = {
      ...installEnv,
      ...pathEnv,
      PNPM_HOME,
    };
    await fs.writeFile(
      env.DEBUG_ORIGINAL_ENV_JSON_PATH,
      JSON.stringify(env, (_, value) => (value === undefined ? null : value)),
    );

    await exec.exec('pnpm add --global', [tarballFullpath], { env });
  } else if (pmType === 'bun') {
    await exec.exec('bun add --global', [tarballFullpath], { env: installEnv });
  }
  {
    const { GITHUB_STEP_SUMMARY } = defaultEnv;
    const debugDataList = await fs
      .readFile(installEnv.DEBUG_DATA_JSON_LINES_PATH, 'utf8')
      .then(parseJsonLines)
      .catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    const { binCommand, binName, ...debugData } =
      debugDataList.find(
        ({ postinstallType }) =>
          postinstallType === installEnv.POSTINSTALL_TYPE,
      ) ?? {};
    async function inspectInstalledBin(bindirPath) {
      const showAll = !binName;
      return await fs
        .readdir(bindirPath)
        .then((files) => {
          if (showAll) return inspect(files);

          const { binFiles = [], otherFiles = [] } = files.reduce(
            ({ binFiles = [], otherFiles = [] }, file) => {
              const isInstalledBin =
                file === binName || file.startsWith(`${binName}.`);
              (isInstalledBin ? binFiles : otherFiles).push(file);
              return { binFiles, otherFiles };
            },
            {},
          );
          return inspect(binFiles.concat(otherFiles), {
            maxArrayLength: binFiles.length,
          });
        })
        .catch((error) => inspect(error));
    }

    const prefixEnvName = 'npm_config_prefix';
    if (binCommand?.result) {
      await fs.appendFile(
        GITHUB_STEP_SUMMARY,
        [
          '```js',
          indentStr(
            [
              `$(${binCommand.args.join(' ')})`,
              `( ${binCommand.result} )`,
            ].join('\n'),
            '// ',
            '// Files in ',
          ),
          ...insertHeader(
            '// This path can also be got using environment variables:',
            filepathUsingEnvNameList(
              binCommand.result,
              debugData.env,
              installEnv,
            ).map(({ path }) => path),
            '//     ',
          ),
          await inspectInstalledBin(binCommand.result),
          '```',
          '',
          '',
        ].join('\n'),
      );
    } else if (debugData.env?.[prefixEnvName]) {
      const prefix = debugData.env[prefixEnvName];
      // see https://docs.npmjs.com/cli/v9/configuring-npm/folders#executables
      const binDir =
        process.platform === 'win32' ? prefix : path.join(prefix, 'bin');

      const binDirUsingEnvNameList = filepathUsingEnvNameList(
        binDir,
        debugData.env,
        installEnv,
      );
      await fs.appendFile(
        GITHUB_STEP_SUMMARY,
        [
          '```js',
          indentStr(
            [
              ...binDirUsingEnvNameList
                .filter(({ envName }) => envName === prefixEnvName)
                .map(({ path }) => path),
              `( ${binDir} )`,
            ].join('\n'),
            '// ',
            '// Files in ',
          ),
          ...insertHeader(
            '// This path can also be got using other environment variables:',
            binDirUsingEnvNameList
              .filter(({ envName }) => envName !== prefixEnvName)
              .map(({ path }) => path),
            '//     ',
          ),
          await inspectInstalledBin(binDir),
          '```',
          '',
          '',
        ].join('\n'),
      );
    } else if (pmType === 'bun') {
      const binCmdArgs = ['bun', 'pm', 'bin', '--global'];
      const binDir = await exec
        .getExecOutput(binCmdArgs[0], binCmdArgs.slice(1), { env: installEnv })
        .then(({ stdout }) => stdout.trim());
      const debugData =
        debugDataList.find(
          ({ postinstallType }) =>
            postinstallType === installEnv.POSTINSTALL_TYPE,
        ) ??
        // Bun does not execute the "postinstall" script of installed dependencies.
        // Instead, it uses the debug data from the project's "postinstall" script.
        debugDataList.find(({ postinstallType }) =>
          /^Project$/i.test(postinstallType),
        ) ??
        {};
      await fs.appendFile(
        GITHUB_STEP_SUMMARY,
        [
          '```js',
          indentStr(
            [`$(${binCmdArgs.join(' ')})`, `( ${binDir} )`].join('\n'),
            '// ',
            '// Files in ',
          ),
          ...insertHeader(
            '// This path can also be got using environment variables:',
            filepathUsingEnvNameList(binDir, debugData.env, installEnv).map(
              ({ path }) => path,
            ),
            '//     ',
          ),
          await inspectInstalledBin(binDir),
          '```',
          '',
          '',
        ].join('\n'),
      );
    }
  }
};

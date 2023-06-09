import { appendFile, readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import { inspect } from 'util';

import ansiColors from 'ansi-colors';

import { isGlobalMode } from './utils/is-global-mode';
import { isPnPEnabled } from './utils/is-pnp-enabled';
import { execBinCmd } from './utils/exec-bin-cmd';
import { findInstalledExecutables } from './utils/find-installed-executables';
import type { OutputData } from './types';

const postinstallType =
  process.argv
    .map((arg) => /^--type\s*=(.+)$/.exec(arg)?.[1]?.trim())
    .findLast(Boolean) ?? process.env['POSTINSTALL_TYPE'];

function validateUtils(expected: { isPnPEnabled: unknown }): void {
  if (typeof expected.isPnPEnabled === 'boolean') {
    if (isPnPEnabled !== expected.isPnPEnabled) {
      throw new Error(
        `Plug'n'Play is not ${expected.isPnPEnabled ? 'enabled' : 'disabled'}`,
      );
    }
  }
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

  const expectedValues: Readonly<Record<string, unknown>> = JSON.parse(
    process.env['DEBUG_EXPECTED_VARS_JSON'] || '{}',
  );

  const { DEBUG_DATA_JSON_PATH, DEBUG_DATA_JSON_LINES_PATH } = process.env;

  if (DEBUG_DATA_JSON_PATH || DEBUG_DATA_JSON_LINES_PATH) {
    const binDir: string | undefined = !binCommandResult?.error
      ? binCommandResult?.stdout.trim()
      : undefined;
    const output: OutputData = {
      postinstallType: postinstallType ?? null,
      binName: binName ?? null,
      actual: {
        cwd,
        env: Object.fromEntries(
          Object.entries(process.env).map(([key, value]) => [
            key,
            value ?? null,
          ]),
        ),
        // see https://yarnpkg.com/advanced/pnpapi#processversionspnp
        pnpVersion: process.versions['pnp'] ?? null,
        isGlobalMode,
        binCommandResult: binCommandResult
          ? {
              ...binCommandResult,
              error: binCommandResult.error
                ? inspect(binCommandResult.error)
                : null,
            }
          : null,
        foundBinFiles: binName
          ? await findInstalledExecutables(
              [cwd].concat(binDir || []),
              isGlobalMode
                ? // see https://docs.npmjs.com/cli/v9/configuring-npm/folders#executables
                  ['bin', '']
                : // see https://docs.npmjs.com/cli/v9/configuring-npm/folders#executables
                  ['node_modules/.bin'],
              binName,
            )
          : null,
      },
    };
    const jsonStr = JSON.stringify(output);
    if (DEBUG_DATA_JSON_PATH) await writeFile(DEBUG_DATA_JSON_PATH, jsonStr);
    if (DEBUG_DATA_JSON_LINES_PATH)
      /**
       * @see https://jsonlines.org/
       */
      await appendFile(DEBUG_DATA_JSON_LINES_PATH, `\n${jsonStr}\n`);
  }

  validateUtils({
    isPnPEnabled: expectedValues['expectedPnPEnabled'],
  });

  console.log(
    ansiColors.green(
      `Finish postinstall${postinstallType ? ` / ${postinstallType}` : ''}`,
    ),
  );
})().catch((error) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(error);
});

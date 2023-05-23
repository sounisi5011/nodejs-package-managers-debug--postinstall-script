import * as child_process from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

import usedPM from 'used-pm';

import { isGlobalMode } from './is-global-mode';

const execAsync = promisify(child_process.exec);

async function fileExists(filepath: string): Promise<boolean> {
  return await fs
    .stat(filepath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

async function isWorkspaceRoot(dirpath: string): Promise<boolean> {
  const packageManager = usedPM();

  if (packageManager?.name.toLowerCase() === 'pnpm') {
    // see https://pnpm.io/workspaces
    // see https://github.com/pnpm/pnpm.github.io/blob/ca887546015ee833a04ded6b7e491afb26f6fbb2/docs/workspaces.md
    return await fileExists(path.join(dirpath, 'pnpm-workspace.yaml'));
  }

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
  return await fs
    .readFile(path.join(dirpath, 'package.json'), 'utf8')
    .then((pkgJsonText) => {
      const pkgJson: unknown = JSON.parse(pkgJsonText);
      return (
        typeof pkgJson === 'object' &&
        pkgJson !== null &&
        'workspaces' in pkgJson
      );
    })
    .catch(() => false);
}

export async function getInstallationPath(): Promise<string> {
  const env = process.env;

  if (!isGlobalMode) {
    const isWorkspacePackage =
      typeof env['npm_config_user_agent'] === 'string' &&
      /(?:^| )workspaces\/true(?: |$)/.test(env['npm_config_user_agent']);

    // If the "npm_config_local_prefix" environment variable exists, use it.
    if (env['npm_config_local_prefix']) {
      ///// DEBUG /////
      console.log({ npm_config_local_prefix: env['npm_config_local_prefix'] });
      ///// DEBUG /////

      // The value of the npm_config_local_prefix environment variable might be the workspace root.
      // If the installation is to a submodule within a workspace, this value should not be used.
      if (
        !isWorkspacePackage ||
        !(await isWorkspaceRoot(env['npm_config_local_prefix']))
      ) {
        return path.join(env['npm_config_local_prefix'], 'node_modules/.bin');
      }
    }

    // If the "npm_config_local_prefix" environment variable does not exist, use the current working directory and the "INIT_CWD" environment variable instead.
    // The same parent directory path that is contained in both the current working directory and "INIT_CWD" can be used.
    if (env['INIT_CWD']) {
      const cwdPathItems = process.cwd().split(path.sep);
      const initCwdPathItems = env['INIT_CWD'].split(path.sep);
      for (
        let i = 0;
        i < Math.max(cwdPathItems.length, initCwdPathItems.length);
        i++
      ) {
        if (cwdPathItems[i] !== initCwdPathItems[i]) {
          const sameParentPathItems = cwdPathItems.slice(0, i);
          ///// DEBUG /////
          console.log({
            cwd: process.cwd(),
            INIT_CWD: env['INIT_CWD'],
            sameParentPathItems,
          });
          ///// DEBUG /////
          sameParentPathItems.push('node_modules', '.bin');
          return sameParentPathItems.join(path.sep);
        }
      }
    }

    throw new Error('Error finding binary installation directory');
  } else {
    /**
     * @see https://github.com/go-task/go-npm/blob/v0.1.17/src/common.js#L23-L60
     */
    const { stdout, stderr } = await execAsync('npm bin').catch(() => ({
      stdout: '',
      stderr: '',
    }));

    let dir = null;
    if (stderr || !stdout || stdout.length === 0) {
      const packageManager = usedPM();

      if (env && env['npm_config_prefix']) {
        dir = path.join(env['npm_config_prefix'], 'bin');
      } else if (env && env['npm_config_local_prefix']) {
        dir = path.join(
          env['npm_config_local_prefix'],
          path.join('node_modules', '.bin'),
        );
      } else if (packageManager?.name.toLowerCase() === 'pnpm') {
        dir = path.join(process.cwd(), 'node_modules', '.bin');
      } else {
        throw new Error('Error finding binary installation directory');
      }
    } else {
      dir = stdout.trim();
    }

    dir = dir.replace(
      /node_modules.*[\/\\]\.bin/,
      path.join('node_modules', '.bin'),
    );
    return dir;
  }
}

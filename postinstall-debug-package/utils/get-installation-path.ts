import * as child_process from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

import usedPM from 'used-pm';

import { isGlobalMode } from './is-global-mode';

const execAsync = promisify(child_process.exec);

export async function getInstallationPath(): Promise<string> {
  const env = process.env;

  if (!isGlobalMode) {
    // If the "npm_config_local_prefix" environment variable exists, use it.
    if (env['npm_config_local_prefix']) {
      ///// DEBUG /////
      console.log({ npm_config_local_prefix: env['npm_config_local_prefix'] });
      ///// DEBUG /////
      return path.join(env['npm_config_local_prefix'], 'node_modules/.bin');
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

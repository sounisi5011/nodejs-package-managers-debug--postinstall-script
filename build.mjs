// @ts-check

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPropAccessible } from '@sounisi5011/ts-utils-is-property-accessible';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} dirpath
 * @returns {Promise<string[]>}
 */
async function findFiles(dirpath) {
  dirpath = path.resolve(dirpath);
  const files = await fs.readdir(dirpath, { withFileTypes: true });
  return files.flatMap((file) =>
    file.isFile() ? path.resolve(dirpath, file.name) : [],
  );
}

/**
 * @param {string} filepath
 * @returns {IterableIterator<string>}
 */
function* walkParentDir(filepath) {
  while (true) {
    yield filepath;

    const parentDir = path.dirname(filepath);
    if (filepath === parentDir) break;
    filepath = parentDir;
  }
}

/**
 * @param {string} filepath
 * @returns {Promise<boolean>}
 */
async function isEsm(filepath) {
  const jsType = /\.([mc]?)[jt]sx?$/i.exec(filepath)?.[1]?.toLowerCase();
  if (jsType === 'm') return true;

  if (jsType === '') {
    for (const dirpath of walkParentDir(path.dirname(filepath))) {
      try {
        /** @type {unknown} */
        const pkgJson = JSON.parse(
          await fs.readFile(path.join(dirpath, 'package.json'), 'utf8'),
        );
        if (!isPropAccessible(pkgJson)) continue;
        if (pkgJson['type'] === 'module') return true;
        if (pkgJson['type'] === 'commonjs') return false;
      } catch {}
    }
  }

  return false;
}

await Promise.all(
  [
    ...(await findFiles(path.resolve(__dirname, '.github/workflows'))),
    ...(await findFiles(path.resolve(__dirname, 'postinstall-debug-package'))),
  ]
    .filter((filepath) => /^\.[cm]?[jt]s$/i.test(path.extname(filepath)))
    .map(async (filepath) => {
      await esbuild.build({
        entryPoints: [filepath],
        bundle: true,
        format: (await isEsm(filepath)) ? 'esm' : 'cjs',
        minify: true,
        outfile: filepath.replace(/\.([cm]?)[jt]s$/i, '.$1js'),
        platform: 'node',
        target: 'node18',
        allowOverwrite: true,
        charset: 'utf8',
      });
    }),
);

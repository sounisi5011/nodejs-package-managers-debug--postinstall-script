const { appendFileSync } = require('fs');
const { inspect } = require('util');

const postinstallType =
  process.argv
    .map((arg) => /^--type\s*=(.+)$/.exec(arg)?.[1].trim())
    .findLast(Boolean) ?? process.env.POSTINSTALL_TYPE;
const envs = {
  cwd: process.cwd(),
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:npm|yarn|pnpm|bun)_/i.test(key),
    ),
  ),
};
if (postinstallType) console.log(postinstallType);
console.log(envs);

const { GITHUB_STEP_SUMMARY } = process.env;
if (GITHUB_STEP_SUMMARY)
  appendFileSync(
    GITHUB_STEP_SUMMARY,
    [
      `<details${Object.keys(envs).length < 30 ? ' open' : ''}>`,
      ...(postinstallType ? [`<summary>${postinstallType}</summary>`] : []),
      '',
      '```js',
      inspect(envs),
      '```',
      '',
      '</details>',
      '',
      '',
    ].join('\n'),
  );

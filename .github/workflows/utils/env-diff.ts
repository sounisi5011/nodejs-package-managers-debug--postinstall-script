import * as path from 'node:path';
import { inspect } from 'node:util';
import type { InspectOptions } from 'node:util';

/**
 * @see https://nodejs.org/api/util.html#custom-inspection-functions-on-objects
 */
type CustomInspectFunction<TThis = unknown> = (
  this: TThis,
  depth: number,
  options: Readonly<InspectOptions>,
  _inspect: typeof inspect,
) => string;

type PrefixRecord = Record<string, unknown>;

function genValueInspectFn(
  args: Readonly<{
    prefixRecord: Readonly<PrefixRecord>;
    key: string;
    value: Readonly<NodeJS.ProcessEnv[string]>;
    origValue: Readonly<NodeJS.ProcessEnv[string]>;
  }>,
): CustomInspectFunction {
  let commentList: string[] = [];
  const overwriteOptions: InspectOptions = {};

  if (/^PATH$/i.test(args.key) && typeof args.value === 'string') {
    const pathList = args.value
      .split(path.delimiter)
      .map((path) => `- ${path}`);
    if (
      typeof args.origValue === 'string' &&
      args.origValue.length < args.value.length &&
      args.value.endsWith(args.origValue)
    ) {
      // Omit duplicate $PATH values
      overwriteOptions.maxStringLength =
        args.value.length - args.origValue.length;
      const origPathLength = args.origValue.split(path.delimiter).length;
      pathList.splice(
        -origPathLength,
        origPathLength,
        `... ${origPathLength} more paths`,
      );
    }
    commentList = ['PATH List:', ...pathList];
  } else if (typeof args.value === 'string') {
    const value = args.value;
    const compareList = Object.entries(args.prefixRecord).flatMap(
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

  return 0 < commentList.length
    ? (_depth, options, inspect) =>
        `(\n${(
          inspect(args.value, { ...options, ...overwriteOptions }) +
          commentList.map((comment) => `\n// ${comment}`).join('')
        ).replace(/^(?!$)/gm, '  ')}\n)`
    : (_depth, options, inspect) =>
        inspect(args.value, { ...options, ...overwriteOptions });
}

export function envDiff(
  env1: Readonly<NodeJS.ProcessEnv>,
  env2: Readonly<Record<string, NodeJS.ProcessEnv[string] | null>>,
  {
    cwd,
    prefixesToCompareRecord,
  }: {
    cwd?: string;
    prefixesToCompareRecord?: Readonly<PrefixRecord>;
  } = {},
): NodeJS.ProcessEnv & {
  readonly [inspect.custom]: CustomInspectFunction<NodeJS.ProcessEnv>;
} {
  const prefixRecord: PrefixRecord = Object.assign(
    cwd ? { 'process.cwd()': cwd } : {},
    prefixesToCompareRecord,
  );

  const customInspect: CustomInspectFunction<NodeJS.ProcessEnv> = function (
    _depth,
    options,
    inspect,
  ) {
    const entries = Object.entries(this).map(([key, value]) => [
      key,
      {
        [inspect.custom]: genValueInspectFn({
          prefixRecord,
          key,
          value,
          origValue: env1[key],
        }),
      },
    ]);
    return inspect(Object.fromEntries(entries), options);
  };

  const envEntries = Object.entries(env2).map(
    ([key, value]) => [key, value ?? undefined] as const,
  );
  return Object.assign(
    Object.fromEntries(
      envEntries.filter(([key, value]) => env1[key] !== value),
    ),
    { [inspect.custom]: customInspect },
  );
}

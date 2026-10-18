import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { build, type Plugin } from 'esbuild';

/** Compile-time only: exports a class map and ?inline CSS string. BotsPage renders
 * that string in its own style element; this plugin never touches the DOM.
 */
export function cssModules(): Plugin {
  const cache = new Map<string, Promise<{ js: string; css: string }>>();
  return {
    name: 'component-css-modules',
    setup(builder) {
      // Watch/rebuild must read changed CSS, while both imports in one build share
      // the same compilation. A failed prior build must not poison the next one.
      builder.onStart(() => { cache.clear(); });
      builder.onResolve({ filter: /\.module\.css(?:\?inline)?$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path), namespace: 'component-css',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'component-css' }, async (args) => {
        const path = args.path.replace(/\?inline$/, '');
        let compilation = cache.get(path);
        if (!compilation) {
          compilation = (async () => {
            const result = await build({
              stdin: {
                contents: `export { default } from ${JSON.stringify(path)};`,
                resolveDir: dirname(path), loader: 'js',
              },
              bundle: true, write: false, format: 'esm', outdir: 'css-output',
              plugins: [{ name: 'read-owned-css', setup(nested) {
                nested.onLoad({ filter: /\.module\.css$/ }, async ({ path: cssPath }) => ({
                  contents: await readFile(cssPath, 'utf8'), loader: 'local-css',
                }));
              } }],
            });
            return {
              js: result.outputFiles.find((file) => file.path.endsWith('.js'))?.text ?? '',
              css: result.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '',
            };
          })();
          cache.set(path, compilation);
        }
        const { js, css } = await compilation;
        return {
          contents: args.path.endsWith('?inline') ? `export default ${JSON.stringify(css)};` : js,
          loader: 'js', watchFiles: [path],
        };
      });
    },
  };
}

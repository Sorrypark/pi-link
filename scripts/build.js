import { readFile } from 'node:fs/promises';
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['client/src/main.js'],
  bundle: true,
  outfile: 'public/app.js',
  format: 'iife',
  target: ['es2022'],
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  plugins: [{
    name: 'css-text',
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        const css = await readFile(args.path, 'utf8');
        return {
          contents: `document.head.append(Object.assign(document.createElement('style'),{textContent:${JSON.stringify(css)}}));`,
          loader: 'js',
        };
      });
    },
  }],
});

import { defineConfig } from 'tsup'
import { resolve } from 'node:path'

export default defineConfig({
  entry: [
    'src/index.ts'
  ],
  format: ['esm', 'cjs'],
  target: 'es2023',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' }
  },
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      '@xeno-js/sqlite': resolve(import.meta.dirname, 'src'),
    }
  },
  external: [
    '@libsql/client',
    '@libsql/client/web',
    '@xeno-js/shared',
    '@xeno-js/core',
    'drizzle-orm',
  ],
})
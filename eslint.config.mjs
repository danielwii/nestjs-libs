import { createEslintConfig } from './eslint-shared.mjs';

export default createEslintConfig({
  rootDir: import.meta.dirname,
  tsconfigPath: './tsconfig.json',
});

#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import kleur from 'kleur';
import prompts from 'prompts';

const GITHUB_REPO = 'danielwii/nestjs-libs';
const RAW_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main`;

async function main() {
  const args = Bun.argv.slice(2);
  const command = args[0];

  if (command !== 'add' || !args[1]) {
    console.log(kleur.cyan('\nUsage:'));
    console.log(`  bunx ${GITHUB_REPO} add <module-path>`);
    console.log(kleur.gray('\nExample:'));
    console.log(`  bunx ${GITHUB_REPO} add utils/fetch\n`);
    process.exit(0);
  }

  const modulePath = args[1]; // e.g., "utils/fetch"

  // 智能补全路径: utils/fetch -> utils/src/fetch.ts
  let remoteFilePath = modulePath;
  if (!remoteFilePath.includes('/src/')) {
    const parts = remoteFilePath.split('/');
    if (parts.length >= 2) {
      const pkg = parts[0];
      const rest = parts.slice(1).join('/');
      remoteFilePath = `${pkg}/src/${rest}`;
    }
  }
  if (!remoteFilePath.endsWith('.ts')) {
    remoteFilePath += '.ts';
  }

  const url = `${RAW_BASE_URL}/${remoteFilePath}`;

  console.log(kleur.yellow(`\n🔍 Fetching ${kleur.bold(modulePath)} from GitHub...`));

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(kleur.red(`❌ Module not found at: ${url}`));
      process.exit(1);
    }

    const content = await response.text();

    // 确定本地目标路径
    const targetBaseDir = 'src/libs';
    const fileName = remoteFilePath.split('/').pop()!;
    const targetPath = join(process.cwd(), targetBaseDir, fileName);

    // 确认安装
    const confirm = await prompts({
      type: 'confirm',
      name: 'value',
      message: `Install to ${kleur.cyan(join(targetBaseDir, fileName))}?`,
      initial: true,
    });

    if (!confirm.value) {
      console.log(kleur.gray('Cancelled.'));
      process.exit(0);
    }

    // 确保目录存在
    const targetDir = dirname(targetPath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    // 写入文件
    writeFileSync(targetPath, content);

    console.log(kleur.green(`\n✅ Successfully added ${kleur.bold(fileName)}!`));
    console.log(kleur.gray(`Location: ${targetPath}\n`));

    // 简单的依赖提示 (从源码中粗略正则提取)
    const depMatches = content.match(/from\s+['"](@?[\w\-/]+)['"]/g);
    if (depMatches) {
      const deps = [...new Set(depMatches.map((m) => m.match(/['"](@?[\w\-/]+)['"]/)?.[1]))].filter(
        (d): d is string => !!d && !d.startsWith('.') && !d.startsWith('@/'),
      );

      if (deps.length > 0) {
        console.log(kleur.yellow('💡 This module might need the following dependencies:'));
        console.log(kleur.cyan(`   bun add ${deps.join(' ')}\n`));
      }
    }
  } catch (error: unknown) {
    console.error(kleur.red(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

void main();

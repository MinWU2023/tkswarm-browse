#!/usr/bin/env node
/**
 * 从 build/icon.svg 生成 icon.png / icon.ico（Windows exe + 窗口图标）
 * 用法：npm run icons
 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');
const svgPath = path.join(buildDir, 'icon.svg');
const pngPath = path.join(buildDir, 'icon.png');
const png256Path = path.join(buildDir, 'icon-256.png');
const icoPath = path.join(buildDir, 'icon.ico');

async function main() {
  if (!fs.existsSync(svgPath)) {
    console.error('缺少 build/icon.svg');
    process.exit(1);
  }
  const svg = fs.readFileSync(svgPath);

  await sharp(svg).resize(512, 512).png().toFile(pngPath);
  await sharp(svg).resize(256, 256).png().toFile(png256Path);

  const icoBuf = await pngToIco([png256Path, pngPath]);
  fs.writeFileSync(icoPath, icoBuf);

  console.log('已生成:');
  console.log(' -', pngPath);
  console.log(' -', png256Path);
  console.log(' -', icoPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

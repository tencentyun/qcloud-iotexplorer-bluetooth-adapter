#!/usr/bin/env node
const { program } = require('commander');
const Terser = require('terser');
const fs = require('fs');
const path = require('path');

program
  .requiredOption('-p, --package <package>', '需要压缩的包名称')
  .requiredOption('-t, --target <target>', '压缩代码输出目录');

program.parse(process.argv);

const { target, package } = program;

const rootDir = path.resolve(__dirname, `../packages/${package}`);
const entryPath = path.resolve(rootDir, `${target}`);

const files = getAllFiles(entryPath);

minifyFiles(files);

function getAllFiles(dirPath, arrayOfFiles) {
  // console.log('dirPath', dirPath);

  const files = fs.readdirSync(dirPath);

  // console.log('files', files);


  arrayOfFiles = arrayOfFiles || [];

  files.forEach((file) => {
    if (fs.statSync(`${dirPath}/${file}`).isDirectory()) {
      arrayOfFiles = getAllFiles(`${dirPath}/${file}`, arrayOfFiles);
    } else {
      arrayOfFiles.push(`${dirPath}/${file}`);
    }
  });

  return arrayOfFiles.filter(path => path.match(/\.js$/));
}

async function minifyFiles(filePaths) {
  for (let i = 0, l = filePaths.length; i < l; i++) {
    const filePath = filePaths[i];

    const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);

    const sourceMapPath = `${filePath}.map`;

    // console.log('sourceMapPath', sourceMapPath);

    const result = await Terser.minify(fs.readFileSync(filePath, 'utf8'), {
      module: target === 'es',
      sourceMap: {
        content: fs.readFileSync(sourceMapPath, 'utf8'),
        url: `${fileName}.map`,
      },
    });

    // console.log('result', result);

    const { code, map } = result;

    fs.writeFileSync(filePath, code);
    fs.writeFileSync(sourceMapPath, map);
  }
}

// minifyFiles(['/Users/xyz/Sites/tencent/qcloud/qcloud_iot/iotexplorer-appdev-jssdk/appdev-jssdk/es/utils/utillib.js'])

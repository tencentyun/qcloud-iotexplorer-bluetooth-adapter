#!/usr/bin/env node
const { program } = require('commander');
const Terser = require("terser");
const fs = require("fs");
const path = require("path");

program
	.requiredOption('-t, --target <target>', '需要压缩的目标目录');

program.parse(process.argv);

const target = program.target;

function getAllFiles(dirPath, arrayOfFiles) {
	// console.log('dirPath', dirPath);

	let files = fs.readdirSync(dirPath);

	// console.log('files', files);


	arrayOfFiles = arrayOfFiles || [];

	files.forEach(function (file) {
		if (fs.statSync(dirPath + "/" + file).isDirectory()) {
			arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
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
				url: `${fileName}.map`
			},
		});

		// console.log('result', result);

		const { code, map } = result;

		fs.writeFileSync(filePath, code);
		fs.writeFileSync(sourceMapPath, map);
	}
}

const files = getAllFiles(path.resolve(__dirname, `../${program.target}`));

// console.log('files', files);
minifyFiles(files);
// minifyFiles(['/Users/xyz/Sites/tencent/qcloud/qcloud_iot/iotexplorer-appdev-jssdk/appdev-jssdk/es/utils/utillib.js'])

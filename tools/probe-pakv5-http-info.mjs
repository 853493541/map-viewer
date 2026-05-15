#!/usr/bin/env node

import iconv from 'iconv-lite';
import koffi from 'koffi';

const ROOT = 'C:/SeasunGame/Game/JX3/bin/zhcn_hd/SeasunDownloaderV2.4';
const DLL = `${ROOT}/KGPK5_FileSystemX64.dll`;
const ROOT_PATH = 'C:\\SeasunGame\\Game\\JX3\\bin\\zhcn_hd\\SeasunDownloaderV2.4\\';

const logicalPaths = process.argv.slice(2);
if (!logicalPaths.length) {
	console.error('usage: node tools/probe-pakv5-http-info.mjs <logicalPath> [morePaths...]');
	process.exit(1);
}

process.chdir(ROOT);
const lib = koffi.load(DLL);

function tryBind(name, signatures) {
	const bound = [];
	for (const signature of signatures) {
		try {
			bound.push({ signature, fn: lib.func(signature) });
			console.log(`bind OK: ${signature}`);
		} catch (error) {
			console.log(`bind FAIL ${signature}: ${String(error.message || error).split('\n')[0]}`);
		}
	}
	return bound;
}

function callInitialization(label, fn, ...args) {
	if (!fn) {
		return;
	}
	try {
		console.log(`${label} ->`, fn(...args));
	} catch (error) {
		console.log(`${label} failed -> ${error.message}`);
	}
}

function decodeCString(buffer) {
	return buffer.toString('utf8').replace(/\0.*$/, '');
}

function buildPathInputs(path) {
	return [
		{ label: 'utf8-string', value: path },
		{ label: 'gbk-buffer', value: Buffer.concat([iconv.encode(path, 'gbk'), Buffer.from([0])]) },
	];
}

function uniquePush(list, seen, item) {
	const key = JSON.stringify(item);
	if (seen.has(key)) {
		return;
	}
	seen.add(key);
	list.push(item);
}

function invokeStringOrBuffer(candidates, inputValue) {
	const results = [];
	const seen = new Set();
	for (const candidate of candidates) {
		try {
			if (candidate.signature.startsWith('const char *')) {
				const value = candidate.fn(inputValue);
				if (value) {
					uniquePush(results, seen, { signature: candidate.signature, value: String(value) });
				}
				continue;
			}
			const out = Buffer.alloc(256);
			const rc = candidate.fn(inputValue, out, 256);
			const value = decodeCString(out);
			uniquePush(results, seen, { signature: candidate.signature, rc, value });
		} catch (error) {
			uniquePush(results, seen, { signature: candidate.signature, error: error.message });
		}
	}
	return results;
}

const setRootFns = tryBind('g_SetPakV5RootPath', [
	'int g_SetPakV5RootPath(const char *path)',
	'void g_SetPakV5RootPath(const char *path)',
]);
const createAdapterFns = tryBind('g_CreatePakV5Adapter', [
	'int g_CreatePakV5Adapter()',
	'void *g_CreatePakV5Adapter()',
]);
const enablePakV5Fns = tryBind('g_EnablePakV5', [
	'int g_EnablePakV5(int enable)',
	'void g_EnablePakV5(int enable)',
]);
const enableHttpFns = tryBind('g_EnableHttpFile', [
	'int g_EnableHttpFile(int enable)',
	'void g_EnableHttpFile(int enable)',
	'int g_EnableHttpFile()',
	'void g_EnableHttpFile()',
]);
const getFileContentHashFns = tryBind('g_GetFileContentHash', [
	'int g_GetFileContentHash(const char *path, char *outBuf, uint32_t outLen)',
	'int g_GetFileContentHash(const char *path, char *outBuf, int outLen)',
	'const char *g_GetFileContentHash(const char *path)',
]);
const formatShortFileNameFns = tryBind('g_FormatShortFileName', [
	'int g_FormatShortFileName(const char *path, char *outBuf, uint32_t outLen)',
	'int g_FormatShortFileName(const char *path, char *outBuf, int outLen)',
	'const char *g_FormatShortFileName(const char *path)',
]);

callInitialization('setRoot', setRootFns[0]?.fn, ROOT_PATH);
callInitialization('createAdapter', createAdapterFns[0]?.fn);
callInitialization('enablePakV5', enablePakV5Fns[0]?.fn, 1);
if (enableHttpFns[0]) {
	const sig = enableHttpFns[0].signature;
	if (sig.includes('(int enable)')) {
		callInitialization('enableHttp', enableHttpFns[0].fn, 1);
	} else {
		callInitialization('enableHttp', enableHttpFns[0].fn);
	}
}


for (const logicalPath of logicalPaths) {
	console.log(`\nPATH ${logicalPath}`);
	for (const input of buildPathInputs(logicalPath)) {
		console.log(`  INPUT ${input.label}`);
		const hashResults = invokeStringOrBuffer(getFileContentHashFns, input.value)
			.filter((item) => item.value);
		if (!hashResults.length) {
			console.log('    getFileContentHash: no value');
		}
		for (const result of hashResults) {
			console.log(`    hash signature=${result.signature}`);
			console.log(`    hash value=${result.value}`);
			if (typeof result.rc !== 'undefined') {
				console.log(`    hash rc=${result.rc}`);
			}

			const shortResults = invokeStringOrBuffer(formatShortFileNameFns, result.value)
				.filter((item) => item.value);
			if (!shortResults.length) {
				console.log('    shortName: no value');
			}
			for (const shortResult of shortResults) {
				console.log(`    short signature=${shortResult.signature}`);
				console.log(`    short value=${shortResult.value}`);
				if (typeof shortResult.rc !== 'undefined') {
					console.log(`    short rc=${shortResult.rc}`);
				}
			}
		}
	}
}
